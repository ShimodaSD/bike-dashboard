"""The logger's web server: ride buttons, downloads, the event stream, and refusing other websites."""
import asyncio
import csv
import json

import pytest

import thinkrider_logger as tl
from helpers.fit import USER_PROFILE, messages
from helpers.http import next_event, open_events, request, serve


class StubControl:
    def __init__(self):
        self.calls = []

    def set_enabled(self, on):
        self.calls.append(("on", on))

    def set_grade(self, pct):
        self.calls.append(("grade", pct))

    def set_power(self, w):
        self.calls.append(("power", w))

    def to_flat(self, why):
        pass

    def current_grade(self):
        return None


@pytest.fixture
def live(tmp_path):
    lv = tl.Live(str(tmp_path))
    lv.status["connected"] = True
    lv.control = StubControl()
    yield lv
    lv.close()


def run(live, steps):
    async def go():
        async with serve(live) as port:
            return await steps(port)
    return asyncio.run(go())


class TestOriginProtection:
    """Any website you visit could POST to localhost:8000 (stop the logger, end the ride,
    drive the trainer). The server must only accept POSTs from its own page."""

    @pytest.mark.parametrize("origin", ["https://evil.example", "null", "http://127.0.0.1:1"])
    def test_other_sites_are_refused(self, live, origin):
        async def steps(port):
            for path in ("/start", "/finish", "/quit", "/clear", "/control?on=1", "/devices/scan"):
                code, _, _ = await request(port, "POST", path, {"Origin": origin})
                assert code == 403, path
        live.quit = lambda: pytest.fail("quit ran")
        run(live, steps)
        assert live.status["ride"]["state"] == "ready"
        assert live.control.calls == []

    def test_own_page_and_non_browser_clients_are_accepted(self, live):
        async def steps(port):
            code, _, _ = await request(port, "POST", "/start", {"Origin": f"http://127.0.0.1:{port}"})
            assert code == 200
            code, _, _ = await request(port, "POST", "/lap")             # curl: no Origin
            assert code == 200
        run(live, steps)
        assert live.recording

    def test_dns_rebinding_is_refused(self, live):
        """evil.example resolving to 127.0.0.1: Origin and Host match, but it isn't our page."""
        async def steps(port):
            host = f"evil.example:{port}"
            code, _, _ = await request(port, "POST", "/start", {"Host": host, "Origin": f"http://{host}"})
            assert code == 403
        run(live, steps)
        assert not live.recording

    @pytest.mark.parametrize("host", ["localhost", "192.168.1.20", "mac-mini.local", "[::1]"])
    def test_phone_on_the_wifi_is_accepted(self, live, host):
        async def steps(port):
            h = f"{host}:{port}"
            code, _, _ = await request(port, "POST", "/start", {"Host": h, "Origin": f"http://{h}"})
            assert code == 200
        run(live, steps)

    def test_get_page_works_from_anywhere(self, live):
        async def steps(port):
            code, hdr, body = await request(port, "GET", "/", {"Origin": "https://evil.example"})
            assert code == 200 and hdr["content-type"].startswith("text/html")
            assert b'<div id="root">' in body
        run(live, steps)


