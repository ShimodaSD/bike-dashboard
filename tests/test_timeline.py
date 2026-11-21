"""The 1 Hz timeline: what Live.tick records, previews and pauses, and the CSV it writes."""
import asyncio
import csv
import os

import pytest

import thinkrider_logger as tl


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


@pytest.fixture
def clock(monkeypatch):
    c = Clock()
    monkeypatch.setattr(tl.time, "monotonic", c)
    return c


@pytest.fixture
def live(tmp_path):
    lv = tl.Live(str(tmp_path))
    lv.status["connected"] = True
    yield lv
    lv.close()


class Tab:
    """A dashboard tab: collects the events the logger broadcasts."""

    def __init__(self, live, gap=0):
        self.q = asyncio.Queue(maxsize=600)
        self.q.live_gap, self.q.live_last = gap, 0.0
        live.clients.add(self.q)

    def events(self):
        out = []
        while not self.q.empty():
            head, data = self.q.get_nowait().decode().split("\n", 1)
            out.append((head[len("event: "):], data))
        return out

    def names(self):
        return [e for e, _ in self.events()]


def test_before_start_only_previews(live, clock):
    tab = Tab(live)
    live.update({"power_w": 180, "cadence_rpm": 85, "speed_kmh": 28.4})
    assert live.tick() is None
    assert live.history == []
    assert "preview" in tab.names()


def test_recording_one_sample_per_tick(live, clock, tmp_path):
    live.start_ride()
    for i in range(5):
        live.update({"power_w": 200 + i, "cadence_rpm": 90, "speed_kmh": 36.0})
        live.update_hr(140)
        clock.t += 1
        live.tick()
    assert [s["t"] for s in live.history] == [0, 1, 2, 3, 4]
    last = live.history[-1]
    assert last["power_w"] == 204
    assert last["heart_rate_bpm"] == 140
    assert last["distance_m"] == 50.0            # 36 km/h = 10 m/s for 5 s
    assert last["energy_kj"] == pytest.approx(1.01)
    assert last["lap"] == 1
    assert last["grade_pct"] is None             # no trainer control
    with open(tmp_path / "session_1hz.csv") as fh:
        rows = list(csv.DictReader(fh))
    assert len(rows) == 5 and rows[-1]["distance_m"] == "50.0"


def test_paused_while_disconnected(live, clock):
    live.start_ride()
    live.update({"power_w": 200})
    live.tick()
    live.status["connected"] = False
    assert live.tick() is None
    assert len(live.history) == 1


def test_stale_numbers_drop_to_zero(live, clock):
    live.start_ride()
    live.update({"power_w": 250, "cadence_rpm": 90, "speed_kmh": 30.0})
    clock.t += 3.5                               # trainer stopped sending
    s = live.tick()
    assert (s["power_w"], s["cadence_rpm"], s["speed_kmh"]) == (0, 0, 0)


def test_speed_unknown_until_trainer_sends_it(live, clock):
    live.start_ride()
    live.update({"power_w": 200})                # Cycling Power only: no speed field
    assert live.tick()["speed_kmh"] is None
    assert live.now()["speed_kmh"] is None


def test_watch_hr_beats_trainer_hr_and_zero_is_ignored(live, clock):
    live.update({"heart_rate_bpm": 0})           # trainer with no strap paired
    assert live.now()["heart_rate_bpm"] is None
    live.update({"heart_rate_bpm": 120})
    live.update_hr(150)
    assert live.now()["heart_rate_bpm"] == 150
    clock.t += 6                                 # watch silent > 5 s: trainer HR again (< 10 s)
    assert live.now()["heart_rate_bpm"] == 120
    clock.t += 5
    assert live.now()["heart_rate_bpm"] is None


def test_laps(live, clock):
    live.add_lap()                               # not recording: ignored
    live.start_ride()
    live.add_lap()                               # no samples yet: ignored
    assert live.laps == [0]
    for _ in range(3):
        live.tick()
    live.add_lap()
    live.add_lap()                               # same spot twice: one lap
    live.tick()
    assert live.laps == [0, 3]
    assert [s["lap"] for s in live.history] == [1, 1, 1, 2]


