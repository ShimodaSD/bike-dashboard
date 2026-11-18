# bike-dashboard

Log every Bluetooth LE packet from a ThinkRider X2Max (or any FTMS / Cycling Power
smart trainer) and watch a live training dashboard in your browser.

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

Your picks are saved in `devices.json` next to the script, and the logger connects to
them by itself on the next start. On the very first start (nothing picked yet) it takes
the first ThinkRider / FTMS trainer and the first heart-rate broadcast it finds, and the
panel opens so you can change that. Disconnecting the trainer during a ride pauses the
ride timer (the panel asks you to click twice). The logger only listens: it never writes
to the trainer.

Command line, if you prefer:

```bash
uv run thinkrider_logger.py            # find the trainer, log + open the dashboard
uv run thinkrider_logger.py --demo     # simulated ride, no trainer needed
uv run thinkrider_logger.py --scan     # list nearby BLE devices
uv run thinkrider_logger.py --host 0.0.0.0   # view from a phone/tablet on the same Wi-Fi
uv run thinkrider_logger.py --hr-name forerunner   # pick the heart-rate watch/strap by name
                                                   # (--address / --hr-address / --no-hr also work)
uv run thinkrider_logger.py --strava-setup   # one-time: save your Strava API app keys
```

Close Zwift / the ThinkRider app first: the trainer usually allows only one Bluetooth connection.

Press **Start** on the dashboard to begin recording and **Finish** to end the ride
(click it twice, so a stray click can't end it). Before Start the dashboard shows live
numbers but saves nothing. Use `--autostart` to record straight away.

Each run is saved to `x2max_YYYYMMDD_HHMMSS/`: `ride_<date>_<time>.fit` (one per ride),
`session_1hz.csv`, `decoded.csv`, `raw_packets.csv` and `gatt_dump.json`. Ctrl+C in the
middle of a ride still saves the `.fit`. To rebuild the `.fit` files from the saved CSVs
(`session_1hz.csv` -> `ride.fit`, `session_1hz_2.csv` -> `ride_2.fit`, ...):
`uv run thinkrider_logger.py --fit-from x2max_YYYYMMDD_HHMMSS`.

Self-check for the packet decoder and the `.fit` writer: `uv run python -m unittest test_logger`.

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
distance, heart rate, laps). Upload it by hand at
[strava.com/upload/select](https://www.strava.com/upload/select) or Garmin Connect
(Import Data), or let the dashboard upload it to Strava:

1. Create your own Strava API app at
   [strava.com/settings/api](https://www.strava.com/settings/api). Any name and
   website are fine; set **Authorization Callback Domain** to `localhost`.
2. On the dashboard open **Settings**, paste the Client ID and Client Secret under
   **Strava** and click **Save keys** (or run `uv run thinkrider_logger.py --strava-setup`).
   They are saved in `strava_config.json` next to the script (or set
   `STRAVA_CLIENT_ID` / `STRAVA_CLIENT_SECRET`). Don't share the secret.
3. Click **Connect to Strava** on the dashboard and approve on Strava's page. The
   sign-in is kept in `strava_token.json` and refreshed automatically.
4. After **Finish**, click **Upload to Strava**. The button turns into a link to the
   new activity. Strava rejects a file it already has, so a ride can't be uploaded twice.

Both files are in `.gitignore`. Connect from the PC running the logger (Strava sends you
back to `localhost`); uploads work from any device after that.

## Dashboard

`dashboard.html` is served by the script at http://localhost:8000. It shows power
(3 s), cadence, speed, heart rate, power zones, NP / IF / TSS, W/kg, laps and live
power / cadence / HR charts. While recording it shows a red REC strip and frame;
after Finish it shows the ride's summary. Keys: `S` start, `L` lap, `F` twice to
finish. FTP, weight, Strava account and CSV export are under **Settings**; FTP,
weight and chart window are remembered in the browser.

It is a React app in `dashboard/`, compiled into the single self-contained
`dashboard.html` (works offline, no CDN). The built file is committed, so you only
need Node.js and [pnpm](https://pnpm.io/) if you change the dashboard:

```bash
cd dashboard
pnpm install
pnpm build           # rewrites ../dashboard.html
```

The script talks to the page over `GET /events` (Server-Sent Events: `init`,
`sample`, `preview`, `status`, `laps`), `POST /start`, `/finish`, `/lap`, `/quit`, `/strava/setup`,
`POST /devices/scan`, `/devices/use?role=trainer|hr&address=..&name=..`,
`/devices/off?role=..`, `GET /ride.fit` and the `/strava/...` routes. POSTs from other
sites are refused.
