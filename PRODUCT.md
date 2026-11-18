# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

One rider (the owner) training indoors on a ThinkRider X2Max smart trainer. The dashboard is watched on a MacBook in front of the bike, and sometimes on a Samsung Galaxy S26+ phone on the same Wi-Fi (`--host 0.0.0.0`). The rider glances at it mid-effort, between pedal strokes, often sweaty and at arm's length or more.

## Product Purpose

Record every ride on the X2Max from macOS, where the ThinkRider app can't read the trainer's data, and show the live numbers while riding. Success is a complete ride file (FIT, plus raw CSVs) that lands on Strava, and a live view the rider can read at a glance.

## Positioning

A small local tool instead of a heavy training app: it works on macOS where ThinkRider doesn't, and it stays light on battery compared to apps like Zwift. It works fully offline: no account, no internet needed to ride, record or view the dashboard. Sending a ride to Strava is a manual upload of the .FIT, and it never writes to the trainer.

## Operating Context

- `uv run logger/thinkrider_logger.py` connects over Bluetooth LE to the trainer and, optionally, a Garmin Forerunner 165 broadcasting heart rate, then serves the dashboard at `http://localhost:8000`.
- Press Start to record, Finish (double click) to end the ride. Before Start the dashboard shows live numbers but saves nothing.
- Zwift and the ThinkRider app must be closed: the trainer and the watch accept one Bluetooth connection at a time.
- Rides are saved to `rides/x2max_YYYYMMDD_HHMMSS/` and sent to Strava or Garmin Connect from the dashboard (downloads the .FIT and opens the upload page).

## Capabilities and Constraints

- Live metrics: power, cadence, speed, heart rate, zones, NP/TSS, laps, live charts.
- Dashboard is React (source in `dashboard/src`, built with pnpm) served by the Python logger (uv).
- Must stay light on CPU and battery on a laptop running unplugged: no heavy animation, WebGL or constant re-rendering beyond what live data needs.
- Must work with no internet connection: no CDN scripts, web fonts or remote assets at runtime; everything is bundled locally.
- Must work in a laptop browser on macOS and on the Galaxy S26+ at phone width.

## Brand Commitments

- Dark mode stays. It is the primary look and must not be removed or made secondary.

## Evidence on Hand

Real ride data from the logger (`session_1hz.csv`, `.fit` files) and the `--demo` simulated ride. No users besides the owner, no testimonials or benchmarks: do not invent any.

## Product Principles

1. Glanceable first: the current numbers must read in under a second at a distance, mid-effort.
2. Never lose a ride: recording state is always obvious, and ending a ride is deliberate.
3. Light by default: every visual addition earns its CPU and battery cost.
4. Offline and private: works with no internet, and nothing leaves the machine unless the rider uploads it.
