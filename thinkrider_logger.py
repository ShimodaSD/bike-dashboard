#!/usr/bin/env python3
"""
thinkrider_logger.py - capture ALL Bluetooth LE data from a ThinkRider X2Max
(or any BLE smart trainer) and show a LIVE training dashboard in your browser.

What it does
  1. Scans for the trainer (by name or MAC/UUID address) and connects.
  2. Dumps the full GATT table + every readable value      -> gatt_dump.json
  3. Subscribes to EVERY notify/indicate characteristic (incl. proprietary).
  4. Logs every packet as raw hex                          -> raw_packets.csv
  5. Decodes FTMS / Cycling Power / CSC / Heart Rate       -> decoded.csv
  6. Builds a 1-second training timeline                   -> session_1hz.csv
     and a FIT activity for Strava / Garmin Connect     -> ride_<date>_<time>.fit
     Heart rate can come from a 2nd BLE device (Garmin watch broadcasting HR).
  7. Serves a live dashboard at http://localhost:8000  (power, cadence, speed,
     HR, zones, NP/TSS, laps, live charts). Reconnects automatically if the
     trainer drops. Passive: never writes to the trainer.

Requirements
  uv (https://docs.astral.sh/uv/) - `uv run` installs bleak from pyproject.toml.
  dashboard.html must sit in the same folder as this script.

Usage
  uv run thinkrider_logger.py                 # find trainer, log + dashboard
  uv run thinkrider_logger.py --demo          # fake ride, to try the dashboard
  uv run thinkrider_logger.py --scan          # list nearby BLE devices
  uv run thinkrider_logger.py --host 0.0.0.0  # open dashboard from a phone/tablet
                                              # on the same Wi-Fi: http://<PC-IP>:8000
  uv run thinkrider_logger.py --hr-name forerunner   # pick the HR watch/strap
  uv run thinkrider_logger.py --autostart     # record without pressing Start
  uv run thinkrider_logger.py --fit-from x2max_...   # rebuild ride.fit from a CSV
  Other options: --name X2MAX  --address AA:BB:..  --port 8000  --out ride1
                 --duration 3600  --no-browser  --hr-address ..  --no-hr

Heart rate from a watch: on a Garmin Forerunner 165 turn on Broadcast Heart
Rate (hold UP > Settings > Sensors & Accessories > Wrist Heart Rate >
Broadcast Heart Rate, or add the Broadcast Heart Rate control to the controls
menu). The logger connects to it as a second Bluetooth device and keeps
reconnecting if it drops.

Press Start on the dashboard to begin recording and Finish to end the ride:
Finish saves ride_<date>_<time>.fit, which you can download from the dashboard
and upload to Strava (strava.com/upload/select) or Garmin Connect (Import Data).
Ctrl+C during a ride also saves it.

IMPORTANT: a trainer usually accepts only ONE Bluetooth connection.
Close Zwift / ThinkRider app / MyWhoosh etc. (or use them over ANT+).
"""

import argparse
import asyncio
import csv
import json
import os
import random
import struct
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from datetime import datetime, timezone

try:
    from bleak import BleakClient, BleakScanner
except ImportError:                       # --demo works without bleak
    BleakClient = BleakScanner = None


# --------------------------------------------------------------------------
# Known UUID names (Bluetooth SIG 16-bit UUIDs)
# --------------------------------------------------------------------------
def u16(x: int) -> str:
    return f"0000{x:04x}-0000-1000-8000-00805f9b34fb"


NAMES = {
    u16(0x1826): "Fitness Machine Service (FTMS)",
    u16(0x1818): "Cycling Power Service",
    u16(0x1816): "Cycling Speed and Cadence Service",
    u16(0x180D): "Heart Rate Service",
    u16(0x180A): "Device Information Service",
    u16(0x180F): "Battery Service",
    u16(0x1800): "Generic Access",
    u16(0x1801): "Generic Attribute",
    u16(0x2ACC): "Fitness Machine Feature",
    u16(0x2AD2): "Indoor Bike Data",
    u16(0x2AD3): "Training Status",
    u16(0x2AD4): "Supported Speed Range",
    u16(0x2AD5): "Supported Inclination Range",
    u16(0x2AD6): "Supported Resistance Level Range",
    u16(0x2AD8): "Supported Power Range",
    u16(0x2AD9): "Fitness Machine Control Point",
    u16(0x2ADA): "Fitness Machine Status",
    u16(0x2A63): "Cycling Power Measurement",
    u16(0x2A65): "Cycling Power Feature",
    u16(0x2A5D): "Sensor Location",
    u16(0x2A66): "Cycling Power Control Point",
    u16(0x2A5B): "CSC Measurement",
    u16(0x2A5C): "CSC Feature",
    u16(0x2A37): "Heart Rate Measurement",
    u16(0x2A19): "Battery Level",
    u16(0x2A29): "Manufacturer Name",
    u16(0x2A24): "Model Number",
    u16(0x2A25): "Serial Number",
    u16(0x2A26): "Firmware Revision",
    u16(0x2A27): "Hardware Revision",
    u16(0x2A28): "Software Revision",
    u16(0x2A00): "Device Name",
}


def uuid_name(uuid: str) -> str:
    return NAMES.get(uuid.lower(), "Unknown/Proprietary")


# --------------------------------------------------------------------------
# Small byte reader
# --------------------------------------------------------------------------
class Reader:
    def __init__(self, data: bytes):
        self.d = bytes(data)
        self.i = 0

    def _take(self, fmt: str, n: int):
        if self.i + n > len(self.d):
            raise ValueError("packet too short")
        v = struct.unpack_from("<" + fmt, self.d, self.i)[0]
        self.i += n
        return v

    def u8(self):  return self._take("B", 1)
    def s8(self):  return self._take("b", 1)
    def u16(self): return self._take("H", 2)
    def s16(self): return self._take("h", 2)
    def u32(self): return self._take("I", 4)

    def u24(self):
        if self.i + 3 > len(self.d):
            raise ValueError("packet too short")
        v = int.from_bytes(self.d[self.i:self.i + 3], "little")
        self.i += 3
        return v


# --------------------------------------------------------------------------
# Decoders
# --------------------------------------------------------------------------
def decode_indoor_bike_data(data: bytes) -> dict:
    r = Reader(data)
    f = r.u16()
    out = {}
    if not f & 0x0001:            # bit0 = "More Data"; 0 means speed present
        out["speed_kmh"] = r.u16() / 100
    if f & 0x0002: out["avg_speed_kmh"] = r.u16() / 100
    if f & 0x0004: out["cadence_rpm"] = r.u16() / 2
    if f & 0x0008: out["avg_cadence_rpm"] = r.u16() / 2
    if f & 0x0010: out["total_distance_m"] = r.u24()
    if f & 0x0020: out["resistance_level"] = r.s16()
    if f & 0x0040: out["power_w"] = r.s16()
    if f & 0x0080: out["avg_power_w"] = r.s16()
    if f & 0x0100:
        out["total_energy_kcal"] = r.u16()
        out["energy_per_hour_kcal"] = r.u16()
        out["energy_per_min_kcal"] = r.u8()
    if f & 0x0200: out["heart_rate_bpm"] = r.u8()
    if f & 0x0400: out["met"] = r.u8() / 10
    if f & 0x0800: out["elapsed_time_s"] = r.u16()
    if f & 0x1000: out["remaining_time_s"] = r.u16()
    return out


