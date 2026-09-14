**#Ambulance Patrol Drone System**
A comprehensive emergency medical response system that combines drone technology with real-time video streaming to provide faster emergency response and enable remote medical professionals to assess situations before the ambulance arrives.

**🚀 Features**
Real-time Drone Simulation: Interactive map interface for drone operators

Doctor Monitoring Interface: Real-time video feed and patient monitoring

Live GPS Tracking: Synchronized location data between drone and doctor interfaces

Video Conferencing: Integrated Daily.co video calls for emergency consultations

Traffic Navigation: Advanced routing algorithms for efficient emergency response

Multi-device Support: Accessible from multiple devices simultaneously

**🏥 System Architecture**
The system consists of three main components:

Main Portal (index.html): Landing page with connection management

Drone Interface (drone.html): Operator control panel with map and simulation

Doctor Interface (doctor.html): Medical professional monitoring dashboard

**🛠️ Technology Stack**
Frontend: HTML5, CSS3, JavaScript (ES6+)

Mapping: Leaflet.js with OpenStreetMap tiles

Real-time Communication: Socket.IO

Video Conferencing: Daily.co (daily-js)

Backend: Node.js, Express.js

Deployment: Render.com

**📋 Prerequisites**
Node.js (v14 or higher)

npm or yarn package manager

Modern web browser with WebRTC support

**🚀 Installation & Setup**
1.Clone the repository
bash
git clone <repository-url>
cd testfile6

2.Install dependencies
bash
npm install

3.Configure environment variables
Create a .env file in the root directory:
text
PORT=8003

4.Start the server
bash
npm start

5.Access the application

Main Portal: http://localhost:8003

Drone Interface: http://localhost:8003/drone.html

Doctor Interface: http://localhost:8003/doctor.html

**🌐 Network Access**
For multi-device testing, the server binds to all network interfaces. Other devices on the same network can access using your computer's IP address:

text
http://[YOUR-IP-ADDRESS]:8003

  **📱 Usage Instructions**
**For Drone Operators:**
Open the drone interface

Click "Get Current Location" to set your position

Select a hospital destination from the map

Deploy drone to clear traffic path

Initiate video call with connected doctor

**For Medical Professionals:**
Open the doctor interface

Monitor real-time drone location and ambulance position

Receive live video feed from the drone

Provide remote medical guidance

Communicate with emergency responders

**🔧 Configuration**
Socket.IO Server
The server is configured to allow connections from:

Render deployment domain

Local development environments

All network interfaces for multi-device testing

**🗂️ File Structure**
text
testfile6/
├── index.html          # Main portal with connection management
├── drone.html          # Drone operator interface
├── doctor.html         # Doctor monitoring interface
├── server.js           # Express + Socket.IO server
├── package.json        # Dependencies and scripts
├── .gitignore         # Git ignore rules
└── README.md          # This file

**🎮 Simulation Controls**
1.Drone Interface:
Traffic Density Slider: Adjust simulated traffic conditions

Drone Volume Control: Adjust alert volume

Ambulance Speed Control: Set emergency vehicle speed

Emergency Mode: Maximum priority clearance

Deploy Drone: Initiate drone operation

2.Map Features:
Ambulance marker with siren animation

Hospital locations in Kurnool area

Real-time routing with traffic considerations

Drone guidance system with visual path

3.🔌 API Endpoints
GET / - Serves main portal

GET /drone.html - Serves drone interface

GET /doctor.html - Serves doctor interface

4.📡 Real-time Events
Socket.IO Events:
join - Join specific room (e.g., '108')

updateConnection - Update drone-doctor connection status

resetConnection - Clear current connection

updateDroneData - Sync GPS coordinates between interfaces

droneData - Broadcast location data to connected clients

5.🚨 Emergency Features
108 Emergency Call simulation

Real-time traffic clearance alerts

Automated voice warnings for vehicles

Priority routing to nearest hospital

Live patient vitals monitoring (simulated)

**👥 Development Team**
Faculty Lead: Dr. K. Krishna Naik

Lead Developer: G. Kashifa Anjum

Institution: Indian Institute of Information Technology, Design and Manufacturing, Kurnool

Collaboration: 5G Labs, Trigun Robotics System Pvt Ltd

**📄 License**
This project is developed for academic and research purposes at IIITDM Kurnool.

**🔒 Security Notes**
The server includes CORS configuration for controlled access

Video conferencing uses test credentials (replace for production)

GPS data is simulated for demonstration purposes

**🚦 Status Indicators**
Green: Connected to server and active

Orange: Connecting or intermediate state

Red: Disconnected or error state

**This system is part of research initiatives at IIITDM Kurnool to explore the integration of drone technology in emergency medical services.**
