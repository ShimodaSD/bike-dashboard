// What logger/thinkrider_logger.py sends on GET /events (Server-Sent Events).
// Keep in step with Live.now(), Live.tick(), Live.status, Devices and ControlBase.snapshot().
import type { Workout } from './workout';
import type { CoachStatus } from './coach';

// The four ride series shown on the charts.
export type SeriesKey = 'power_w' | 'cadence_rpm' | 'heart_rate_bpm' | 'speed_kmh';

// `live` (every trainer packet) and `preview` (1 Hz before Start / after Finish): instant numbers.
// speed and heart rate are null when the trainer sends no speed or there is no HR source.
export interface LiveValues {
  power_w: number;
  cadence_rpm: number;
  speed_kmh: number | null;
  heart_rate_bpm: number | null;
}

// `sample`: one recorded second. `t` is its index in the ride history.
export interface Sample extends LiveValues {
  t: number;
  timestamp_utc: string;
  lap: number;                       // 1-based
  distance_m: number;
  energy_kj: number;
  grade_pct: number | null;          // set while trainer control is on
}

export type TrainerState = 'starting' | 'searching' | 'connected' | 'demo' | 'reconnecting' | 'off';
export type HrState = 'off' | 'searching' | 'connected' | 'reconnecting';
export type RideState = 'ready' | 'recording' | 'finished';
export type DeviceRole = 'trainer' | 'hr';
export type DeviceKind = DeviceRole | 'other';

export interface HrStatus {
  state: HrState;
  device: string | null;
}

export interface RideStatus {
  state: RideState;
  n: number;                         // ride number since the logger started
  fit: string | null;                // the finished ride's .FIT file name
  paused?: boolean;                  // Pause pressed: the timer stops, nothing is recorded
  dir: string;                       // ride folder name
  kg?: number | null;                // rider weight saved with this ride (sent with Start)
}

// Device panel: what each role connects to.
export interface DeviceChoice {
  mode: 'auto' | 'device' | 'off';
  address?: string | null;
  name?: string | null;
}

export interface FoundDevice {
  address: string;
  name: string | null;
  rssi: number | null;
  kind: DeviceKind;
}

export interface ScanStatus {
  state: 'scanning' | 'done' | 'error' | null;
  found: FoundDevice[];
  error?: string;
}

// Climb feel (logger/trainer_control.py SIM_DEFAULTS), saved by the logger.
export interface SimSettings {
  difficulty: number;                // % of the grade sent to the trainer
  crr: number;                       // rolling resistance
  cw: number;                        // wind resistance coefficient, kg/m
}

// Trainer control (logger/trainer_control.py)
export type ControlState = 'off' | 'connecting' | 'on' | 'waiting' | 'lost' | 'error' | 'unsupported';
export interface ControlStatus {
  enabled: boolean;
  state: ControlState;
  mode: 'sim' | 'erg';
  grade: number;                     // % (Climb mode): the road grade picked
  trainer_grade: number;             // % the trainer is sent: grade x difficulty
  sim: SimSettings;                  // climb feel
  power_w: number;                   // W (ERG mode)
  msg: string | null;
  supports: { sim: boolean; erg: boolean };
  power_range: [number, number];
}

// FTP test (logger/ftp_test.py). Steps: lo / hi = power target as a fraction of FTP, null = no target.
export interface FtpStep {
  name: string;
  dur: number;                       // s
  lo: number | null;
  hi: number | null;
  test?: boolean;                    // the 20 minutes that set the FTP
}

export interface FtpResult {
  id: string;
  date: string;                      // local time, ISO
  ftp: number;                       // W, 95 % of avg_w
  avg_w: number;                     // 20 min average power
  max_w?: number;
  avg_hr?: number | null;
  max_hr?: number | null;
  avg_cad?: number | null;
  ftp_before?: number | null;        // the dashboard's FTP when the test started
  ride?: string | null;              // ride folder
}

export interface FtpTestRun {
  state: 'running' | 'done' | 'stopped';
  t0: number;                        // ride second the test started at
  ftp_before: number | null;
  result: FtpResult | null;          // set when done (null if the 20 min had no power)
}

export interface FtpStatus {
  test: FtpTestRun | null;
  results: FtpResult[];              // newest first, kept in config/ftp_tests.json
  protocol: FtpStep[];
  factor: number;                    // 0.95
}

export interface Status {
  state: TrainerState;
  connected: boolean;
  device: string | null;
  hr: HrStatus;
  ride: RideStatus;
  devices?: Record<DeviceRole, DeviceChoice>;
  scan?: ScanStatus;
  control?: ControlStatus;
  ftp?: FtpStatus;
  coach?: CoachStatus;               // logger/coach.py: Ask Claude on the Ride review
  workout?: Workout | null;          // logger/workout_store.py: the loaded workout, the same in every browser
  media?: MediaStatus;               // logger/media_control.py: the Mac's music
}

// What plays on the logger's Mac. `now` is only known for the Spotify and Music apps (YouTube Music
// in a browser plays but reports nothing). keys: whether media keys may be pressed (Accessibility).
export interface MediaStatus {
  available: boolean;
  keys?: boolean | null;
  volume?: number | null;
  now?: { app: string; title: string; artist: string; playing: boolean } | null;
}
export type MediaAction = 'playpause' | 'next' | 'previous' | 'volup' | 'voldown';

// `init`: the whole ride so far, sent on connect, Start and Clear.
export interface InitPayload {
  history: Sample[];
  laps: number[];                    // history index where each lap starts
  status: Status;
}

// Event name -> JSON payload.
export interface FeedEvents {
  init: InitPayload;
  sample: Sample;
  live: LiveValues;
  preview: LiveValues;
  laps: number[];
  status: Status;
}
