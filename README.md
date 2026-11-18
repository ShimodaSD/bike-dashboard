# bike-dashboard

Log every Bluetooth LE packet from a ThinkRider X2Max (or any FTMS / Cycling Power
smart trainer) and watch a live training dashboard in your browser.

## Run it

```bash
pip install bleak
python thinkrider_logger.py            # find the trainer, log + open the dashboard
python thinkrider_logger.py --demo     # simulated ride, no trainer needed
python thinkrider_logger.py --scan     # list nearby BLE devices
python thinkrider_logger.py --host 0.0.0.0   # view from a phone/tablet on the same Wi-Fi
```

Close Zwift / the ThinkRider app first: the trainer usually allows only one Bluetooth connection.

Each ride is saved to `x2max_YYYYMMDD_HHMMSS/`: `session_1hz.csv`, `decoded.csv`,
`raw_packets.csv` and `gatt_dump.json`.

## Dashboard

`dashboard.html` is served by the script at http://localhost:8000. It shows power
(3 s), cadence, speed, heart rate, power zones, NP / IF / TSS, W/kg, laps (button or
`L` key) and live power / cadence / HR charts. FTP, weight and chart window are
remembered in the browser.

It is a React app in `dashboard/`, compiled into the single self-contained
`dashboard.html` (works offline, no CDN). The built file is committed, so you only
need Node.js if you change the dashboard:

```bash
cd dashboard
npm install
npm run build        # rewrites ../dashboard.html
```

The script talks to the page over `GET /events` (Server-Sent Events: `init`,
`sample`, `status`, `laps`) and `POST /lap`.
