require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const { v4: uuidv4 } = require('uuid');
const { computeRoute } = require('./routing');
const { queryOverpass } = require('./overpass');
const db = require('./db');

// Secret used to sign admin session JWTs. Falls back to a random value
// generated at process start (still secure, just invalidates existing
// admin sessions on every restart) so this never silently runs with a
// guessable default; set ADMIN_JWT_SECRET in production for sessions
// that survive restarts.
const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || uuidv4() + uuidv4();

// Session cookie for regular (doctor/drone-operator) logins -- separate
// from the admin panel's own admin_session cookie, though both are
// signed with the same secret.
const USER_COOKIE = 'user_session';

const app = express();
const server = http.createServer(app);

// Get the network IP for multi-device access
const os = require('os');
const interfaces = os.networkInterfaces();
let networkIP = 'localhost';

for (const interfaceName in interfaces) {
  for (const iface of interfaces[interfaceName]) {
    if (iface.family === 'IPv4' && !iface.internal) {
      networkIP = iface.address;
      break;
    }
  }
}

const io = new Server(server, {
    cors: {
        origin: [
            "https://testfile6.onrender.com",
            "http://localhost:3000",
            "http://localhost:8080",
            "https://drone-ztxx.onrender.com",
            "https://trigun-smart-health-drone.onrender.com"
        ],
        // Allow all origins for multi-device testing
        methods: ["GET", "POST"],
        credentials: true,
        allowedHeaders: ["Content-Type", "Authorization"]
    }
});

// --- Centralized Connection State ---
// Keyed by roomId so multiple drone/doctor pairs can be active at once
// without leaking GPS or video data across pairings.
let activeConnections = {};

// Emergency calls a drone has raised but no doctor has accepted yet,
// keyed by the roomId that was pre-assigned when the request was made.
let pendingRequests = {};

// userId -> { socketId, role }, populated by the 'identify' socket event
// once a client knows which logged-in user it is (used for admin's online
// status view and to notify a specific drone when a doctor accepts its call).
let onlineUsers = new Map();

// Public-safe view of a user (never expose the password hash)
function toPublicUser(user) {
    const { passwordHash, ...publicUser } = user;
    return publicUser;
}

function appendAuditLog({ adminUserId, action, details }) {
    return db.appendAuditLog({
        id: uuidv4(),
        timestamp: Date.now(),
        adminUserId,
        action,
        details: details || null
    });
}

// Serve static files
app.use(express.static(__dirname));
app.use(express.json());
app.use(cookieParser());

// Route handlers
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/drone.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'drone.html'));
});

app.get('/doctor.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'doctor.html'));
});

