"""Ask Claude to evaluate a ride, like a coach would: the dashboard's Ride review plus your
recent Garmin rides for context (training load, how this ride compares, what to do next).

Optional and on request only: nothing is sent until you press "Ask Claude" on the dashboard.
What is sent to Anthropic: the ride's summary numbers (averages, zones, laps, a 1-minute
power / heart-rate profile, the local review's notes) and, with Garmin set up, your last six
weeks of Garmin activity summaries and last week's sleep and HRV summaries.
Not sent: the raw recording, files, your name or location.

Needs ANTHROPIC_API_KEY in .env (see env.py). Garmin context needs GARMIN_API_KEY
(garmin_rides.py); without it the evaluation covers this ride only.
"""
import json
import os
from datetime import datetime

try:
    import anthropic
except ImportError:                       # optional: the logger runs without it
    anthropic = None

from garmin_rides import GarminError, GarminRides, same_ride

MODEL = "claude-opus-5-5"
MAX_SUMMARY_BYTES = 60_000                # a summary is ~5 KB; refuse anything far bigger

SYSTEM = """You are an experienced cycling coach reviewing one indoor ride for the rider who did it.
The rider trains on a smart trainer at home and gets this review on their dashboard right after the ride
(or for a past ride they loaded from a file).

You get JSON with:
- "ride": this ride's numbers, worked out on their computer from 1 Hz data and their FTP: duration,
  average / normalized / best powers, intensity factor (IF), TSS, variability (VI), heart rate,
  time in each power zone, laps, the two halves compared, heart-rate drift (Pw:HR) when it could be
  judged, the workout's targets and misses if one was followed, and a 1-minute profile of power,
  heart rate and cadence.
- "local_review": the notes the dashboard already shows (ride type, load, drift, pacing, workout).
- "garmin": from the rider's Garmin account (any part may be empty): "activities" = the last six
  weeks of activities, newest first, all sports (TSS / IF only where Garmin had power); "sleep" and
  "hrv" = daily sleep and heart-rate-variability summaries for the last week, as Garmin reports them.
  Use sleep and HRV to judge recovery, and say so when they suggest the rider was tired.

Write the review the rider will read on a phone between sessions:
- Ground every claim in the numbers you were given. Don't invent data, and say so when something
  can't be judged (no heart rate, no recent rides, a short ride).
- Go beyond restating the local review: explain why things happened (pacing, fatigue from recent
  load, heat or fuelling when the data points that way), compare with recent rides when they help,
  and judge the rider's training load across the last days and weeks.
- Be specific and practical, like a coach talking to an athlete: numbers in watts, bpm, minutes.
- Plain language, short sentences. No medical advice; suggest seeing a professional only for
  real warning signs.
- Write in the same language as the rider's activity names in "garmin" if they are clearly not English;
  otherwise English."""

SCHEMA = {
    "type": "object",
    "properties": {
        "headline": {"type": "string", "description": "One sentence verdict on the ride, under 20 words."},
        "verdict": {"type": "string", "enum": ["great", "good", "mixed", "tough"],
                    "description": "Overall: how well the ride went for its purpose."},
        "went_well": {"type": "array", "items": {"type": "string"}, "description": "2 to 4 short points."},
        "to_improve": {"type": "array", "items": {"type": "string"}, "description": "1 to 3 short points."},
        "load": {"type": "string", "description": "2 to 3 sentences on recent training load and recovery, using the recent rides when given."},
        "next_session": {"type": "string", "description": "A concrete suggestion for the next ride: type, duration, targets in watts or zones."},
    },
    "required": ["headline", "verdict", "went_well", "to_improve", "load", "next_session"],
    "additionalProperties": False,
}


class CoachError(Exception):
    """Something the rider can act on (shown on the dashboard)."""


class Coach:
    def __init__(self, garmin: GarminRides | None = None, client=None):
        self.garmin = garmin if garmin is not None else GarminRides()
        self._client = client

    def available(self):
        return anthropic is not None and bool(os.environ.get("ANTHROPIC_API_KEY") or self._client)

    def status(self):
        return {"claude": self.available(), "garmin": self.garmin.configured(), "model": MODEL}

    def client(self):
        if self._client is None:
            if anthropic is None:
                raise CoachError("The anthropic package is missing: run uv sync.")
            if not os.environ.get("ANTHROPIC_API_KEY"):
                raise CoachError("Add ANTHROPIC_API_KEY to the .env file, then restart the logger.")
            self._client = anthropic.Anthropic()
        return self._client

    def garmin_context(self, ride_start=None):
        """Recent Garmin activities (without this ride itself), sleep and HRV.
        Returns (context, note): note says why there is none, for the dashboard."""
        empty = {"activities": [], "sleep": [], "hrv": []}
        if not self.garmin.configured():
            return empty, "Garmin not set up"
        try:
            ctx = self.garmin.context()
        except GarminError as e:
            return empty, str(e)
        acts = [r for r in ctx.get("activities", []) if not same_ride(r, ride_start)][:15]
        return {**ctx, "activities": acts}, None

    def evaluate(self, payload):
        """payload: {"ride": {...}, "local_review": {...}} from the dashboard. Blocking (run it
        in a thread). Returns {"review": {...}, "recent": [...], "garmin_note": str | None}."""
        if not isinstance(payload, dict) or not isinstance(payload.get("ride"), dict):
            raise CoachError("No ride to evaluate.")
        client = self.client()
        garmin, note = self.garmin_context(payload["ride"].get("start"))
        data = {"ride": payload["ride"], "local_review": payload.get("local_review"), "garmin": garmin,
                "today": datetime.now().strftime("%Y-%m-%d %A")}
        try:
            resp = client.beta.messages.create(
                model=MODEL,
                max_tokens=16000,
                system=SYSTEM,
                output_config={"effort": "medium", "format": {"type": "json_schema", "schema": SCHEMA}},
                betas=["server-side-fallback-2026-07-01"],
                fallbacks="default",
                messages=[{"role": "user", "content": json.dumps(data, separators=(",", ":"))}],
            )
        except anthropic.AuthenticationError:
            raise CoachError("Anthropic refused the API key: check ANTHROPIC_API_KEY in .env.") from None
        except anthropic.PermissionDeniedError:
            raise CoachError("This API key can't use the model. Check your Anthropic account.") from None
        except anthropic.RateLimitError:
            raise CoachError("Too many requests to Claude right now. Try again in a minute.") from None
        except anthropic.APIStatusError as e:
            raise CoachError(f"Claude returned an error ({e.status_code}). Try again later.") from None
        except anthropic.APIConnectionError:
            raise CoachError("Couldn't reach Claude: check the internet connection.") from None
        if resp.stop_reason == "refusal":
            raise CoachError("Claude declined to review this ride.")
        if resp.stop_reason == "max_tokens":
            raise CoachError("Claude's answer was cut short. Try again.")
        text = next((b.text for b in resp.content if b.type == "text"), None)
        try:
            review = json.loads(text or "")
        except ValueError:
            raise CoachError("Claude's answer couldn't be read. Try again.") from None
        return {"review": review, "recent": garmin["activities"], "garmin_note": note, "model": resp.model}
