"""Claude ride evaluation (coach.py), Garmin rides (garmin_rides.py), .env loading and POST /coach.
No network: Claude and Garmin are fakes."""
import asyncio
import json
import os
from types import SimpleNamespace

import pytest

import coach as coach_mod
import garmin_rides
import thinkrider_logger as tl
from env import load_env
from helpers.http import request, serve

REVIEW = {"headline": "Solid endurance ride.", "verdict": "good", "went_well": ["Even pacing"],
          "to_improve": ["Drink more"], "load": "Moderate week.", "next_session": "60 min Z2 at 150-170 W."}
RIDE = {"ride": {"start": "2026-11-18T21:30:00Z", "duration_s": 3600, "np_w": 165}, "local_review": {"kind": "Endurance ride"}}


class FakeMessages:
    def __init__(self, text=json.dumps(REVIEW), stop="end_turn"):
        self.text, self.stop, self.calls = text, stop, []

    def create(self, **kw):
        self.calls.append(kw)
        return SimpleNamespace(stop_reason=self.stop, model=kw["model"],
                               content=[SimpleNamespace(type="thinking", thinking=""), SimpleNamespace(type="text", text=self.text)])


def fake_client(**kw):
    m = FakeMessages(**kw)
    return SimpleNamespace(beta=SimpleNamespace(messages=m)), m


class FakeGarmin:
    def __init__(self, rows=None, err=None, configured=True):
        self.rows, self.err, self._configured = rows or [], err, configured

    def configured(self):
        return self._configured

    def context(self):
        if self.err:
            raise garmin_rides.GarminError(self.err)
        return {"activities": self.rows, "sleep": [{"calendarDate": "2026-11-18", "sleepScore": 81}], "hrv": []}


def row(date, name="Ride", tss=60):
    return {"date": date, "name": name, "type": "virtual_ride", "cycling": True, "tss": tss}


# ---------------------------------------------------------------- .env
def test_load_env_reads_keys_and_keeps_existing(tmp_path, monkeypatch):
    f = tmp_path / ".env"
    f.write_text('# keys\nANTHROPIC_API_KEY="sk-test"\nexport GARMIN_EMAIL=me@example.com  # mine\nGARMIN_PASSWORD=\'p#ss\'\nJUNK\n')
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("GARMIN_PASSWORD", raising=False)
    monkeypatch.setenv("GARMIN_EMAIL", "already@set")
    assert load_env(str(f)) == ["ANTHROPIC_API_KEY", "GARMIN_EMAIL", "GARMIN_PASSWORD"]
    assert os.environ["ANTHROPIC_API_KEY"] == "sk-test"
    assert os.environ["GARMIN_EMAIL"] == "already@set"        # the environment wins
    assert os.environ["GARMIN_PASSWORD"] == "p#ss"


def test_load_env_missing_file(tmp_path):
    assert load_env(str(tmp_path / "nope")) == []


# ---------------------------------------------------------------- Coach
def test_evaluate_sends_ride_and_recent_rides_and_reads_the_review():
    client, msgs = fake_client()
    c = coach_mod.Coach(garmin=FakeGarmin([row("2026-11-17 18:00:00", "Tempo")]), client=client)
    out = c.evaluate(RIDE)
    assert out["review"] == REVIEW and out["garmin_note"] is None
    kw = msgs.calls[0]
    assert kw["model"] == "claude-opus-5-5"
    assert kw["output_config"]["format"]["schema"]["required"][0] == "headline"
    assert kw["fallbacks"] == "default" and "server-side-fallback-2026-07-01" in kw["betas"]
    sent = json.loads(kw["messages"][0]["content"])
    assert sent["ride"]["np_w"] == 165 and sent["garmin"]["activities"][0]["name"] == "Tempo"
    assert sent["garmin"]["sleep"][0]["sleepScore"] == 81
    assert out["recent"][0]["name"] == "Tempo"


def test_the_same_ride_on_garmin_is_not_counted_twice():
    from datetime import datetime, timedelta
    local = (datetime.fromisoformat("2026-11-18T21:30:00+00:00").astimezone() + timedelta(minutes=2))
    rows = [row(local.strftime("%Y-%m-%d %H:%M:%S"), "This ride"), row("2026-11-10 18:00:00", "Older")]
    c = coach_mod.Coach(garmin=FakeGarmin(rows), client=fake_client()[0])
    assert [r["name"] for r in c.garmin_context("2026-11-18T21:30:00Z")[0]["activities"]] == ["Older"]


def test_garmin_trouble_still_gives_a_review():
    client, msgs = fake_client()
    out = coach_mod.Coach(garmin=FakeGarmin(err="Garmin login failed: nope"), client=client).evaluate(RIDE)
    assert out["review"]["verdict"] == "good"
    assert out["garmin_note"] == "Garmin login failed: nope"
    assert json.loads(msgs.calls[0]["messages"][0]["content"])["garmin"]["activities"] == []


def test_no_garmin_set_up():
    out = coach_mod.Coach(garmin=FakeGarmin(configured=False), client=fake_client()[0]).evaluate(RIDE)
    assert out["garmin_note"] == "Garmin not set up"