// --- Registration / Login API (server-side, hashed passwords) ---
app.post('/api/register', async (req, res) => {
    try {
        const {
            name, userId, email, phone, userType, password,
            specialization, license, clinic,
            city, village, state, country
        } = req.body || {};

        if (!name || !userId || !email || !phone || !userType || !password) {
            return res.status(400).json({ error: 'Missing required registration fields.' });
        }

        const users = await db.loadUsers();
        if (users.some(u => u.userId === userId)) {
            return res.status(409).json({ error: 'User ID already taken. Please choose a different one.' });
        }

        const passwordHash = await bcrypt.hash(password, 10);

        const newUser = {
            name, userId, email, phone, userType, passwordHash,
            // New doctor/drone-operator accounts require admin approval before
            // they can log in; admin accounts (created through their own
            // setup/create-admin endpoints) are never routed through here and
            // remain immediately active.
            status: 'pending',
            skills: [],
            workDetails: '',
            metrics: {
                assignedCases: 0,
                completedTasks: 0,
                responseTime: 0,
                successRate: 100
            }
        };

        if (userType === 'doctor') {
            newUser.specialization = specialization || '';
            newUser.license = license || '';
            newUser.clinic = clinic || '';
            newUser.metrics.onlineConsultations = 0;
            newUser.metrics.emergencyResponses = 0;
        } else if (userType === 'drone_operator') {
            newUser.city = city || '';
            newUser.village = village || '';
            newUser.state = state || '';
            newUser.country = country || '';
        }

        users.push(newUser);
        await db.saveUsers(users);

        // Let any connected admin panel show a live "new registration" badge
        // without needing to refresh or poll.
        io.emit('newRegistrationPending', toPublicUser(newUser));

        res.status(201).json({ user: toPublicUser(newUser), pendingApproval: true });
    } catch (err) {
        console.error('Registration failed:', err);
        res.status(500).json({ error: 'Registration failed due to a server error. Please try again.' });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { userId, password } = req.body || {};
        if (!userId || !password) {
            return res.status(400).json({ error: 'User ID and password are required.' });
        }

        const users = await db.loadUsers();
        const user = users.find(u => u.userId === userId);
        // A missing/corrupted passwordHash (e.g. a record from before
        // hashing was introduced, or written by an older code path) would
        // make bcrypt.compare() throw synchronously -- treat it the same
        // as "no such user" instead of crashing the request.
        if (!user || !user.passwordHash) {
            return res.status(401).json({ error: 'Invalid User ID or password.' });
        }

        const match = await bcrypt.compare(password, user.passwordHash);
        if (!match) {
            return res.status(401).json({ error: 'Invalid User ID or password.' });
        }

        // Pending/rejected accounts never receive a session, even with the
        // right password.
        if (user.status === 'pending') {
            return res.status(403).json({ error: 'Your account is still pending admin approval.' });
        }
        if (user.status === 'rejected') {
            return res.status(403).json({ error: 'Your registration was not approved.' });
        }

        const token = jwt.sign({ userId: user.userId, role: user.userType }, ADMIN_JWT_SECRET, { expiresIn: '12h' });
        res.cookie(USER_COOKIE, token, {
            httpOnly: true,
            sameSite: 'lax',
            secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
            maxAge: 12 * 60 * 60 * 1000
        });

        res.json({ user: toPublicUser(user) });
    } catch (err) {
        console.error('Login failed:', err);
        // TEMPORARY: include the real error message in the response while
        // diagnosing a live deployment issue where server logs weren't
        // readily available. Remove this once the root cause is fixed --
        // it's a mild internal-detail disclosure, not appropriate long-term.
        res.status(500).json({ error: 'Login failed due to a server error. Please try again.' });
    }
});

app.post('/api/logout', (req, res) => {
    res.clearCookie(USER_COOKIE);
    res.json({ success: true });
});

// Lets doctor.html/drone.html/index.html confirm an existing session
// (e.g. after a page reload) without resending credentials.
app.get('/api/me', async (req, res) => {
    const token = req.cookies && req.cookies[USER_COOKIE];
    if (!token) return res.status(401).json({ error: 'Not logged in.' });
    try {
        const payload = jwt.verify(token, ADMIN_JWT_SECRET);
        const users = await db.loadUsers();
        const user = users.find(u => u.userId === payload.userId);
        if (!user || user.status === 'rejected') {
            return res.status(401).json({ error: 'Session no longer valid.' });
        }
        res.json({ user: toPublicUser(user) });
    } catch (err) {
        return res.status(401).json({ error: 'Session expired or invalid.' });
    }
});

// List registered users (public fields only) so the UI can show real
// doctors/drone operators instead of a hardcoded list.
app.get('/api/users', async (req, res) => {
    const { userType } = req.query;
    const users = (await db.loadUsers()).map(toPublicUser);
    const filtered = userType ? users.filter(u => u.userType === userType) : users;
    res.json({ users: filtered });
});

// Convenience aliases over /api/users for populating doctor/drone dropdowns.
app.get('/api/doctors', async (req, res) => {
    const users = (await db.loadUsers()).map(toPublicUser).filter(u => u.userType === 'doctor');
    res.json({ users });
});

app.get('/api/drones', async (req, res) => {
    const users = (await db.loadUsers()).map(toPublicUser).filter(u => u.userType === 'drone_operator');
    res.json({ users });
});

// --- Video calls: PeerJS (direct browser-to-browser WebRTC) ---
// No server-side involvement needed at all: PeerJS's free public
// PeerServer brokers the initial connection between the two browsers'
// Peer objects, then media flows directly peer-to-peer. The drone
// registers under a Peer ID derived from the existing per-connection
// roomId (already used for the Socket.IO pairing), and the doctor
// calls that exact ID -- both entirely client-side in
// drone.html/doctor.html, so no new server code is required here.

