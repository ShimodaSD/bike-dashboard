// Heart-rate zones in bpm, next to the power zones (util/ride.ts ZONES). Two ways to work them out:
//
//   max    5 zones from maximum heart rate, the split Garmin watches use by default:
//          Z1 < 60 %, Z2 60–70 %, Z3 70–80 %, Z4 80–90 %, Z5 90 %+ of max.
//   lthr   7 zones from lactate threshold heart rate (Joe Friel's cycling zones, "The Cyclist's
//          Training Bible"): Z1 < 81 %, Z2 81–89 %, Z3 90–93 %, Z4 94–99 %, Z5a 100–102 %,
//          Z5b 103–105 %, Z5c 106 %+ of LTHR.
//
// The rider can then move any zone's lower edge by hand (`lows`). Changing the method or the
// max / LTHR value goes back to the calculated edges.
import type { Sample } from '../types/feed';

export type HrMethod = 'max' | 'lthr';

export interface HrSettings {
  method: HrMethod;
  max: number | null;                 // max heart rate, bpm (null: not set)
  lthr: number | null;                // threshold heart rate, bpm (null: not set)
  lows: number[] | null;              // hand-set lower edge of Z2 … last zone, bpm (null: calculated)
}
export const HR_DEFAULT: HrSettings = { method: 'max', max: null, lthr: null, lows: null };

export interface HrZone {
  n: string;                          // Z1 … Z5 / Z5c
  name: string;
  lo: number;                         // first bpm in the zone (0 for Z1)
  hi: number | null;                  // last bpm in the zone (null: open-ended top zone)
}

interface ZoneDef { n: string; name: string; from: number }    // from: fraction of the reference
export const HR_METHODS: Record<HrMethod, { label: string; ref: string; refLong: string; defs: ZoneDef[] }> = {
  max: {
    label: 'Max heart rate (5 zones)', ref: 'max', refLong: 'Max heart rate',
    defs: [
      { n: 'Z1', name: 'Warm up', from: 0 },
      { n: 'Z2', name: 'Easy', from: 0.6 },
      { n: 'Z3', name: 'Aerobic', from: 0.7 },
      { n: 'Z4', name: 'Threshold', from: 0.8 },
      { n: 'Z5', name: 'Maximum', from: 0.9 },
    ],
  },
  lthr: {
    label: 'Threshold heart rate, LTHR (7 zones)', ref: 'LTHR', refLong: 'Threshold heart rate (LTHR)',
    defs: [
      { n: 'Z1', name: 'Recovery', from: 0 },
      { n: 'Z2', name: 'Aerobic', from: 0.81 },
      { n: 'Z3', name: 'Tempo', from: 0.90 },
      { n: 'Z4', name: 'Sub-threshold', from: 0.94 },
      { n: 'Z5a', name: 'Super-threshold', from: 1.00 },
      { n: 'Z5b', name: 'Aerobic capacity', from: 1.03 },
      { n: 'Z5c', name: 'Anaerobic capacity', from: 1.06 },
    ],
  },
};

export const HR_MIN = 80, HR_MAX = 230;            // accepted max HR / LTHR
export const refOf = (s: HrSettings) => (s.method === 'max' ? s.max : s.lthr);

// Lower edges (Z2 …) worked out from the reference.
export const calcLows = (method: HrMethod, ref: number) =>
  HR_METHODS[method].defs.slice(1).map(d => Math.round(d.from * ref));

// The zones in bpm, or null until the max HR / LTHR is set. Hand-set edges win when they fit.
export function hrZones(s: HrSettings): HrZone[] | null {
  const ref = refOf(s);
  if (!ref) return null;
  const defs = HR_METHODS[s.method].defs;
  const lows = s.lows && validLows(s.lows, defs.length) ? s.lows : calcLows(s.method, ref);
  return defs.map((d, i) => ({ n: d.n, name: d.name, lo: i ? lows[i - 1] : 0, hi: i < lows.length ? lows[i] - 1 : null }));
}

// Edges must rise by at least 1 bpm and sit in a heart-rate range.
export const validLows = (lows: number[], zones: number) =>
  lows.length === zones - 1 && lows.every((v, i) => Number.isInteger(v) && v >= 40 && v <= 250 && (i === 0 || v > lows[i - 1]));

export const hrZoneOf = (bpm: number, zones: HrZone[]) => {
  let i = 0;
  while (i + 1 < zones.length && bpm >= zones[i + 1].lo) i++;
  return i;
};

// Colours: the power zone colours in order, so Z1 grey … top zone red in both systems.
export const hrZoneColor = (i: number, zones: HrZone[]) =>
  `var(--z${zones.length <= 5 ? [1, 2, 3, 4, 6][i] : i + 1})`;

// Range text for a zone: "< 114", "114–132", "171+".
export const hrRange = (z: HrZone) => (z.lo === 0 ? `< ${(z.hi ?? 0) + 1}` : z.hi === null ? `${z.lo}+` : `${z.lo}–${z.hi}`);

// Seconds in each heart-rate zone: every second with a heart-rate reading counts (heart rate is
// still training while coasting), unlike power zones, which count moving seconds.
export function timeInHrZones(hist: Sample[], zones: HrZone[]) {
  const out = new Array<number>(zones.length).fill(0);
  for (const s of hist) if (s.heart_rate_bpm != null && s.heart_rate_bpm > 0) out[hrZoneOf(s.heart_rate_bpm, zones)]++;
  return out;
}
