"""Your recent Garmin Connect activities, sleep and HRV, as context for the Claude ride evaluation
(coach.py). Uses Garmin's official Personal API (garmin-connect-personal-api-python).

Set GARMIN_API_KEY in .env to a Personal API key made at
https://connect.garmin.com/app/settings/personalApiToken (it expires after the period you pick).
The key is swapped for a 24-hour access token, cached in config/garmin_token.json (gitignored).

    uv run logger/garmin_rides.py        lists what the coach would see
"""
import os
import sys
import io
import threading
import time
import zipfile
from datetime import date, datetime, timedelta

try:
    from garmin_personal_api import GarminPersonalApiClient, GarminPersonalApiError, HttpError, PersonalApiAuthenticator
except ImportError:                       # optional: the logger runs without it
    GarminPersonalApiClient = None

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOKEN_CACHE = os.path.join(ROOT, "config", "garmin_token.json")
KEY_VAR = "GARMIN_API_KEY"
CACHE_S = 600                             # Garmin is asked at most every 10 minutes
CYCLING = ("cycling", "biking", "virtual_ride", "road_biking", "gravel", "mountain_biking")


class GarminError(Exception):
    """Something the rider can act on (shown on the dashboard)."""


def _num(v, nd=0):
    try:
        return None if v is None else round(float(v), nd) if nd else round(float(v))
    except (TypeError, ValueError):
        return None


def activity_row(a):
    """The fields of one Garmin activity that matter for training load, in plain units."""
    typ = (a.get("activityType") or {}).get("typeKey") or ""
    return {
        "id": a.get("activityId"),
        "date": a.get("startTimeLocal"),            # "2026-11-18 18:30:00", local time
        "name": a.get("activityName"),
        "type": typ,
        "cycling": any(k in typ for k in CYCLING),
        "duration_min": _num((a.get("movingDuration") or a.get("duration") or 0) / 60),
        "distance_km": _num((a.get("distance") or 0) / 1000, 1),
        "avg_power_w": _num(a.get("avgPower")),
        "np_w": _num(a.get("normPower")),
        "max_power_w": _num(a.get("maxPower")),
        "avg_hr": _num(a.get("averageHR")),
        "max_hr": _num(a.get("maxHR")),
        "tss": _num(a.get("trainingStressScore")),
        "if": _num(a.get("intensityFactor"), 2),
        "aerobic_te": _num(a.get("aerobicTrainingEffect"), 1),
        "anaerobic_te": _num(a.get("anaerobicTrainingEffect"), 1),
        "kcal": _num(a.get("calories")),
    }


def compact(value, max_items=8, max_keys=30):
    """A small, flat copy of a wellness response (sleep, HRV): the first list of records found,
    each cut to its plain number / text fields (one level of nesting flattened as a.b)."""
    def records(v):
        if isinstance(v, list):
            return v
        if isinstance(v, dict):
            for x in v.values():
                if isinstance(x, list) and x and isinstance(x[0], dict):
                    return x
            return [v]
        return []
    out = []
    for rec in records(value)[-max_items:]:
        if not isinstance(rec, dict):
            continue
        flat = {}
        for k, v in rec.items():
            if isinstance(v, (int, float, str, bool)) and not (isinstance(v, str) and len(v) > 40):
                flat[k] = v
            elif isinstance(v, dict):
                flat.update({f"{k}.{k2}": v2 for k2, v2 in v.items() if isinstance(v2, (int, float, bool))})
            if len(flat) >= max_keys:
                break
        out.append(flat)
    return out


