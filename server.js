require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { computeRoute } = require('./routing');

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

// --- User store (interim JSON-file store; replace with a real DB later) ---
const USERS_FILE = path.join(__dirname, 'users.json');

function loadUsers() {
    try {
        return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    } catch (err) {
        return [];
    }
}

function saveUsers(users) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// Public-safe view of a user (never expose the password hash)
function toPublicUser(user) {
    const { passwordHash, ...publicUser } = user;
    return publicUser;
}

// Serve static files
app.use(express.static(__dirname));
app.use(express.json());

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
    const {
        name, userId, email, phone, userType, password,
        specialization, license, clinic,
        city, village, state, country
    } = req.body || {};

    if (!name || !userId || !email || !phone || !userType || !password) {
        return res.status(400).json({ error: 'Missing required registration fields.' });
    }

    const users = loadUsers();
    if (users.some(u => u.userId === userId)) {
        return res.status(409).json({ error: 'User ID already taken. Please choose a different one.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const newUser = {
        name, userId, email, phone, userType, passwordHash,
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
    saveUsers(users);

    res.status(201).json({ user: toPublicUser(newUser) });
});

app.post('/api/login', async (req, res) => {
    const { userId, password } = req.body || {};
    if (!userId || !password) {
        return res.status(400).json({ error: 'User ID and password are required.' });
    }

    const users = loadUsers();
    const user = users.find(u => u.userId === userId);
    if (!user) {
        return res.status(401).json({ error: 'Invalid User ID or password.' });
    }

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) {
        return res.status(401).json({ error: 'Invalid User ID or password.' });
    }

    res.json({ user: toPublicUser(user) });
});

// List registered users (public fields only) so the UI can show real
// doctors/drone operators instead of a hardcoded list.
app.get('/api/users', (req, res) => {
    const { userType } = req.query;
    const users = loadUsers().map(toPublicUser);
    const filtered = userType ? users.filter(u => u.userType === userType) : users;
    res.json({ users: filtered });
});

// Convenience aliases over /api/users for populating doctor/drone dropdowns.
app.get('/api/doctors', (req, res) => {
    const users = loadUsers().map(toPublicUser).filter(u => u.userType === 'doctor');
    res.json({ users });
});

app.get('/api/drones', (req, res) => {
    const users = loadUsers().map(toPublicUser).filter(u => u.userType === 'drone_operator');
    res.json({ users });
});

// --- ZegoCloud Kit Token generation (server-side, production-safe) ---
// Implements the ZEGOCLOUD "Token04" scheme so appID/serverSecret never
// reach the browser. See ZEGOCLOUD server-assistant docs for the format.
const ZEGO_APP_ID = process.env.ZEGO_APP_ID ? Number(process.env.ZEGO_APP_ID) : null;
const ZEGO_SERVER_SECRET = process.env.ZEGO_SERVER_SECRET || null;

function makeRandomIv() {
    const chars = '0123456789abcdefghijklmnopqrstuvwxyz';
    let result = '';
    for (let i = 0; i < 16; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

function numTo64Bit(num) {
    const buf = Buffer.alloc(8);
    buf.writeBigInt64BE(BigInt(num));
    return buf;
}

function numTo16Bit(num) {
    const buf = Buffer.alloc(2);
    buf.writeInt16BE(num);
    return buf;
}

function aesEncrypt(plainText, key, iv) {
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    cipher.setAutoPadding(true);
    return Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
}

function generateZegoToken04(appId, userId, secret, effectiveTimeInSeconds, payload = '') {
    if (!appId || !userId || !secret || secret.length !== 32) {
        throw new Error('Invalid Zego token parameters: appId, userId and a 32-byte secret are required.');
    }

    const createTime = Math.floor(Date.now() / 1000);
    const tokenInfo = {
        app_id: appId,
        user_id: userId,
        nonce: Math.floor(Math.random() * 2147483647) - 1073741824,
        ctime: createTime,
        expire: createTime + effectiveTimeInSeconds,
        payload
    };

    const plainText = JSON.stringify(tokenInfo);
    const iv = makeRandomIv();
    const encrypted = aesEncrypt(plainText, secret, iv);

    const buf = Buffer.concat([
        numTo64Bit(tokenInfo.expire),
        numTo16Bit(iv.length),
        Buffer.from(iv),
        numTo16Bit(encrypted.length),
        encrypted
    ]);

    return '04' + buf.toString('base64');
}

app.post('/api/zego-token', (req, res) => {
    const { userId, roomId } = req.body || {};
    if (!userId) {
        return res.status(400).json({ error: 'userId is required.' });
    }
    if (!ZEGO_APP_ID || !ZEGO_SERVER_SECRET) {
        return res.status(500).json({
            error: 'Zego credentials are not configured on the server. Set ZEGO_APP_ID and ZEGO_SERVER_SECRET.'
        });
    }

    try {
        const token = generateZegoToken04(ZEGO_APP_ID, userId, ZEGO_SERVER_SECRET, 3600, roomId || '');
        res.json({ token, appId: ZEGO_APP_ID });
    } catch (err) {
        console.error('Zego token generation failed:', err.message);
        res.status(500).json({ error: 'Failed to generate video call token.' });
    }
});

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
        const overpassRes = await fetch('https://overpass-api.de/api/interpreter', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'data=' + encodeURIComponent(query)
        });
        if (!overpassRes.ok) {
            throw new Error(`Overpass API returned ${overpassRes.status}`);
        }
        const data = await overpassRes.json();
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

// --- Admin authentication (placeholder) ---
// A single shared admin credential via env vars, good enough to gate the
// admin panel for now. This is NOT a real role-based auth system: tokens
// are held in memory (lost on restart, not scoped per-admin-user) and
// there is only one admin account. Replace with proper per-admin accounts
// and persisted sessions before relying on this for real access control.
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || null;
const adminSessions = new Set();

function requireAdmin(req, res, next) {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token || !adminSessions.has(token)) {
        return res.status(401).json({ error: 'Admin authentication required.' });
    }
    next();
}

