"""FTP test: the protocol's timing, the FTP worked out from the 20 minutes, saving the
results on this computer, and the /ftp-test buttons."""
import asyncio
import json
import os
from datetime import datetime

import pytest

import ftp_test
import thinkrider_logger as tl
from helpers.http import next_event, open_events, request, serve

START, END = ftp_test.test_window()


@pytest.fixture
def live(tmp_path):
    lv = tl.Live(str(tmp_path / "ride"))
    os.makedirs(lv.out_dir, exist_ok=True)
    lv.status["connected"] = True
    lv.ftp_tests = ftp_test.FtpTests(lv, str(tmp_path / "config" / "ftp_tests.json"))
    yield lv
    lv.close()


def ride(live, seconds, power):
    """`seconds` recorded seconds at `power` (a number or a function of the second)."""
    for _ in range(seconds):
        t = len(live.history)
        live.vals["power_w"] = (power(t) if callable(power) else power, tl.time.monotonic())
        live.vals["cadence_rpm"] = (90, tl.time.monotonic())
        live.vals["heart_rate_bpm"] = (160, tl.time.monotonic())
        live.tick()


class TestProtocol:
    def test_the_20_minutes_follow_warm_up_hard_effort_and_recovery(self):
        assert (START, END) == (1500, 2700)
        assert END - START == 20 * 60
        assert sum(s["dur"] for s in ftp_test.PROTOCOL) == 3300      # 55 min with cool-down

    def test_hard_efforts_have_no_power_target(self):
        free = [s["name"] for s in ftp_test.PROTOCOL if s["lo"] is None]
        assert free == ["5 min hard", "20 min test"]


class TestResult:
    def test_ftp_is_95_percent_of_the_20_minute_average(self):
        samples = [{"power_w": 250, "heart_rate_bpm": 160, "cadence_rpm": 90}] * 1200
        r = ftp_test.result_from(samples, ftp_before=220, ride="x2max_1", when=datetime(2026, 11, 19, 7, 30))
        assert r["ftp"] == 238 and r["avg_w"] == 250
        assert r["ftp_before"] == 220 and r["ride"] == "x2max_1"
        assert r["id"] == "20261119-073000" and r["date"] == "2026-11-19T07:30:00"
        assert (r["avg_hr"], r["max_hr"], r["avg_cad"]) == (160, 160, 90)

    def test_coasting_seconds_count_against_the_average(self):
        samples = [{"power_w": 300}] * 600 + [{"power_w": 0}] * 600
        assert ftp_test.result_from(samples)["avg_w"] == 150

    def test_no_power_means_no_result(self):
        assert ftp_test.result_from([{"power_w": 0}] * 1200) is None
        assert ftp_test.result_from([]) is None

    def test_no_heart_rate_is_none(self):
        r = ftp_test.result_from([{"power_w": 200, "heart_rate_bpm": None}] * 10)
        assert r["avg_hr"] is None and r["max_hr"] is None


class TestRunningATest:
    def test_start_records_a_ride_with_the_test(self, live):
        assert live.ftp_tests.start(220)
        assert live.recording
        assert live.status["ftp"]["test"] == {"state": "running", "t0": 0, "ftp_before": 220, "result": None}
        assert live.status["ftp"]["protocol"] == ftp_test.PROTOCOL

    def test_cant_start_during_a_ride(self, live):
        live.start_ride()
        assert not live.ftp_tests.start(220)
        assert live.status["ftp"]["test"] is None

    def test_result_is_saved_when_the_20_minutes_end(self, live, tmp_path):
        live.ftp_tests.start(220)
        # easy before the test, 260 W during it: only the 20 minutes count
        ride(live, END - 1, lambda t: 260 if t >= START else 120)
        assert live.status["ftp"]["test"]["state"] == "running"
        ride(live, 1, 260)
        test = live.status["ftp"]["test"]
        assert test["state"] == "done"
        assert test["result"]["ftp"] == round(260 * 0.95) == 247
        assert test["result"]["ftp_before"] == 220
        saved = json.loads((tmp_path / "config" / "ftp_tests.json").read_text())
        assert saved["results"][0]["ftp"] == 247
        assert live.status["ftp"]["results"][0]["id"] == test["result"]["id"]
        assert live.recording                      # the cool-down is still part of the ride

    def test_results_survive_a_restart_newest_first(self, live, tmp_path):
        path = str(tmp_path / "config" / "ftp_tests.json")
        for w in (200, 240):
            live.ftp_tests.start(220)
            ride(live, END, w)
            live.finish_ride()
        again = ftp_test.FtpTests(tl.Live(str(tmp_path / "ride")), path)
        assert [r["ftp"] for r in again.results] == [228, 190]
        assert len({r["id"] for r in again.results}) == 2

    def test_finishing_early_stops_the_test_and_saves_nothing(self, live, tmp_path):
        live.ftp_tests.start(220)
        ride(live, START + 60, 250)
        live.finish_ride()
        assert live.status["ftp"]["test"]["state"] == "stopped"
        assert live.status["ftp"]["results"] == []
        assert not (tmp_path / "config" / "ftp_tests.json").exists()

    def test_resume_carries_on_with_the_test(self, live):
        live.ftp_tests.start(220)
        ride(live, START + 60, 250)
        live.finish_ride()
        assert live.resume_ride()
        assert live.status["ftp"]["test"]["state"] == "running"
        ride(live, END - START - 60, 250)
        assert live.status["ftp"]["test"]["result"]["ftp"] == 238

    def test_timer_pause_pauses_the_test(self, live):
        live.ftp_tests.start(220)
        ride(live, END - 5, 250)
        live.status["connected"] = False          # trainer lost: no seconds recorded
        for _ in range(30):
            live.tick()
        assert live.status["ftp"]["test"]["state"] == "running"

    def test_a_normal_start_or_clear_drops_the_test(self, live):
        live.ftp_tests.start(220)
        live.finish_ride()
        live.start_ride()
        assert live.status["ftp"]["test"] is None
        live.finish_ride()
        live.ftp_tests.start(220)
        live.clear()
        assert live.status["ftp"]["test"] is None

    def test_cancel_keeps_the_ride_going(self, live):
        live.ftp_tests.start(220)
        assert live.ftp_tests.cancel()
        assert live.recording and live.status["ftp"]["test"] is None
        assert not live.ftp_tests.cancel()

    def test_no_power_in_the_20_minutes_saves_nothing(self, live):
        live.ftp_tests.start(220)
        ride(live, END, 0)
        assert live.status["ftp"]["test"]["state"] == "done"
        assert live.status["ftp"]["test"]["result"] is None
        assert live.status["ftp"]["results"] == []

    def test_delete(self, live, tmp_path):
        live.ftp_tests.start(220)
        ride(live, END, 250)
        rid = live.status["ftp"]["results"][0]["id"]
        assert live.ftp_tests.delete(rid)
        assert live.status["ftp"]["results"] == []
        assert json.loads((tmp_path / "config" / "ftp_tests.json").read_text()) == {"results": []}
        assert not live.ftp_tests.delete(rid)


