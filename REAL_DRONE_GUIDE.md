# Connecting and Operating a Real Drone

This guide walks through connecting an actual physical drone (or any GPS
source) to the Ambulance Patrol Drone system, and how to operate the
drone.html interface once it's live. It complements
[`hardware-adapters/README.md`](hardware-adapters/README.md), which covers
the adapter scripts themselves in technical detail — read that one too
before wiring anything up.

> **None of the adapters in `hardware-adapters/` have been tested against
> real hardware.** They're best-effort starting points based on public
> protocol docs. Validate units (meters vs. millimeters, percent vs.
> voltage) against your actual hardware before trusting them in the field.

---

## 1. How "Real Drone Mode" works

By default, drone.html runs a **simulation** — the map shows a computer-generated
flight path. **Real Drone Mode** is a toggle on the same page that switches
the map over to live GPS data instead:

```
Your drone / GPS module
        │  (WiFi or a companion computer)
        ▼
POST /api/drone-telemetry   (server.js)
        │  (validated, then relayed over Socket.IO)
        ▼
drone.html's map, live
```

Nothing about doctor-assignment, video calls, or the rest of the app
changes — Real Drone Mode only swaps out where the drone's position on the
map comes from.

## 2. What you need

- A drone (or standalone GPS tracker) that can report its own latitude,
  longitude, and ideally altitude/heading/battery, on some kind of
  interval.
- A way to get that data to the internet as an HTTP POST request. Three
  starting points are provided:
  | Your hardware | Use this adapter |
  |---|---|
  | Flight controller speaking MAVLink (ArduPilot/PX4), via serial or UDP | `hardware-adapters/mavlink_adapter.py` |
  | DJI drone | `hardware-adapters/dji_adapter_template.py` (template only — see its comments, requires DJI Mobile SDK work) |
  | A standalone ESP32 + GPS module (no drone required to test with) | `hardware-adapters/esp32_gps_adapter/esp32_gps_adapter.ino` |
- A shared secret (any random string) that both the server and your
  adapter will use to authenticate telemetry — see step 3.
- Network reachability from wherever your adapter runs to the deployed
  server (or your local dev server, for bench testing).

## 3. Server-side setup (one-time)

The telemetry endpoint is locked down with an API key — it refuses every
request until this is configured, so nothing can inject fake positions
into a random drone's feed.

1. Pick a random, hard-to-guess string, e.g.:
   ```bash
   openssl rand -hex 24
   ```
2. Set it as an environment variable on the server:
   - **Local development**: add a line to your `.env` file:
     ```
     DRONE_TELEMETRY_API_KEY=<the string you generated>
     ```
   - **Render (production)**: Dashboard → your service → Environment →
     add `DRONE_TELEMETRY_API_KEY` with the same value, then redeploy.
3. Restart the server. You should NOT see any error about this — the
   endpoint just silently starts accepting requests carrying the matching
   `x-api-key` header.

Every adapter you run must be configured with this **exact same** key.
Mismatched or missing keys get a `401 Unauthorized` and no data reaches
the map — this is fail-closed by design, not a bug to work around.

## 4. Pick a Drone ID

Every operator/drone pairing on the map is identified by a `droneId`
string. This is arbitrary — pick something that uniquely identifies this
physical drone (e.g. `drone-1`, `kurnool-unit-a`). You'll enter this in
two places that must match exactly:
- The adapter's configuration (`DRONE_ID` in the Python scripts, or the
  equivalent constant in the `.ino` sketch).
- The **Drone ID** field in drone.html's Real Drone Mode panel (step 6).

If you leave the field in drone.html blank, it falls back to your logged-in
operator name — fine for solo testing, but an explicit shared ID is more
reliable once more than one drone is involved.

## 5. Configure and run an adapter

Pick the adapter matching your hardware from the table above, then follow
its own header comments for hardware-specific wiring/config. In broad
strokes, every adapter needs:

- The server's URL (e.g. `https://trigun-smart-health-drone.onrender.com`
  or `http://<your-computer's-IP>:8003` for local/same-network testing).
