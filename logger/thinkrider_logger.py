#!/usr/bin/env python3
"""
thinkrider_logger.py - capture ALL Bluetooth LE data from a ThinkRider X2Max
(or any BLE smart trainer) and show a LIVE training dashboard in your browser.

What it does
  1. Connects to the trainer and heart-rate device picked on the dashboard
     (Devices panel; remembered in config/devices.json). First start: finds them by name.
  2. Dumps the full GATT table + every readable value      -> gatt_dump.json
  3. Subscribes to EVERY notify/indicate characteristic (incl. proprietary).
  4. Logs every packet as raw hex                          -> raw_packets.csv
  5. Decodes FTMS / Cycling Power / CSC / Heart Rate       -> decoded.csv
  6. Builds a 1-second training timeline                   -> session_1hz.csv
     and a FIT activity for Strava / Garmin Connect     -> ride_<date>_<time>.fit
     Heart rate can come from a 2nd BLE device (Garmin watch broadcasting HR).
  7. Serves a live dashboard at http://localhost:8000  (power, cadence, speed,
     HR, zones, NP/TSS, laps, live charts). Reconnects automatically if the
     trainer drops.
  8. Optional trainer control (off by default, a toggle on the dashboard):
     simulate a climb (grade) or hold a power (ERG) over FTMS. See trainer_control.py.
  9. Guided FTP test (a button on the dashboard); results are kept in
     config/ftp_tests.json. See ftp_test.py.

Requirements
  uv (https://docs.astral.sh/uv/) - `uv run` installs bleak from pyproject.toml.
  The dashboard is dashboard/dashboard.html (built from dashboard/src).

Usage
  macOS: double-click "Start X2Max.command" (no terminal typing needed)
  uv run logger/thinkrider_logger.py                 # find trainer, log + dashboard
  uv run logger/thinkrider_logger.py --demo          # fake ride, to try the dashboard
  uv run logger/thinkrider_logger.py --scan          # list nearby BLE devices
  uv run logger/thinkrider_logger.py --host 0.0.0.0  # open dashboard from a phone/tablet
                                              # on the same Wi-Fi: http://<PC-IP>:8000
  (8000 is the default port; if another program uses it, the next free one is picked.)
  uv run logger/thinkrider_logger.py --hr-name forerunner   # pick the HR watch/strap
  uv run logger/thinkrider_logger.py --autostart     # record without pressing Start
  uv run logger/thinkrider_logger.py --fit-from rides/x2max_...   # rebuild ride.fit from a CSV
  Other options: --name X2MAX  --address AA:BB:..  --port 8001  --out ride1
                 --duration 3600  --no-browser  --hr-address ..  --no-hr

Heart rate from a watch: on a Garmin Forerunner 165 turn on Broadcast Heart
Rate (hold UP > Settings > Sensors & Accessories > Wrist Heart Rate >
Broadcast Heart Rate, or add the Broadcast Heart Rate control to the controls
menu). The logger connects to it as a second Bluetooth device and keeps
reconnecting if it drops.

Press Start on the dashboard to begin recording, Pause to stop the clock for a
while, and Finish to end the ride:
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
import glob
import ipaddress
import math
import random
import signal
import socket
import struct
import sys
import time
import urllib.parse
import webbrowser
from datetime import datetime, timezone

try:
    from bleak import BleakClient, BleakScanner
except ImportError:                       # --demo works without bleak
    BleakClient = BleakScanner = None

from trainer_control import TrainerControl, DemoControl, CONTROL_POINT  # noqa: E402 (logger/)
from ftp_test import FtpTests  # noqa: E402 (logger/)
from coach import Coach, CoachError  # noqa: E402 (logger/)
from garmin_rides import GarminError  # noqa: E402 (logger/)
from env import load_env  # noqa: E402 (logger/)


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
            if de > 0:                # de == 0: no new event, keep previous value upstream
                rpm = dr / (de / self.res) * 60
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
                  "speed_kmh", "heart_rate_bpm", "distance_m", "energy_kj", "grade_pct"]


class Live:
    def __init__(self, out_dir):
        self.vals = {}                 # field -> (value, monotonic time)
        self.history = []              # 1 Hz samples
        self.laps = [0]                # history index where each lap starts
        self.clients = set()           # asyncio.Queue per dashboard tab
        self.status = {"state": "starting", "connected": False, "device": None,
                       "hr": {"state": "off", "device": None},
                       "ride": {"state": "ready", "n": 0, "fit": None, "paused": False,
                                "dir": os.path.basename(os.path.abspath(out_dir))}}
        self.trainer_address = None
        self.distance_m = 0.0
        self.energy_kj = 0.0
        self.packets = 0
        self.out_dir = out_dir
        self.sess_f = self.sess_w = None
        self.ride_start = None
        self.port = 8000
        self.fit_path = None
        self.sess_path = None          # this ride's 1 Hz CSV (reopened by Resume)
        self.gatt_dumped = False
        self._live_pending = False     # a "live" push is already scheduled
        self.devices = None            # Devices: trainer / heart-rate choice (device panel)
        self.quit = None               # stops the logger (Stop button, closed launcher window)
        self.control = None            # TrainerControl / DemoControl: climb simulation, ERG
        self.ftp_tests = None          # FtpTests: guided FTP test and its saved results
        self.coach = None              # Coach: optional Claude evaluation of a ride (coach.py)

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
        self.sess_path = os.path.join(self.out_dir, name)
        self.sess_f = open(self.sess_path, "w", newline="")
        self.sess_w = csv.DictWriter(self.sess_f, fieldnames=SESSION_FIELDS)
        self.sess_w.writeheader()
        self.status["ride"] = {**self.status["ride"], "state": "recording", "n": n, "fit": None,
                               "paused": False}
        if self.ftp_tests:
            self.ftp_tests.on_ride_start()
        print(f"Ride {n} started")
        self.broadcast("init", {"history": [], "laps": self.laps, "status": self.status})

    def finish_ride(self):
        """Stop recording and save the .FIT. Returns its path (None if empty)."""
        if self.control:
            self.control.to_flat("ride finished")
        if not self.recording:
            return self.fit_path
        self.sess_f.close()
        self.sess_f = None
        path = os.path.join(self.out_dir, self.ride_start.strftime("ride_%Y%m%d_%H%M%S.fit"))
        self.fit_path = path if write_fit(path, self.history, self.laps) else None
        self.status["ride"] = {**self.status["ride"], "state": "finished", "paused": False,
                               "fit": self.fit_path and os.path.basename(self.fit_path)}
        if self.ftp_tests:
            self.ftp_tests.on_ride_finish()
        n = len(self.history)
        print(f"Ride {self.status['ride']['n']} finished: {n // 60}:{n % 60:02d}"
              + (f" - saved {self.fit_path}" if self.fit_path else " - nothing recorded"))
        self.broadcast("status", self.status)
        return self.fit_path

    def resume_ride(self):
        """Resume button: carry on with the ride that was just finished. Samples keep
        their numbering (the time in between counts as a pause), the CSV is appended
        to, and Finish writes the .FIT again under the same name."""
        if self.recording or not self.history or not self.sess_path:
            return False
        self.sess_f = open(self.sess_path, "a", newline="")
        self.sess_w = csv.DictWriter(self.sess_f, fieldnames=SESSION_FIELDS)
        self.status["ride"] = {**self.status["ride"], "state": "recording", "fit": None,
                               "paused": False}
        if self.ftp_tests:
            self.ftp_tests.on_ride_resume()
        print(f"Ride {self.status['ride']['n']} resumed")
        self.broadcast("status", self.status)
        return True

    @property
    def paused(self):
        return self.recording and bool(self.status["ride"].get("paused"))

    def set_paused(self, on):
        """Pause button: while paused the ride timer stops and no samples are recorded,
        so averages, distance and energy skip the stop. The .FIT marks the gap as a
        timer stop / start (see build_fit), so Strava shows the right moving time."""
        on = bool(on)
        if not self.recording or self.paused == on:
            return False
        self.status["ride"] = {**self.status["ride"], "paused": on}
        print(f"Ride {self.status['ride']['n']} {'paused' if on else 'continued'}")
        self.broadcast("status", self.status)
        return True

    def clear(self):
        """Clear button: empty the dashboard (ride so far, laps, totals) without
        saving a .FIT. Files already in the ride folder stay on disk."""
        if self.sess_f:
            self.sess_f.close()
            self.sess_f = self.sess_w = None
        self.history, self.laps = [], [0]
        self.distance_m = self.energy_kj = 0.0
        self.ride_start = self.fit_path = self.sess_path = None
        self.status["ride"] = {**self.status["ride"], "state": "ready", "fit": None, "paused": False}
        if self.ftp_tests:
            self.ftp_tests.on_ride_start()        # a test in progress goes too
        print("Dashboard cleared")
        self.broadcast("init", {"history": [], "laps": self.laps, "status": self.status})

    # -- inputs ------------------------------------------------------------
    def update(self, row: dict):
        now = time.monotonic()
        for k in ("power_w", "cadence_rpm", "speed_kmh", "heart_rate_bpm"):
            v = row.get(k)
            if v is None or (k == "heart_rate_bpm" and v <= 0):
                continue                     # FTMS sends HR 0 when no strap is paired
            self.vals[k] = (v, now)
        self._push_live()

    def update_hr(self, bpm):
        """Heart rate from a dedicated HR device (watch / strap): beats trainer HR."""
        if bpm and bpm > 0:
            self.vals["hr_device"] = (bpm, time.monotonic())
            self._push_live()

    # -- instant values for the dashboard (every packet; recording stays 1 Hz) --
    def now(self):
        spd = self._get("speed_kmh", 3)
        hr = self._get("hr_device", 5)
        if hr is None:
            hr = self._get("heart_rate_bpm", 10)
        return {"power_w": round(self._get("power_w", 3) or 0),
                "cadence_rpm": round(self._get("cadence_rpm", 3) or 0),
                "speed_kmh": (0 if "speed_kmh" in self.vals else None) if spd is None else round(spd, 2),
                "heart_rate_bpm": None if hr is None else round(hr)}

    def _push_live(self):
        """Send the new numbers right away. Packets that arrive together (power and
        cadence often come from two characteristics a few ms apart) share one push."""
        if self._live_pending or not self.clients:
            return
        try:
            asyncio.get_running_loop().call_later(0.005, self._send_live)
            self._live_pending = True
        except RuntimeError:
            pass                                    # not in the event loop (tests)

    def _send_live(self):
        self._live_pending = False
        self.broadcast("live", self.now())

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
        if self.clients:
            self._send_live()                       # also clears stale numbers if packets stop
        power = self._get("power_w", 3) or 0
        cad = self._get("cadence_rpm", 3) or 0
        spd = self._get("speed_kmh", 3)
        hr = self._get("hr_device", 5)
        if hr is None:
            hr = self._get("heart_rate_bpm", 10)
        spd = 0 if spd is None and ("speed_kmh" in self.vals) else spd
        if not self.recording or self.paused:       # before Start / after Finish / paused:
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
            "grade_pct": self.control.current_grade() if self.control else None,
        }
        self.history.append(s)
        self.sess_w.writerow(s)
        self.sess_f.flush()
        self.broadcast("sample", s)
        if self.ftp_tests:
            self.ftp_tests.on_sample()
        return s

    # -- push to browsers --------------------------------------------------
    def broadcast(self, event, data):
        msg = f"event: {event}\ndata: {json.dumps(data)}\n\n".encode()
        now = time.monotonic()
        for q in list(self.clients):
            if event == "live" and getattr(q, "live_gap", 0):
                if now - q.live_last < q.live_gap - 0.05:
                    continue                        # this tab asked for fewer updates
                q.live_last = now
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
# Repo layout: logger/ (this script), dashboard/ (web page), config/ (local settings),
# rides/ (recordings).
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HTML_PATH = os.path.join(ROOT, "dashboard", "dashboard.html")


def is_local_host(host_header):
    """True when the Host header names this computer the way a rider reaches it: localhost,
    an IP address (phone on the Wi-Fi), the computer's name or its .local name. A page on
    another site that makes its own name resolve to 127.0.0.1 (DNS rebinding) sends its own
    name here, so its POSTs are refused even though its Origin matches that Host."""
    host = urllib.parse.urlsplit("//" + (host_header or "")).hostname
    if not host:
        return False
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        pass
    me = socket.gethostname().lower().removesuffix(".local")
    return host in ("localhost", me) or host.endswith(".localhost") or host.endswith(".local")


MAX_COACH_BODY = 200_000                    # bytes: a ride summary is ~5 KB


def finite(text):
    """float() that refuses nan and inf (they would clamp to the hardest grade / most power)."""
    v = float(text)
    if not math.isfinite(v):
        raise ValueError("not a finite number")
    return v


async def handle_http(reader, writer, live: Live):
    q = None
    try:
        line = (await reader.readline()).decode("latin-1").split()
        method, path = (line[0], line[1]) if len(line) >= 2 else ("GET", "/")
        headers = {}
        while (h := await reader.readline()) not in (b"\r\n", b"\n", b""):
            k, _, v = h.decode("latin-1").partition(":")
            headers[k.strip().lower()] = v.strip()
        path, _, query = path.partition("?")
        # Any web page can POST to localhost; browsers send Origin, so refuse other sites.
        origin = headers.get("origin")
        if method == "POST" and (not is_local_host(headers.get("host")) or origin
                                 and urllib.parse.urlsplit(origin).netloc != headers.get("host")):
            writer.write(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            await writer.drain()
            return
        params = dict(urllib.parse.parse_qsl(query))

        if path == "/events":
            writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n"
                         b"Cache-Control: no-cache\r\nConnection: keep-alive\r\n\r\n")
            init = {"history": live.history, "laps": live.laps, "status": live.status}
            sock = writer.get_extra_info("socket")
            if sock is not None:                    # send each event at once (no Nagle delay)
                try:
                    sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                except OSError:
                    pass
            writer.write(f"event: init\ndata: {json.dumps(init)}\n\n".encode())
            await writer.drain()
            q = asyncio.Queue(maxsize=600)
            # /events?live=2 : at most 2 instant updates per second (phone: saves battery)
            try:
                q.live_gap = 1 / max(0.5, float(params.get("live", 0))) if params.get("live") else 0
            except ValueError:
                q.live_gap = 0
            q.live_last = 0.0
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
        elif path.startswith("/devices/") and method == "POST" and live.devices:
            devs, act, role = live.devices, path[len("/devices/"):], params.get("role")
            body, ctype, code = b"ok", "text/plain", "200 OK"
            if act == "scan":
                devs.scan()
            elif role in ROLES and act == "use" and 0 < len(params.get("address", "")) <= 200:
                asyncio.ensure_future(devs.set(role, {"mode": "device", "address": params["address"],
                                                      "name": params.get("name", "")[:100] or None}))
            elif role in ROLES and act == "auto":
                asyncio.ensure_future(devs.set(role, {"mode": "auto"}))
            elif role in ROLES and act == "search":         # search back on: the saved device, else any
                c = devs.choice[role]
                asyncio.ensure_future(devs.set(role, {**c, "mode": "device"} if c.get("address")
                                               else {"mode": "auto"}))
            elif role in ROLES and act == "off":
                asyncio.ensure_future(devs.set(role, {**devs.choice[role], "mode": "off"}))
            else:
                body, code = b"bad request", "400 Bad Request"
        elif path.startswith("/control") and method == "POST" and live.control:
            ctl, act = live.control, path[len("/control"):]
            body, ctype, code = b"ok", "text/plain", "200 OK"
            try:
                if act == "" and params.get("on") in ("0", "1"):
                    ctl.set_enabled(params["on"] == "1")
                elif act == "/grade":
                    ctl.set_grade(finite(params["pct"]))
                elif act == "/power":
                    ctl.set_power(finite(params["w"]))
                elif act == "/sim" and params and set(params) <= {"difficulty", "crr", "cw"}:
                    ctl.set_sim(**{k: finite(v) for k, v in params.items()})
                else:
                    raise ValueError
            except (KeyError, ValueError, OverflowError):
                body, code = b"bad request", "400 Bad Request"
        elif path == "/quit" and method == "POST" and live.quit:
            print("Stop pressed on the dashboard")
            live.quit()
            body, ctype, code = b"ok", "text/plain", "200 OK"
        elif path == "/clear" and method == "POST":
            live.clear()
            body, ctype, code = b"ok", "text/plain", "200 OK"
        elif path in ("/start", "/finish") and method == "POST":
            live.start_ride() if path == "/start" else live.finish_ride()
            body, ctype, code = b"ok", "text/plain", "200 OK"
        elif path.startswith("/ftp-test/") and method == "POST" and live.ftp_tests:
            ft, act = live.ftp_tests, path[len("/ftp-test/"):]
            try:
                ftp = int(finite(params["ftp"])) if params.get("ftp") else None
                ok = (ft.start(ftp if ftp and 50 <= ftp <= 600 else None) if act == "start"
                      else ft.cancel() if act == "cancel"
                      else ft.delete(params["id"]) if act == "delete"
                      else None)
            except (KeyError, ValueError, OverflowError):
                ok = None
            body, ctype = (b"ok" if ok else b"bad request" if ok is None else b"not now"), "text/plain"
            code = "200 OK" if ok else "400 Bad Request" if ok is None else "409 Conflict"
        elif path == "/coach" and method == "POST" and live.coach:
            # Ask Claude to evaluate a ride: JSON body from the dashboard, JSON answer.
            try:
                n = int(headers.get("content-length", "0"))
                if not 0 < n <= MAX_COACH_BODY:
                    raise ValueError("bad length")
                payload = json.loads(await reader.readexactly(n))
                result, code = await asyncio.to_thread(live.coach.evaluate, payload), "200 OK"
            except CoachError as e:
                result, code = {"error": str(e)}, "503 Service Unavailable"
            except (ValueError, asyncio.IncompleteReadError):
                result, code = {"error": "Bad request."}, "400 Bad Request"
            body, ctype = json.dumps(result).encode(), "application/json"
        elif path == "/garmin/rides" and live.coach:
            # Past rides page: the last 10 cycling activities on Garmin Connect
            try:
                rows = await asyncio.to_thread(live.coach.garmin.rides, 10, params.get("refresh") == "1")
                result, code = {"rides": rows}, "200 OK"
            except GarminError as e:
                result, code = {"error": str(e)}, "503 Service Unavailable"
            body, ctype = json.dumps(result).encode(), "application/json"
        elif path == "/garmin/activity.fit" and live.coach:
            try:
                body = await asyncio.to_thread(live.coach.garmin.fit, params.get("id", ""))
                ctype, code = "application/vnd.ant.fit", "200 OK"
            except GarminError as e:
                body, ctype, code = json.dumps({"error": str(e)}).encode(), "application/json", "503 Service Unavailable"
            except ValueError:
                body, ctype, code = json.dumps({"error": "Bad activity id."}).encode(), "application/json", "400 Bad Request"
        elif path == "/pause" and method == "POST":
            # Pause / continue the ride in progress: /pause?on=1 or /pause?on=0
            ok = live.set_paused(params.get("on") == "1")
            body, ctype = (b"ok", "text/plain") if ok else (b"not now", "text/plain")
            code = "200 OK" if ok else "409 Conflict"
        elif path == "/resume" and method == "POST":
            ok = live.resume_ride()
            body, ctype = (b"ok", "text/plain") if ok else (b"nothing to resume", "text/plain")
            code = "200 OK" if ok else "409 Conflict"
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
                body = b"dashboard/dashboard.html not found: run  cd dashboard && pnpm build"
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


TRAINER_HINTS = ("think", "x2", "x2max", "x2-max")
TRAINER_SVCS = {u16(0x1826), u16(0x1818)}       # FTMS, Cycling Power
HR_SVC = u16(0x180D)
HR_HINTS = ("forerunner", "garmin", "fr165", "fr 165")


def adv_name(dev, adv) -> str:
    return dev.name or adv.local_name or ""


def device_kind(name, service_uuids) -> str:
    """'trainer', 'hr' or 'other', from what a device advertises (for the device panel)."""
    nm = (name or "").lower()
    svcs = {s.lower() for s in service_uuids}
    if svcs & TRAINER_SVCS or any(h in nm for h in ("think", "x2max", "x2 max", "x2-max")):
        return "trainer"
    if HR_SVC in svcs or any(h in nm for h in HR_HINTS):
        return "hr"
    return "other"


async def find_trainer(name_hint, timeout):
    """No device picked yet: the first ThinkRider / X2 name, else any FTMS trainer."""
    hints = [name_hint.lower()] if name_hint else list(TRAINER_HINTS)
    ftms = u16(0x1826)
    found = await BleakScanner.discover(timeout=timeout, return_adv=True)
    candidates = []
    for dev, adv in found.values():
        nm = adv_name(dev, adv).lower()
        if any(h in nm for h in hints):
            candidates.append((0, dev, adv))
        elif not name_hint and ftms in [s.lower() for s in adv.service_uuids]:
            candidates.append((1, dev, adv))
    if not candidates:
        return None
    candidates.sort(key=lambda c: (c[0], -(c[2].rssi or -999)))
    return candidates[0][1]


async def find_hr(name_hint, timeout, exclude):
    """No heart-rate device picked yet: any device broadcasting heart rate
    (Garmin watch, chest strap ...), Garmin / Forerunner names first."""
    found = await BleakScanner.discover(timeout=timeout, return_adv=True)
    candidates = []
    for dev, adv in found.values():
        if exclude and dev.address == exclude:
            continue
        nm = adv_name(dev, adv).lower()
        has_hr = HR_SVC in [x.lower() for x in adv.service_uuids]
        if name_hint:
            if name_hint.lower() in nm:
                candidates.append((0, dev, adv))
        elif has_hr:
            candidates.append((0 if any(h in nm for h in HR_HINTS) else 1, dev, adv))
    if not candidates:
        return None
    candidates.sort(key=lambda c: (c[0], -(c[2].rssi or -999)))
    return candidates[0][1]


async def find_chosen(choice, timeout, exclude=None):
    """The device picked on the dashboard: by address, or by its exact name
    (macOS can give a device a new address id after a Bluetooth reset).
    Returns as soon as it is seen."""
    addr = (choice.get("address") or "").lower()
    name = choice.get("name")

    def match(dev, adv):
        if exclude and dev.address == exclude:
            return False
        return dev.address.lower() == addr or bool(name) and adv_name(dev, adv) == name
    return await BleakScanner.find_device_by_filter(match, timeout=timeout)

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


# Calories burned per kJ of work at the pedals. Gross efficiency measured in cyclists is ~19 %
# (Med Sci Sports Exerc 2013;45(9):1833-40: energy expenditure = work x 5.3), so
# 1 kJ of work costs 5.3 kJ = 1.27 kcal. Same factor as kcalOf() in dashboard/src/util/ride.ts.
KCAL_PER_KJ = 5.3 / 4.184


def _summary(rows):
    """Lap/session totals from 1 Hz samples."""
    pw = [r["power_w"] or 0 for r in rows]
    cad = [r["cadence_rpm"] for r in rows if r["cadence_rpm"]]
    hr = [r["heart_rate_bpm"] for r in rows if r["heart_rate_bpm"]]
    spd = [r["speed_kmh"] / 3.6 for r in rows if r["speed_kmh"] is not None]
    # NP: 4th-power mean of the 30 s rolling average, full 30 s windows only (as the dashboard does)
    roll = [sum(pw[i - 29:i + 1]) / 30 for i in range(29, len(pw))]
    np_ = (sum(x ** 4 for x in roll) / len(roll)) ** 0.25 if roll else None
    work_j = sum(max(p, 0) for p in pw)
    return {
        "avg_power": sum(pw) / len(pw), "max_power": max(pw), "np": np_,
        "avg_cad": sum(cad) / len(cad) if cad else None, "max_cad": max(cad) if cad else None,
        "avg_hr": sum(hr) / len(hr) if hr else None, "max_hr": max(hr) if hr else None,
        "avg_spd": sum(spd) / len(spd) if spd else None, "max_spd": max(spd) if spd else None,
        "work_j": work_j, "kcal": work_j / 1000 * KCAL_PER_KJ,
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
        if i and r["ts"] - rows[i - 1]["ts"] > 2:             # paused or trainer dropped: timer stop / start
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
    """Rebuild a .fit from every saved session_1hz*.csv (e.g. after a crash):
    session_1hz.csv -> ride.fit, session_1hz_2.csv -> ride_2.fit, ..."""
    csvs = sorted(glob.glob(os.path.join(folder, "session_1hz*.csv")))
    if not csvs:
        print(f"No session_1hz*.csv in {folder}")
    for path in csvs:
        with open(path, newline="") as fh:
            hist = list(csv.DictReader(fh))
        laps, prev = [], None
        for i, s in enumerate(hist):
            if s.get("lap") != prev:
                laps.append(i)
                prev = s.get("lap")
        name = os.path.basename(path)
        out = os.path.join(folder, "ride" + name[len("session_1hz"):-len(".csv")] + ".fit")
        if write_fit(out, hist, laps):
            print(f"Wrote {out} ({len(hist)} s) - upload it to Strava or Garmin Connect")
        else:
            print(f"{name} has no samples")


# --------------------------------------------------------------------------
# Local settings (config/, never committed)
# --------------------------------------------------------------------------
APP_DIR = os.path.join(ROOT, "config")


def _read_json(path):
    try:
        with open(path) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


# --------------------------------------------------------------------------
# Device choice: which trainer and heart-rate device to use. Picked on the
# dashboard's device panel; the last pick is kept in config/devices.json (in
# this repo) and reconnected automatically on the next start.
# --------------------------------------------------------------------------
DEVICES_FILE = os.path.join(APP_DIR, "devices.json")
FTP_TESTS_FILE = os.path.join(APP_DIR, "ftp_tests.json")    # FTP test results (ftp_test.py)
TRAINER_FILE = os.path.join(APP_DIR, "trainer.json")        # climb feel (trainer_control.py)

ROLES = ("trainer", "hr")
KIND_ORDER = {"trainer": 0, "hr": 1, "other": 2}


class Devices:
    """A choice per role is {"mode": "auto" | "device" | "off", "address", "name"}.
    auto = take the first trainer / heart-rate broadcaster found (first start),
    device = that device only, off = don't connect."""

    def __init__(self, live, args, demo=False):
        self.live, self.demo = live, demo
        self.runners = {}                 # role -> coroutine function (connect + stay connected)
        self.tasks = {}
        self.locks = {r: asyncio.Lock() for r in ROLES}
        self.scan_task = None
        self.saved = {} if demo else (_read_json(DEVICES_FILE) or {})
        self.choice = {}
        for role in ROLES:
            c = self.saved.get(role)
            ok = (isinstance(c, dict) and c.get("mode") in ("auto", "device", "off")
                  and (c["mode"] != "device" or c.get("address")))
            self.choice[role] = dict(c) if ok else {"mode": "auto"}
        # command-line options win for this run (and are not saved unless they connect)
        if args.address:
            self.choice["trainer"] = {"mode": "device", "address": args.address, "name": None}
        elif args.name:
            self.choice["trainer"] = {"mode": "auto"}
        if args.no_hr:
            self.choice["hr"] = {**self.choice["hr"], "mode": "off"}
        elif args.hr_address:
            self.choice["hr"] = {"mode": "device", "address": args.hr_address, "name": None}
        elif args.hr_name:
            self.choice["hr"] = {"mode": "auto"}
        live.status["devices"] = self.choice
        live.status["scan"] = {"state": None, "found": []}

    def _save(self, role):
        if self.demo:
            return
        self.saved[role] = self.choice[role]
        try:
            os.makedirs(APP_DIR, exist_ok=True)
            with open(DEVICES_FILE, "w") as fh:
                json.dump(self.saved, fh, indent=2)
        except OSError as e:
            print(f"Could not save {DEVICES_FILE}: {e}")

    def start(self, role):
        if self.choice[role]["mode"] == "off":
            if role == "trainer":
                self.live.trainer_address = None
                self.live.set_status(state="off", connected=False, device=None)
            else:
                self.live.set_hr_status(state="off", device=None)
            return
        self.tasks[role] = asyncio.create_task(self.runners[role]())

    async def stop(self, role):
        t = self.tasks.pop(role, None)
        if t:
            t.cancel()
            await asyncio.gather(t, return_exceptions=True)

    async def set(self, role, choice):
        """Switch a role to another device, to auto, or off (disconnects first)."""
        async with self.locks[role]:
            await self.stop(role)
            self.choice[role] = choice
            self._save(role)
            self.start(role)
            self.live.broadcast("status", self.live.status)
        other = "hr" if role == "trainer" else "trainer"
        oc = self.choice[other]
        if (choice["mode"] == "device" and oc["mode"] != "off"
                and (oc.get("address") or "").lower() == choice["address"].lower()):
            await self.set(other, {**oc, "mode": "off"})      # one device can't be both

    def remember(self, role, address, name):
        """Called on connect: this device is the one to reconnect next time."""
        c = self.choice[role]
        if c.get("mode") != "device" or c.get("address") != address or c.get("name") != name:
            self.choice[role] = {"mode": "device", "address": address, "name": name}
            self._save(role)

    def scan(self):
        if not (self.scan_task and not self.scan_task.done()):
            self.scan_task = asyncio.create_task(self._scan())

    async def _scan(self, seconds=6):
        """On demand only (device panel open), so Bluetooth isn't kept scanning."""
        st = self.live.status
        st["scan"] = {"state": "scanning", "found": st["scan"].get("found", [])}
        self.live.broadcast("status", st)
        try:
            if self.demo:
                await asyncio.sleep(2)
                found = [dict(d) for d in DEMO_FOUND]
            else:
                async with BLE_LOCK:
                    res = await BleakScanner.discover(timeout=seconds, return_adv=True)
                found = []
                for dev, adv in res.values():
                    name = adv_name(dev, adv)
                    kind = device_kind(name, adv.service_uuids)
                    if name or kind != "other":            # skip anonymous beacons
                        found.append({"address": dev.address, "name": name or None,
                                      "rssi": adv.rssi, "kind": kind})
            found.sort(key=lambda d: (KIND_ORDER[d["kind"]], -(d["rssi"] or -999)))
            st["scan"] = {"state": "done", "found": found}
        except asyncio.CancelledError:
            raise
        except Exception as e:
            st["scan"] = {"state": "error", "error": str(e), "found": []}
        self.live.broadcast("status", st)

    async def close(self):
        if self.scan_task:
            self.scan_task.cancel()
        for role in ROLES:
            await self.stop(role)


