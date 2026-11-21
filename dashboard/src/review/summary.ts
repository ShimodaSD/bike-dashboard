// The ride summary sent to Claude when the rider presses Ask Claude (logger/coach.py): numbers
// worked out here, a 1-minute profile and the local review's notes. Not the raw 1 Hz recording.
import type { Sample } from '../types/feed';
import { ZONES, bestPower, stats, type RideStats } from '../util/ride';
import type { Review } from './review';

const r = (v: number | null | undefined, nd = 0) => (v == null || !Number.isFinite(v) ? null : +v.toFixed(nd));
const avgOf = (a: number[]) => (a.length ? a.reduce((t, x) => t + x, 0) / a.length : null);

// Minute-by-minute averages (power over all seconds, heart rate / cadence over seconds that have them).
function profile(hist: Sample[]) {
  const out: { min: number; w: number | null; hr: number | null; rpm: number | null }[] = [];
  for (let i = 0; i < hist.length; i += 60) {
    const m = hist.slice(i, i + 60);
    out.push({ min: i / 60, w: r(avgOf(m.map(s => s.power_w || 0))),
               hr: r(avgOf(m.flatMap(s => (s.heart_rate_bpm ? [s.heart_rate_bpm] : [])))),
               rpm: r(avgOf(m.flatMap(s => (s.cadence_rpm > 0 ? [s.cadence_rpm] : [])))) });
  }
  return out;
}

export interface SummaryInput {
  hist: Sample[]; st: RideStats; ftp: number; review: Review; laps?: number[]; source: 'live' | 'file'; name?: string;
}

export function rideSummary({ hist, st, ftp, review, laps = [0], source }: SummaryInput) {
  const half = Math.floor(hist.length / 2);
  const h1 = stats(hist.slice(0, half), ftp, null), h2 = stats(hist.slice(half), ftp, half > 0 ? hist[half - 1] : null);
  const lapRows = laps.slice(0, 30).map((start, i) => {
    const end = i + 1 < laps.length ? laps[i + 1] : hist.length;
    const ls = stats(hist.slice(start, end), ftp, start > 0 ? hist[start - 1] : null);
    return { lap: i + 1, min: r(ls.n / 60, 1), avg_w: r(ls.avgP), np_w: r(ls.np), avg_hr: r(ls.avgHr), rpm: r(ls.avgCad) };
  });
  const wo = review.workout;
  return {
    ride: {
      source,
      start: hist[0]?.timestamp_utc ?? null,
      duration_min: r(hist.length / 60, 1), moving_min: r(st.moving / 60, 1),
      ftp_w: ftp,
      avg_w: r(st.avgP), np_w: r(st.np), max_w: r(st.maxP),
      best_w: { '1min': r(bestPower(hist, 60)), '5min': r(bestPower(hist, 300)), '20min': r(bestPower(hist, 1200)) },
      if: r(review.IF, 2), tss: r(review.tss), vi: r(review.VI, 2),
      avg_hr: r(st.avgHr), max_hr: st.maxHr, avg_rpm: r(st.avgCad), avg_kmh: r(st.avgSpd, 1),
      distance_km: r(st.dist / 1000, 1), kj: r(st.kj),
      zones_min: Object.fromEntries(ZONES.map((z, i) => [`${z.n} ${z.name}`, r(st.tiz[i] / 60, 1)])),
      halves: [{ avg_w: r(h1.avgP), avg_hr: r(h1.avgHr) }, { avg_w: r(h2.avgP), avg_hr: r(h2.avgHr) }],
      hr_drift_pct: r(review.decoupling, 1),
      laps: lapRows.length > 1 ? lapRows : undefined,
      workout: wo ? { name: wo.name, on_target_pct: r(wo.onPct), steps_ridden: wo.done, steps: wo.total, complete: wo.complete,
                      missed: wo.missed.slice(0, 5).map(m => ({ step: m.name, target_w: r(m.target), avg_w: r(m.avg) })) } : undefined,
      profile_1min: profile(hist),
    },
    local_review: { kind: review.kind, load: review.load, notes: review.notes.map(n => `${n.title}. ${n.text}`) },
  };
}
export type RideSummary = ReturnType<typeof rideSummary>;
