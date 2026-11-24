"""
fec.py - ANT+ FE-C pages over Bluetooth, the private protocol of Tacx smart trainers.

Tacx trainers (Flow Smart, Vortex, Neo, Flux ...) carry the ANT+ Fitness Equipment pages
inside a Bluetooth service of their own. Newer firmware also speaks FTMS, which the logger
prefers; this is the fallback for a Tacx without an FTMS control point.

  service  6E40FEC1-B5A3-F393-E0A9-E50E24DCCA9E
  FEC2     notify: trainer -> logger (data pages 16 and 25, command echoes)
  FEC3     write:  logger -> trainer (pages 49, 50, 51)

Each message is an ANT broadcast frame: A4 09 4E 05 <8-byte page> <xor checksum>.

Pages used (ANT+ FE-C profile):
  16  General FE data       speed (0.001 m/s), distance, elapsed time
  25  Specific trainer data cadence (rpm), instantaneous power (W, 12 bits)
  49  Target power          ERG, 0.25 W units
  50  Wind resistance       cw (0.01 kg/m), wind speed (km/h, offset 127), drafting
  51  Track resistance      grade (0.01 %, offset -200 %), rolling resistance (5e-5 units)
"""

import struct


def _uuid(short: int) -> str:
    return f"6e40{short:04x}-b5a3-f393-e0a9-e50e24dcca9e"


FEC_SVC = _uuid(0xFEC1)
FEC_NOTIFY = _uuid(0xFEC2)
FEC_WRITE = _uuid(0xFEC3)

SYNC, MSG_BROADCAST, CHANNEL = 0xA4, 0x4E, 0x05
PAGE_GENERAL, PAGE_TRAINER = 0x10, 0x19
PAGE_TARGET_POWER, PAGE_WIND, PAGE_TRACK = 0x31, 0x32, 0x33


# --------------------------------------------------------------------------
# Frames
# --------------------------------------------------------------------------
def frame(page: bytes) -> bytes:
    """Wrap one 8-byte page in an ANT broadcast message with its checksum."""
    if len(page) != 8:
        raise ValueError("an FE-C page is 8 bytes")
    body = bytes([SYNC, 9, MSG_BROADCAST, CHANNEL]) + page
    x = 0
    for b in body:
        x ^= b
    return body + bytes([x])


def unframe(data: bytes):
    """The 8-byte page inside a notification, or None when it isn't a valid frame."""
    if len(data) < 13 or data[0] != SYNC or data[2] != MSG_BROADCAST:
        return None
    n = data[1]                       # channel + page bytes
    if n < 9 or len(data) < 3 + n:
        return None
    x = 0
    for b in data[:3 + n]:
        x ^= b
    if len(data) > 3 + n and data[3 + n] != x:   # checksum present and wrong
        return None
    return bytes(data[4:12])


# --------------------------------------------------------------------------
# Commands (logger -> trainer)
# --------------------------------------------------------------------------
def cmd_track(grade_pct: float, crr: float = 0.004) -> bytes:
    """Page 51: road grade and rolling resistance."""
    raw = max(0, min(40000, round((grade_pct + 200) * 100)))
    c = max(0, min(254, round(crr / 5e-5)))
    return frame(bytes([PAGE_TRACK, 0xFF, 0xFF, 0xFF, 0xFF]) + struct.pack("<H", raw) + bytes([c]))


def cmd_wind(cw: float = 0.51, wind_kmh: float = 0.0, drafting: float = 1.0) -> bytes:
    """Page 50: wind resistance coefficient (kg/m), wind speed, drafting factor."""
    c = max(0, min(186, round(cw * 100)))
    w = max(0, min(254, round(wind_kmh + 127)))
    d = max(0, min(100, round(drafting * 100)))
    return frame(bytes([PAGE_WIND, 0xFF, 0xFF, 0xFF, 0xFF, c, w, d]))


def cmd_target_power(watts: float) -> bytes:
    """Page 49: ERG target in 0.25 W units."""
    raw = max(0, min(16000, round(watts * 4)))
    return frame(bytes([PAGE_TARGET_POWER, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]) + struct.pack("<H", raw))


# --------------------------------------------------------------------------
# Data (trainer -> logger)
# --------------------------------------------------------------------------
def decode(data: bytes) -> dict:
    """Riding data from a FEC2 notification, in the same keys as the FTMS decoders."""
    p = unframe(data)
    if p is None:
        return {}
    out = {"fec_page": p[0]}
    if p[0] == PAGE_GENERAL:
        speed = struct.unpack_from("<H", p, 4)[0]
        if speed != 0xFFFF:
            out["speed_kmh"] = round(speed * 0.0036, 2)
        if p[6] not in (0x00, 0xFF):
            out["heart_rate_bpm"] = p[6]
    elif p[0] == PAGE_TRAINER:
        if p[2] != 0xFF:
            out["cadence_rpm"] = p[2]
        power = p[5] | (p[6] & 0x0F) << 8
        if power != 0xFFF:
            out["power_w"] = power
    return out