# --------------------------------------------------------------------------
# Bluetooth connections with auto-reconnect (one task per role)
# --------------------------------------------------------------------------
async def trainer_loop(args, live: Live, devices: Devices, raw_w, dec_w, t0):
    while True:
        client = None
        try:
            choice = devices.choice["trainer"]
            wanted = choice.get("name") if choice["mode"] == "device" else None
            live.set_status(state="searching", connected=False, device=wanted)
            print(f"Searching for {wanted or 'trainer'} ...")
            gone = asyncio.Event()
            async with BLE_LOCK:
                if choice["mode"] == "device":
                    dev = await find_chosen(choice, args.scan_time)
                else:
                    dev = await find_trainer(args.name, args.scan_time)
                if dev:
                    client = BleakClient(dev, disconnected_callback=lambda _c: gone.set())
                    await client.connect()
            if not dev:
                print("  not found - pedal to wake it, close other apps. Retrying ...")
                await asyncio.sleep(2)
                continue
            name = dev.name or choice.get("name") or dev.address
            live.trainer_address = dev.address
            devices.remember("trainer", dev.address, name)
            print(f"Connected to {name} [{dev.address}]")
            for calc in (cps_crank, cps_wheel, csc_crank, csc_wheel):
                calc.prev = None         # stale counters would give a fake rpm spike
            if not live.gatt_dumped:
                await dump_gatt(client, dev, args.out)
                live.gatt_dumped = True

            def make_handler(svc_uuid, ch):
                cname = uuid_name(ch.uuid)
                decoder = DECODERS.get(ch.uuid)

                def handler(_sender, data: bytearray):
                    ts = datetime.now(timezone.utc).isoformat()
                    el = round(time.monotonic() - t0, 3)
                    raw_w.writerow([ts, el, svc_uuid, ch.uuid, cname, ch.handle,
                                    len(data), data.hex()])
                    live.packets += 1
                    if live.control and data:
                        if ch.uuid.lower() == CONTROL_POINT:
                            live.control.on_indication(bytes(data))
                        elif ch.uuid.lower() == u16(0x2ADA):
                            live.control.on_status(data[0])
                    if decoder:
                        try:
                            row = decoder(bytes(data))
                            live.update(row)
                            row.update(timestamp_utc=ts, elapsed_s=el, source=cname)
                            dec_w.writerow(row)
                        except Exception as e:
                            print(f"[decode error {cname}: {e} data={data.hex()}]")
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
            live.set_status(state="connected", connected=True, device=name)
            if live.control:
                await live.control.attach(client)
            await gone.wait()
            print("Trainer disconnected - reconnecting ...")
        except asyncio.CancelledError:
            print("Trainer disconnected from the dashboard")
            raise
        except Exception as e:
            print(f"Bluetooth error: {e} - retrying ...")
        finally:
            if live.control:
                live.control.detach()
            if client is not None:
                try:
                    await client.disconnect()
                except Exception:
                    pass
        live.set_status(state="reconnecting", connected=False)
        await asyncio.sleep(3)


