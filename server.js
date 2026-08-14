require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

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
        origin: ["https://testfile6.onrender.com", "http://localhost:3000", "http://localhost:8080","https://drone-ztxx.onrender.com/"],
        // Allow all origins for multi-device testing
        methods: ["GET", "POST"],
        credentials: true,
        allowedHeaders: ["Content-Type", "Authorization"]
    }
});

// --- Centralized Connection State ---
let currentActiveConnection = null; // Stores the active drone-doctor connection

// Serve static files
app.use(express.static(__dirname));

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

// Socket.io events
io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id} from ${socket.handshake.address}`);

    // Send current active connection to newly connected client
    if (currentActiveConnection) {
        socket.emit('currentConnectionStatus', currentActiveConnection);
    }

    socket.on('join', (room) => {
        socket.join(room);
        console.log(`${socket.id} joined room: ${room}`);
    });

    // --- Handle Connection Updates from Clients ---
    socket.on('updateConnection', (connectionData) => {
        currentActiveConnection = connectionData;
        console.log('Updated active connection:', currentActiveConnection);
        // Broadcast the updated connection status to all connected clients
        io.emit('currentConnectionStatus', currentActiveConnection);
    });

    // --- Handle Connection Reset from Clients ---
    socket.on('resetConnection', () => {
        currentActiveConnection = null;
        console.log('Connection reset by a client.');
        // Broadcast the reset status to all connected clients
        io.emit('currentConnectionStatus', null);
    });

    // --- GPS Data Sync ---
    socket.on('updateDroneData', (data) => {
        socket.to('108').emit('droneData', data);
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
