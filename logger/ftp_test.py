"""FTP test: a guided 20-minute test that ends with a new FTP, saved on this computer.

The protocol (about 55 min) is the classic 20-minute test:
  10 min warm-up (50 -> 70 % FTP), 5 min hard (clears the fresh legs that would
  inflate the 20 min), 10 min easy, 20 min all-out, 10 min cool-down.
FTP = 95 % of the average power over the 20 minutes. Seconds at 0 W count: coasting
lowers the average, like on a road test.

The test is a ride: Start FTP test on the dashboard starts recording and the test
follows the ride timer (it pauses with it). When the 20 minutes end, the result is
worked out and appended to config/ftp_tests.json, so every browser and device sees
the history. Finishing the ride before that stops the test without a result
(Resume picks it up again). --demo keeps its results in memory only.

status["ftp"] = {"test": None | {"state": "running" | "done" | "stopped", "t0",
                 "ftp_before", "result"}, "results": [...], "protocol": PROTOCOL,
                 "factor": FACTOR}
"""
import json
import os
from datetime import datetime

# Steps: lo / hi = power target at the step's start / end as a fraction of FTP;
# None = no target (the rider sets the power: hard efforts).
PROTOCOL = [
    {"name": "Warm-up", "dur": 600, "lo": 0.50, "hi": 0.70},
    {"name": "5 min hard", "dur": 300, "lo": None, "hi": None},
    {"name": "Easy", "dur": 600, "lo": 0.50, "hi": 0.50},
    {"name": "20 min test", "dur": 1200, "lo": None, "hi": None, "test": True},
    {"name": "Cool-down", "dur": 600, "lo": 0.50, "hi": 0.40},
]
FACTOR = 0.95
MAX_RESULTS = 200


def test_window(protocol=PROTOCOL):
    """(start, end) of the 20-minute step, in seconds from the start of the test."""
    t = 0
    for step in protocol:
        if step.get("test"):
            return t, t + step["dur"]
        t += step["dur"]
    raise ValueError("protocol has no test step")


def _avg(values):
    values = [v for v in values if v is not None]
    return sum(values) / len(values) if values else None


def result_from(samples, ftp_before=None, ride=None, when=None):
    """The test's result from the 20-minute step's 1 Hz samples (None if no power)."""
    if not samples:
        return None
    avg_w = sum(s.get("power_w") or 0 for s in samples) / len(samples)
    if avg_w <= 0:
        return None
    when = when or datetime.now()
    hrs = [s.get("heart_rate_bpm") for s in samples if s.get("heart_rate_bpm")]
    cad = _avg([s.get("cadence_rpm") for s in samples])
    return {
        "id": when.strftime("%Y%m%d-%H%M%S"),
        "date": when.isoformat(timespec="seconds"),
        "ftp": round(avg_w * FACTOR),
        "avg_w": round(avg_w, 1),
        "max_w": max(s.get("power_w") or 0 for s in samples),
        "avg_hr": None if not hrs else round(_avg(hrs)),
        "max_hr": max(hrs) if hrs else None,
        "avg_cad": None if cad is None else round(cad),
        "ftp_before": ftp_before,
        "ride": ride,
    }


class FtpTests:
    def __init__(self, live, path, demo=False):
        self.live, self.path, self.demo = live, path, demo
        self.results = [] if demo else self._load()
        self.test = None
        self._publish(broadcast=False)

    def _load(self):
        try:
            with open(self.path) as fh:
                data = json.load(fh)
        except (OSError, ValueError):
            return []
        items = data.get("results") if isinstance(data, dict) else None
        return [r for r in items if isinstance(r, dict) and isinstance(r.get("ftp"), (int, float))
                and r.get("id")] if isinstance(items, list) else []

    def _save(self):
        if self.demo:
            return
        try:
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            tmp = self.path + ".tmp"
            with open(tmp, "w") as fh:
                json.dump({"results": self.results}, fh, indent=2)
            os.replace(tmp, self.path)
        except OSError as e:
            print(f"Could not save {self.path}: {e}")

    def _publish(self, broadcast=True):
        self.live.status["ftp"] = {"test": self.test, "results": self.results,
                                   "protocol": PROTOCOL, "factor": FACTOR}
        if broadcast:
            self.live.broadcast("status", self.live.status)

    # -- buttons -----------------------------------------------------------
    def start(self, ftp_before=None):
        """Start FTP test: a new ride with the test from its first second."""
        if self.live.recording:
            return False
        self.live.start_ride()                 # calls on_ride_start(), which clears an old test
        self.test = {"state": "running", "t0": 0, "ftp_before": ftp_before, "result": None}
        print("FTP test started")
        self._publish()
        return True

    def cancel(self):
        """Stop test: the ride carries on as a normal ride, nothing is saved."""
        if not self.test:
            return False
        self.test = None
        self._publish()
        return True

    def delete(self, rid):
        n = len(self.results)
        self.results = [r for r in self.results if r.get("id") != rid]
        if len(self.results) == n:
            return False
        self._save()
        self._publish()
        return True

    # -- ride events (called by Live) ----------------------------------------
    def on_ride_start(self):
        if self.test:
            self.test = None
            self._publish()

    def on_ride_finish(self):
        if self.test and self.test["state"] == "running":
            self.test = {**self.test, "state": "stopped"}
            print("FTP test stopped before the 20 minutes ended: no result")
            self._publish()

    def on_ride_resume(self):
        if self.test and self.test["state"] == "stopped":
            self.test = {**self.test, "state": "running"}
            self._publish()

    def on_sample(self):
        """After each recorded second: when the 20 minutes are over, save the result."""
        if not self.test or self.test["state"] != "running":
            return
        start, end = test_window()
        t0 = self.test["t0"]
        hist = self.live.history
        if len(hist) - t0 < end:
            return
        res = result_from(hist[t0 + start:t0 + end], self.test.get("ftp_before"),
                          self.live.status["ride"].get("dir"))
        if res:
            if any(r["id"] == res["id"] for r in self.results):
                res["id"] += f"-{len(self.results)}"
            self.results = ([res] + self.results)[:MAX_RESULTS]
            self._save()
            print(f"FTP test done: 20 min at {res['avg_w']:.0f} W -> FTP {res['ftp']} W")
        else:
            print("FTP test done, but there was no power in the 20 minutes: nothing saved")
        self.test = {**self.test, "state": "done", "result": res}
        self._publish()
