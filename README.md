# bike-dashboard

Log every Bluetooth LE packet from a ThinkRider X2Max (or any FTMS / Cycling Power
smart trainer) and watch a live training dashboard in your browser.

## Folders

```
Start X2Max.command   double-click to start (macOS)
logger/               thinkrider_logger.py: Bluetooth, recording, .FIT, web server
                      trainer_control.py: climb simulation / ERG over FTMS (off by default)
                      ftp_test.py: the guided FTP test and its saved results
                      coach.py: Ask Claude; garmin_rides.py: Garmin Personal API; env.py: .env keys
dashboard/            dashboard.html (built, served by the logger) and its React + TypeScript source in src/
  src/types/          the logger's SSE payloads (feed.ts) and the workout model (workout.ts)
  src/workout/        workout files: reading .zwo / .erg / .mrc, step targets, off-target beep
  src/control/        Trainer control band: grade slider, ERG, workout grades
  src/ftp/            FTP test: start button, test band, result and saved results
  src/util/           ride maths: zones, NP, TSS, lap stats
  src/review/         Ride review, its summary for Claude and Ask Claude
  src/import/         reading ride files (.fit / .tcx / .gpx / CSV) for a review
  src/past/           Past rides page (#rides): your last 10 Garmin rides, pick one to review
  test/               dashboard tests: unit/ (Vitest), components/ (React Testing Library), e2e/ (Playwright)
tests/                logger tests (pytest); helpers/ has the fake Bluetooth, a .FIT reader and an HTTP client
workouts/             test workouts: power, heart rate, cadence and speed targets (load them in Settings)
rides/                your recordings, one folder per run (not committed)
config/               devices.json (your trainer / HR pick) and ftp_tests.json (FTP test results),
                      kept on this computer (not committed)
```

New code goes in the folder it belongs to; a new dashboard feature gets its own folder in
`dashboard/src/`.

## Run it