class CadenceCalc:
    """Derive rpm from cumulative revolutions + event time."""

    def __init__(self, time_res: float, rev_max: int):
        self.prev = None
        self.res = time_res
        self.rev_max = rev_max

    def update(self, revs: int, evt: int):
        rpm = None
        if self.prev:
            pr, pe = self.prev
            dr = (revs - pr) % self.rev_max
            de = (evt - pe) % 65536
            if de > 0:
                rpm = dr / (de / self.res) * 60
            elif dr == 0:
                rpm = None  # no new event; keep previous value upstream
        self.prev = (revs, evt)
        return rpm


cps_crank = CadenceCalc(1024, 65536)
cps_wheel = CadenceCalc(2048, 2 ** 32)
csc_crank = CadenceCalc(1024, 65536)
csc_wheel = CadenceCalc(1024, 2 ** 32)


def decode_cycling_power(data: bytes) -> dict:
    r = Reader(data)
    f = r.u16()
    out = {"power_w": r.s16()}
    if f & 0x0001: out["pedal_balance_pct"] = r.u8() / 2
    if f & 0x0004: out["accumulated_torque_nm"] = r.u16() / 32
    if f & 0x0010:
        revs, evt = r.u32(), r.u16()
        out["wheel_revs"] = revs
        out["wheel_event_time"] = evt
        rpm = cps_wheel.update(revs, evt)
        if rpm is not None:
            out["wheel_rpm"] = round(rpm, 1)
    if f & 0x0020:
        revs, evt = r.u16(), r.u16()
        out["crank_revs"] = revs
        out["crank_event_time"] = evt
        rpm = cps_crank.update(revs, evt)
        if rpm is not None:
            out["cadence_rpm"] = round(rpm, 1)
    if f & 0x0040:
        out["max_force_n"] = r.s16()
        out["min_force_n"] = r.s16()
    if f & 0x0080:
        out["max_torque_nm"] = r.s16() / 32
        out["min_torque_nm"] = r.s16() / 32
    if f & 0x0100:
        v = r.u24()
        out["max_angle_deg"] = v & 0xFFF
        out["min_angle_deg"] = v >> 12
    if f & 0x0200: out["top_dead_spot_deg"] = r.u16()
    if f & 0x0400: out["bottom_dead_spot_deg"] = r.u16()
    if f & 0x0800: out["accumulated_energy_kj"] = r.u16()
    return out


def decode_csc(data: bytes) -> dict:
    r = Reader(data)
    f = r.u8()
    out = {}
    if f & 0x01:
        revs, evt = r.u32(), r.u16()
        out["wheel_revs"] = revs
        out["wheel_event_time"] = evt
        rpm = csc_wheel.update(revs, evt)
        if rpm is not None:
            out["wheel_rpm"] = round(rpm, 1)
    if f & 0x02:
        revs, evt = r.u16(), r.u16()
        out["crank_revs"] = revs
        out["crank_event_time"] = evt
        rpm = csc_crank.update(revs, evt)
        if rpm is not None:
            out["cadence_rpm"] = round(rpm, 1)
    return out


def decode_hr(data: bytes) -> dict:
    r = Reader(data)
    f = r.u8()
    return {"heart_rate_bpm": r.u16() if f & 1 else r.u8()}


FTMS_STATUS = {
    0x01: "reset", 0x02: "stopped/paused by user", 0x03: "stopped by safety key",
    0x04: "started/resumed by user", 0x05: "target speed changed",
    0x06: "target incline changed", 0x07: "target resistance changed",
    0x08: "target power changed", 0x12: "indoor bike simulation params changed",
    0x13: "wheel circumference changed", 0x14: "spin down status",
    0xFF: "control permission lost",
}


def decode_ftms_status(data: bytes) -> dict:
    out = {"status_opcode": data[0], "status": FTMS_STATUS.get(data[0], "unknown")}
    p = data[1:]
    if data[0] == 0x07 and len(p) >= 1:
        out["target_resistance"] = p[0] / 10
    elif data[0] == 0x08 and len(p) >= 2:
        out["target_power_w"] = struct.unpack_from("<h", p)[0]
    elif data[0] == 0x12 and len(p) >= 6:
        wind, grade = struct.unpack_from("<hh", p)
        out["wind_speed_ms"] = wind / 1000
        out["grade_pct"] = grade / 100
        out["crr"] = p[4] / 10000
        out["cw_kg_m"] = p[5] / 100
    return out


def decode_training_status(data: bytes) -> dict:
    return {"training_status": data[1] if len(data) > 1 else None}


def decode_supported_range(data: bytes, scale: float, signed=True) -> dict:
    fmt = "<hhH" if signed else "<HHH"
    lo, hi, step = struct.unpack_from(fmt, data)
    return {"min": lo * scale, "max": hi * scale, "step": step * scale}


DECODERS = {
    u16(0x2AD2): decode_indoor_bike_data,
    u16(0x2A63): decode_cycling_power,
    u16(0x2A5B): decode_csc,
    u16(0x2A37): decode_hr,
    u16(0x2ADA): decode_ftms_status,
    u16(0x2AD3): decode_training_status,
}

DECODED_FIELDS = [
    "timestamp_utc", "elapsed_s", "source",
    "speed_kmh", "avg_speed_kmh", "cadence_rpm", "avg_cadence_rpm",
    "power_w", "avg_power_w", "total_distance_m", "resistance_level",
    "heart_rate_bpm", "total_energy_kcal", "energy_per_hour_kcal",
    "energy_per_min_kcal", "met", "elapsed_time_s", "remaining_time_s",
    "pedal_balance_pct", "accumulated_torque_nm", "accumulated_energy_kj",
    "wheel_revs", "wheel_event_time", "wheel_rpm",
    "crank_revs", "crank_event_time",
    "max_force_n", "min_force_n", "max_torque_nm", "min_torque_nm",
    "max_angle_deg", "min_angle_deg", "top_dead_spot_deg", "bottom_dead_spot_deg",
    "status_opcode", "status", "target_resistance", "target_power_w",
    "wind_speed_ms", "grade_pct", "crr", "cw_kg_m", "training_status",
]


# --------------------------------------------------------------------------
# Live state shared between Bluetooth, the 1 Hz timeline and the dashboard
# --------------------------------------------------------------------------
SESSION_FIELDS = ["t", "timestamp_utc", "lap", "power_w", "cadence_rpm",
                  "speed_kmh", "heart_rate_bpm", "distance_m", "energy_kj"]


