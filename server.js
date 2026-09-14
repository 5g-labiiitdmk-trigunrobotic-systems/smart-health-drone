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
const { queryOverpass } = require('./overpass');

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
// reach the browser. This is ZegoCloud's own reference implementation,
// vendored from their official zego_server_assistant repo (Node sample at
// token/nodejs/server/zegoServerAssistant.js) rather than hand-rolled --
// ZegoCloud does not publish this as an npm package, only as source to
// copy into your project. See https://docs.zegocloud.com and
// https://github.com/zegocloud/zego_server_assistant for the current docs.
const ZEGO_APP_ID = process.env.ZEGO_APP_ID ? Number(process.env.ZEGO_APP_ID) : null;
const ZEGO_SERVER_SECRET = process.env.ZEGO_SERVER_SECRET || null;

function zegoRandomInt(a, b) {
    return Math.ceil((a + (b - a)) * Math.random());
}

function zegoMakeRandomIv() {
    const chars = '0123456789abcdefghijklmnopqrstuvwxyz';
    const result = [];
    for (let i = 0; i < 16; i++) {
        result.push(chars.charAt(Math.floor(Math.random() * chars.length)));
    }
    return result.join('');
}

function zegoGetAlgorithm(keyBuf) {
    switch (keyBuf.length) {
        case 16: return 'aes-128-cbc';
        case 24: return 'aes-192-cbc';
        case 32: return 'aes-256-cbc';
        default: throw new Error('Invalid key length: ' + keyBuf.length);
    }
}

function zegoAesEncrypt(plainText, key, iv) {
    const cipher = crypto.createCipheriv(zegoGetAlgorithm(Buffer.from(key)), key, iv);
    cipher.setAutoPadding(true);
    return Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
}

function generateZegoToken04(appId, userId, secret, effectiveTimeInSeconds, payload = '') {
    if (!appId || typeof appId !== 'number') {
        throw new Error('Invalid Zego token parameters: appId must be a number.');
    }
    if (!userId || typeof userId !== 'string') {
        throw new Error('Invalid Zego token parameters: userId must be a string.');
    }
    if (!secret || typeof secret !== 'string' || secret.length !== 32) {
        throw new Error('Invalid Zego token parameters: secret must be a 32-byte string.');
    }
    if (!effectiveTimeInSeconds || typeof effectiveTimeInSeconds !== 'number') {
        throw new Error('Invalid Zego token parameters: effectiveTimeInSeconds must be a number.');
    }

    const createTime = Math.floor(Date.now() / 1000);
    const tokenInfo = {
        app_id: appId,
        user_id: userId,
        nonce: zegoRandomInt(-2147483648, 2147483647),
        ctime: createTime,
        expire: createTime + effectiveTimeInSeconds,
        payload: payload || ''
    };

    const plainText = JSON.stringify(tokenInfo);
    const iv = zegoMakeRandomIv();
    const encrypted = zegoAesEncrypt(plainText, secret, iv);

    const expireBuf = Buffer.alloc(8);
    expireBuf.writeBigInt64BE(BigInt(tokenInfo.expire));
    const ivLenBuf = Buffer.alloc(2);
    ivLenBuf.writeUInt16BE(iv.length);
    const encryptedLenBuf = Buffer.alloc(2);
    encryptedLenBuf.writeUInt16BE(encrypted.length);

    const buf = Buffer.concat([
        expireBuf,
        ivLenBuf,
        Buffer.from(iv),
        encryptedLenBuf,
        encrypted
    ]);

    return '04' + buf.toString('base64');
}

app.post('/api/zego-token', (req, res) => {
    const { userId, roomId, userName } = req.body || {};
    if (!userId) {
        return res.status(400).json({ error: 'userId is required.' });
    }
    if (!ZEGO_APP_ID || !ZEGO_SERVER_SECRET) {
        return res.status(500).json({
            error: 'Zego credentials are not configured on the server. Set ZEGO_APP_ID and ZEGO_SERVER_SECRET.'
        });
    }

    try {
        // ZegoUIKitPrebuilt requires the payload to be a JSON-encoded
        // privilege object (room_id + login/publish permissions), not a
        // bare room-id string.
        // See ZegoCloud's own zego_server_assistant sample-rtc-room.js.
        const payload = JSON.stringify({
            room_id: roomId || '',
            privilege: { 1: 1, 2: 1 }, // 1: loginRoom, 2: publishStream - both allowed
            stream_id_list: null
        });
        const rawToken = generateZegoToken04(ZEGO_APP_ID, userId, ZEGO_SERVER_SECRET, 3600, payload);

        // ZegoUIKitPrebuilt.create() does NOT accept a bare Token04 string --
        // it expects the special "kitToken" format its own
        // generateKitTokenForProduction() produces: `<token04>#<base64 JSON>`
        // where the JSON carries {userID, roomID, userName, appID}. Without
        // the '#' suffix the SDK's internal parser (which splits on '#')
        // silently fails with "kitToken error" and then crashes trying to
        // call .getVersion() on the engine instance it never created.
        const kitTokenSuffix = Buffer.from(JSON.stringify({
            userID: userId,
            roomID: roomId || '',
            userName: encodeURIComponent(userName || userId),
            appID: ZEGO_APP_ID
        })).toString('base64');
        const token = `${rawToken}#${kitTokenSuffix}`;

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
// Render sets RENDER_EXTERNAL_URL to the service's actual live URL; fall
// back to the known deployment for local/other environments.
const PUBLIC_URL = process.env.RENDER_EXTERNAL_URL || 'https://trigun-smart-health-drone.onrender.com';
// Listen on all network interfaces (0.0.0.0) to be accessible from other devices
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port: ${PORT}`);
    console.log(`Drone interface: ${PUBLIC_URL}/drone.html`);
    console.log(`Doctor interface: ${PUBLIC_URL}/doctor.html`);
    console.log(`Main interface: ${PUBLIC_URL}/`);
});
