"""Ride and lap totals (NP, averages, work) and what ends up in the .FIT file."""
import csv
from datetime import datetime, timedelta, timezone

import pytest

import thinkrider_logger as tl
from helpers.fit import ACTIVITY, EVENT, FILE_ID, LAP, RECORD, SESSION, USER_PROFILE, messages, read_fit

T0 = datetime(2026, 3, 1, 9, 0, 0, tzinfo=timezone.utc)


def ride(powers, start=T0, gaps=None, **over):
    """1 Hz samples like Live.history. gaps: {index: extra seconds before that sample}."""
    out, t, dist = [], start, 0.0
    for i, p in enumerate(powers):
        t += timedelta(seconds=(gaps or {}).get(i, 0) + (1 if i else 0))
        dist += 30 / 3.6
        out.append({"t": i, "timestamp_utc": t.isoformat(timespec="seconds"), "lap": 1,
                    "power_w": p, "cadence_rpm": 90, "speed_kmh": 30.0, "heart_rate_bpm": 140,
                    "distance_m": round(dist, 1), "energy_kj": 0, **over})
    return out


def as_rows(hist):
    return [{"power_w": s["power_w"], "cadence_rpm": s["cadence_rpm"],
             "speed_kmh": s["speed_kmh"], "heart_rate_bpm": s["heart_rate_bpm"]} for s in hist]


class TestSummary:
    def test_steady_power(self):
        s = tl._summary(as_rows(ride([200] * 60)))
        assert s["avg_power"] == 200 and s["max_power"] == 200
        assert s["np"] == pytest.approx(200)
        assert s["work_j"] == 12000 and s["kcal"] == 12
        assert s["avg_spd"] == pytest.approx(30 / 3.6)

    def test_np_needs_30_seconds(self):
        assert tl._summary(as_rows(ride([200] * 29)))["np"] is None
        assert tl._summary(as_rows(ride([200] * 30)))["np"] == pytest.approx(200)

    def test_np_uses_full_30_s_windows_like_the_dashboard(self):
        # 30 s at 100 W then 30 s at 300 W: rolling averages 100, 106.7 ... 300 (31 windows).
        # Same numbers as dashboard/test/unit/ride.test.ts, so the .FIT and the page agree.
        rolls = [100 + 200 * k / 30 for k in range(31)]
        want = (sum(r ** 4 for r in rolls) / 31) ** 0.25
        assert tl._summary(as_rows(ride([100] * 30 + [300] * 30)))["np"] == pytest.approx(want)

    def test_np_is_above_average_for_intervals(self):
        s = tl._summary(as_rows(ride(([400] * 60 + [100] * 60) * 5)))
        assert s["avg_power"] == 250
        assert 280 < s["np"] < 330

    def test_missing_values(self):
        rows = as_rows(ride([None, 100], cadence_rpm=0, heart_rate_bpm=None, speed_kmh=None))
        s = tl._summary(rows)
        assert s["avg_power"] == 50                  # missing power counts as 0 W
        assert s["avg_cad"] is s["avg_hr"] is s["avg_spd"] is None

    def test_negative_power_adds_no_work(self):
        assert tl._summary(as_rows(ride([-20, 100])))["work_j"] == 100


class TestFitFile:
    def test_records_session_and_activity(self):
        data = tl.build_fit(ride([200] * 90), [0])
        assert tl.fit_crc(data) == 0
        recs = messages(data, RECORD)
        assert len(recs) == 90
        assert recs[0][7] == 200 and recs[0][3] == 140 and recs[0][4] == 90
        assert recs[0][6] == round(30 / 3.6 * 1000)  # speed in mm/s
        assert recs[-1][253] - recs[0][253] == 89
        (sess,) = messages(data, SESSION)
        assert sess[5] == 2 and sess[6] == 6        # cycling, indoor cycling
        assert sess[20] == 200 and sess[34] == 200 and sess[26] == 1
        assert sess[8] == 90_000                    # timer time in ms
        assert messages(data, FILE_ID)[0][0] == 4   # activity file
        assert messages(data, ACTIVITY)[0][1] == 1

    def test_laps_split_the_ride(self):
        hist = ride([150] * 40 + [300] * 40 + [100] * 20)
        laps = messages(tl.build_fit(hist, [0, 40, 80]), LAP)
        assert [lap[8] for lap in laps] == [40_000, 40_000, 20_000]
        assert [lap[19] for lap in laps] == [150, 300, 100]
        assert [lap[24] for lap in laps] == [0, 0, 7]   # last lap is the session end
        assert laps[1][9] == pytest.approx(40 * 30 / 3.6 * 100, abs=200)

    def test_bad_lap_indexes_are_ignored(self):
        laps = messages(tl.build_fit(ride([200] * 10), [0, 0, 10, 99, -1]), LAP)
        assert len(laps) == 1

    def test_dropout_pauses_the_timer(self):
        hist = ride([200] * 20, gaps={10: 30})      # trainer gone 30 s before sample 10
        data = tl.build_fit(hist, [0])
        events = [(m[253], m[1]) for m in messages(data, EVENT)]
        types = [t for _ts, t in events]
        assert types == [0, 4, 0, 4]                # start, stop_all, start, stop_all
        (sess,) = messages(data, SESSION)
        assert sess[8] == 20_000                    # timer: 20 s ridden
        assert sess[7] == 50_000                    # elapsed: incl. the 30 s pause

    def test_empty_ride_refuses(self, tmp_path):
        with pytest.raises(ValueError):
            tl.build_fit([], [0])
        assert tl.write_fit(str(tmp_path / "x.fit"), [], [0]) is False

    def test_rebuild_from_csv_matches(self, tmp_path):
        hist = ride([180] * 30 + [260] * 30)
        for s in hist[30:]:
            s["lap"] = 2
        for name in ("session_1hz.csv", "session_1hz_2.csv"):
            with open(tmp_path / name, "w", newline="") as fh:
                w = csv.DictWriter(fh, fieldnames=tl.SESSION_FIELDS)
                w.writeheader()
                w.writerows({**s, "grade_pct": ""} for s in hist)
        tl.fit_from_csv(str(tmp_path))
        data = (tmp_path / "ride.fit").read_bytes()
        assert (tmp_path / "ride_2.fit").exists()
        assert len(messages(data, RECORD)) == 60
        assert [lap[19] for lap in messages(data, LAP)] == [180, 260]

    def test_weight_in_user_profile(self):
        assert messages(tl.build_fit(ride([200] * 5), [0]), USER_PROFILE) == []        # no weight: left out
        (prof,) = messages(tl.build_fit(ride([200] * 5), [0], 68.4), USER_PROFILE)
        assert prof[4] == 684

    def test_rebuild_from_csv_keeps_weight(self, tmp_path):
        with open(tmp_path / "session_1hz.csv", "w", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=tl.CSV_FIELDS)
            w.writeheader()
            w.writerows({**s, "grade_pct": "", "weight_kg": 70.5} for s in ride([200] * 10))
        tl.fit_from_csv(str(tmp_path))
        (prof,) = messages((tmp_path / "ride.fit").read_bytes(), USER_PROFILE)
        assert prof[4] == 705

    def test_whole_file_parses(self):
        msgs = read_fit(tl.build_fit(ride([200] * 5), [0]))
        assert msgs[0][0] == FILE_ID and msgs[-1][0] == ACTIVITY