class Live:
    def __init__(self, out_dir):
        self.vals = {}                 # field -> (value, monotonic time)
        self.history = []              # 1 Hz samples
        self.laps = [0]                # history index where each lap starts
        self.clients = set()           # asyncio.Queue per dashboard tab
        self.status = {"state": "starting", "connected": False, "device": None,
                       "hr": {"state": "off", "device": None},
                       "ride": {"state": "ready", "n": 0, "fit": None}}
        self.trainer_address = None
        self.distance_m = 0.0
        self.energy_kj = 0.0
        self.packets = 0
        self.out_dir = out_dir
        self.sess_f = self.sess_w = None
        self.ride_start = None
        self.strava = None
        self.port = 8000
        self.fit_path = None

    # -- ride control (Start / Finish buttons) ------------------------------
    @property
    def recording(self):
        return self.status["ride"]["state"] == "recording"

    def start_ride(self):
        if self.recording:
            return
        n = self.status["ride"]["n"] + 1
        self.history, self.laps = [], [0]
        self.distance_m = self.energy_kj = 0.0
        self.ride_start = datetime.now()
        self.fit_path = None
        name = "session_1hz.csv" if n == 1 else f"session_1hz_{n}.csv"
        self.sess_f = open(os.path.join(self.out_dir, name), "w", newline="")
        self.sess_w = csv.DictWriter(self.sess_f, fieldnames=SESSION_FIELDS)
        self.sess_w.writeheader()
        self.status["ride"] = {"state": "recording", "n": n, "fit": None}
        if self.strava:
            self.strava.upload = {"state": None}
            self.status["strava"] = self.strava.public()
        print(f"Ride {n} started")
        self.broadcast("init", {"history": [], "laps": self.laps, "status": self.status})

    def finish_ride(self):
        """Stop recording and save the .FIT. Returns its path (None if empty)."""
        if not self.recording:
            return self.fit_path
        self.sess_f.close()
        self.sess_f = None
        path = os.path.join(self.out_dir, self.ride_start.strftime("ride_%Y%m%d_%H%M%S.fit"))
        self.fit_path = path if write_fit(path, self.history, self.laps) else None
        self.status["ride"] = {**self.status["ride"], "state": "finished",
                               "fit": self.fit_path and os.path.basename(self.fit_path)}
        n = len(self.history)
        print(f"Ride {self.status['ride']['n']} finished: {n // 60}:{n % 60:02d}"
              + (f" - saved {self.fit_path}" if self.fit_path else " - nothing recorded"))
        self.broadcast("status", self.status)
        return self.fit_path

    # -- inputs ------------------------------------------------------------
    def update(self, row: dict):
        now = time.monotonic()
        for k in ("power_w", "cadence_rpm", "speed_kmh", "heart_rate_bpm"):
            v = row.get(k)
            if v is None or (k == "heart_rate_bpm" and v <= 0):
                continue                     # FTMS sends HR 0 when no strap is paired
            self.vals[k] = (v, now)

    def update_hr(self, bpm):
        """Heart rate from a dedicated HR device (watch / strap): beats trainer HR."""
        if bpm and bpm > 0:
            self.vals["hr_device"] = (bpm, time.monotonic())

    def _get(self, k, max_age):
        v = self.vals.get(k)
        if v and time.monotonic() - v[1] <= max_age:
            return v[0]
        return None

    def set_status(self, **kw):
        self.status.update(kw)
        self.broadcast("status", self.status)

    def set_hr_status(self, **kw):
        self.status["hr"] = {**self.status["hr"], **kw}
        self.broadcast("status", self.status)

    def add_lap(self):
        if self.recording and len(self.history) > self.laps[-1]:
            self.laps.append(len(self.history))
            self.broadcast("laps", self.laps)

    # -- 1 Hz timeline -----------------------------------------------------
    def tick(self):
        if not self.status.get("connected"):
            return                                  # paused while disconnected
        power = self._get("power_w", 3) or 0
        cad = self._get("cadence_rpm", 3) or 0
        spd = self._get("speed_kmh", 3)
        hr = self._get("hr_device", 5)
        if hr is None:
            hr = self._get("heart_rate_bpm", 10)
        spd = 0 if spd is None and ("speed_kmh" in self.vals) else spd
        if not self.recording:                      # before Start / after Finish:
            self.broadcast("preview", {             # live numbers only, not saved
                "power_w": round(power), "cadence_rpm": round(cad),
                "speed_kmh": None if spd is None else round(spd, 2),
                "heart_rate_bpm": None if hr is None else round(hr)})
            return
        self.distance_m += (spd or 0) / 3.6
        self.energy_kj += max(power, 0) / 1000
        s = {
            "t": len(self.history),
            "timestamp_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "lap": len(self.laps),
            "power_w": round(power),
            "cadence_rpm": round(cad),
            "speed_kmh": None if spd is None else round(spd, 2),
            "heart_rate_bpm": None if hr is None else round(hr),
            "distance_m": round(self.distance_m, 1),
            "energy_kj": round(self.energy_kj, 2),
        }
        self.history.append(s)
        self.sess_w.writerow(s)
        self.sess_f.flush()
        self.broadcast("sample", s)
        return s

    # -- push to browsers --------------------------------------------------
    def broadcast(self, event, data):
        msg = f"event: {event}\ndata: {json.dumps(data)}\n\n".encode()
        for q in list(self.clients):
            try:
                q.put_nowait(msg)
            except asyncio.QueueFull:
                pass

    def close(self):
        if self.sess_f:
            self.sess_f.close()


async def ticker(live: Live, duration: float):
    start = nxt = time.monotonic()
    while True:
        nxt += 1
        now = time.monotonic()
        if nxt < now - 1:                 # fell far behind (laptop slept): resync
            nxt = now + 1
        await asyncio.sleep(max(0.0, nxt - now))
        live.tick()
        if duration and time.monotonic() - start >= duration:
            return


# --------------------------------------------------------------------------
# Tiny dependency-free web server (dashboard page + Server-Sent Events)
# --------------------------------------------------------------------------
HTML_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dashboard.html")


