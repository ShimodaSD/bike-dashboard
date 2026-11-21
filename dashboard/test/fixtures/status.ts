// Logger status payloads (Live.status) for the component tests.
import type { ControlStatus, Status } from '../../src/types/feed';

export function status(over: Partial<Status> = {}): Status {
  return {
    state: 'connected', connected: true, device: 'THINK X2MAX',
    hr: { state: 'connected', device: 'Forerunner 165' },
    ride: { state: 'ready', n: 0, fit: null, dir: 'x2max_20260301_090000' },
    devices: { trainer: { mode: 'device', address: 'T1', name: 'THINK X2MAX' },
               hr: { mode: 'device', address: 'W1', name: 'Forerunner 165' } },
    scan: { state: null, found: [] },
    control: control(),
    ...over,
  };
}

export function control(over: Partial<ControlStatus> = {}): ControlStatus {
  return { enabled: false, state: 'off', mode: 'sim', grade: 0, trainer_grade: 0,
           sim: { difficulty: 100, crr: 0.004, cw: 0.51 }, power_w: 150, msg: null,
           supports: { sim: true, erg: true }, power_range: [50, 1000], ...over };
}

export const recording = (over: Partial<Status> = {}) =>
  status({ ride: { state: 'recording', n: 1, fit: null, dir: 'x2max_20260301_090000' }, ...over });

export const finished = (fit: string | null = 'ride_20260301_090000.fit') =>
  status({ ride: { state: 'finished', n: 1, fit, dir: 'x2max_20260301_090000' } });