app.post('/api/admin/login', (req, res) => {
    if (!ADMIN_PASSWORD) {
        return res.status(500).json({
            error: 'Admin login is not configured. Set ADMIN_USERNAME and ADMIN_PASSWORD env vars on the server.'
        });
    }
    const { username, password } = req.body || {};
    if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Invalid admin credentials.' });
    }
    const token = uuidv4();
    adminSessions.add(token);
    res.json({ token });
});

app.post('/api/admin/logout', requireAdmin, (req, res) => {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.slice(7);
    adminSessions.delete(token);
    res.json({ success: true });
});

// Registered users annotated with live online/pairing status for the admin panel.
app.get('/api/admin/users', requireAdmin, (req, res) => {
    const users = loadUsers().map(u => {
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

// Active drone/doctor pairings and unassigned emergency requests, for the
// admin panel's real-time view.
app.get('/api/admin/connections', requireAdmin, (req, res) => {
    res.json({
        connections: Object.values(activeConnections),
        pendingRequests: Object.values(pendingRequests)
    });
});

app.delete('/api/admin/users/:userId', requireAdmin, (req, res) => {
    const users = loadUsers();
    const idx = users.findIndex(u => u.userId === req.params.userId);
    if (idx === -1) {
        return res.status(404).json({ error: 'User not found.' });
    }
    users.splice(idx, 1);
    saveUsers(users);

    const online = onlineUsers.get(req.params.userId);
    if (online) {
        const kickSocket = io.sockets.sockets.get(online.socketId);
        if (kickSocket) {
            kickSocket.emit('accountRemoved');
            kickSocket.disconnect(true);
        }
        onlineUsers.delete(req.params.userId);
    }

    res.json({ success: true });
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
    socket.on('resetConnection', (roomId) => {
        if (roomId && activeConnections[roomId]) {
            delete activeConnections[roomId];
            console.log(`Connection ${roomId} reset by a client.`);
        } else {
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

    // --- Emergency call queue: a drone raises a request, an available ---
    // --- doctor accepts it, rather than doctors self-selecting a call. ---
    socket.on('requestEmergency', (data = {}) => {
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

        socket.emit('emergencyRequestCreated', { roomId });
        io.emit('pendingRequestsUpdated', Object.values(pendingRequests));
        console.log(`New emergency request ${roomId} from ${request.operatorName}`);
    });

    socket.on('cancelEmergencyRequest', (roomId) => {
        if (pendingRequests[roomId] && pendingRequests[roomId].socketId === socket.id) {
            delete pendingRequests[roomId];
            io.emit('pendingRequestsUpdated', Object.values(pendingRequests));
        }
    });

    socket.on('acceptRequest', ({ roomId, doctorUserId, doctorName } = {}, callback) => {
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

        // Tell the specific drone that raised this request who was assigned,
        // and let everyone know the request list / connection list changed.
        io.to(request.socketId).emit('assignedDoctor', connection);
        io.emit('pendingRequestsUpdated', Object.values(pendingRequests));
        io.emit('currentConnectionStatus', Object.values(activeConnections));

        if (typeof callback === 'function') {
            callback({ connection });
        }
    });

    socket.on('disconnect', () => {
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
                requestsChanged = true;
            }
        }
        if (requestsChanged) {
            io.emit('pendingRequestsUpdated', Object.values(pendingRequests));
        }
    });
});

const PORT = process.env.PORT || 8003;
// Listen on all network interfaces (0.0.0.0) to be accessible from other devices
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port: ${PORT}`);
    console.log(`Drone interface: https://testfile6.onrender.com/drone.html`);
    console.log(`Doctor interface: https://testfile6.onrender.com/doctor.html`);
    console.log(`Main interface: https://testfile6.onrender.com/`);
});