async def handle_http(reader, writer, live: Live):
    q = None
    try:
        line = (await reader.readline()).decode("latin-1").split()
        method, path = (line[0], line[1]) if len(line) >= 2 else ("GET", "/")
        while (await reader.readline()) not in (b"\r\n", b"\n", b""):
            pass
        path, _, query = path.partition("?")
        params = dict(urllib.parse.parse_qsl(query))
        strava = live.strava

        if path == "/events":
            writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n"
                         b"Cache-Control: no-cache\r\nConnection: keep-alive\r\n\r\n")
            init = {"history": live.history, "laps": live.laps, "status": live.status}
            writer.write(f"event: init\ndata: {json.dumps(init)}\n\n".encode())
            await writer.drain()
            q = asyncio.Queue(maxsize=600)
            live.clients.add(q)
            while True:
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=15)
                except asyncio.TimeoutError:
                    msg = b": keep-alive\n\n"
                writer.write(msg)
                await writer.drain()

        extra = ""
        if path == "/lap" and method == "POST":
            live.add_lap()
            body, ctype, code = b"ok", "text/plain", "200 OK"
        elif path == "/strava/connect":
            if strava.creds():
                code, extra = "302 Found", f"Location: {strava.authorize_url(live.port)}\r\n"
                body, ctype = b"", "text/plain"
            else:
                body, ctype, code = (b"Strava is not set up yet. In a terminal run:\n\n"
                                     b"  uv run thinkrider_logger.py --strava-setup\n\n"
                                     b"then come back and click Connect to Strava again."), "text/plain", "200 OK"
        elif path == "/strava/callback":
            msg = "connected"
            if "code" in params and "activity:write" in params.get("scope", ""):
                try:
                    await asyncio.to_thread(strava.exchange_code, params["code"])
                    print("Connected to Strava")
                except Exception as e:
                    msg = f"error: {e}"
            else:
                msg = "error: " + params.get("error", "upload permission was not granted")
            strava.push()
            code, body, ctype = "302 Found", b"", "text/plain"
            extra = f"Location: /?strava={urllib.parse.quote(msg)}\r\n"
        elif path == "/strava/disconnect" and method == "POST":
            strava.disconnect(); strava.push()
            body, ctype, code = b"ok", "text/plain", "200 OK"
        elif path == "/strava/upload" and method == "POST":
            asyncio.ensure_future(strava.upload_last_ride())
            body, ctype, code = b"ok", "text/plain", "200 OK"
        elif path in ("/start", "/finish") and method == "POST":
            live.start_ride() if path == "/start" else live.finish_ride()
            body, ctype, code = b"ok", "text/plain", "200 OK"
        elif path == "/ride.fit":
            try:
                if live.fit_path and not live.recording:     # the saved file
                    with open(live.fit_path, "rb") as fh:
                        body = fh.read()
                    name = os.path.basename(live.fit_path)
                else:                                         # ride so far
                    body = build_fit(live.history, live.laps)
                    name = (live.ride_start or datetime.now()).strftime("ride_%Y%m%d_%H%M%S.fit")
                ctype, code = "application/vnd.ant.fit", "200 OK"
                extra = f'Content-Disposition: attachment; filename="{name}"\r\n'
            except (ValueError, OSError):
                body, ctype, code = b"no ride recorded yet", "text/plain", "409 Conflict"
        elif path in ("/", "/index.html"):
            try:
                with open(HTML_PATH, "rb") as f:
                    body = f.read()
                ctype, code = "text/html; charset=utf-8", "200 OK"
            except FileNotFoundError:
                body = b"dashboard.html not found next to thinkrider_logger.py"
                ctype, code = "text/plain", "500 Internal Server Error"
        else:
            body, ctype, code = b"not found", "text/plain", "404 Not Found"
        writer.write(f"HTTP/1.1 {code}\r\nContent-Type: {ctype}\r\n"
                     f"Content-Length: {len(body)}\r\nCache-Control: no-store\r\n{extra}"
                     f"Connection: close\r\n\r\n".encode() + body)
        await writer.drain()
    except (ConnectionError, asyncio.IncompleteReadError, OSError):
        pass
    finally:
        if q is not None:
            live.clients.discard(q)
        try:
            writer.close()
        except Exception:
            pass


# --------------------------------------------------------------------------
# Scanning
# --------------------------------------------------------------------------
async def scan(timeout: float):
    print(f"Scanning {timeout:.0f}s ...")
    found = await BleakScanner.discover(timeout=timeout, return_adv=True)
    rows = sorted(found.values(), key=lambda t: t[1].rssi or -999, reverse=True)
    for dev, adv in rows:
        svcs = ", ".join(uuid_name(s) if uuid_name(s) != "Unknown/Proprietary" else s
                         for s in adv.service_uuids) or "-"
        print(f"{dev.address:40s} RSSI {adv.rssi:>4}  {dev.name or adv.local_name or '?':20s} {svcs}")
    print("\nHeart-rate devices list 'Heart Rate Service'. On a Garmin watch turn on "
          "Broadcast Heart Rate first (see README).")


async def find_trainer(name_hint, address, timeout):
    if address:
        return await BleakScanner.find_device_by_address(address, timeout=timeout)
    hints = [name_hint.lower()] if name_hint else ["think", "x2", "x2max", "x2-max"]
    ftms = u16(0x1826)
    found = await BleakScanner.discover(timeout=timeout, return_adv=True)
    candidates = []
    for dev, adv in found.values():
        nm = (dev.name or adv.local_name or "").lower()
        if any(h in nm for h in hints):
            candidates.append((0, dev, adv))
        elif not name_hint and ftms in [s.lower() for s in adv.service_uuids]:
            candidates.append((1, dev, adv))
    if not candidates:
        return None
    candidates.sort(key=lambda c: (c[0], -(c[2].rssi or -999)))
    return candidates[0][1]


HR_SVC = u16(0x180D)
HR_HINTS = ("forerunner", "garmin", "fr165", "fr 165")


async def find_hr(args, exclude):
    """Find a device broadcasting heart rate (Garmin watch, chest strap ...)."""
    if args.hr_address:
        return await BleakScanner.find_device_by_address(args.hr_address, timeout=args.scan_time)
    found = await BleakScanner.discover(timeout=args.scan_time, return_adv=True)
    candidates = []
    for dev, adv in found.values():
        if exclude and dev.address == exclude:
            continue
        nm = (dev.name or adv.local_name or "").lower()
        has_hr = HR_SVC in [x.lower() for x in adv.service_uuids]
        if args.hr_name:
            if args.hr_name.lower() in nm:
                candidates.append((0, dev, adv))
        elif has_hr:
            candidates.append((0 if any(h in nm for h in HR_HINTS) else 1, dev, adv))
    if not candidates:
        return None
    candidates.sort(key=lambda c: (c[0], -(c[2].rssi or -999)))
    return candidates[0][1]


# Scanning and connecting are serialized: several BLE stacks (BlueZ, WinRT)
# refuse a scan while another scan or connection attempt is running.
BLE_LOCK = None                      # asyncio.Lock, created inside the event loop


# --------------------------------------------------------------------------
# GATT dump (first connection only)
# --------------------------------------------------------------------------
async def dump_gatt(client, dev, out_dir):
    gatt = {"device_name": dev.name, "address": dev.address,
            "captured_utc": datetime.now(timezone.utc).isoformat(), "services": []}
    for svc in client.services:
        s = {"uuid": svc.uuid, "name": uuid_name(svc.uuid), "characteristics": []}
        for ch in svc.characteristics:
            c = {"uuid": ch.uuid, "name": uuid_name(ch.uuid), "handle": ch.handle,
                 "properties": ch.properties, "descriptors": []}
            if "read" in ch.properties:
                try:
                    v = await client.read_gatt_char(ch)
                    c["value_hex"] = v.hex()
                    try:
                        txt = v.decode("utf-8")
                        if txt.isprintable():
                            c["value_text"] = txt
                    except UnicodeDecodeError:
                        pass
                except Exception as e:
                    c["read_error"] = str(e)
                    v = None
                try:
                    if v is None:
                        pass
                    elif ch.uuid == u16(0x2AD6):
                        c["decoded"] = decode_supported_range(v, 0.1)
                    elif ch.uuid == u16(0x2AD8):
                        c["decoded"] = decode_supported_range(v, 1)
                    elif ch.uuid == u16(0x2AD4):
                        c["decoded"] = decode_supported_range(v, 0.01, signed=False)
                    elif ch.uuid == u16(0x2AD5):
                        c["decoded"] = decode_supported_range(v, 0.1)
                    elif ch.uuid == u16(0x2A19):
                        c["decoded"] = {"battery_pct": v[0]}
                except Exception as e:
                    c["decode_error"] = str(e)
            for d in ch.descriptors:
                dd = {"uuid": d.uuid, "handle": d.handle}
                try:
                    dd["value_hex"] = (await client.read_gatt_descriptor(d.handle)).hex()
                except Exception as e:
                    dd["read_error"] = str(e)
                c["descriptors"].append(dd)
            s["characteristics"].append(c)
        gatt["services"].append(s)
    with open(os.path.join(out_dir, "gatt_dump.json"), "w") as f:
        json.dump(gatt, f, indent=2)
    print("\nServices found:")
    for s in gatt["services"]:
        print(f"  {s['name']:40s} {s['uuid']}")
        for c in s["characteristics"]:
            extra = f" = {c.get('value_text') or c.get('value_hex', '')}" if "value_hex" in c else ""
            print(f"     - {c['name']:34s} {c['uuid'][:8]} {','.join(c['properties'])}{extra}")