Needs [uv](https://docs.astral.sh/uv/). `uv run` creates the virtual environment and
installs `bleak` from `pyproject.toml` / `uv.lock` on first use.

**On macOS, no typing needed:** double-click **`Start X2Max.command`** in Finder. It starts
the logger and opens the dashboard. A Terminal window shows the log; leave it open. To
stop, use **Settings > Stop logger** or close that window (a ride in progress is saved
either way). To also open the dashboard on your phone, edit the file and set
`EXTRA_ARGS="--host 0.0.0.0"`. If Finder says it can't be opened, right-click it > Open once.

## Pick your trainer and heart-rate device

Click the status pills at the top of the dashboard (**Devices**). The panel shows what is
connected and scans for nearby trainers and heart-rate broadcasts for a few seconds. Click
**Connect** next to the X2Max and next to the Forerunner, **Disconnect** to drop one, or
connect another device to switch. Other Bluetooth devices are under **Show other devices**.

Your picks are saved in `config/devices.json`, and the logger connects to
them by itself on the next start. On the very first start (nothing picked yet) it takes
the first ThinkRider / FTMS trainer and the first heart-rate broadcast it finds, and the
panel opens so you can change that. Disconnecting the trainer during a ride pauses the
ride timer (the panel asks you to click twice). The logger only listens unless you turn on
**Trainer control** (below).

## Simulate climbs (Trainer control)

The **Trainer control** switch under the ride strip lets the logger drive the trainer over
FTMS, the same standard control Zwift uses. It is off every time the logger starts.

- **Climb**: pick a grade with the quick buttons (0, 3, 6, 10 %), the slider (−5 to 15 %),
  − / + or the <kbd>−</kbd> <kbd>+</kbd> keys. The trainer gets harder or easier like a real hill.
- **ERG**: the trainer holds a target power whatever your cadence.
- **Workouts**: a `.zwo` step can carry `Grade="6"` (or `OnGrade` / `OffGrade` on `IntervalsT`);
  with control on, each step sets the grade when it starts. In ERG mode the step's power target
  is sent instead. Try `workouts/climb-repeats.zwo`.
- **Safety**: the grade goes back to 0 % on Finish, when the trainer disconnects and when the
  logger stops (control is then handed back). If Zwift or the ThinkRider app takes the trainer,
  control turns itself off and the dashboard says so.

The grade is saved in `session_1hz.csv` (`grade_pct`). `--demo` simulates it too: speed drops on a
climb and ERG holds the power.

Command line, if you prefer:

```bash
uv run logger/thinkrider_logger.py            # find the trainer, log + open the dashboard
uv run logger/thinkrider_logger.py --demo     # simulated ride, no trainer needed
uv run logger/thinkrider_logger.py --scan     # list nearby BLE devices
uv run logger/thinkrider_logger.py --host 0.0.0.0   # view from a phone/tablet on the same Wi-Fi
uv run logger/thinkrider_logger.py --hr-name forerunner   # pick the heart-rate watch/strap by name
                                                   # (--address / --hr-address / --no-hr also work)
```

Close Zwift / the ThinkRider app first: the trainer usually allows only one Bluetooth connection.

Press **Start** on the dashboard to begin recording and **Finish** to end the ride
(press it twice, at least half a second apart, so a stray click or a double tap can't end
it). Ended too soon? **Resume ride** on the finished screen carries on with the same ride and
writes the .FIT again. **Pause** (or <kbd>P</kbd>) stops the ride timer mid-ride: nothing is
recorded, so averages, distance and calories skip the stop, a loaded workout waits at the
same point of its step and the off-target beep stays quiet. **Resume** carries on; the .FIT
marks the pause so Strava shows the right moving time. Before Start the dashboard shows live numbers but saves nothing. Use `--autostart` to record straight away.

Each run is saved to `rides/x2max_YYYYMMDD_HHMMSS/`: `ride_<date>_<time>.fit` (one per ride),
`session_1hz.csv`, `decoded.csv`, `raw_packets.csv` and `gatt_dump.json`. Ctrl+C in the
middle of a ride still saves the `.fit`. To rebuild the `.fit` files from the saved CSVs
(`session_1hz.csv` -> `ride.fit`, `session_1hz_2.csv` -> `ride_2.fit`, ...):
`uv run logger/thinkrider_logger.py --fit-from rides/x2max_YYYYMMDD_HHMMSS`.

Tests: see [Testing](#testing).

## Heart rate from a Garmin watch (Forerunner 165)

The logger connects to the watch as a second Bluetooth device, next to the trainer,
and reconnects by itself if it drops. Watch heart rate takes priority over any heart
rate the trainer reports.

1. On the watch, turn on **Broadcast Heart Rate**: hold UP > Settings > Sensors &
   Accessories > Wrist Heart Rate > Broadcast Heart Rate (or add the Broadcast Heart
   Rate control to the controls menu). The exact menu names can vary a little by
   firmware.
2. Start the logger. It picks the first device that broadcasts heart rate, preferring
   Garmin / Forerunner names. The header shows `HR · <device>` once it's connected.
3. If it picks the wrong device (e.g. a chest strap nearby), open **Devices** on the
   dashboard and connect the Forerunner instead. It is remembered from then on.

The watch accepts one Bluetooth heart-rate connection at a time, so close Zwift or other
apps that might grab it.

## Strava and Garmin Connect

The `.fit` file is a standard cycling / indoor-cycling activity (power, cadence, speed,
distance, heart rate, laps). After **Finish**, click **Send to Strava** or **Send to
Garmin Connect**: it downloads the `.fit` and opens the site's upload page in a new tab,
where you drag the file in (Strava: [strava.com/upload/select](https://www.strava.com/upload/select),
Garmin: Import Data). There is no automatic upload: Strava's API needs a paid subscription.

## Dashboard

`dashboard/dashboard.html` is served by the script at http://localhost:8000. It shows power
(3 s), cadence, speed, heart rate, power zones, NP / IF / TSS, W/kg, laps and live
power / cadence / HR / speed charts. While recording it shows a red REC strip and frame;
after Finish it shows the ride's summary and a **Ride review**: what kind of ride it was
(from IF), the load and how long recovery usually takes (from TSS), where the time went by zone,
heart-rate drift against power on steady rides, pacing, how much of a workout was on target and
which steps missed, and a hint when a best 20 min says your FTP is set too low. It is worked
out in the browser from the ride, your FTP and the loaded workout; nothing is sent anywhere.
**Past rides** (on the Preview strip, or Settings › Past rides; the page is `#rides`) gives the same
review for a ride you already did. With `GARMIN_API_KEY` set, **Load my last 10 rides** lists your
last 10 bike rides from Garmin Connect; pick one and the logger downloads its original `.fit` from
Garmin, then the review (and Ask Claude) appear next to the list. Or open **Or review a ride file
from this computer** and pick a `.fit` (this logger, Garmin, Wahoo, Zwift, Strava's Export
original), a `.tcx`, a `.gpx` with power, or this logger's `session_1hz.csv`. Files are read in the
browser and nothing is saved; the trainer doesn't need to be on.
**Ask Claude for a coach's review** (under the Ride review, optional) sends the ride's summary to
Claude, with your last six weeks of Garmin activities and last week's sleep and HRV when Garmin is set
up, and shows a coach's take: what went well, what to work on, your training load and the next
session. Nothing is sent until you press it. Set it up in a `.env` file in the repo root (gitignored):

```
ANTHROPIC_API_KEY=sk-ant-...      # console.anthropic.com
GARMIN_API_KEY=...                # optional: connect.garmin.com/app/settings/personalApiToken
```

Restart the logger after editing it. `uv run logger/garmin_rides.py` shows what Garmin returns. Keys: `S` start, `L` lap, `F` twice to
finish, `Esc` closes Devices / Settings. FTP, weight, workout, CSV export and **Clear all
data** (only between rides) are under **Settings**; FTP,
weight and chart window are remembered in the browser.

The big numbers update on every reading the trainer sends (a few times a second), within
a few milliseconds; recording and the charts stay at one sample per second. **Settings >
Power number** switches between instant power and a 3 s / 5 s average. **Live updates**
is instant on a computer and capped at 2 updates a second on a phone or tablet to save
its battery (change it there).

### FTP test

**Start FTP test** (on the Preview strip, or **Settings > FTP test**) starts a ride that guides
you through the classic 20-minute test, about 55 min in all: 10 min warm-up (50 to 70 % FTP),
5 min hard, 10 min easy, **20 min as hard as you can hold**, 10 min cool-down. A band at the top
counts down to the 20 minutes, then shows the 20-minute average so far and the FTP it gives.
**Hide FTP numbers** hides those two (ride by feel); the choice is remembered in the browser.
FTP = 95 % of the 20-minute average (seconds at 0 W count). The test's steps take the place of a
loaded workout while it runs. With **Trainer control** in ERG mode, the trainer holds the warm-up
and easy targets and switches to Climb at 0 % for the hard efforts, so you set the power.

When the 20 minutes end the result is saved on this computer in `config/ftp_tests.json`, so every
browser and phone sees it. The band then asks **Use 249 W** or **Keep**: FTP changes only if you
press Use. Finishing before the 20 minutes end saves nothing (**Resume ride** carries on with the
test). **Settings > FTP test** lists past results, newest first, with **Use** and **Delete**.
`--demo` keeps its results in memory only.

The band also coaches the test as it goes: what each step is for, a starting pace for the 20
minutes (your current FTP ÷ 0.95), steady pacing in the middle and when to push at the end. The
result explains what the number means (power you can hold for about 35 to 50 minutes; 95 % reads
a little high for many riders) and when to test again (4 to 8 weeks). **Settings > FTP test > How
to get a good test** has the full checklist: rested, fed, a fan, the same setup every time.

### Workouts

**Settings > Workout > Load workout** reads a Zwift `.zwo`, an `.erg` (watts) or an `.mrc`
(% FTP) file. A band above the big numbers then shows the current step, its target power,
cadence, heart rate and/or speed, time left, the next step and a profile of the whole
workout. The workout starts with **Start** and follows the ride timer. When power is more
than 7 % (at least 10 W) off the target, cadence more than 8 rpm off, or heart rate more
than 5 bpm off (checked from 30 s into a step, since heart rate is slow to follow), or speed
more than 2 km/h off, the band turns
yellow right away. If it stays off for more than 7 s without a break it beeps: two rising
beeps for too low, one falling beep for too high. Getting back on target resets those 7 s. It
beeps at most once every 15 s, and not in the first 8 s of a step. Turn the beep off or test it
under **Settings > Workout**. The logger does not control the trainer (no ERG mode). The
workout is remembered in the browser, and its targets are drawn on the charts.

Heart-rate targets are an extra `.zwo` attribute (Zwift ignores it): `HeartRate="140"` on a
step, or `OnHeartRate` / `OffHeartRate` on `IntervalsT`; speed the same way with `Speed="30"`
(km/h) or `OnSpeed` / `OffSpeed`. Cadence uses Zwift's own
`Cadence` attribute. Four test workouts are in `workouts/`:

- `power-sweet-spot.zwo` (18 min): power steps in % FTP, 3 x 3 min at 90 %.
- `heart-rate-zones.zwo` (18 min): hold 110 / 130 / 115 / 145 / 115 bpm. Edit the numbers to your zones.
- `cadence-drills.zwo` (16 min): 70 to 110 rpm blocks at an easy effort.
- `speed-steps.zwo` (16 min): 24 to 33 km/h steps. Trainer speed depends on gear, so adjust.

It is a React app written in TypeScript (strict) in `dashboard/`, compiled into the single self-contained
`dashboard/dashboard.html` (works offline, no CDN). The built file is committed, so you only
need Node.js and [pnpm](https://pnpm.io/) if you change the dashboard:

```bash
cd dashboard
pnpm install
pnpm typecheck       # tsc --noEmit, strict
pnpm build           # rewrites dashboard/dashboard.html
```

esbuild strips the types without checking them, so run `pnpm typecheck` before a build.
The SSE payload types in `dashboard/src/types/feed.ts` mirror what `logger/thinkrider_logger.py`
sends: change both together.

The script talks to the page over `GET /events` (Server-Sent Events: `init`,
`sample`, `preview`, `live`, `status`, `laps`; `/events?live=2` caps `live` at 2/s), `POST /start`, `/finish`, `/lap`, `/clear`, `/quit`,
`POST /devices/scan`, `/devices/use?role=trainer|hr&address=..&name=..`,
`/devices/off?role=..`, `/ftp-test/start?ftp=..`, `/ftp-test/cancel`, `/ftp-test/delete?id=..` and `GET /ride.fit`. POSTs from other
sites are refused (the Origin must match, and the Host must be localhost, an IP address or a
`.local` name).

## Testing

Nothing needs a trainer: the logger tests use a fake Bluetooth stack, and the end-to-end tests
run the logger with `--demo`.

```bash
uv run pytest                 # logger: decoders, 1 Hz timeline, ride / lap maths, .FIT, web server,
                              # origin protection, reconnects, trainer control safety

cd dashboard
pnpm install
pnpm test                     # Vitest: ride maths, workouts, beep rules, live feed, components
pnpm build                    # the end-to-end tests use the built dashboard.html
pnpm exec playwright install chromium   # once
pnpm test:e2e                 # Playwright: a demo ride in Chromium at laptop and phone size
pnpm test:all                 # typecheck + Vitest + Playwright
```

- `tests/` (pytest, run with uv): one file per area. `helpers/fit.py` reads a `.fit` back field
  by field, `helpers/http.py` runs the logger's web server on a free port.
- `dashboard/test/unit/`: pure logic (`src/util/ride.ts`, `src/workout/workout.tsx`, the feed store).
- `dashboard/test/components/`: the dashboard and its panels in jsdom, against a fake event
  stream (`test/fixtures/`). Charts are stubbed there (uPlot needs a canvas) and covered end to end.
- `dashboard/test/e2e/`: starts `logger/thinkrider_logger.py --demo` on port 8765 (so a logger
  you have running on 8000 doesn't clash) and rides it: Start, Lap, Finish, the `.FIT` download,
  Resume, a workout, Trainer control and the device panel. Output goes to `dashboard/test-results/`.
- `pnpm test:watch` reruns the Vitest tests on save.