async def hr_loop(args, live: Live, devices: Devices, raw_w, dec_w, t0):
    """Second BLE connection to a heart-rate broadcaster (e.g. Garmin Forerunner
    with Broadcast Heart Rate on). Independent of the trainer, own reconnect."""
    hr_char = u16(0x2A37)
    told = False
    while True:
        client = None
        try:
            choice = devices.choice["hr"]
            live.set_hr_status(state="searching",
                               device=choice.get("name") if choice["mode"] == "device" else None)
            if not told:
                print("Looking for a heart-rate broadcast (watch: turn on Broadcast Heart Rate) ...")
                told = True
            gone = asyncio.Event()
            async with BLE_LOCK:
                if choice["mode"] == "device":
                    dev = await find_chosen(choice, args.scan_time, live.trainer_address)
                else:
                    dev = await find_hr(args.hr_name, args.scan_time, live.trainer_address)
                if dev:
                    client = BleakClient(dev, disconnected_callback=lambda _c: gone.set())
                    await client.connect()
            if not dev:
                await asyncio.sleep(5)
                continue
            name = dev.name or choice.get("name") or dev.address
            devices.remember("hr", dev.address, name)

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
            print(f"Heart-rate device {name} lost - reconnecting ...")
        except asyncio.CancelledError:
            raise
        except Exception as e:
            print(f"Heart-rate device error: {e} - retrying ...")
        finally:
            if client is not None:
                try:
                    await client.disconnect()
                except Exception:
                    pass
        live.set_hr_status(state="reconnecting")
        await asyncio.sleep(3)