# --------------------------------------------------------------------------
# FIT activity file (upload to Garmin Connect / Strava / TrainingPeaks)
# Minimal dependency-free encoder: file_id, events, 1 Hz records, laps,
# session and activity messages. Sport = cycling / indoor cycling.
# --------------------------------------------------------------------------
FIT_EPOCH = 631065600            # 1989-12-31T00:00:00Z in Unix seconds
_FIT_CRC = [0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401,
            0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400]

# base type id -> (struct code, invalid value)
_FIT_T = {0x00: ("B", 0xFF), 0x02: ("B", 0xFF), 0x84: ("H", 0xFFFF),
          0x86: ("I", 0xFFFFFFFF), 0x8C: ("I", 0)}
ENUM, U8, U16, U32, U32Z = 0x00, 0x02, 0x84, 0x86, 0x8C


def fit_crc(data: bytes, crc: int = 0) -> int:
    for b in data:
        for nib in (b & 0xF, b >> 4):
            tmp = _FIT_CRC[crc & 0xF]
            crc = ((crc >> 4) & 0x0FFF) ^ tmp ^ _FIT_CRC[nib]
    return crc


class FitWriter:
    def __init__(self):
        self.body = bytearray()
        self.defs = {}               # global msg num -> (local id, field list)

    def msg(self, gnum: int, fields):
        """fields: list of (field number, base type, value or None)."""
        layout = tuple((n, t) for n, t, _ in fields)
        if gnum not in self.defs or self.defs[gnum][1] != layout:
            local = self.defs[gnum][0] if gnum in self.defs else len(self.defs) % 16
            self.defs[gnum] = (local, layout)
            self.body += struct.pack("<BBBHB", 0x40 | local, 0, 0, gnum, len(fields))
            for n, t in layout:
                self.body += struct.pack("<BBB", n, struct.calcsize(_FIT_T[t][0]), t)
        self.body.append(self.defs[gnum][0])
        for _n, t, v in fields:
            code, invalid = _FIT_T[t]
            if v is None:
                v = invalid
            else:
                v = int(round(v))
                v = max(0, min(v, invalid - 1)) if t != U32Z else max(1, v)
            self.body += struct.pack("<" + code, v)

    def bytes(self) -> bytes:
        hdr = struct.pack("<BBHI4s", 14, 0x20, 2132, len(self.body), b".FIT")
        hdr += struct.pack("<H", fit_crc(hdr))
        data = hdr + bytes(self.body)
        return data + struct.pack("<H", fit_crc(data))


def _fit_ts(iso: str) -> int:
    return int(datetime.fromisoformat(iso).timestamp()) - FIT_EPOCH


def _num(v):
    if v in (None, ""):
        return None
    return float(v)


def _summary(rows):
    """Lap/session totals from 1 Hz samples."""
    pw = [r["power_w"] or 0 for r in rows]
    cad = [r["cadence_rpm"] for r in rows if r["cadence_rpm"]]
    hr = [r["heart_rate_bpm"] for r in rows if r["heart_rate_bpm"]]
    spd = [r["speed_kmh"] / 3.6 for r in rows if r["speed_kmh"] is not None]
    roll = [sum(pw[max(0, i - 29):i + 1]) / min(i + 1, 30) for i in range(len(pw))]
    np_ = (sum(x ** 4 for x in roll) / len(roll)) ** 0.25 if len(pw) >= 30 else None
    work_j = sum(max(p, 0) for p in pw)
    return {
        "avg_power": sum(pw) / len(pw), "max_power": max(pw), "np": np_,
        "avg_cad": sum(cad) / len(cad) if cad else None, "max_cad": max(cad) if cad else None,
        "avg_hr": sum(hr) / len(hr) if hr else None, "max_hr": max(hr) if hr else None,
        "avg_spd": sum(spd) / len(spd) if spd else None, "max_spd": max(spd) if spd else None,
        "work_j": work_j, "kcal": work_j / 1000,   # ~24% efficiency: 1 kJ at pedals ~= 1 kcal
    }


