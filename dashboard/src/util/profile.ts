// Weight-based numbers: W/kg and where a W/kg sits on Andrew Coggan's power profile
// (Allen & Coggan, "Training and Racing with a Power Meter", VeloPress). The table rates 5 s,
// 1 min, 5 min and functional threshold (FT) power per kg, separately for men and women.
//
// The book's table has one row per step with a category label on the first row of each band.
// A band runs from its labelled row down to the row before the next label, so each lower bound
// below is the last row of that band; anything under Fair's last row is Untrained.
export type ProfileSex = 'm' | 'f';
export type ProfileDur = '5s' | '1min' | '5min' | 'ft';

export const LEVELS = ['World class', 'Exceptional', 'Excellent (Cat 1)', 'Very good (Cat 2)',
                       'Good (Cat 3)', 'Moderate (Cat 4)', 'Fair (Cat 5)', 'Untrained'] as const;
export type Level = typeof LEVELS[number];

// Lower bound (W/kg) of World class … Fair, top to bottom.
const BOUNDS: Record<ProfileSex, Record<ProfileDur, number[]>> = {
  m: {
    '5s':   [22.51, 20.74, 18.96, 17.18, 15.11, 13.33, 11.56],
    '1min': [10.47, 9.78, 9.09, 8.40, 7.59, 6.90, 6.21],
    '5min': [6.67, 6.05, 5.43, 4.81, 4.08, 3.46, 2.84],
    ft:     [5.60, 5.07, 4.53, 4.00, 3.38, 2.84, 2.31],
  },
  f: {
    '5s':   [17.48, 16.19, 14.89, 13.60, 12.09, 10.80, 9.51],
    '1min': [8.47, 7.93, 7.39, 6.84, 6.21, 5.66, 5.12],
    '5min': [5.88, 5.31, 4.74, 4.17, 3.50, 2.93, 2.36],
    ft:     [4.95, 4.46, 3.97, 3.47, 2.90, 2.40, 1.91],
  },
};

export const PROFILE_SOURCE = "Coggan's power profile (Allen & Coggan, Training and Racing with a Power Meter)";

export function levelOf(dur: ProfileDur, wkg: number, sex: ProfileSex): Level {
  const i = BOUNDS[sex][dur].findIndex(lo => wkg >= lo);
  return LEVELS[i < 0 ? LEVELS.length - 1 : i];
}

// Short form for tight spaces: "Cat 3", "World class".
export const shortLevel = (l: Level) => /\((Cat \d)\)/.exec(l)?.[1] ?? l;

export const wkgOf = (w: number | null | undefined, kg: number | null | undefined) =>
  w != null && kg ? w / kg : null;
export const fmtWkg = (x: number | null) => (x == null ? '–' : x.toFixed(2));

// The ride's power profile: best 5 s, 1 min, 5 min and 20 min in W and W/kg, with a level.
// The 20 min is rated as FT from 95 % of it (the same rule as the FTP test).
export interface Peak { label: string; sec: number; w: number | null; wkg: number | null; level: Level | null }
export const PEAKS: { label: string; sec: number; dur: ProfileDur; factor: number }[] = [
  { label: '5 s', sec: 5, dur: '5s', factor: 1 },
  { label: '1 min', sec: 60, dur: '1min', factor: 1 },
  { label: '5 min', sec: 300, dur: '5min', factor: 1 },
  { label: '20 min', sec: 1200, dur: 'ft', factor: 0.95 },
];
export function peaksOf(best: (sec: number) => number | null, kg: number | null, sex: ProfileSex): Peak[] {
  return PEAKS.map(({ label, sec, dur, factor }) => {
    const w = best(sec), wkg = wkgOf(w, kg);
    return { label, sec, w, wkg, level: wkg == null || !w ? null : levelOf(dur, wkg * factor, sex) };
  });
}