# --------------------------------------------------------------------------
# Demo ride (no trainer needed): simulated devices, so the device panel works too
# --------------------------------------------------------------------------
DEMO_FOUND = [
    {"address": "DEMO-X2MAX", "name": "X2Max (demo)", "rssi": -54, "kind": "trainer"},
    {"address": "DEMO-FR165", "name": "Forerunner 165 (demo)", "rssi": -61, "kind": "hr"},
    {"address": "DEMO-HRM", "name": "HRM-Dual (demo)", "rssi": -83, "kind": "hr"},
    {"address": "DEMO-SPEAKER", "name": "Living room speaker", "rssi": -72, "kind": "other"},
]


def _demo_device(choice, default):
    return next((d for d in DEMO_FOUND if d["address"] == choice.get("address")), default)


async def demo_trainer(live: Live, devices: Devices):
    dev = _demo_device(devices.choice["trainer"], DEMO_FOUND[0])
    live.set_status(state="searching", connected=False, device=dev["name"])
    await asyncio.sleep(1.5)
    live.trainer_address = dev["address"]
    devices.remember("trainer", dev["address"], dev["name"])
    live.set_status(state="demo", connected=True, device=dev["name"])
    ctl = live.control
    if ctl:
        ctl.attach()
    t = 0
    try:
        while True:
            if t < 300:
                target = 110 + 90 * t / 300                # warm-up ramp
            else:
                c = (t - 300) % 420
                target = 285 if c < 240 else 155           # 4 min on / 3 min easy
            grade = (ctl.current_grade() if ctl else None) or 0
            if grade:                                      # the rider feels the trainer's grade
                grade = ctl.trainer_grade()
            erg = ctl and ctl.enabled and ctl.state == "on" and ctl.mode == "erg"
            if erg:
                target = ctl.power_w                       # ERG: the trainer holds the power
            else:
                target = max(60, target + 12 * grade)     # a climb makes the rider push harder
            p = max(0.0, random.gauss(target, 5 if erg else 14))
            cad = random.gauss((93 if target > 250 else 86) - 1.5 * max(grade, 0), 2)
            live.update({"power_w": p, "cadence_rpm": cad, "speed_kmh": demo_speed(p, grade)})
            t += 0.25
            await asyncio.sleep(0.25)                      # trainers send ~4 readings a second
    finally:
        if ctl:
            ctl.detach()


