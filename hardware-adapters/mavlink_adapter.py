#!/usr/bin/env python3
"""
MAVLink -> smart-health-drone telemetry adapter.

UNTESTED AGAINST REAL HARDWARE. Written against pymavlink / MAVLink common
message documentation only, in an environment with no physical flight
controller available. Validate GLOBAL_POSITION_INT scaling, altitude
reference (relative_alt vs alt/MSL), heading units, and battery source
against your actual autopilot before flight use.

Reads position from GLOBAL_POSITION_INT and battery percentage from
BATTERY_STATUS (falling back to SYS_STATUS.battery_remaining) over a
serial or UDP MAVLink connection, then POSTs it to the server's
/api/drone-telemetry endpoint on a fixed interval.

Requires: pip install pymavlink requests

Examples:
    python3 mavlink_adapter.py --udp 127.0.0.1:14550 \\
        --server http://localhost:8003 --drone-id drone-1 \\
        --api-key mysecret --interval 1.5

    python3 mavlink_adapter.py --device /dev/ttyUSB0 --baud 57600 \\
        --server https://your-server.example.com --drone-id drone-1 \\
        --api-key mysecret
"""

import argparse
import sys
import time

try:
    from pymavlink import mavutil
except ImportError:
    mavutil = None

try:
    import requests
except ImportError:
    requests = None


def connect(args):
    """Open a MAVLink connection over serial or UDP, per the given CLI args."""
    if args.udp:
        conn_str = 'udpin:' + args.udp
    elif args.device:
        conn_str = args.device
    else:
        raise SystemExit('Specify either --udp HOST:PORT or --device /dev/ttyXXX')

    print(f'Connecting to MAVLink at {conn_str} ...')
    connection = mavutil.mavlink_connection(conn_str, baud=args.baud)
    connection.wait_heartbeat(timeout=30)
    print(f'Heartbeat received from system {connection.target_system}, '
          f'component {connection.target_component}')
    return connection


def read_latest_telemetry(connection, timeout=2.0):
    """
    Drain pending MAVLink messages for up to `timeout` seconds, keeping the
    most recent GLOBAL_POSITION_INT and battery reading seen. Returns a
    dict suitable for the /api/drone-telemetry payload, or None if no
    position update was seen in the window.
    """
    position = None
    battery_pct = None
    deadline = time.time() + timeout

    while time.time() < deadline:
        msg = connection.recv_match(blocking=True, timeout=0.5)
        if msg is None:
            continue
        msg_type = msg.get_type()

        if msg_type == 'GLOBAL_POSITION_INT':
            # lat/lon are in 1e7 degrees; alt/relative_alt are millimeters;
            # hdg is in centidegrees (0-35999), 65535 means unknown.
            position = {
                'lat': msg.lat / 1e7,
                'lng': msg.lon / 1e7,
                'altitude': msg.relative_alt / 1000.0,
                'heading': (msg.hdg / 100.0) if msg.hdg != 65535 else None,
                'speed': ((msg.vx ** 2 + msg.vy ** 2) ** 0.5) / 100.0 * 3.6
                         if hasattr(msg, 'vx') else None,  # cm/s -> km/h
            }
        elif msg_type == 'BATTERY_STATUS':
            if hasattr(msg, 'battery_remaining') and msg.battery_remaining >= 0:
                battery_pct = msg.battery_remaining
        elif msg_type == 'SYS_STATUS':
            if hasattr(msg, 'battery_remaining') and msg.battery_remaining >= 0:
                battery_pct = msg.battery_remaining

    if position is None:
        return None

    telemetry = dict(position)
    telemetry['battery'] = battery_pct
    return telemetry


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
    parser.add_argument('--device', help='Serial device, e.g. /dev/ttyUSB0 or COM3')
    parser.add_argument('--baud', type=int, default=57600, help='Serial baud rate (default 57600)')
    parser.add_argument('--udp', help='UDP host:port to listen on, e.g. 127.0.0.1:14550')
    parser.add_argument('--server', required=True, help='Base URL of the smart-health-drone server, e.g. http://localhost:8003')
    parser.add_argument('--drone-id', required=True, help='Drone ID to report as (must match drone.html Real Drone Mode input)')
    parser.add_argument('--api-key', required=True, help='Value matching the server\'s DRONE_TELEMETRY_API_KEY')
    parser.add_argument('--interval', type=float, default=1.5, help='Seconds between telemetry posts (default 1.5)')
    args = parser.parse_args()

    if mavutil is None:
        sys.exit('pymavlink is not installed. Run: pip install pymavlink')
    if requests is None:
        sys.exit('requests is not installed. Run: pip install requests')

    connection = connect(args)

    print(f'Streaming telemetry for droneId={args.drone_id} to {args.server} every {args.interval}s ...')
    try:
        while True:
            telemetry = read_latest_telemetry(connection, timeout=args.interval)
            if telemetry:
                post_telemetry(args.server, args.drone_id, args.api_key, telemetry)
            else:
                print('[info] no GLOBAL_POSITION_INT received in this interval')
    except KeyboardInterrupt:
        print('\nStopped.')


if __name__ == '__main__':
    main()
