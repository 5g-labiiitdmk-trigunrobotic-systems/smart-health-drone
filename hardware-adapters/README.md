# Hardware Adapters — Real Drone Telemetry

**IMPORTANT: NONE of the adapters in this directory have been tested against
real hardware.** They were written in a development environment with no
physical drone, flight controller, GPS module, or ESP32 board available.
They are best-effort implementations based on public protocol/SDK
documentation (MAVLink message definitions, DJI SDK docs, TinyGPSPlus /
ESP32 WiFi/HTTPClient docs). **Validate every field — especially altitude
units (meters vs millimeters), battery representation (percent vs voltage
vs remaining mAh), and coordinate scaling (MAVLink lat/lon are int32 in
1e7 degrees) — against your actual hardware before any real flight use.**
Treat all three scripts as a starting point to adapt, not drop-in
production code.

## What these adapters do

Each adapter reads live telemetry from a real drone / flight controller /
GPS module and forwards it to the smart-health-drone server's HTTP
endpoint, so the drone.html "Real Drone Mode" toggle can display live
position instead of the simulation.

## Generic POST format

All adapters POST JSON to:

```
POST /api/drone-telemetry
Content-Type: application/json
x-api-key: <DRONE_TELEMETRY_API_KEY>

{
  "droneId": "string, required — must match the Drone ID entered in drone.html's Real Drone Mode panel",
  "lat": -90..90, required,
  "lng": -180..180, required,
  "altitude": number, optional (meters),
  "heading": number, optional (degrees, 0-360),
  "speed": number, optional (km/h),
  "battery": number, optional (percent, 0-100),
  "timestamp": number, optional (unix ms; server fills in Date.now() if omitted)
}
```

A successful call returns `200 { "ok": true }`. Missing/invalid `x-api-key`
returns `401`. Invalid payload shape (missing droneId, lat/lng out of range
or not numbers) returns `400` with a message describing the problem.

## Required environment variable

The server must have `DRONE_TELEMETRY_API_KEY` set to a shared secret. Every
adapter must be configured with the exact same value in its `x-api-key`
header, or every request will be rejected with 401. If this env var is
unset on the server, the endpoint refuses all telemetry (fails closed).

## The three adapters

### `mavlink_adapter.py`
For flight controllers running ArduPilot/PX4 or anything else speaking
MAVLink, connected via a serial link or UDP. Uses `pymavlink` to read
`GLOBAL_POSITION_INT` (lat/lon/alt/heading) and battery status messages,
then POSTs to the server on an interval. Requires `pip install pymavlink
requests`.

### `dji_adapter_template.py`
A **template only**, not a working script. DJI drones do not expose a
simple local telemetry API from a desktop/server process — the DJI Mobile
SDK requires a native Android/iOS app and a DJI Developer account, and the
exact calls to obtain lat/lng/altitude/battery vary by SDK version and
drone model. This file sketches the HTTP POST logic and leaves
`get_dji_telemetry()` raising `NotImplementedError` with comments on where
real SDK integration would plug in. Expect to replace most of this file
with your own DJI SDK bridge (e.g. a small native app relaying telemetry
over a local socket to this script, or reimplementing the POST logic
directly inside the DJI app).

### `esp32_gps_adapter/esp32_gps_adapter.ino`
Arduino/C++ firmware for an ESP32 board wired to a NEO-6M (or similar) GPS
module, for a fully standalone tracker (no companion computer needed). Uses
`TinyGPSPlus` for NMEA parsing and `WiFi.h`/`HTTPClient` to POST telemetry
over WiFi. Requires the TinyGPSPlus library installed in the Arduino IDE /
PlatformIO. Battery reporting from this sketch is a placeholder (ESP32 has
no built-in flight-battery telemetry) — wire an actual voltage divider/ADC
or fuel gauge IC and adjust the code if you need real battery percentage.

## Before flying with any of this

1. Bench-test against a local copy of the server with a fake/low API key
   first, watching server logs and the drone.html Real Drone Mode panel.
2. Confirm altitude units and reference (AGL vs MSL) match what drone.html
   expects (meters).
3. Confirm battery is being sent as a 0-100 percentage, not raw voltage or
   mAh remaining — convert on the adapter side if your source data differs.
4. Add your own retry/backoff and error handling suited to your network
   conditions; the adapters here use minimal, best-effort error handling.