def demo_speed(power_w, grade_pct, mass_kg=85.0):
    """Road speed (km/h) for a power on a grade: air drag + rolling resistance + climbing.
    Solves 0.32 v^3 + m g (crr + grade) v = P for v (m/s) by bisection."""
    if power_w <= 0 and grade_pct >= 0:
        return 0.0
    k = mass_kg * 9.81 * (0.004 + grade_pct / 100)
    lo, hi = 0.0, 40.0
    for _ in range(40):
        v = (lo + hi) / 2
        if 0.32 * v ** 3 + k * v < power_w:
            lo = v
        else:
            hi = v
    return 3.6 * lo


async def demo_hr(live: Live, devices: Devices):
    dev = _demo_device(devices.choice["hr"], DEMO_FOUND[1])
    live.set_hr_status(state="searching", device=dev["name"])
    await asyncio.sleep(4)
    devices.remember("hr", dev["address"], dev["name"])
    live.set_hr_status(state="connected", device=dev["name"])
    hr = 92.0
    while True:                                            # simulated watch broadcast
        p = live._get("power_w", 3) or 0
        hr += ((62 + 0.42 * p) - hr) * 0.035 + random.gauss(0, 0.4)
        live.update_hr(hr)
        await asyncio.sleep(1)


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------
DEFAULT_PORT = 8000


