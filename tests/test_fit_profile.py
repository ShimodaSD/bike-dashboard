"""The .FIT file read back with fitdecode, an independent decoder that uses Garmin's FIT profile
(field names, scales, units, CRC). tests/helpers/fit.py reads it with this repo's own field table,
so a wrong field number or scale there would go unnoticed; here it would not."""
import io
from datetime import datetime, timedelta, timezone

import fitdecode
import pytest

import thinkrider_logger as tl

T0 = datetime(2026, 3, 1, 9, 0, 0, tzinfo=timezone.utc)


def ride(powers, pause_at=None, pause_s=0):
    """1 Hz samples at 30 km/h and 140 bpm; a pause of `pause_s` seconds before sample `pause_at`."""
    out, dist = [], 0.0
    for i, p in enumerate(powers):
        t = T0 + timedelta(seconds=i + (pause_s if pause_at is not None and i >= pause_at else 0))
        dist += 30 / 3.6
        out.append({"t": i, "timestamp_utc": t.isoformat(timespec="seconds"), "lap": 1, "power_w": p,
                    "cadence_rpm": 90, "speed_kmh": 30.0, "heart_rate_bpm": 140,
                    "distance_m": round(dist, 1), "energy_kj": 0})
    return out


def decode(data):
    msgs = []
    with fitdecode.FitReader(io.BytesIO(data), check_crc=fitdecode.CrcCheck.ENABLED) as fr:
        for frame in fr:
            if isinstance(frame, fitdecode.FitDataMessage):
                msgs.append((frame.name, {f.name: f.value for f in frame.fields}))
    return msgs


def only(msgs, name):
    return [m for n, m in msgs if n == name]


@pytest.fixture(scope="module")
def two_laps_with_pause():
    # lap 1: 60 s at 200 W; a 30 s pause; lap 2: 60 s at 300 W
    return decode(tl.build_fit(ride([200] * 60 + [300] * 60, pause_at=60, pause_s=30), [0, 60]))


def test_header_and_data_crc_are_valid(two_laps_with_pause):
    assert only(two_laps_with_pause, "file_id")[0]["type"] == "activity"


def test_session_totals_in_profile_units(two_laps_with_pause):
    s = only(two_laps_with_pause, "session")[0]
    assert (s["sport"], s["sub_sport"]) == ("cycling", "indoor_cycling")
    assert s["total_timer_time"] == 120.0              # s, the pause left out
    assert s["total_elapsed_time"] == 150.0            # s, the pause included
    assert s["total_distance"] == pytest.approx(1000.0)  # m: 120 s at 30 km/h
    assert s["avg_speed"] == pytest.approx(8.333, abs=1e-3)   # m/s
    assert s["avg_power"] == 250 and s["max_power"] == 300
    assert s["total_work"] == 30000                    # J = 200 W x 60 s + 300 W x 60 s
    assert s["total_calories"] == round(30 * 5.3 / 4.184)   # kcal: 30 kJ of work at ~19 % efficiency
    assert s["avg_heart_rate"] == 140 and s["avg_cadence"] == 90
    assert s["num_laps"] == 2 and s["trigger"] == "activity_end"
    # NP: 30 s rolling average over the 120 samples (the pause joins them), 4th-power mean
    pw = [200] * 60 + [300] * 60
    roll = [sum(pw[i - 29:i + 1]) / 30 for i in range(29, 120)]
    assert s["normalized_power"] == round((sum(r ** 4 for r in roll) / len(roll)) ** 0.25)


def test_laps(two_laps_with_pause):
    l1, l2 = only(two_laps_with_pause, "lap")
    assert (l1["avg_power"], l1["total_work"], l1["lap_trigger"]) == (200, 12000, "manual")
    assert (l2["avg_power"], l2["total_work"], l2["lap_trigger"]) == (300, 18000, "session_end")
    assert l1["total_timer_time"] == l2["total_timer_time"] == 60.0
    assert l1["total_distance"] == pytest.approx(500.0) and l2["total_distance"] == pytest.approx(500.0)
    assert l1["normalized_power"] == 200 and l2["normalized_power"] == 300


def test_pause_is_a_timer_stop_and_start(two_laps_with_pause):
    ev = [(e["timestamp"] - T0).total_seconds() for e in only(two_laps_with_pause, "event")]
    types = [e["event_type"] for e in only(two_laps_with_pause, "event")]
    assert list(zip(types, ev)) == [("start", 0), ("stop_all", 59), ("start", 90), ("stop_all", 149)]


def test_records(two_laps_with_pause):
    recs = only(two_laps_with_pause, "record")
    assert len(recs) == 120
    r = recs[0]
    assert (r["power"], r["heart_rate"], r["cadence"]) == (200, 140, 90)
    assert r["speed"] == pytest.approx(8.333, abs=1e-3) and r["distance"] == pytest.approx(8.3, abs=0.01)


def test_activity_totals(two_laps_with_pause):
    a = only(two_laps_with_pause, "activity")[0]
    assert a["total_timer_time"] == 120.0 and a["num_sessions"] == 1