class TestSavedFile:
    def test_missing_or_broken_file_means_no_results(self, tmp_path):
        p = tmp_path / "ftp_tests.json"
        lv = tl.Live(str(tmp_path))
        assert ftp_test.FtpTests(lv, str(p)).results == []
        p.write_text("{not json")
        assert ftp_test.FtpTests(lv, str(p)).results == []
        p.write_text(json.dumps({"results": [{"id": "a", "ftp": 250}, {"ftp": "x"}, "junk"]}))
        assert ftp_test.FtpTests(lv, str(p)).results == [{"id": "a", "ftp": 250}]

    def test_demo_keeps_results_in_memory(self, tmp_path):
        p = tmp_path / "ftp_tests.json"
        p.write_text(json.dumps({"results": [{"id": "a", "ftp": 250}]}))
        lv = tl.Live(str(tmp_path))
        ft = ftp_test.FtpTests(lv, str(p), demo=True)
        assert ft.results == []
        ft.results = [{"id": "b", "ftp": 1}]
        ft._save()
        assert json.loads(p.read_text())["results"] == [{"id": "a", "ftp": 250}]


def run(live, steps):
    async def go():
        async with serve(live) as port:
            return await steps(port)
    return asyncio.run(go())


class TestHttp:
    def test_start_cancel_and_delete(self, live):
        async def steps(port):
            code, _, _ = await request(port, "POST", "/ftp-test/start?ftp=230")
            assert code == 200
            assert live.status["ftp"]["test"]["ftp_before"] == 230
            code, _, _ = await request(port, "POST", "/ftp-test/start?ftp=230")
            assert code == 409                           # already riding
            assert (await request(port, "POST", "/ftp-test/cancel"))[0] == 200
            assert (await request(port, "POST", "/ftp-test/delete?id=nope"))[0] == 409
            assert (await request(port, "POST", "/ftp-test/delete"))[0] == 400
            assert (await request(port, "POST", "/ftp-test/what"))[0] == 400
        run(live, steps)

    def test_odd_ftp_is_ignored(self, live):
        async def steps(port):
            assert (await request(port, "POST", "/ftp-test/start?ftp=nan"))[0] == 400
            assert (await request(port, "POST", "/ftp-test/start?ftp=9000"))[0] == 200
        run(live, steps)
        assert live.status["ftp"]["test"]["ftp_before"] is None

    def test_other_sites_are_refused(self, live):
        async def steps(port):
            code, _, _ = await request(port, "POST", "/ftp-test/start", {"Origin": "https://evil.example"})
            assert code == 403
        run(live, steps)
        assert not live.recording

    def test_results_are_in_the_init_event(self, live):
        live.ftp_tests.results = [{"id": "a", "ftp": 250}]
        live.ftp_tests._publish(broadcast=False)

        async def steps(port):
            reader, writer = await open_events(port)
            name, data = await next_event(reader)
            writer.close()
            return name, json.loads(data)
        name, data = run(live, steps)
        assert name == "init"
        assert data["status"]["ftp"]["results"] == [{"id": "a", "ftp": 250}]