def port_in_use(host, port):
    """True if something already answers on `port` or would stop us binding it.

    Binding 127.0.0.1 alone is not enough: on macOS that succeeds even while a Docker
    container listens on *:8000, and the browser's http://localhost:8000 then reaches the
    container ({"detail":"Not Found"}). So also try to connect on IPv4 and IPv6 loopback
    and to bind the wildcard address. SO_REUSEADDR so the leftovers of a logger that just
    stopped (TIME_WAIT) don't push us off 8000: a different port means a different origin,
    and the browser's saved FTP / weight / workout belong to the old one."""
    for family, addr in ((socket.AF_INET, "127.0.0.1"), (socket.AF_INET6, "::1")):
        try:
            with socket.socket(family, socket.SOCK_STREAM) as s:
                s.settimeout(0.3)
                if s.connect_ex((addr, port)) == 0:
                    return True
        except OSError:
            pass                              # no IPv6 here
    wildcard = "0.0.0.0" if host in ("127.0.0.1", "localhost", "0.0.0.0") else host
    try:
        family = socket.AF_INET6 if ":" in wildcard else socket.AF_INET
        with socket.socket(family, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind((wildcard, port))
    except OSError:
        return True
    return False


def pick_port(host, port=None, tries=20):
    """The port to serve the dashboard on. An explicit --port is used as given (with a
    clear error if it is taken); otherwise DEFAULT_PORT, or the next free port after it."""
    if port is not None:
        if port and port_in_use(host, port):
            raise OSError(f"Port {port} is already in use (another logger, or e.g. a Docker "
                          f"container). Leave out --port to pick a free one, or choose another.")
        return port
    for p in range(DEFAULT_PORT, DEFAULT_PORT + tries):
        if not port_in_use(host, p):
            if p != DEFAULT_PORT:
                print(f"Port {DEFAULT_PORT} is already in use by another program, "
                      f"so the dashboard is on port {p}.")
            return p
    raise OSError(f"Ports {DEFAULT_PORT} to {DEFAULT_PORT + tries - 1} are all in use. "
                  "Pass a free one with --port.")


async def main_async(args):
    global BLE_LOCK
    BLE_LOCK = asyncio.Lock()
    os.makedirs(args.out, exist_ok=True)
    live = Live(args.out)
    live.port = args.port
    live.devices = devices = Devices(live, args, demo=args.demo)
    live.control = DemoControl(live) if args.demo else TrainerControl(live, sim_file=TRAINER_FILE)
    live.ftp_tests = FtpTests(live, FTP_TESTS_FILE, demo=args.demo)
    load_env(os.path.join(ROOT, ".env"))       # ANTHROPIC_API_KEY, GARMIN_API_KEY
    live.coach = Coach()
    live.status["coach"] = live.coach.status()
    t0 = time.monotonic()

    # Stop button on the dashboard, closing the launcher's Terminal window (SIGHUP) or
    # a kill (SIGTERM) all end like Ctrl+C: a ride in progress is saved.
    main_task = asyncio.current_task()
    loop = asyncio.get_running_loop()
    live.quit = lambda: loop.call_later(0.3, main_task.cancel)
    for sig in (getattr(signal, "SIGHUP", None), signal.SIGTERM):
        if sig is not None:
            try:
                loop.add_signal_handler(sig, main_task.cancel)
            except (NotImplementedError, RuntimeError):
                pass                          # Windows

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

    if args.demo:
        devices.runners = {"trainer": lambda: demo_trainer(live, devices),
                           "hr": lambda: demo_hr(live, devices)}
    else:
        devices.runners = {"trainer": lambda: trainer_loop(args, live, devices, raw_w, dec_w, t0),
                           "hr": lambda: hr_loop(args, live, devices, raw_w, dec_w, t0)}
    for role in ROLES:
        devices.start(role)
    tasks = [asyncio.create_task(ticker(live, args.duration))]

    async def flusher():
        while True:
            await asyncio.sleep(2)
            raw_f.flush(); dec_f.flush()
    tasks.append(asyncio.create_task(flusher()))

    try:
        await tasks[0]                      # ticker ends only when --duration elapses
    finally:
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await live.control.close()        # trainer back to 0 %, control released
        await devices.close()
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
    p.add_argument("--fit-from", metavar="FOLDER",
                   help="only rebuild FOLDER/ride.fit from its session_1hz.csv, then exit")
    p.add_argument("--duration", type=float, default=0,
                   help="seconds to run, recording from the start (0 = until Ctrl+C)")
    p.add_argument("--scan-time", type=float, default=8, help="scan timeout in seconds")
    p.add_argument("--host", default="127.0.0.1", help="use 0.0.0.0 to view from phone/tablet")
    p.add_argument("--port", type=int, default=None,
                   help=f"dashboard port (default: {DEFAULT_PORT}, or the next free one if "
                   "something else, e.g. a Docker container, already uses it)")
    p.add_argument("--no-browser", action="store_true", help="don't open the dashboard automatically")
    p.add_argument("--out", default=os.path.join(ROOT, "rides", datetime.now().strftime("x2max_%Y%m%d_%H%M%S")),
                   help="output folder")
    args = p.parse_args()
    if args.fit_from:
        return fit_from_csv(args.fit_from)
    if not args.scan:
        try:
            args.port = pick_port(args.host, args.port)
        except OSError as e:
            sys.exit(str(e))
    if BleakScanner is None and not args.demo:
        sys.exit("bleak is not installed. Run with:  uv run logger/thinkrider_logger.py   (or try --demo)")
    try:
        asyncio.run(scan(args.scan_time) if args.scan else main_async(args))
    except (KeyboardInterrupt, asyncio.CancelledError):
        pass


if __name__ == "__main__":
    main()