def build_fit(history, laps) -> bytes:
    """history: 1 Hz samples (Live.history or rows of session_1hz.csv);
    laps: history indexes where each lap starts."""
    rows = []
    for s in history:
        rows.append({
            "ts": _fit_ts(s["timestamp_utc"]),
            "power_w": _num(s.get("power_w")), "cadence_rpm": _num(s.get("cadence_rpm")),
            "speed_kmh": _num(s.get("speed_kmh")), "heart_rate_bpm": _num(s.get("heart_rate_bpm")),
            "distance_m": _num(s.get("distance_m")) or 0,
        })
    if not rows:
        raise ValueError("no samples to write")
    SPORT, SUB = 2, 6                        # cycling, indoor_cycling
    f = FitWriter()
    start, end = rows[0]["ts"], rows[-1]["ts"]
    f.msg(0, [(0, ENUM, 4), (1, U16, 255), (2, U16, 0),       # activity, development
              (3, U32Z, start), (4, U32, start)])
    ev = lambda ts, typ: f.msg(21, [(253, U32, ts), (0, ENUM, 0), (1, ENUM, typ), (4, U8, 0)])
    ev(start, 0)                                               # timer start
    for i, r in enumerate(rows):
        if i and r["ts"] - rows[i - 1]["ts"] > 2:             # trainer dropped: pause timer
            ev(rows[i - 1]["ts"], 4)
            ev(r["ts"], 0)
        f.msg(20, [(253, U32, r["ts"]), (3, U8, r["heart_rate_bpm"]),
                   (4, U8, r["cadence_rpm"]), (5, U32, r["distance_m"] * 100),
                   (6, U16, None if r["speed_kmh"] is None else r["speed_kmh"] / 3.6 * 1000),
                   (7, U16, r["power_w"])])
    ev(end, 4)                                                 # timer stop_all

    bounds = sorted({b for b in laps if 0 < b < len(rows)} | {0}) + [len(rows)]
    for k in range(len(bounds) - 1):
        seg = rows[bounds[k]:bounds[k + 1]]
        s = _summary(seg)
        d0 = rows[bounds[k] - 1]["distance_m"] if bounds[k] else 0
        last = k == len(bounds) - 2
        f.msg(19, [(254, U16, k), (253, U32, seg[-1]["ts"]), (0, ENUM, 9), (1, ENUM, 1),
                   (2, U32, seg[0]["ts"]), (7, U32, (seg[-1]["ts"] - seg[0]["ts"] + 1) * 1000),
                   (8, U32, len(seg) * 1000), (9, U32, (seg[-1]["distance_m"] - d0) * 100),
                   (11, U16, s["kcal"]),
                   (13, U16, None if s["avg_spd"] is None else s["avg_spd"] * 1000),
                   (14, U16, None if s["max_spd"] is None else s["max_spd"] * 1000),
                   (15, U8, s["avg_hr"]), (16, U8, s["max_hr"]),
                   (17, U8, s["avg_cad"]), (18, U8, s["max_cad"]),
                   (19, U16, s["avg_power"]), (20, U16, s["max_power"]),
                   (24, ENUM, 7 if last else 0), (25, ENUM, SPORT), (39, ENUM, SUB),
                   (33, U16, s["np"]), (41, U32, s["work_j"])])

    s = _summary(rows)
    elapsed, timer = (end - start + 1), len(rows)
    f.msg(18, [(254, U16, 0), (253, U32, end), (0, ENUM, 8), (1, ENUM, 1),
               (2, U32, start), (5, ENUM, SPORT), (6, ENUM, SUB),
               (7, U32, elapsed * 1000), (8, U32, timer * 1000),
               (9, U32, rows[-1]["distance_m"] * 100), (11, U16, s["kcal"]),
               (14, U16, None if s["avg_spd"] is None else s["avg_spd"] * 1000),
               (15, U16, None if s["max_spd"] is None else s["max_spd"] * 1000),
               (16, U8, s["avg_hr"]), (17, U8, s["max_hr"]),
               (18, U8, s["avg_cad"]), (19, U8, s["max_cad"]),
               (20, U16, s["avg_power"]), (21, U16, s["max_power"]),
               (25, U16, 0), (26, U16, len(bounds) - 1), (28, ENUM, 0),
               (34, U16, s["np"]), (48, U32, s["work_j"])])
    local_off = int(datetime.now().astimezone().utcoffset().total_seconds())
    f.msg(34, [(253, U32, end), (0, U32, timer * 1000), (1, U16, 1), (2, ENUM, 0),
               (3, ENUM, 26), (4, ENUM, 1), (5, U32, end + local_off)])
    return f.bytes()


def write_fit(path, history, laps) -> bool:
    try:
        data = build_fit(history, laps)
    except ValueError:
        return False
    with open(path, "wb") as fh:
        fh.write(data)
    return True


def fit_from_csv(folder):
    """Rebuild ride.fit from a saved session_1hz.csv (e.g. after a crash)."""
    with open(os.path.join(folder, "session_1hz.csv"), newline="") as fh:
        hist = list(csv.DictReader(fh))
    laps, prev = [], None
    for i, s in enumerate(hist):
        if s.get("lap") != prev:
            laps.append(i)
            prev = s.get("lap")
    out = os.path.join(folder, "ride.fit")
    if write_fit(out, hist, laps):
        print(f"Wrote {out} ({len(hist)} s) - upload it to Strava or Garmin Connect")
    else:
        print("session_1hz.csv has no samples")


# --------------------------------------------------------------------------
# Strava: OAuth "Connect to Strava" + upload of the finished .FIT
# Uses your own Strava API app (strava.com/settings/api, callback domain
# "localhost"). Client id/secret come from STRAVA_CLIENT_ID /
# STRAVA_CLIENT_SECRET or strava_config.json (written by --strava-setup);
# tokens go to strava_token.json. Both files stay on this PC (.gitignore).
# --------------------------------------------------------------------------
STRAVA_WEB = os.environ.get("STRAVA_WEB_URL", "https://www.strava.com")
STRAVA_API = os.environ.get("STRAVA_API_URL", "https://www.strava.com/api/v3")
APP_DIR = os.path.dirname(os.path.abspath(__file__))
STRAVA_CONFIG = os.path.join(APP_DIR, "strava_config.json")
STRAVA_TOKEN = os.path.join(APP_DIR, "strava_token.json")


def _read_json(path):
    try:
        with open(path) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def _write_private(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        json.dump(data, fh, indent=2)


def _http(method, url, data=None, headers=None, files=None):
    """Tiny stdlib HTTP client (blocking: call through asyncio.to_thread)."""
    headers = dict(headers or {})
    body = None
    if files:
        boundary = "----x2max" + os.urandom(8).hex()
        parts = []
        for k, v in (data or {}).items():
            parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"'
                         f'\r\n\r\n{v}\r\n'.encode())
        for k, (fname, content) in files.items():
            parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"; '
                         f'filename="{fname}"\r\nContent-Type: application/octet-stream'
                         f'\r\n\r\n'.encode() + content + b"\r\n")
        body = b"".join(parts) + f"--{boundary}--\r\n".encode()
        headers["Content-Type"] = f"multipart/form-data; boundary={boundary}"
    elif data is not None:
        body = urllib.parse.urlencode(data).encode()
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except ValueError:
            return e.code, {"message": e.reason}