def test_second_ride_gets_its_own_csv(live, clock, tmp_path):
    live.start_ride()
    live.tick()
    live.finish_ride()
    live.start_ride()
    live.tick()
    live.tick()
    live.finish_ride()
    assert live.status["ride"]["n"] == 2
    assert os.path.exists(tmp_path / "session_1hz_2.csv")
    assert [s["t"] for s in live.history] == [0, 1]


def test_finish_with_no_samples_saves_nothing(live, clock):
    live.start_ride()
    assert live.finish_ride() is None
    assert live.status["ride"]["state"] == "finished"
    assert live.resume_ride() is False


def test_start_twice_keeps_the_ride(live, clock):
    live.start_ride()
    live.tick()
    live.start_ride()
    assert len(live.history) == 1


def test_clear_empties_without_saving(live, clock, tmp_path):
    live.start_ride()
    live.tick()
    live.clear()
    assert live.history == [] and live.status["ride"]["state"] == "ready"
    assert not any(p.suffix == ".fit" for p in tmp_path.iterdir())


def test_live_push_respects_tab_rate(live, clock):
    fast, slow = Tab(live), Tab(live, gap=0.5)
    for _ in range(4):
        live._send_live()
        clock.t += 0.2
    assert fast.names().count("live") == 4
    assert slow.names().count("live") == 2       # at 0 s and 0.6 s (gap 0.5 s)


def test_full_queue_does_not_block(live):
    tab = Tab(live)
    for _ in range(700):
        live.broadcast("status", {})
    assert tab.q.qsize() == 600


def test_ticker_runs_once_a_second_and_stops_after_duration(monkeypatch):
    ticks, sleeps = [], []
    clock = Clock()

    async def fake_sleep(d):
        sleeps.append(round(d, 3))
        clock.t += d

    class FakeLive:
        def tick(self):
            ticks.append(clock.t)

    monkeypatch.setattr(tl.time, "monotonic", clock)
    monkeypatch.setattr(tl.asyncio, "sleep", fake_sleep)
    asyncio.run(tl.ticker(FakeLive(), 3))
    assert len(ticks) == 3 and sleeps == [1.0, 1.0, 1.0]


def test_ticker_resyncs_after_laptop_sleep(monkeypatch):
    clock, sleeps, n = Clock(), [], [0]

    async def fake_sleep(d):
        sleeps.append(round(d, 3))
        clock.t += d
        if n[0] == 0:
            clock.t += 120                       # laptop slept 2 minutes
        n[0] += 1

    class FakeLive:
        def tick(self):
            pass

    monkeypatch.setattr(tl.time, "monotonic", clock)
    monkeypatch.setattr(tl.asyncio, "sleep", fake_sleep)
    asyncio.run(tl.ticker(FakeLive(), 125))
    assert sleeps[1] == 1.0                      # no burst of 120 catch-up ticks


def test_pause_stops_recording_and_continue_carries_on(live, clock):
    tab = Tab(live)
    live.start_ride()
    live.update({"power_w": 200, "speed_kmh": 36.0})
    live.tick()
    assert live.set_paused(True)
    assert live.status["ride"]["paused"] is True
    tab.events()
    for _ in range(3):                           # paused: live preview, nothing recorded
        assert live.tick() is None
    assert len(live.history) == 1
    assert live.distance_m == 10.0 and live.energy_kj == pytest.approx(0.2)
    assert "preview" in tab.names()
    assert not live.set_paused(True)             # already paused
    assert live.set_paused(False)
    s = live.tick()
    assert s["t"] == 1 and s["distance_m"] == 20.0


def test_pause_only_while_recording_and_reset_by_finish(live, clock):
    assert not live.set_paused(True)             # nothing to pause before Start
    live.start_ride()
    live.update({"power_w": 200})
    live.tick()
    live.set_paused(True)
    live.finish_ride()
    assert live.status["ride"]["paused"] is False
    assert live.resume_ride()
    assert live.paused is False and live.tick() is not None
