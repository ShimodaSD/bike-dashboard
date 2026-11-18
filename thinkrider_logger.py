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
  7. Serves a live dashboard at http://localhost:8000  (power, cadence, speed,
     HR, zones, NP/TSS, laps, live charts). Reconnects automatically if the
     trainer drops. Passive: never writes to the trainer.

Requirements
  pip install bleak
  dashboard.html must sit in the same folder as this script.

Usage
  python thinkrider_logger.py                 # find trainer, log + dashboard
  python thinkrider_logger.py --demo          # fake ride, to try the dashboard
  python thinkrider_logger.py --scan          # list nearby BLE devices
  python thinkrider_logger.py --host 0.0.0.0  # open dashboard from a phone/tablet
                                              # on the same Wi-Fi: http://<PC-IP>:8000
  Other options: --name X2MAX  --address AA:BB:..  --port 8000  --out ride1
                 --duration 3600  --no-browser

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
        self.status = {"state": "starting", "connected": False, "device": None}
        self.distance_m = 0.0
        self.energy_kj = 0.0
        self.packets = 0
        self.sess_f = open(os.path.join(out_dir, "session_1hz.csv"), "w", newline="")
        self.sess_w = csv.DictWriter(self.sess_f, fieldnames=SESSION_FIELDS)
        self.sess_w.writeheader()

    # -- inputs ------------------------------------------------------------
    def update(self, row: dict):
        now = time.monotonic()
        for k in ("power_w", "cadence_rpm", "speed_kmh", "heart_rate_bpm"):
            v = row.get(k)
            if v is None or (k == "heart_rate_bpm" and v <= 0):
                continue                     # FTMS sends HR 0 when no strap is paired
            self.vals[k] = (v, now)

    def _get(self, k, max_age):
        v = self.vals.get(k)
        if v and time.monotonic() - v[1] <= max_age:
            return v[0]
        return None

    def set_status(self, **kw):
        self.status.update(kw)
        self.broadcast("status", self.status)

    def add_lap(self):
        if len(self.history) > self.laps[-1]:
            self.laps.append(len(self.history))
            self.broadcast("laps", self.laps)

    # -- 1 Hz timeline -----------------------------------------------------
    def tick(self):
        if not self.status.get("connected"):
            return                                  # paused while disconnected
        power = self._get("power_w", 3) or 0
        cad = self._get("cadence_rpm", 3) or 0
        spd = self._get("speed_kmh", 3)
        hr = self._get("heart_rate_bpm", 10)
        spd = 0 if spd is None and ("speed_kmh" in self.vals) else spd
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
        path = path.split("?")[0]

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

        if path == "/lap" and method == "POST":
            live.add_lap()
            body, ctype, code = b"ok", "text/plain", "200 OK"
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
                     f"Content-Length: {len(body)}\r\nCache-Control: no-store\r\n"
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
# Bluetooth loop with auto-reconnect
# --------------------------------------------------------------------------
async def ble_loop(args, live: Live, raw_w, dec_w, t0):
    first = True
    while True:
        try:
            live.set_status(state="searching", connected=False)
            print("Searching for trainer ...")
            dev = await find_trainer(args.name, args.address, args.scan_time)
            if not dev:
                print("  not found - pedal to wake it, close other apps. Retrying ...")
                await asyncio.sleep(2)
                continue
            gone = asyncio.Event()
            async with BleakClient(dev, disconnected_callback=lambda _c: gone.set()) as client:
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
            print("Trainer disconnected - reconnecting ...")
        except asyncio.CancelledError:
            raise
        except Exception as e:
            print(f"Bluetooth error: {e} - retrying ...")
        live.set_status(state="reconnecting", connected=False)
        await asyncio.sleep(3)


# --------------------------------------------------------------------------
# Demo ride (no trainer needed)
# --------------------------------------------------------------------------
async def demo_loop(live: Live):
    live.set_status(state="demo", connected=True, device="Demo ride")
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
        live.update({"power_w": p, "cadence_rpm": cad, "speed_kmh": spd,
                     "heart_rate_bpm": hr})
        t += 1
        await asyncio.sleep(1)


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------
async def main_async(args):
    os.makedirs(args.out, exist_ok=True)
    live = Live(args.out)
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
    print(f"Saving to ./{args.out}/   -   Ctrl+C to stop\n")
    if not args.no_browser:
        webbrowser.open(url)

    source = demo_loop(live) if args.demo else ble_loop(args, live, raw_w, dec_w, t0)
    tasks = [asyncio.create_task(source), asyncio.create_task(ticker(live, args.duration))]

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
        raw_f.close(); dec_f.close(); live.close()
        h = live.history
        if h:
            n = len(h)
            avg = sum(s["power_w"] for s in h) / n
            print(f"\nRide: {n // 60}:{n % 60:02d}  avg {avg:.0f} W  "
                  f"{h[-1]['distance_m'] / 1000:.2f} km  {h[-1]['energy_kj']:.0f} kJ")
        files = "session_1hz.csv" if args.demo else \
            "session_1hz.csv, decoded.csv, raw_packets.csv, gatt_dump.json"
        print(f"Files in ./{args.out}/ : {files}")


def main():
    p = argparse.ArgumentParser(description="Log all BLE data from a ThinkRider X2Max + live dashboard")
    p.add_argument("--scan", action="store_true", help="only list nearby BLE devices")
    p.add_argument("--demo", action="store_true", help="simulate a ride (no trainer needed)")
    p.add_argument("--name", help="part of the device name to match (default: think/x2)")
    p.add_argument("--address", help="exact BLE address (MAC on Win/Linux, UUID on macOS)")
    p.add_argument("--duration", type=float, default=0, help="seconds to record (0 = until Ctrl+C)")
    p.add_argument("--scan-time", type=float, default=8, help="scan timeout in seconds")
    p.add_argument("--host", default="127.0.0.1", help="use 0.0.0.0 to view from phone/tablet")
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--no-browser", action="store_true", help="don't open the dashboard automatically")
    p.add_argument("--out", default=datetime.now().strftime("x2max_%Y%m%d_%H%M%S"),
                   help="output folder")
    args = p.parse_args()
    if BleakScanner is None and not args.demo:
        sys.exit("bleak is not installed. Run:  pip install bleak   (or try --demo)")
    try:
        asyncio.run(scan(args.scan_time) if args.scan else main_async(args))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