class Strava:
    def __init__(self, live):
        self.live = live
        self.upload = {"state": None}           # None | uploading | done | error

    def creds(self):
        cid, sec = os.environ.get("STRAVA_CLIENT_ID"), os.environ.get("STRAVA_CLIENT_SECRET")
        if cid and sec:
            return cid, sec
        c = _read_json(STRAVA_CONFIG) or {}
        if c.get("client_id") and c.get("client_secret"):
            return str(c["client_id"]), c["client_secret"]
        return None

    def public(self):
        tok = _read_json(STRAVA_TOKEN) or {}
        return {"configured": self.creds() is not None,
                "connected": bool(tok.get("refresh_token")),
                "athlete": tok.get("athlete_name"),
                "upload": self.upload}

    def push(self):
        self.live.status["strava"] = self.public()
        self.live.broadcast("status", self.live.status)

    def authorize_url(self, port):
        cid, _ = self.creds()
        q = urllib.parse.urlencode({
            "client_id": cid, "response_type": "code", "approval_prompt": "auto",
            "redirect_uri": f"http://localhost:{port}/strava/callback",
            "scope": "read,activity:write"})
        return f"{STRAVA_WEB}/oauth/authorize?{q}"

    def _save_token(self, r, old=None):
        athlete = (r.get("athlete") or {})
        name = " ".join(x for x in (athlete.get("firstname"), athlete.get("lastname")) if x)
        _write_private(STRAVA_TOKEN, {
            "access_token": r["access_token"], "refresh_token": r["refresh_token"],
            "expires_at": r["expires_at"],
            "athlete_name": name or (old or {}).get("athlete_name")})

    def exchange_code(self, code):
        cid, sec = self.creds()
        st, r = _http("POST", f"{STRAVA_WEB}/oauth/token", {
            "client_id": cid, "client_secret": sec, "code": code,
            "grant_type": "authorization_code"})
        if st != 200 or "access_token" not in r:
            raise RuntimeError(r.get("message") or f"HTTP {st}")
        self._save_token(r)

    def access_token(self):
        tok = _read_json(STRAVA_TOKEN)
        if not tok:
            raise RuntimeError("not connected to Strava")
        if tok["expires_at"] - time.time() < 120:
            cid, sec = self.creds()
            st, r = _http("POST", f"{STRAVA_WEB}/oauth/token", {
                "client_id": cid, "client_secret": sec,
                "grant_type": "refresh_token", "refresh_token": tok["refresh_token"]})
            if st != 200 or "access_token" not in r:
                raise RuntimeError("Strava sign-in expired - click Connect to Strava again")
            self._save_token(r, tok)
            tok = _read_json(STRAVA_TOKEN)
        return tok["access_token"]

    def disconnect(self):
        try:
            os.remove(STRAVA_TOKEN)
        except OSError:
            pass

    def upload_fit(self, path, name):
        """Blocking. Returns the Strava activity URL."""
        auth = {"Authorization": f"Bearer {self.access_token()}"}
        with open(path, "rb") as fh:
            content = fh.read()
        st, r = _http("POST", f"{STRAVA_API}/uploads", headers=auth,
                      data={"data_type": "fit", "name": name, "trainer": "1",
                            "external_id": os.path.basename(path)},
                      files={"file": (os.path.basename(path), content)})
        if st >= 300 or "id" not in r:
            raise RuntimeError(r.get("error") or r.get("message") or f"HTTP {st}")
        for _ in range(30):                    # Strava processes uploads async
            if r.get("error"):
                raise RuntimeError(r["error"])
            if r.get("activity_id"):
                return f"{STRAVA_WEB}/activities/{r['activity_id']}"
            time.sleep(2)
            st, r = _http("GET", f"{STRAVA_API}/uploads/{r['id']}", headers=auth)
        raise RuntimeError("Strava is still processing - check your Strava feed in a minute")

    async def upload_last_ride(self):
        path = self.live.fit_path
        if not path or self.live.recording or self.upload.get("state") == "uploading":
            return
        start = self.live.ride_start
        name = f"Indoor ride {start:%Y-%m-%d %H:%M}" if start else "Indoor ride"
        self.upload = {"state": "uploading", "file": os.path.basename(path)}
        self.push()
        try:
            url = await asyncio.to_thread(self.upload_fit, path, name)
            self.upload = {"state": "done", "file": os.path.basename(path), "url": url}
            print(f"Uploaded to Strava: {url}")
        except Exception as e:
            self.upload = {"state": "error", "file": os.path.basename(path), "error": str(e)}
            print(f"Strava upload failed: {e}")
        self.push()


def strava_setup():
    import getpass
    print("Strava setup\n"
          "1. Open https://www.strava.com/settings/api and create an app\n"
          "   (any name/website; Authorization Callback Domain: localhost).\n"
          "2. Copy its Client ID and Client Secret below. They are saved only in\n"
          f"   {STRAVA_CONFIG} (never committed).\n")
    cid = input("Client ID: ").strip()
    sec = getpass.getpass("Client Secret (hidden): ").strip()
    if not cid.isdigit() or len(sec) < 20:
        sys.exit("That doesn't look right (the ID is a number, the secret ~40 characters).")
    _write_private(STRAVA_CONFIG, {"client_id": cid, "client_secret": sec})
    print("Saved. Start the logger and click 'Connect to Strava' on the dashboard.")


# --------------------------------------------------------------------------
# Bluetooth loop with auto-reconnect
# --------------------------------------------------------------------------
async def ble_loop(args, live: Live, raw_w, dec_w, t0):
    first = True
    while True:
        try:
            live.set_status(state="searching", connected=False)
            print("Searching for trainer ...")
            gone = asyncio.Event()
            async with BLE_LOCK:
                dev = await find_trainer(args.name, args.address, args.scan_time)
                if dev:
                    client = BleakClient(dev, disconnected_callback=lambda _c: gone.set())
                    await client.connect()
            if not dev:
                print("  not found - pedal to wake it, close other apps. Retrying ...")
                await asyncio.sleep(2)
                continue
            live.trainer_address = dev.address
            try:
                print(f"Connected to {dev.name} [{dev.address}]")
                for calc in (cps_crank, cps_wheel, csc_crank, csc_wheel):
                    calc.prev = None         # stale counters would give a fake rpm spike
                if first:
                    await dump_gatt(client, dev, args.out)
                    first = False

                def make_handler(svc_uuid, ch):
                    name = uuid_name(ch.uuid)
                    decoder = DECODERS.get(ch.uuid)

                    def handler(_sender, data: bytearray):
                        ts = datetime.now(timezone.utc).isoformat()
                        el = round(time.monotonic() - t0, 3)
                        raw_w.writerow([ts, el, svc_uuid, ch.uuid, name, ch.handle,
                                        len(data), data.hex()])
                        live.packets += 1
                        if decoder:
                            try:
                                row = decoder(bytes(data))
                                live.update(row)
                                row.update(timestamp_utc=ts, elapsed_s=el, source=name)
                                dec_w.writerow(row)
                            except Exception as e:
                                print(f"[decode error {name}: {e} data={data.hex()}]")
                    return handler

                n = 0
                for svc in client.services:
                    for ch in svc.characteristics:
                        if "notify" in ch.properties or "indicate" in ch.properties:
                            try:
                                await client.start_notify(ch, make_handler(svc.uuid, ch))
                                n += 1
                            except Exception as e:
                                print(f"  subscribe failed {uuid_name(ch.uuid)}: {e}")
                print(f"Subscribed to {n} characteristics. Riding data is live.")
                live.set_status(state="connected", connected=True,
                                device=dev.name or dev.address)
                await gone.wait()
            finally:
                try:
                    await client.disconnect()
                except Exception:
                    pass
            print("Trainer disconnected - reconnecting ...")
        except asyncio.CancelledError:
            raise
        except Exception as e:
            print(f"Bluetooth error: {e} - retrying ...")
        live.set_status(state="reconnecting", connected=False)
        await asyncio.sleep(3)