@pytest.mark.parametrize("stop,text,msg", [
    ("refusal", "", "declined"),
    ("max_tokens", "{", "cut short"),
    ("end_turn", "not json", "couldn't be read"),
])
def test_bad_answers_say_what_happened(stop, text, msg):
    c = coach_mod.Coach(garmin=FakeGarmin(configured=False), client=fake_client(text=text, stop=stop)[0])
    with pytest.raises(coach_mod.CoachError, match=msg):
        c.evaluate(RIDE)


def test_no_api_key(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    c = coach_mod.Coach(garmin=FakeGarmin(configured=False))
    assert c.status()["claude"] is False
    with pytest.raises(coach_mod.CoachError, match="ANTHROPIC_API_KEY"):
        c.evaluate(RIDE)


def test_no_ride():
    with pytest.raises(coach_mod.CoachError, match="No ride"):
        coach_mod.Coach(garmin=FakeGarmin(), client=fake_client()[0]).evaluate({"foo": 1})


# ---------------------------------------------------------------- Garmin rows
def test_activity_row_plain_units():
    r = garmin_rides.activity_row({"activityName": "Zwift", "startTimeLocal": "2026-11-18 18:30:00",
                                   "activityType": {"typeKey": "virtual_ride"}, "movingDuration": 3600.0,
                                   "distance": 30500.0, "avgPower": 180.4, "normPower": 190.6,
                                   "trainingStressScore": 72.3, "intensityFactor": 0.794, "averageHR": 140.2})
    assert r == {**r, "cycling": True, "duration_min": 60, "distance_km": 30.5, "avg_power_w": 180,
                 "np_w": 191, "tss": 72, "if": 0.79, "avg_hr": 140, "max_hr": None}


def test_garmin_needs_the_api_key(monkeypatch):
    monkeypatch.delenv("GARMIN_API_KEY", raising=False)
    assert not garmin_rides.GarminRides().configured()
    monkeypatch.setenv("GARMIN_API_KEY", "key")
    assert garmin_rides.GarminRides().configured()


def test_compact_keeps_plain_fields_of_the_records():
    hrv = {"userProfilePk": 1, "hrvSummaries": [
        {"calendarDate": "2026-11-18", "weeklyAvg": 52, "lastNightAvg": 48, "status": "BALANCED",
         "baseline": {"lowUpper": 45, "balancedLow": 47}, "readings": [{"x": 1}]}]}
    assert garmin_rides.compact(hrv) == [{"calendarDate": "2026-11-18", "weeklyAvg": 52, "lastNightAvg": 48,
                                          "status": "BALANCED", "baseline.lowUpper": 45, "baseline.balancedLow": 47}]
    assert garmin_rides.compact(None) == []


class FakeAuth:
    def __init__(self, bearer_token_cache_file):
        self.cache = bearer_token_cache_file

    def __enter__(self):
        return self

    def __exit__(self, *a):
        pass

    def obtain_token(self, key):
        if key == "expired":
            raise garmin_rides.HttpError(status_code=401, method="POST", url="u", response_text="")
        return SimpleNamespace(access_token="tok", expires_at=0)


class FakeApi:
    calls = []

    def __init__(self, token):
        assert token == "tok"

    def __enter__(self):
        return self

    def __exit__(self, *a):
        pass

    def search_activities(self, **kw):
        FakeApi.calls.append(kw)
        return [{"activityName": "Old", "startTimeLocal": "2026-11-10 18:00:00", "activityType": {"typeKey": "running"}},
                {"activityName": "New", "startTimeLocal": "2026-11-18 18:00:00", "activityType": {"typeKey": "virtual_ride"}}]

    def get_daily_sleep_summaries(self, a, b):
        return [{"calendarDate": "2026-11-18", "sleepScore": 77}]

    def get_daily_hrv_summaries(self, a, b):
        raise garmin_rides.GarminPersonalApiError("no HRV on this watch")


def test_context_from_the_personal_api(monkeypatch, tmp_path):
    monkeypatch.setattr(garmin_rides, "PersonalApiAuthenticator", FakeAuth)
    monkeypatch.setattr(garmin_rides, "GarminPersonalApiClient", FakeApi)
    monkeypatch.setenv("GARMIN_API_KEY", "key")
    ctx = garmin_rides.GarminRides(token_cache=str(tmp_path / "t.json")).context()
    assert [a["name"] for a in ctx["activities"]] == ["New", "Old"]          # newest first
    assert ctx["sleep"] == [{"calendarDate": "2026-11-18", "sleepScore": 77}] and ctx["hrv"] == []
    assert FakeApi.calls[-1]["limit"] == 30


def test_expired_key_says_so(monkeypatch, tmp_path):
    monkeypatch.setattr(garmin_rides, "PersonalApiAuthenticator", FakeAuth)
    monkeypatch.setenv("GARMIN_API_KEY", "expired")
    with pytest.raises(garmin_rides.GarminError, match="expired"):
        garmin_rides.GarminRides(token_cache=str(tmp_path / "t.json")).context()


# ---------------------------------------------------------------- POST /coach
@pytest.fixture
def live(tmp_path):
    lv = tl.Live(str(tmp_path))
    yield lv
    lv.close()


def run(coro):
    return asyncio.run(coro)


def test_post_coach_returns_the_review(live):
    live.coach = coach_mod.Coach(garmin=FakeGarmin(configured=False), client=fake_client()[0])

    async def go():
        async with serve(live) as port:
            return await request(port, "POST", "/coach", {"Content-Type": "application/json"}, json.dumps(RIDE).encode())
    code, hdrs, body = run(go())
    assert code == 200 and hdrs["content-type"] == "application/json"
    assert json.loads(body)["review"]["headline"] == "Solid endurance ride."


def test_post_coach_error_is_json(live, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    live.coach = coach_mod.Coach(garmin=FakeGarmin(configured=False))

    async def go():
        async with serve(live) as port:
            return await request(port, "POST", "/coach", body=json.dumps(RIDE).encode())
    code, _, body = run(go())
    assert code == 503 and "ANTHROPIC_API_KEY" in json.loads(body)["error"]


def test_post_coach_needs_a_body(live):
    live.coach = coach_mod.Coach(garmin=FakeGarmin(configured=False), client=fake_client()[0])

    async def go():
        async with serve(live) as port:
            return await request(port, "POST", "/coach")
    assert run(go())[0] == 400


def test_other_websites_cannot_ask_claude(live):
    client, msgs = fake_client()
    live.coach = coach_mod.Coach(garmin=FakeGarmin(configured=False), client=client)

    async def go():
        async with serve(live) as port:
            return await request(port, "POST", "/coach", {"Origin": "https://evil.example"}, json.dumps(RIDE).encode())
    assert run(go())[0] == 403 and not msgs.calls


# ---------------------------------------------------------------- Past rides page: Garmin list + .fit
class RidesApi(FakeApi):
    def search_activities(self, **kw):
        FakeApi.calls.append(kw)
        acts = [{"activityId": 100 + i, "activityName": f"Ride {i}", "startTimeLocal": f"2026-11-{10 + i:02d} 18:00:00",
                 "activityType": {"typeKey": "virtual_ride" if i % 2 else "road_biking"}} for i in range(12)]
        return acts + [{"activityId": 9, "activityName": "Run", "startTimeLocal": "2026-11-30 07:00:00",
                        "activityType": {"typeKey": "running"}}]

    def download_activity(self, activity_id):
        import io
        import zipfile
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr(f"{activity_id}_ACTIVITY.fit", b"\x0e\x10\x00\x00\x00\x00\x00\x00.FITdata")
        return buf.getvalue()


@pytest.fixture
def garmin(monkeypatch, tmp_path):
    monkeypatch.setattr(garmin_rides, "PersonalApiAuthenticator", FakeAuth)
    monkeypatch.setattr(garmin_rides, "GarminPersonalApiClient", RidesApi)
    monkeypatch.setenv("GARMIN_API_KEY", "key")
    return garmin_rides.GarminRides(token_cache=str(tmp_path / "t.json"))


def test_rides_are_the_last_10_bike_rides(garmin):
    rows = garmin.rides(10)
    assert len(rows) == 10 and rows[0]["name"] == "Ride 11" and rows[0]["id"] == 111
    assert all(r["cycling"] for r in rows)                          # the run is left out


def test_fit_comes_out_of_the_zip(garmin):
    assert garmin.fit("111")[8:12] == b".FIT"
    with pytest.raises(ValueError):
        garmin.fit("../etc")


def test_fit_from_zip_without_a_fit():
    import io
    import zipfile
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("notes.txt", "x")
    with pytest.raises(garmin_rides.GarminError, match="no .fit"):
        garmin_rides.fit_from_zip(buf.getvalue())
    with pytest.raises(garmin_rides.GarminError, match="isn't a .fit"):
        garmin_rides.fit_from_zip(b"garbage!!!!!!!")


def test_garmin_endpoints(live, garmin):
    live.coach = coach_mod.Coach(garmin=garmin, client=fake_client()[0])

    async def go():
        async with serve(live) as port:
            return (await request(port, "GET", "/garmin/rides"),
                    await request(port, "GET", "/garmin/activity.fit?id=105"),
                    await request(port, "GET", "/garmin/activity.fit?id=abc"))
    (c1, _, b1), (c2, h2, b2), (c3, _, _) = run(go())
    assert c1 == 200 and len(json.loads(b1)["rides"]) == 10
    assert c2 == 200 and h2["content-type"] == "application/vnd.ant.fit" and b2[8:12] == b".FIT"
    assert c3 == 400


def test_garmin_rides_without_a_key(live, monkeypatch):
    monkeypatch.delenv("GARMIN_API_KEY", raising=False)
    live.coach = coach_mod.Coach(garmin=garmin_rides.GarminRides(), client=fake_client()[0])

    async def go():
        async with serve(live) as port:
            return await request(port, "GET", "/garmin/rides")
    code, _, body = run(go())
    assert code == 503 and "GARMIN_API_KEY" in json.loads(body)["error"]
