"""The loaded workout, kept by the logger so every browser sees the same one.

The dashboard parses the .zwo / .erg / .mrc file and POSTs the result to /workout; the logger
checks its shape, keeps it in status["workout"] and saves it to config/workout.json, so the
laptop and a phone on the same Wi-Fi follow the same steps, and it is still there after a
restart. An empty POST removes it. --demo keeps it in memory only.

status["workout"] = None | {"name": str, "total": seconds, "segs": [{"dur", "lo", "hi", "unit",
                    "cad", "hr", "spd", "grade", "name", "note"}, ...]}
"""
import json
import math
import os

MAX_BODY = 200_000                  # bytes: a long workout is ~30 KB
MAX_SEGS = 2000
SEG_NUMBERS = ("lo", "hi", "cad", "hr", "spd", "grade")
SEG_TEXT = ("name", "note")


def _num(v, lo, hi):
    if v is None:
        return None
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or not lo <= v <= hi:
        raise ValueError("bad number")
    return v


def clean(wo):
    """The workout with only the known fields, or ValueError if it isn't one."""
    if not isinstance(wo, dict) or not isinstance(wo.get("segs"), list) or not 0 < len(wo["segs"]) <= MAX_SEGS:
        raise ValueError("not a workout")
    segs = []
    for s in wo["segs"]:
        if not isinstance(s, dict):
            raise ValueError("bad step")
        seg = {"dur": _num(s.get("dur"), 0, 86_400) or 0, "unit": "w" if s.get("unit") == "w" else "ftp"}
        for k in SEG_NUMBERS:
            seg[k] = _num(s.get(k), -100, 5000)
        for k in SEG_TEXT:
            if isinstance(s.get(k), str):
                seg[k] = s[k][:200]
        segs.append(seg)
    name = wo.get("name") if isinstance(wo.get("name"), str) else "Workout"
    return {"name": name[:200], "segs": segs, "total": sum(s["dur"] for s in segs)}


class WorkoutStore:
    def __init__(self, live, path, demo=False):
        self.live, self.path, self.demo = live, path, demo
        saved = None
        if not demo:
            try:
                with open(path) as fh:
                    saved = clean(json.load(fh))
            except (OSError, ValueError):
                saved = None
        live.status["workout"] = saved

    def set(self, wo):
        """Load (a dict) or remove (None) the workout. ValueError if it isn't one."""
        wo = None if wo is None else clean(wo)
        if not self.demo:
            try:
                if wo is None:
                    if os.path.exists(self.path):
                        os.remove(self.path)
                else:
                    os.makedirs(os.path.dirname(self.path), exist_ok=True)
                    tmp = self.path + ".tmp"
                    with open(tmp, "w") as fh:
                        json.dump(wo, fh)
                    os.replace(tmp, self.path)
            except OSError as e:
                print(f"Could not save the workout: {e}")
        self.live.set_status(workout=wo)