class GarminRides:
    def __init__(self, token_cache=TOKEN_CACHE):
        self.token_cache = token_cache
        self.cache = (0.0, None)
        self.rides_cache = (0.0, None)
        self.lock = threading.Lock()

    def configured(self):
        return GarminPersonalApiClient is not None and bool(os.environ.get(KEY_VAR, "").strip())

    def _client(self):
        if GarminPersonalApiClient is None:
            raise GarminError("The Garmin package is missing: run uv sync.")
        key = os.environ.get(KEY_VAR, "").strip()
        if not key:
            raise GarminError(f"Add {KEY_VAR} to the .env file.")
        os.makedirs(os.path.dirname(self.token_cache), exist_ok=True)
        try:
            with PersonalApiAuthenticator(bearer_token_cache_file=self.token_cache) as auth:
                token = auth.obtain_token(key)
        except HttpError as e:
            if e.status_code in (401, 403):
                raise GarminError(f"Garmin refused the API key: it may have expired. Make a new one and update {KEY_VAR}.") from None
            raise GarminError(f"Garmin login failed ({e.status_code}).") from None
        except (GarminPersonalApiError, OSError) as e:
            raise GarminError(f"Garmin login failed: {str(e)[:160]}") from None
        return GarminPersonalApiClient(token.access_token)

    def context(self, days=42):
        """{"activities": [...newest first], "sleep": [...], "hrv": [...]} for the coach.
        Activities are needed; sleep / HRV are skipped if Garmin has none. Cached for 10 min."""
        with self.lock:
            at, ctx = self.cache
            if ctx is not None and time.monotonic() - at < CACHE_S:
                return ctx
            client = self._client()
            today = date.today()
            try:
                with client:
                    acts = client.search_activities(limit=30, start_date=today - timedelta(days=days), end_date=today)
                    ctx = {"activities": [activity_row(a) for a in acts if isinstance(a, dict)] if isinstance(acts, list) else []}
                    week = today - timedelta(days=7)
                    for name, call in (("sleep", lambda: client.get_daily_sleep_summaries(week, today)),
                                       ("hrv", lambda: client.get_daily_hrv_summaries(week, today))):
                        try:
                            ctx[name] = compact(call())
                        except (GarminPersonalApiError, ValueError, OSError):
                            ctx[name] = []                      # not on every watch / account
            except HttpError as e:
                raise GarminError(f"Couldn't read Garmin activities ({e.status_code}).") from None
            except (GarminPersonalApiError, ValueError, OSError) as e:
                raise GarminError(f"Couldn't read Garmin activities: {str(e)[:160]}") from None
            ctx["activities"].sort(key=lambda r: r["date"] or "", reverse=True)
            self.cache = (time.monotonic(), ctx)
            return ctx


    def rides(self, n=10, refresh=False):
        """The last `n` cycling activities (newest first) from the last year, for the Past rides
        page. Cached for 10 min unless `refresh`."""
        with self.lock:
            at, rows = self.rides_cache
            if rows is not None and not refresh and time.monotonic() - at < CACHE_S:
                return rows[:n]
            client = self._client()
            today = date.today()
            try:
                with client:
                    acts = client.search_activities(limit=100, start_date=today - timedelta(days=365), end_date=today)
            except HttpError as e:
                raise GarminError(f"Couldn't read Garmin activities ({e.status_code}).") from None
            except (GarminPersonalApiError, ValueError, OSError) as e:
                raise GarminError(f"Couldn't read Garmin activities: {str(e)[:160]}") from None
            rows = [r for r in (activity_row(a) for a in (acts if isinstance(acts, list) else []) if isinstance(a, dict))
                    if r["cycling"] and r["id"]]
            rows.sort(key=lambda r: r["date"] or "", reverse=True)
            self.rides_cache = (time.monotonic(), rows)
            return rows[:n]

    def fit(self, activity_id):
        """The original .fit of one activity (Garmin sends it zipped)."""
        activity_id = str(activity_id)
        if not activity_id.isdecimal() or len(activity_id) > 20:
            raise ValueError("bad activity id")
        client = self._client()
        try:
            with client:
                data = client.download_activity(activity_id)
        except HttpError as e:
            raise GarminError("Garmin has no such activity." if e.status_code == 404
                              else f"Couldn't download the activity ({e.status_code}).") from None
        except (GarminPersonalApiError, OSError) as e:
            raise GarminError(f"Couldn't download the activity: {str(e)[:160]}") from None
        return fit_from_zip(data)


def fit_from_zip(data):
    """The .fit inside Garmin's download (a zip), or the bytes themselves if they already are one."""
    if data[8:12] == b".FIT":
        return data
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            names = [n for n in z.namelist() if n.lower().endswith(".fit")]
            if not names:
                raise GarminError("This activity has no .fit file (it may be a manual entry).")
            info = z.getinfo(names[0])
            if info.file_size > 50_000_000:
                raise GarminError("The activity file is too big.")
            return z.read(info)
    except zipfile.BadZipFile:
        raise GarminError("Garmin sent a file that isn't a .fit or a zip.") from None


def same_ride(row, ride_start_iso, within_s=900):
    """True when a Garmin activity starts within 15 min of this ride (it is this ride, uploaded)."""
    if not row.get("date") or not ride_start_iso:
        return False
    try:
        t0 = datetime.fromisoformat(ride_start_iso.replace("Z", "+00:00")).astimezone().replace(tzinfo=None)
        return abs((datetime.strptime(row["date"][:19], "%Y-%m-%d %H:%M:%S") - t0).total_seconds()) <= within_s
    except ValueError:
        return False


def main():
    from env import load_env
    load_env(os.path.join(ROOT, ".env"))
    ctx = GarminRides().context()
    for r in ctx["activities"]:
        print(f"{r['date']}  {r['type']:<16} {r['duration_min'] or 0:>4} min  "
              f"NP {r['np_w'] or '-':>4}  TSS {r['tss'] or '-':>4}  HR {r['avg_hr'] or '-':>4}  {r['name']}")
    print(f"sleep: {len(ctx['sleep'])} days, HRV: {len(ctx['hrv'])} days")


if __name__ == "__main__":
    try:
        main()
    except GarminError as e:
        sys.exit(str(e))