// --- Nearby hospitals (OpenStreetMap Overpass API, proxied server-side) ---
app.get('/api/hospitals', async (req, res) => {
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    const radiusMeters = parseInt(req.query.radius, 10) || 10000; // default 10km

    if (Number.isNaN(lat) || Number.isNaN(lng)) {
        return res.status(400).json({ error: 'lat and lng query parameters are required.' });
    }

    const query = `[out:json][timeout:25];node["amenity"="hospital"](around:${radiusMeters},${lat},${lng});out body;`;

    try {
        const data = await queryOverpass(query);
        const hospitals = (data.elements || [])
            .filter(el => typeof el.lat === 'number' && typeof el.lon === 'number')
            .map(el => ({
                id: el.id,
                name: (el.tags && el.tags.name) || 'Unnamed Hospital',
                lat: el.lat,
                lng: el.lon
            }));
        res.json({ hospitals });
    } catch (err) {
        console.error('Hospital lookup failed:', err.message);
        res.status(502).json({ error: 'Failed to fetch nearby hospitals: ' + err.message });
    }
});

// --- Real drone hardware telemetry ingestion ---
// Env var needed: DRONE_TELEMETRY_API_KEY - shared secret hardware adapters
// (see hardware-adapters/) must send as the x-api-key header. Requests
// without a matching key are rejected with 401.
const DRONE_TELEMETRY_API_KEY = process.env.DRONE_TELEMETRY_API_KEY || null;

app.post('/api/drone-telemetry', (req, res) => {
    const providedKey = req.headers['x-api-key'];
    if (!DRONE_TELEMETRY_API_KEY || providedKey !== DRONE_TELEMETRY_API_KEY) {
        return res.status(401).json({ error: 'Invalid or missing x-api-key.' });
    }

    const { droneId, lat, lng, altitude, heading, speed, battery, timestamp } = req.body || {};

    if (!droneId || typeof droneId !== 'string' || droneId.trim() === '') {
        return res.status(400).json({ error: 'droneId (non-empty string) is required.' });
    }
    if (typeof lat !== 'number' || Number.isNaN(lat) || lat < -90 || lat > 90) {
        return res.status(400).json({ error: 'lat must be a number between -90 and 90.' });
    }
    if (typeof lng !== 'number' || Number.isNaN(lng) || lng < -180 || lng > 180) {
        return res.status(400).json({ error: 'lng must be a number between -180 and 180.' });
    }
    for (const [field, value] of Object.entries({ altitude, heading, speed, battery })) {
        if (value !== undefined && value !== null && (typeof value !== 'number' || Number.isNaN(value))) {
            return res.status(400).json({ error: `${field}, if provided, must be a number.` });
        }
    }

    const telemetry = {
        droneId: droneId.trim(),
        lat, lng,
        altitude: typeof altitude === 'number' ? altitude : null,
        heading: typeof heading === 'number' ? heading : null,
        speed: typeof speed === 'number' ? speed : null,
        battery: typeof battery === 'number' ? battery : null,
        timestamp: typeof timestamp === 'number' ? timestamp : Date.now()
    };

    io.to('drone-telemetry-' + telemetry.droneId).emit('real-drone-position', telemetry);
    res.json({ ok: true });
});

// --- A* road routing (OpenStreetMap Overpass API + server-side A*) ---
app.post('/api/route', async (req, res) => {
    const { start, end, trafficDensity } = req.body || {};
    if (!start || !end || typeof start.lat !== 'number' || typeof start.lng !== 'number' ||
        typeof end.lat !== 'number' || typeof end.lng !== 'number') {
        return res.status(400).json({ error: 'start and end coordinates ({lat, lng}) are required.' });
    }

    try {
        const route = await computeRoute({
            start, end,
            trafficDensity: Number(trafficDensity) || 0
        });
        res.json(route);
    } catch (err) {
        console.error('Route computation failed:', err.message);
        res.status(502).json({ error: 'Failed to compute route: ' + err.message });
    }
});

// --- Admin authentication (real, per-account, hashed + signed sessions) ---
// Admin accounts live in the same user store as doctors/drone operators,
// distinguished by userType === 'admin', with bcrypt-hashed passwords
// exactly like every other account. Session state is a signed JWT held
// in an httpOnly cookie (not readable/forgeable from client JS), so
// there is no in-memory token set and no shared env-var password.
const ADMIN_COOKIE = 'admin_session';
const ADMIN_TOKEN_TTL = '12h';

