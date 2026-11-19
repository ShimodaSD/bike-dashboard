// Fake rides for the tests: 1 Hz samples like the logger's `sample` events.
import type { Sample } from '../../src/types/feed';

export function sample(t: number, over: Partial<Sample> = {}): Sample {
  return {
    t, timestamp_utc: new Date(Date.UTC(2026, 2, 1, 9, 0, t)).toISOString(), lap: 1,
    power_w: 200, cadence_rpm: 90, speed_kmh: 30, heart_rate_bpm: 140,
    distance_m: (t + 1) * 30 / 3.6, energy_kj: (t + 1) * 0.2, grade_pct: null, ...over,
  };
}

// One sample per entry of `powers`; distance and energy add up like the logger's.
export function ride(powers: number[], over: Partial<Sample> = {}): Sample[] {
  let dist = 0, kj = 0;
  return powers.map((p, t) => {
    dist += (over.speed_kmh ?? 30) / 3.6;
    kj += Math.max(p, 0) / 1000;
    return sample(t, { power_w: p, distance_m: dist, energy_kj: kj, ...over });
  });
}