async def hr_loop(args, live: Live, raw_w, dec_w, t0):
    """Second BLE connection to a heart-rate broadcaster (e.g. Garmin Forerunner
    with Broadcast Heart Rate on). Independent of the trainer, own reconnect."""
    hr_char = u16(0x2A37)
    told = False
    while True:
        try:
            live.set_hr_status(state="searching", device=None)
            if not told:
                print("Looking for a heart-rate broadcast (watch: turn on Broadcast Heart Rate) ...")
                told = True
            gone = asyncio.Event()
            async with BLE_LOCK:
                exclude = live.trainer_address if not args.hr_address else None
                dev = await find_hr(args, exclude)
                if dev:
                    client = BleakClient(dev, disconnected_callback=lambda _c: gone.set())
                    await client.connect()
            if not dev:
                await asyncio.sleep(5)
                continue
            name = dev.name or dev.address
            try:
                def handler(_sender, data: bytearray):
                    ts = datetime.now(timezone.utc).isoformat()
                    el = round(time.monotonic() - t0, 3)
                    raw_w.writerow([ts, el, HR_SVC, hr_char, f"Heart Rate Measurement ({name})",
                                    "", len(data), data.hex()])
                    try:
                        row = decode_hr(bytes(data))
                    except Exception as e:
                        print(f"[decode error HR: {e} data={data.hex()}]")
                        return
                    live.update_hr(row["heart_rate_bpm"])
                    row.update(timestamp_utc=ts, elapsed_s=el, source=f"HR device ({name})")
                    dec_w.writerow(row)

                await client.start_notify(hr_char, handler)
                print(f"Heart rate from {name} [{dev.address}]")
                live.set_hr_status(state="connected", device=name)
                await gone.wait()
            finally:
                try:
                    await client.disconnect()
                except Exception:
                    pass
            print(f"Heart-rate device {name} lost - reconnecting ...")
        except asyncio.CancelledError:
            raise
        except Exception as e:
            print(f"Heart-rate device error: {e} - retrying ...")
        live.set_hr_status(state="reconnecting")
        await asyncio.sleep(3)


# --------------------------------------------------------------------------
# Demo ride (no trainer needed)
# --------------------------------------------------------------------------
async def demo_loop(live: Live, hr_on=True):
    live.set_status(state="demo", connected=True, device="Demo ride")
    if hr_on:
        live.set_hr_status(state="searching")
    t, hr = 0, 92.0
    while True:
        if t < 300:
            target = 110 + 90 * t / 300                    # warm-up ramp
        else:
            c = (t - 300) % 420
            target = 285 if c < 240 else 155               # 4 min on / 3 min easy
        p = max(0.0, random.gauss(target, 9))
        cad = random.gauss(93 if target > 250 else 86, 2)
        spd = 3.6 * (p / 0.32) ** (1 / 3) if p > 0 else 0  # rough flat-road speed
        hr += ((62 + 0.42 * p) - hr) * 0.035 + random.gauss(0, 0.4)
        live.update({"power_w": p, "cadence_rpm": cad, "speed_kmh": spd})
        if t == 4 and hr_on:
            live.set_hr_status(state="connected", device="Forerunner 165 (demo)")
        if t >= 4 and hr_on:
            live.update_hr(hr)                             # simulated watch broadcast
        t += 1
        await asyncio.sleep(1)


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------
async def main_async(args):
    global BLE_LOCK
    BLE_LOCK = asyncio.Lock()
    os.makedirs(args.out, exist_ok=True)
    live = Live(args.out)
    live.port = args.port
    live.strava = Strava(live)
    live.status["strava"] = live.strava.public()
    t0 = time.monotonic()

    raw_f = open(os.path.join(args.out, "raw_packets.csv"), "w", newline="")
    dec_f = open(os.path.join(args.out, "decoded.csv"), "w", newline="")
    raw_w = csv.writer(raw_f)
    raw_w.writerow(["timestamp_utc", "elapsed_s", "service_uuid", "char_uuid",
                    "char_name", "handle", "length", "hex"])
    dec_w = csv.DictWriter(dec_f, fieldnames=DECODED_FIELDS, extrasaction="ignore")
    dec_w.writeheader()

    server = await asyncio.start_server(lambda r, w: handle_http(r, w, live),
                                        args.host, args.port)
    url = f"http://localhost:{args.port}"
    print(f"Dashboard: {url}" + ("  (also reachable from your network)" if args.host != "127.0.0.1" else ""))
    print(f"Saving to {args.out}/   -   Ctrl+C to stop")
    if args.autostart or args.duration:
        live.start_ride()
    else:
        print("Press Start on the dashboard to begin recording, Finish to save the .FIT.")
    print()
    if not args.no_browser:
        webbrowser.open(url)

    source = demo_loop(live, not args.no_hr) if args.demo else ble_loop(args, live, raw_w, dec_w, t0)
    tasks = [asyncio.create_task(source), asyncio.create_task(ticker(live, args.duration))]
    if not args.demo and not args.no_hr:
        tasks.append(asyncio.create_task(hr_loop(args, live, raw_w, dec_w, t0)))

    async def flusher():
        while True:
            await asyncio.sleep(2)
            raw_f.flush(); dec_f.flush()
    tasks.append(asyncio.create_task(flusher()))

    try:
        await tasks[1]                      # ticker ends only when --duration elapses
    finally:
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        server.close()
        fit = live.finish_ride()          # Ctrl+C mid-ride still saves the .FIT
        raw_f.close(); dec_f.close(); live.close()
        h = live.history
        if h:
            n = len(h)
            avg = sum(s["power_w"] for s in h) / n
            print(f"\nRide: {n // 60}:{n % 60:02d}  avg {avg:.0f} W  "
                  f"{h[-1]['distance_m'] / 1000:.2f} km  {h[-1]['energy_kj']:.0f} kJ")
        print(f"Files in {args.out}/ : " + ", ".join(sorted(os.listdir(args.out))))
        if fit:
            print(f"Upload {os.path.basename(fit)} to Strava (strava.com/upload/select) "
                  "or Garmin Connect (Import Data)")


def main():
    p = argparse.ArgumentParser(description="Log all BLE data from a ThinkRider X2Max + live dashboard")
    p.add_argument("--scan", action="store_true", help="only list nearby BLE devices")
    p.add_argument("--demo", action="store_true", help="simulate a ride (no trainer needed)")
    p.add_argument("--name", help="part of the device name to match (default: think/x2)")
    p.add_argument("--address", help="exact BLE address (MAC on Win/Linux, UUID on macOS)")
    p.add_argument("--hr-name", help="part of the heart-rate device name, e.g. Forerunner "
                   "(default: any device broadcasting heart rate)")
    p.add_argument("--hr-address", help="exact BLE address of the heart-rate device (see --scan)")
    p.add_argument("--no-hr", action="store_true", help="don't look for a separate heart-rate device")
    p.add_argument("--autostart", action="store_true",
                   help="start recording right away instead of waiting for Start")
    p.add_argument("--strava-setup", action="store_true",
                   help="save your Strava API app's Client ID/Secret on this PC, then exit")
    p.add_argument("--fit-from", metavar="FOLDER",
                   help="only rebuild FOLDER/ride.fit from its session_1hz.csv, then exit")
    p.add_argument("--duration", type=float, default=0,
                   help="seconds to run, recording from the start (0 = until Ctrl+C)")
    p.add_argument("--scan-time", type=float, default=8, help="scan timeout in seconds")
    p.add_argument("--host", default="127.0.0.1", help="use 0.0.0.0 to view from phone/tablet")
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--no-browser", action="store_true", help="don't open the dashboard automatically")
    p.add_argument("--out", default=datetime.now().strftime("x2max_%Y%m%d_%H%M%S"),
                   help="output folder")
    args = p.parse_args()
    if args.fit_from:
        return fit_from_csv(args.fit_from)
    if args.strava_setup:
        return strava_setup()
    if BleakScanner is None and not args.demo:
        sys.exit("bleak is not installed. Run with:  uv run thinkrider_logger.py   (or try --demo)")
    try:
        asyncio.run(scan(args.scan_time) if args.scan else main_async(args))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
