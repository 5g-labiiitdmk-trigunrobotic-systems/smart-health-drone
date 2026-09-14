#!/usr/bin/env python3
"""
DJI drone -> smart-health-drone telemetry adapter -- TEMPLATE ONLY.

*** THIS FILE IS NOT A WORKING SCRIPT. IT IS A TEMPLATE / SKETCH. ***

Unlike MAVLink-based flight controllers, DJI consumer/enterprise drones do
not expose telemetry over a simple serial/UDP link that a desktop Python
process can read directly. Getting live lat/lng/altitude/battery off a DJI
drone normally requires:

  1. A DJI Developer account (https://developer.dji.com/) and an app key
     registered for the specific SDK you use.
  2. Integrating the DJI Mobile SDK (Android/iOS, Java/Kotlin/Swift/ObjC)
     or DJI Windows SDK / Onboard SDK, depending on drone model -- there is
     no official pure-Python SDK.
  3. Building a native mobile app (or using DJI Pilot's plugin
     capabilities) that receives `FlightController` telemetry callbacks
     (e.g. `FlightControllerState.getAircraftLocation()`,
     `.getAltitude()`, and `BatteryState.getChargeRemainingInPercent()` on
     Android; equivalent classes on iOS) and forwards them onward -- e.g.
     over a local HTTP/WebSocket bridge to a script like this one, or by
     POSTing directly to /api/drone-telemetry from the native app itself.

Exact class/method names, units, and behavior vary by DJI SDK major
version and drone model (Mavic, Phantom, Matrice, etc.) -- consult the
DJI SDK docs for your specific hardware before implementing
`get_dji_telemetry()` below.

This file only sketches the POST-to-server logic (identical to the other
adapters) and leaves the DJI-specific telemetry retrieval as a stub you
must implement, most likely by replacing this stub with a client that
talks to your own native-app bridge rather than doing the SDK calls in
Python directly.

Requires: pip install requests
"""

import argparse
import sys
import time

try:
    import requests
except ImportError:
    requests = None


def get_dji_telemetry():
    """
    Placeholder for real DJI telemetry retrieval.

    In a real integration this would NOT run pure DJI SDK calls in Python
    (the SDK is native Android/iOS/Windows) -- it would instead read from
    whatever bridge you built between your native DJI app and this script,
    e.g.:

        - A local HTTP endpoint your native app POSTs to, which this
          script polls or subscribes to.
        - A local WebSocket / TCP socket your native app pushes telemetry
          frames over.
        - A shared file / message queue updated by the native app.

    Expected return shape once implemented, matching /api/drone-telemetry:

        {
            "lat": float,        # degrees
            "lng": float,        # degrees
            "altitude": float,   # meters, optional
            "heading": float,    # degrees 0-360, optional
            "speed": float,      # km/h, optional
            "battery": float,    # percent 0-100, optional
        }
    """
    raise NotImplementedError(
        'get_dji_telemetry() is a template stub. Replace this with a call '
        'into your DJI Mobile SDK bridge -- see module docstring above.'
    )


def post_telemetry(server, drone_id, api_key, telemetry, timeout=5):
    payload = {
        'droneId': drone_id,
        'lat': telemetry['lat'],
        'lng': telemetry['lng'],
    }
    for field in ('altitude', 'heading', 'speed', 'battery'):
        if telemetry.get(field) is not None:
            payload[field] = telemetry[field]

    url = server.rstrip('/') + '/api/drone-telemetry'
    try:
        resp = requests.post(url, json=payload, headers={'x-api-key': api_key}, timeout=timeout)
        if resp.status_code != 200:
            print(f'[warn] server rejected telemetry ({resp.status_code}): {resp.text}')
        return resp.status_code == 200
    except requests.RequestException as exc:
        print(f'[warn] failed to POST telemetry: {exc}')
        return False


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--server', required=True, help='Base URL of the smart-health-drone server, e.g. http://localhost:8003')
    parser.add_argument('--drone-id', required=True, help='Drone ID to report as (must match drone.html Real Drone Mode input)')
    parser.add_argument('--api-key', required=True, help='Value matching the server\'s DRONE_TELEMETRY_API_KEY')
    parser.add_argument('--interval', type=float, default=1.5, help='Seconds between telemetry posts (default 1.5)')
    args = parser.parse_args()

    if requests is None:
        sys.exit('requests is not installed. Run: pip install requests')

    print('*** dji_adapter_template.py is a TEMPLATE, not a working adapter. ***')
    print('Implement get_dji_telemetry() before running this for real -- see module docstring.')

    try:
        while True:
            telemetry = get_dji_telemetry()  # will raise NotImplementedError until filled in
            post_telemetry(args.server, args.drone_id, args.api_key, telemetry)
            time.sleep(args.interval)
    except KeyboardInterrupt:
        print('\nStopped.')


if __name__ == '__main__':
    main()
