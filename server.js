require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

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

// Socket.io events
io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id} from ${socket.handshake.address}`);

    // Send all currently active connections to a newly connected client
    socket.emit('currentConnectionStatus', Object.values(activeConnections));

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

    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
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