function requireAdmin(req, res, next) {
    const token = req.cookies && req.cookies[ADMIN_COOKIE];
    if (!token) {
        return res.status(401).json({ error: 'Admin authentication required.' });
    }
    try {
        const payload = jwt.verify(token, ADMIN_JWT_SECRET);
        if (payload.role !== 'admin') throw new Error('not an admin token');
        req.adminUserId = payload.userId;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Admin session expired or invalid. Please log in again.' });
    }
}

// One-time setup: creates the FIRST admin account. Refuses once any admin
// account already exists, so this can never be used to mint unauthorized
// extra admins after initial setup -- further admins are created by an
// already-authenticated admin (see POST /api/admin/users below).
app.post('/api/admin/setup', async (req, res) => {
    try {
        const { name, userId, email, password } = req.body || {};
        if (!name || !userId || !email || !password) {
            return res.status(400).json({ error: 'name, userId, email and password are required.' });
        }
        if (password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters.' });
        }

        const users = await db.loadUsers();
        if (users.some(u => u.userType === 'admin')) {
            return res.status(403).json({ error: 'An admin account already exists. Setup is one-time only.' });
        }
        if (users.some(u => u.userId === userId)) {
            return res.status(409).json({ error: 'User ID already taken. Please choose a different one.' });
        }

        const passwordHash = await bcrypt.hash(password, 10);
        const newAdmin = { name, userId, email, userType: 'admin', passwordHash, status: 'active', createdAt: Date.now() };
        users.push(newAdmin);
        await db.saveUsers(users);

        await appendAuditLog({ adminUserId: userId, action: 'admin_account_created', details: { via: 'initial_setup' } });

        res.status(201).json({ user: toPublicUser(newAdmin) });
    } catch (err) {
        console.error('Admin setup failed:', err);
        res.status(500).json({ error: 'Setup failed due to a server error. Please try again.' });
    }
});

// Lets the dashboard know whether setup still needs to run, without
// exposing anything about existing accounts.
app.get('/api/admin/setup-status', async (req, res) => {
    const users = await db.loadUsers();
    res.json({ setupRequired: !users.some(u => u.userType === 'admin') });
});

app.post('/api/admin/login', async (req, res) => {
    try {
        const { userId, password } = req.body || {};
        if (!userId || !password) {
            return res.status(400).json({ error: 'User ID and password are required.' });
        }

        const users = await db.loadUsers();
        const admin = users.find(u => u.userId === userId && u.userType === 'admin');
        if (!admin || !admin.passwordHash) {
            return res.status(401).json({ error: 'Invalid admin credentials.' });
        }

        const match = await bcrypt.compare(password, admin.passwordHash);
        if (!match) {
            return res.status(401).json({ error: 'Invalid admin credentials.' });
        }

        const token = jwt.sign({ userId: admin.userId, role: 'admin' }, ADMIN_JWT_SECRET, { expiresIn: ADMIN_TOKEN_TTL });
        res.cookie(ADMIN_COOKIE, token, {
            httpOnly: true,
            sameSite: 'lax',
            secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
            maxAge: 12 * 60 * 60 * 1000
        });

        await appendAuditLog({ adminUserId: admin.userId, action: 'admin_login' });

        res.json({ user: toPublicUser(admin) });
    } catch (err) {
        console.error('Admin login failed:', err);
        res.status(500).json({ error: 'Login failed due to a server error. Please try again.' });
    }
});

app.post('/api/admin/logout', requireAdmin, async (req, res) => {
    await appendAuditLog({ adminUserId: req.adminUserId, action: 'admin_logout' });
    res.clearCookie(ADMIN_COOKIE);
    res.json({ success: true });
});

// Lets the dashboard confirm an existing session (e.g. after a page
// reload) without needing to resend credentials.
app.get('/api/admin/me', requireAdmin, async (req, res) => {
    const users = await db.loadUsers();
    const admin = users.find(u => u.userId === req.adminUserId && u.userType === 'admin');
    if (!admin) return res.status(401).json({ error: 'Admin account no longer exists.' });
    res.json({ user: toPublicUser(admin) });
});