- The same `DRONE_TELEMETRY_API_KEY` you set in step 3.
- The same `droneId` you picked in step 4.

**Python adapters** (`mavlink_adapter.py`, and the DJI template once you've
filled it in):
```bash
pip install pymavlink requests   # mavlink_adapter.py's dependencies
python hardware-adapters/mavlink_adapter.py
```

**ESP32 sketch** (`esp32_gps_adapter.ino`): open it in the Arduino IDE or
PlatformIO, install the `TinyGPSPlus` library, edit the WiFi
SSID/password and the server URL/API key/droneId constants near the top,
then flash it to the board.

**Bench-test first.** Before connecting real flight hardware, run your
adapter against a local copy of the server (`npm start` in this repo) with
a throwaway API key, and confirm you see `200 {"ok":true}` responses and
telemetry appearing in drone.html (next step) before trusting it in the
air.

## 6. Operate the drone from drone.html

1. Log in to drone.html as an approved drone operator.
2. In the **DRONE MODE** panel (left sidebar), select **Real Drone Mode**.
   A "Drone ID" field and a status panel appear.
3. Enter the same Drone ID you configured in your adapter, if it isn't
   already correct.
4. Once your adapter starts sending telemetry, you'll see:
   - A **green "Live" badge** and a "last updated Ns ago" counter that
     keeps resetting — telemetry is flowing normally.
   - A **"No Signal" badge**, and the drone marker fading to partial
     opacity, if no telemetry has arrived in the last 10 seconds — check
     your adapter's own console output and network connectivity first.
   - Altitude, speed, and battery readouts, when your adapter sends them
     (any field it omits just shows `-`).
5. The drone marker on the map moves to the live GPS position as reports
   come in — no manual refresh needed.
6. Everything else works exactly as in simulation mode: the doctor can
   still assign/launch this operator, video calls and chat work the same
   way, and the emergency dispatch flow is unaffected — Real Drone Mode
   only changes where the marker's position comes from.
7. To go back to the simulation (e.g. between real flights, or if hardware
   isn't available), switch back to **Simulation Mode** in the same panel.
   This immediately stops listening for real telemetry and clears the
   "Real Drone" status panel.

### Multiple drones at once

Each operator's browser session only ever displays the Drone ID entered in
*their own* Real Drone Mode panel — telemetry is routed server-side into a
room scoped to that exact ID, so two operators running two different
drones (two different Drone IDs) never see each other's position data.

## 7. Troubleshooting

| Symptom | Likely cause |
|---|---|
| Adapter gets `401` from `/api/drone-telemetry` | `DRONE_TELEMETRY_API_KEY` isn't set on the server, or doesn't match what the adapter sends in `x-api-key`. |
| Adapter gets `400` | Check the response body — usually a missing `droneId`, or `lat`/`lng` outside valid ranges or not sent as numbers. |
| drone.html shows "No Signal" even though the adapter reports success | The Drone ID in drone.html doesn't exactly match the adapter's configured ID (case-sensitive). Re-check both. |
| Marker appears in the wrong place / jumps around | Check your GPS source's fix quality; for the ESP32 sketch specifically, a NEO-6M can take a couple of minutes outdoors to get an accurate fix on first power-up. |
| Altitude/speed/battery always show `-` | Your adapter isn't sending those optional fields — this is expected if your hardware doesn't provide them; only `lat`/`lng` are required. |
| Battery reads a strange number (e.g. voltage instead of percent) | Convert it to a 0–100 percentage on the adapter side before sending — the server stores whatever number it's given. |

## 8. Before any real flight

1. Bench-test end-to-end (adapter → server → drone.html) on the ground
   first, exactly as in step 5.
2. Confirm altitude units/reference match what's expected (meters).
3. Confirm battery is a 0–100 percentage, not raw voltage/mAh.
4. Have a manual/backup way to track and recover the drone — this system
   is a monitoring/dispatch UI, not a flight controller, and has no
   failsafe or return-to-home logic of its own.
