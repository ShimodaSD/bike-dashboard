// What logger/thinkrider_logger.py sends on GET /events (Server-Sent Events).
// Keep in step with Live.now(), Live.tick(), Live.status, Devices and ControlBase.snapshot().

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
  dir: string;                       // ride folder name
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

// Trainer control (logger/trainer_control.py)
export type ControlState = 'off' | 'connecting' | 'on' | 'waiting' | 'lost' | 'error' | 'unsupported';
export interface ControlStatus {
  enabled: boolean;
  state: ControlState;
  mode: 'sim' | 'erg';
  grade: number;                     // % (Climb mode)
  power_w: number;                   // W (ERG mode)
  msg: string | null;
  supports: { sim: boolean; erg: boolean };
  power_range: [number, number];
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
}

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