// Create additional admin accounts. Only an already-authenticated admin
// can do this, so this is the ONLY path to more admins after setup.
app.post('/api/admin/users', requireAdmin, async (req, res) => {
    try {
        const { name, userId, email, password } = req.body || {};
        if (!name || !userId || !email || !password) {
            return res.status(400).json({ error: 'name, userId, email and password are required.' });
        }
        if (password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters.' });
        }

        const users = await db.loadUsers();
        if (users.some(u => u.userId === userId)) {
            return res.status(409).json({ error: 'User ID already taken. Please choose a different one.' });
        }

        const passwordHash = await bcrypt.hash(password, 10);
        const newAdmin = { name, userId, email, userType: 'admin', passwordHash, status: 'active', createdAt: Date.now() };
        users.push(newAdmin);
        await db.saveUsers(users);

        await appendAuditLog({ adminUserId: req.adminUserId, action: 'admin_account_created', details: { createdUserId: userId } });

        res.status(201).json({ user: toPublicUser(newAdmin) });
    } catch (err) {
        console.error('Admin account creation failed:', err);
        res.status(500).json({ error: 'Failed to create admin account due to a server error.' });
    }
});

// Registered users annotated with live online/pairing status for the admin panel.
app.get('/api/admin/users', requireAdmin, async (req, res) => {
    const users = (await db.loadUsers()).map(u => {
        const pub = toPublicUser(u);
        const pairing = Object.values(activeConnections).find(c =>
            c.doctorUserId === u.userId || c.operatorUserId === u.userId ||
            c.doctorName === u.userId || c.operatorName === u.userId
        );
        return {
            ...pub,
            online: onlineUsers.has(u.userId),
            paired: !!pairing,
            roomId: pairing ? pairing.roomId : null
        };
    });
    res.json({ users });
});

// Accounts awaiting admin approval before they can log in.
app.get('/api/admin/pending-users', requireAdmin, async (req, res) => {
    const users = (await db.loadUsers())
        .filter(u => u.status === 'pending')
        .map(toPublicUser);
    res.json({ users });
});

