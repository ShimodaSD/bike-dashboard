"""The loaded workout lives in the logger, so the laptop and a phone follow the same steps."""
import asyncio
import json

import pytest

import thinkrider_logger as tl
import workout_store
from helpers.http import request, serve

WO = {"name": "Sweet spot", "total": 999, "segs": [
    {"dur": 600, "lo": 0.5, "hi": 0.7, "unit": "ftp", "cad": None, "name": "Warm-up", "extra": "dropped"},
    {"dur": 300, "lo": 180, "hi": 180, "unit": "w", "cad": 90, "hr": None, "name": "Steady"},
]}


@pytest.fixture
def live(tmp_path):
    lv = tl.Live(str(tmp_path / "rides"))
    lv.workout = workout_store.WorkoutStore(lv, str(tmp_path / "config" / "workout.json"))
    yield lv
    lv.close()


def post(live, body):
    async def go():
        async with serve(live) as port:
            return (await request(port, "POST", "/workout", body=body))[0]
    return asyncio.run(go())


def test_load_is_shared_saved_and_cleaned(live, tmp_path):
    assert live.status["workout"] is None
    assert post(live, json.dumps(WO).encode()) == 200
    wo = live.status["workout"]
    assert wo["name"] == "Sweet spot" and wo["total"] == 900          # total is worked out again
    assert "extra" not in wo["segs"][0] and wo["segs"][1]["unit"] == "w"
    again = workout_store.WorkoutStore(tl.Live(str(tmp_path / "r2")), live.workout.path)
    assert again.live.status["workout"] == wo                          # still there after a restart


def test_empty_post_removes_it(live, tmp_path):
    post(live, json.dumps(WO).encode())
    assert post(live, b"") == 200
    assert live.status["workout"] is None
    assert not (tmp_path / "config" / "workout.json").exists()


@pytest.mark.parametrize("body", [b"not json", b"[]", json.dumps({"segs": []}).encode(),
                                  json.dumps({"segs": [{"dur": float("1e9")}]}).encode(),
                                  json.dumps({"segs": [{"dur": 60, "lo": "x"}]}).encode()])
def test_bad_workouts_are_refused(live, body):
    assert post(live, body) == 400
    assert live.status["workout"] is None


def test_other_sites_cannot_load_one(live):
    async def go():
        async with serve(live) as port:
            return (await request(port, "POST", "/workout", {"Origin": "https://evil.example"}, json.dumps(WO).encode()))[0]
    assert asyncio.run(go()) == 403


def test_demo_keeps_it_in_memory(tmp_path):
    lv = tl.Live(str(tmp_path / "rides"))
    st = workout_store.WorkoutStore(lv, str(tmp_path / "config" / "workout.json"), demo=True)
    st.set(WO)
    assert lv.status["workout"]["name"] == "Sweet spot"
    assert not (tmp_path / "config").exists()
    lv.close()