class TestRideEndpoints:
    def test_start_lap_finish_download_resume(self, live):
        async def steps(port):
            assert (await request(port, "POST", "/resume"))[0] == 409   # nothing yet
            code, _, body = await request(port, "GET", "/ride.fit")
            assert code == 409 and body == b"no ride recorded yet"
            await request(port, "POST", "/start")
            for _ in range(3):
                live.tick()
            await request(port, "POST", "/lap")
            live.tick()
            code, hdr, body = await request(port, "GET", "/ride.fit")     # ride so far
            assert code == 200 and body[8:12] == b".FIT"
            assert hdr["content-disposition"].startswith('attachment; filename="ride_')
            await request(port, "POST", "/finish")
            code, hdr, saved = await request(port, "GET", "/ride.fit")    # the saved file
            assert saved == open(live.fit_path, "rb").read()
            assert (await request(port, "POST", "/resume"))[0] == 200
            await request(port, "POST", "/clear")
        run(live, steps)
        assert live.laps == [0] and live.history == []

    def test_weight_goes_with_the_ride(self, live):
        """?kg= on Start is saved with the ride: status, every CSV row, the .FIT user profile."""
        async def steps(port):
            assert (await request(port, "POST", "/ride/weight?kg=70"))[0] == 409   # not recording
            await request(port, "POST", "/start?kg=72.46")
            assert live.status["ride"]["kg"] == 72.5
            live.tick()
            assert (await request(port, "POST", "/ride/weight?kg=71"))[0] == 200   # changed mid-ride
            live.tick()
            await request(port, "POST", "/finish")
            assert live.status["ride"]["kg"] == 71
            with open(live.sess_path, newline="") as fh:
                assert [r["weight_kg"] for r in csv.DictReader(fh)] == ["72.5", "71.0"]
            (prof,) = messages(open(live.fit_path, "rb").read(), USER_PROFILE)
            assert prof[4] == 710                                   # 0.1 kg units
            await request(port, "POST", "/clear")
            assert live.status["ride"]["kg"] is None
            for bad in ("", "abc", "nan", "5", "900"):              # missing or implausible: no weight
                await request(port, "POST", f"/start?kg={bad}")
                assert live.status["ride"]["kg"] is None, bad
                await request(port, "POST", "/clear")
        run(live, steps)

    def test_pause_and_continue(self, live):
        async def steps(port):
            assert (await request(port, "POST", "/pause?on=1"))[0] == 409   # not recording
            await request(port, "POST", "/start")
            live.tick()
            assert (await request(port, "POST", "/pause?on=1"))[0] == 200
            live.tick()
            assert len(live.history) == 1 and live.status["ride"]["paused"]
            assert (await request(port, "POST", "/pause?on=0"))[0] == 200
            live.tick()
            assert len(live.history) == 2 and not live.status["ride"]["paused"]
        run(live, steps)

    def test_unknown_and_wrong_method(self, live):
        async def steps(port):
            assert (await request(port, "GET", "/start"))[0] == 404
            assert (await request(port, "GET", "/nope"))[0] == 404
            assert (await request(port, "POST", "/quit"))[0] == 404     # no quit handler set
        run(live, steps)
        assert not live.recording


class TestControlEndpoint:
    def test_valid_commands(self, live):
        async def steps(port):
            for path in ("/control?on=1", "/control/grade?pct=6.5", "/control/power?w=210", "/control?on=0"):
                assert (await request(port, "POST", path))[0] == 200, path
        run(live, steps)
        assert live.control.calls == [("on", True), ("grade", 6.5), ("power", 210.0), ("on", False)]

    @pytest.mark.parametrize("path", ["/control", "/control?on=yes", "/control/grade", "/control/grade?pct=steep",
                                      "/control/grade?pct=nan", "/control/grade?pct=inf",
                                      "/control/power?w=-inf", "/control/power?w=NaN", "/control/other"])
    def test_bad_commands(self, live, path):
        async def steps(port):
            assert (await request(port, "POST", path))[0] == 400
        run(live, steps)
        assert live.control.calls == []


class TestDevicesEndpoint:
    def test_bad_requests(self, live):
        live.devices = object()
        async def steps(port):
            for path in ("/devices/use?role=trainer", "/devices/use?role=kettle&address=A",
                         "/devices/use?role=hr&address=" + "A" * 201, "/devices/explode?role=hr"):
                assert (await request(port, "POST", path))[0] == 400, path
        run(live, steps)


class TestEventStream:
    def test_init_then_live_updates(self, live):
        async def steps(port):
            r, w = await open_events(port)
            name, data = await next_event(r)
            assert name == "init" and json.loads(data)["status"]["connected"] is True
            await asyncio.sleep(0.05)
            live.update({"power_w": 222, "cadence_rpm": 91})
            name, data = await next_event(r)
            assert name == "live" and json.loads(data)["power_w"] == 222
            live.start_ride()
            assert (await next_event(r))[0] == "init"                  # Start resets the page
            live.tick()
            name, data = await next_event(r)
            while name == "live":
                name, data = await next_event(r)
            assert name == "sample" and json.loads(data)["t"] == 0
            w.close()
            for _ in range(3):                                         # a closed tab is dropped on
                live.broadcast("status", {})                           # the next write that fails
                await asyncio.sleep(0.05)
            assert live.clients == set()
        run(live, steps)

    def test_phone_rate_is_capped(self, live):
        async def steps(port):
            r, w = await open_events(port, "?live=2")
            await next_event(r)
            await asyncio.sleep(0.05)
            (q,) = live.clients
            assert q.live_gap == 0.5
            w.close()
        run(live, steps)

    def test_bad_rate_falls_back_to_unlimited(self, live):
        async def steps(port):
            r, w = await open_events(port, "?live=fast")
            await next_event(r)
            await asyncio.sleep(0.05)
            (q,) = live.clients
            assert q.live_gap == 0
            w.close()
        run(live, steps)