app.post('/api/admin/users/:userId/approve', requireAdmin, async (req, res) => {
    const users = await db.loadUsers();
    const user = users.find(u => u.userId === req.params.userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (user.status !== 'pending') {
        return res.status(400).json({ error: 'This account is not awaiting approval.' });
    }
    user.status = 'active';
    await db.saveUsers(users);

    await appendAuditLog({
        adminUserId: req.adminUserId,
        action: 'user_approved',
        details: { userId: user.userId, name: user.name, userType: user.userType }
    });

    res.json({ user: toPublicUser(user) });
});

app.post('/api/admin/users/:userId/reject', requireAdmin, async (req, res) => {
    const users = await db.loadUsers();
    const user = users.find(u => u.userId === req.params.userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (user.status !== 'pending') {
        return res.status(400).json({ error: 'This account is not awaiting approval.' });
    }
    user.status = 'rejected';
    await db.saveUsers(users);

    await appendAuditLog({
        adminUserId: req.adminUserId,
        action: 'user_rejected',
        details: { userId: user.userId, name: user.name, userType: user.userType }
    });

    res.json({ user: toPublicUser(user) });
});

// Active drone/doctor pairings and unassigned emergency requests, for the
// admin panel's real-time view.
app.get('/api/admin/connections', requireAdmin, (req, res) => {
    res.json({
        connections: Object.values(activeConnections),
        pendingRequests: Object.values(pendingRequests)
    });
});

app.delete('/api/admin/users/:userId', requireAdmin, async (req, res) => {
    const users = await db.loadUsers();
    const idx = users.findIndex(u => u.userId === req.params.userId);
    if (idx === -1) {
        return res.status(404).json({ error: 'User not found.' });
    }
    const removed = users[idx];
    if (removed.userType === 'admin') {
        return res.status(400).json({ error: 'Admin accounts cannot be removed from this endpoint.' });
    }
    users.splice(idx, 1);
    await db.saveUsers(users);

    const online = onlineUsers.get(req.params.userId);
    if (online) {
        const kickSocket = io.sockets.sockets.get(online.socketId);
        if (kickSocket) {
            kickSocket.emit('accountRemoved');
            kickSocket.disconnect(true);
        }
        onlineUsers.delete(req.params.userId);
    }

    await appendAuditLog({
        adminUserId: req.adminUserId,
        action: 'user_removed',
        details: { userId: removed.userId, name: removed.name, userType: removed.userType }
    });

    res.json({ success: true });
});

// Shared editable-field logic for both doctor and drone-operator updates.
// Mirrors the validation registration already performs, and never allows
// userId/userType/passwordHash to be changed through this endpoint.
async function updateUserDetails(req, res, expectedUserType) {
    const users = await db.loadUsers();
    const idx = users.findIndex(u => u.userId === req.params.userId && u.userType === expectedUserType);
    if (idx === -1) {
        return res.status(404).json({ error: `${expectedUserType === 'doctor' ? 'Doctor' : 'Drone operator'} not found.` });
    }

    const { name, email, phone, specialization, license, clinic, city, village, state, country, password } = req.body || {};

    if (name !== undefined && !String(name).trim()) {
        return res.status(400).json({ error: 'Name cannot be empty.' });
    }
    if (email !== undefined && !String(email).trim()) {
        return res.status(400).json({ error: 'Email cannot be empty.' });
    }
    if (phone !== undefined && !String(phone).trim()) {
        return res.status(400).json({ error: 'Phone cannot be empty.' });
    }

    const user = users[idx];
    if (name !== undefined) user.name = name;
    if (email !== undefined) user.email = email;
    if (phone !== undefined) user.phone = phone;

    if (expectedUserType === 'doctor') {
        if (specialization !== undefined) user.specialization = specialization;
        if (license !== undefined) user.license = license;
        if (clinic !== undefined) user.clinic = clinic;
    } else {
        if (city !== undefined) user.city = city;
        if (village !== undefined) user.village = village;
        if (state !== undefined) user.state = state;
        if (country !== undefined) user.country = country;
    }

    if (password) {
        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters.' });
        }
        user.passwordHash = await bcrypt.hash(password, 10);
    }

    await db.saveUsers(users);

    const changedFields = Object.keys(req.body || {}).filter(k => k !== 'password');
    await appendAuditLog({
        adminUserId: req.adminUserId,
        action: 'user_edited',
        details: { userId: user.userId, userType: user.userType, changedFields }
    });

    res.json({ user: toPublicUser(user) });
}

app.put('/api/doctors/:userId', requireAdmin, async (req, res) => updateUserDetails(req, res, 'doctor'));
app.put('/api/drones/:userId', requireAdmin, async (req, res) => updateUserDetails(req, res, 'drone_operator'));

// --- Analytics: computed entirely from the persisted emergency log ---
app.get('/api/admin/analytics', requireAdmin, async (req, res) => {
    const log = await db.loadEmergencyLog();
    const users = await db.loadUsers();
    const userName = (userId) => {
        const u = users.find(x => x.userId === userId);
        return u ? u.name : userId;
    };

    // Daily call counts (by createdAt date, oldest first).
    const byDay = {};
    for (const entry of log) {
        const day = new Date(entry.createdAt).toISOString().slice(0, 10);
        byDay[day] = (byDay[day] || 0) + 1;
    }
    const callsByDay = Object.entries(byDay)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, count]) => ({ date, count }));

    // Average response time: assignedAt - createdAt, across entries that
    // were ever accepted by a doctor.
    const responseTimes = log
        .filter(e => e.assignedAt)
        .map(e => e.assignedAt - e.createdAt);
    const avgResponseTimeMs = responseTimes.length
        ? Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length)
        : null;

    // Per-doctor and per-drone-operator call counts.
    const doctorCounts = {};
    const droneCounts = {};
    for (const entry of log) {
        if (entry.doctorUserId) {
            doctorCounts[entry.doctorUserId] = (doctorCounts[entry.doctorUserId] || 0) + 1;
        }
        if (entry.droneUserId) {
            droneCounts[entry.droneUserId] = (droneCounts[entry.droneUserId] || 0) + 1;
        }
    }
    const doctorUtilization = Object.entries(doctorCounts)
        .map(([userId, count]) => ({ userId, name: userName(userId), count }))
        .sort((a, b) => b.count - a.count);
    const droneUtilization = Object.entries(droneCounts)
        .map(([userId, count]) => ({ userId, name: userName(userId), count }))
        .sort((a, b) => b.count - a.count);

    res.json({
        totalCalls: log.length,
        callsByDay,
        avgResponseTimeMs,
        doctorUtilization,
        droneUtilization
    });
});

// --- Historical emergency request log, filterable for the admin panel ---
app.get('/api/admin/emergency-log', requireAdmin, async (req, res) => {
    const { from, to, doctorId, droneId } = req.query;
    let log = await db.loadEmergencyLog();

    if (from) {
        const fromMs = new Date(from).getTime();
        if (!Number.isNaN(fromMs)) log = log.filter(e => e.createdAt >= fromMs);
    }
    if (to) {
        const toMs = new Date(to).getTime();
        if (!Number.isNaN(toMs)) log = log.filter(e => e.createdAt <= toMs);
    }
    if (doctorId) log = log.filter(e => e.doctorUserId === doctorId);
    if (droneId) log = log.filter(e => e.droneUserId === droneId);

    log.sort((a, b) => b.createdAt - a.createdAt);
    res.json({ log });
});

// --- Admin audit trail, most recent first ---
app.get('/api/admin/audit-log', requireAdmin, async (req, res) => {
    const log = (await db.loadAuditLog()).sort((a, b) => b.timestamp - a.timestamp);
    res.json({ log });
});

app.get('/admin.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// Socket.io events
io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id} from ${socket.handshake.address}`);

    // Send all currently active connections and unassigned emergency
    // requests to a newly connected client (e.g. a doctor panel opening).
    socket.emit('currentConnectionStatus', Object.values(activeConnections));
    socket.emit('pendingRequestsUpdated', Object.values(pendingRequests));

    // Associates this socket with a logged-in userId, so the admin panel
    // can show accurate online status and so a doctor's acceptance can be
    // routed back to the exact drone socket that raised the request.
    socket.on('identify', ({ userId, role } = {}) => {
        if (!userId) return;
        socket.data.userId = userId;
        socket.data.role = role;
        onlineUsers.set(userId, { socketId: socket.id, role });
    });

    socket.on('join', (room) => {
        socket.join(room);
        console.log(`${socket.id} joined room: ${room}`);
    });

    // --- Handle Connection Updates from Clients ---
    // Generates a unique roomId per drone/doctor pairing so GPS data and
    // video calls for different pairs never cross over.
    socket.on('updateConnection', (connectionData, callback) => {
        const roomId = connectionData.roomId || uuidv4();
        const connection = { ...connectionData, roomId };
        activeConnections[roomId] = connection;
        console.log('Updated active connection:', connection);
        // Broadcast the updated connection list to all connected clients so
        // both sides of the pairing (and the portal page) learn the roomId.
        io.emit('currentConnectionStatus', Object.values(activeConnections));
        // Ack directly back to the caller with the assigned roomId, since
        // multiple pairs can be active at once and the caller needs to know
        // which one is theirs.
        if (typeof callback === 'function') {
            callback(connection);
        }
    });

    // --- Handle Connection Reset from Clients ---
    socket.on('resetConnection', async (roomId) => {
        if (roomId && activeConnections[roomId]) {
            delete activeConnections[roomId];
            // An assigned pairing being reset is how this system represents
            // a completed mission -- log it as such rather than letting the
            // record just vanish from memory.
            await db.updateEmergencyLogByRoom(roomId, ['assigned'], {
                status: 'completed',
                resolvedAt: Date.now()
            });
            console.log(`Connection ${roomId} reset by a client.`);
        } else {
            for (const id of Object.keys(activeConnections)) {
                await db.updateEmergencyLogByRoom(id, ['assigned'], { status: 'completed', resolvedAt: Date.now() });
            }
            activeConnections = {};
            console.log('All connections reset by a client.');
        }
        io.emit('currentConnectionStatus', Object.values(activeConnections));
    });

    // --- GPS Data Sync (scoped to the pairing's own room) ---
    socket.on('updateDroneData', (data) => {
        if (!data || !data.roomId) {
            return;
        }
        socket.to(data.roomId).emit('droneData', data);
    });

    // --- Doctor -> drone text message (scoped to the pairing's own room) ---
    // The drone side speaks this aloud via the browser's Speech Synthesis
    // API, same room-isolation pattern as the GPS relay above.
    socket.on('doctorMessage', (data) => {
        if (!data || !data.roomId || !data.text) {
            return;
        }
        socket.to(data.roomId).emit('doctorMessage', data);
    });

    // --- Emergency call queue: a drone raises a request, an available ---
    // --- doctor accepts it, rather than doctors self-selecting a call. ---
    socket.on('requestEmergency', async (data = {}) => {
        const roomId = uuidv4();
        const request = {
            roomId,
            droneUserId: data.droneUserId || null,
            operatorName: data.operatorName || 'Unknown Operator',
            location: data.location || null,
            socketId: socket.id,
            timestamp: Date.now()
        };
        pendingRequests[roomId] = request;
        // The requesting drone joins its own (future) room immediately so
        // it starts receiving anything sent to it as soon as it's assigned.
        socket.join(roomId);

        await db.appendEmergencyLog({
            id: uuidv4(),
            roomId,
            droneUserId: request.droneUserId,
            operatorName: request.operatorName,
            location: request.location,
            doctorUserId: null,
            doctorName: null,
            status: 'pending',
            createdAt: request.timestamp,
            assignedAt: null,
            resolvedAt: null
        });

        socket.emit('emergencyRequestCreated', { roomId });
        io.emit('pendingRequestsUpdated', Object.values(pendingRequests));
        console.log(`New emergency request ${roomId} from ${request.operatorName}`);
    });

    socket.on('cancelEmergencyRequest', async (roomId) => {
        if (pendingRequests[roomId] && pendingRequests[roomId].socketId === socket.id) {
            delete pendingRequests[roomId];
            await db.updateEmergencyLogByRoom(roomId, ['pending'], { status: 'cancelled', resolvedAt: Date.now() });
            io.emit('pendingRequestsUpdated', Object.values(pendingRequests));
        }
    });

    socket.on('acceptRequest', async ({ roomId, doctorUserId, doctorName } = {}, callback) => {
        const request = pendingRequests[roomId];
        if (!request) {
            if (typeof callback === 'function') {
                callback({ error: 'This request is no longer available.' });
            }
            return;
        }
        delete pendingRequests[roomId];

        const connection = {
            role: 'assigned',
            roomId,
            doctorName: doctorName || doctorUserId,
            doctorUserId,
            operatorName: request.operatorName,
            droneUserId: request.droneUserId
        };
        activeConnections[roomId] = connection;
        socket.join(roomId);

        await db.updateEmergencyLogByRoom(roomId, ['pending'], {
            status: 'assigned',
            doctorUserId: doctorUserId || null,
            doctorName: doctorName || doctorUserId || null,
            assignedAt: Date.now()
        });

        // Tell the specific drone that raised this request who was assigned,
        // and let everyone know the request list / connection list changed.
        io.to(request.socketId).emit('assignedDoctor', connection);
        io.emit('pendingRequestsUpdated', Object.values(pendingRequests));
        io.emit('currentConnectionStatus', Object.values(activeConnections));

        if (typeof callback === 'function') {
            callback({ connection });
        }
    });

    socket.on('disconnect', async () => {
        console.log(`User disconnected: ${socket.id}`);

        if (socket.data.userId) {
            onlineUsers.delete(socket.data.userId);
        }

        // Drop any pending emergency request this socket raised but nobody
        // accepted yet, so it doesn't linger forever on the doctor panel.
        let requestsChanged = false;
        for (const [roomId, request] of Object.entries(pendingRequests)) {
            if (request.socketId === socket.id) {
                delete pendingRequests[roomId];
                await db.updateEmergencyLogByRoom(roomId, ['pending'], { status: 'timed_out', resolvedAt: Date.now() });
                requestsChanged = true;
            }
        }
        if (requestsChanged) {
            io.emit('pendingRequestsUpdated', Object.values(pendingRequests));
        }
    });
});

const PORT = process.env.PORT || 8003;
// Render sets RENDER_EXTERNAL_URL to the service's actual live URL; fall
// back to the known deployment for local/other environments.
const PUBLIC_URL = process.env.RENDER_EXTERNAL_URL || 'https://trigun-smart-health-drone.onrender.com';

db.initSchema()
    .then(() => {
        // Listen on all network interfaces (0.0.0.0) to be accessible from other devices
        server.listen(PORT, '0.0.0.0', () => {
            console.log(`Server running on port: ${PORT}`);
            console.log(`Storage: ${db.isPersistent ? 'DATABASE_URL (persists across restarts/redeploys)' : 'local JSON files (NOT persisted across redeploys on platforms with an ephemeral filesystem -- set DATABASE_URL in production)'}`);
            console.log(`Drone interface: ${PUBLIC_URL}/drone.html`);
            console.log(`Doctor interface: ${PUBLIC_URL}/doctor.html`);
            console.log(`Main interface: ${PUBLIC_URL}/`);
        });
    })
    .catch(err => {
        console.error('Failed to initialize database schema:', err);
        process.exit(1);
    });
