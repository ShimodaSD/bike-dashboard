// Ride review: a plain-language evaluation of a finished ride, worked out here from the 1 Hz
// samples, the FTP and the workout that was followed. Nothing leaves the machine.
//
// What it looks at:
//   intensity   IF (NP ÷ FTP) names the kind of ride, VI (NP ÷ avg power) says steady or surgy
//   load        TSS, with the usual recovery guide (Coggan: < 150 low, 150–300 medium, ...)
//   zones       where most of the moving time went
//   heart rate  aerobic decoupling (Pw:HR): power per beat in the first vs second half
//   pacing      power held in the second half (free rides with no HR)
//   workout     share of seconds within the power target, and the steps that missed it
//   FTP         a best 20 min (× 0.95) above the saved FTP says the FTP is set too low
import type { Sample } from '../types/feed';
import type { Workout } from '../types/workout';
import { ZONES, bestPower, stats, tssOf, type RideStats } from '../util/ride';
import { powerTol } from '../workout/workout';

export type Tone = 'good' | 'info' | 'warn';
export interface Note { id: string; tone: Tone; title: string; text: string }

export interface StepResult {
  i: number;
  name: string;
  target: number;                      // mean power target over the step, W
  avg: number;                         // mean power, W
  onPct: number;                       // % of seconds within the target (after the grace seconds)
}
export interface WorkoutReview {
  name: string;
  onPct: number;                       // % of targeted seconds within the target
  done: number;                        // steps with a power target the ride got through
  total: number;                       // steps with a power target
  missed: StepResult[];                // steps under 70 % on target, worst first
  complete: boolean;                   // the ride lasted the whole workout
}

export interface Review {
  kind: string;                        // "Endurance ride"
  load: string;                        // "Moderate load"
  summary: string;                     // one sentence
  IF: number | null;
  VI: number | null;
  tss: number | null;
  decoupling: number | null;           // %, positive = heart rate drifted up against power; null if not judged
  ef: number | null;                   // efficiency factor, NP ÷ avg HR
  workout: WorkoutReview | null;
  notes: Note[];
  tooShort: boolean;
}

export const MIN_REVIEW_S = 5 * 60;    // shorter than this: too little to say much
const DECOUPLE_MIN_S = 20 * 60;        // decoupling needs a reasonably long steady stretch
const DECOUPLE_SKIP_S = 5 * 60;        // leave out the warm-up, while heart rate is still rising
const STEADY_VI = 1.1;                 // above this the ride is too surgy for Pw:HR to mean much
const GRACE_S = 10;                    // seconds at the start of a step to reach the new target
const MISS_PCT = 70;

// IF bands: what a ride at this intensity usually is.
const KINDS: [maxIF: number, kind: string, what: string][] = [
  [0.55, 'Recovery ride', 'very easy spinning that helps you recover'],
  [0.75, 'Endurance ride', 'aerobic base work you can repeat often'],
  [0.85, 'Tempo ride', 'comfortably hard aerobic work'],
  [0.95, 'Sweet spot ride', 'hard but sustainable work just under threshold'],
  [1.05, 'Threshold ride', 'a hard effort around your FTP'],
  [Infinity, 'Very hard ride', 'an effort above your FTP'],
];

// TSS bands for one ride, and how long recovery usually takes.
function loadOf(tss: number): [label: string, text: string, tone: Tone] {
  if (tss < 50) return ['Light load', 'Easy on the body. Fine to train again tomorrow.', 'good'];
  if (tss < 150) return ['Moderate load', 'You should be recovered by tomorrow.', 'good'];
  if (tss < 300) return ['High load', 'Expect some fatigue tomorrow, mostly gone the day after. Keep tomorrow easy.', 'info'];
  if (tss < 450) return ['Very high load', 'Fatigue can last a couple of days. Plan easy days next.', 'warn'];
  return ['Extreme load', 'Fatigue can last several days. Rest and eat well.', 'warn'];
}

const pct = (x: number) => `${Math.round(x)}%`;

export interface ReviewInput {
  hist: Sample[];
  ftp: number;
  workout?: Workout | null;            // the workout followed, from ride second `woStart`
  woStart?: number;
  ftpTest?: boolean;                   // an FTP test: its own band judges the test, skip the workout part
  st?: RideStats;                      // stats(hist, ftp, null) if the caller already has them
}

export function reviewRide({ hist, ftp, workout, woStart = 0, ftpTest = false, st: given }: ReviewInput): Review {
  const st = given ?? stats(hist, ftp, null);
  const IF = st.np ? st.np / ftp : null;
  const VI = st.np && st.avgP ? st.np / st.avgP : null;
  const tss = tssOf(hist.length, st.np, ftp);
  const tooShort = st.moving < MIN_REVIEW_S;
  const notes: Note[] = [];

  const kindRow = IF === null ? null : KINDS.find(k => IF < k[0])!;
  const kind = ftpTest ? 'FTP test' : kindRow ? kindRow[1] : 'Ride';
  const [load, loadText, loadTone] = tss === null ? ['No load', '', 'info' as Tone] : loadOf(tss);

  // ---- intensity + zones
  const moving = st.moving || 1;
  const order = st.tiz.map((s, i) => ({ i, s })).sort((a, b) => b.s - a.s);
  const top = order[0], second = order[1];
  if (IF !== null && kindRow && !tooShort) {
    const zTxt = top.s ? `Most of it in ${ZONES[top.i].n} ${ZONES[top.i].name} (${pct((top.s / moving) * 100)})` +
      (second.s / moving >= 0.2 ? `, then ${ZONES[second.i].n} ${ZONES[second.i].name} (${pct((second.s / moving) * 100)})` : '') + '.' : '';
    notes.push({ id: 'intensity', tone: 'info', title: `Intensity ${IF.toFixed(2)}`,
      text: `${ftpTest ? 'Overall the ride was' : 'This was'} ${kindRow[2]}. ${zTxt}`.trim() });
  }
  if (VI !== null && !tooShort && !workout) {
    if (VI <= 1.05) notes.push({ id: 'steady', tone: 'good', title: 'Even pacing',
      text: `Variability ${VI.toFixed(2)}: your power was very steady, the most efficient way to ride.` });
    else if (VI > 1.15) notes.push({ id: 'steady', tone: 'info', title: 'Surgy ride',
      text: `Variability ${VI.toFixed(2)}: lots of surges and easing off. It costs more than the average power shows.` });
  }

  // ---- load
  if (tss !== null && !tooShort) notes.push({ id: 'load', tone: loadTone, title: `TSS ${Math.round(tss)}`, text: loadText });

  // ---- heart rate: aerobic decoupling (Pw:HR) over the steady part, after the warm-up
  let decoupling: number | null = null, ef: number | null = null;
  const withHr = hist.filter(s => s.heart_rate_bpm != null && s.heart_rate_bpm > 0 && (s.power_w || 0) > 0);
  if (st.np && st.avgHr && withHr.length > 0.8 * st.moving) ef = st.np / st.avgHr;
  const body = withHr.length > DECOUPLE_SKIP_S + DECOUPLE_MIN_S ? withHr.slice(DECOUPLE_SKIP_S) : null;
  const steady = VI !== null && VI <= STEADY_VI && !hasIntervals(workout);
  if (body && withHr.length > 0.8 * st.moving) {
    const half = Math.floor(body.length / 2);
    const efOf = (a: Sample[]) => a.reduce((t, s) => t + s.power_w, 0) / a.reduce((t, s) => t + (s.heart_rate_bpm as number), 0);
    const e1 = efOf(body.slice(0, half)), e2 = efOf(body.slice(half));
    decoupling = ((e1 - e2) / e1) * 100;
    if (steady) {
      const d = decoupling;
      notes.push(d < 5
        ? { id: 'hr', tone: 'good', title: `Heart rate held (${d.toFixed(1)}% drift)`,
            text: 'Power per heartbeat stayed steady from the first half to the second: your aerobic fitness covered this ride.' }
        : d < 10
        ? { id: 'hr', tone: 'info', title: `Some heart-rate drift (${d.toFixed(1)}%)`,
            text: 'Heart rate crept up against the same power. Normal near the end of your endurance; heat and drinking too little add to it.' }
        : { id: 'hr', tone: 'warn', title: `Big heart-rate drift (${d.toFixed(1)}%)`,
            text: 'Heart rate rose a lot against the same power. This ride was past your aerobic limit for its length, or heat, fatigue or drinking too little played a part.' });
    } else {
      decoupling = null;                 // intervals or surges: the number would mislead
      notes.push({ id: 'hr', tone: 'info', title: 'Heart-rate drift not judged',
        text: 'The power changed too much (intervals or surges) for heart-rate drift to say anything about aerobic fitness.' });
    }
  }

  // ---- pacing: power held in the second half (free rides without heart rate)
  if (!workout && !ftpTest && decoupling === null && st.moving >= DECOUPLE_MIN_S) {
    const mv = hist.filter(s => (s.power_w || 0) > 0 || (s.cadence_rpm || 0) > 0);
    const half = Math.floor(mv.length / 2);
    const avg = (a: Sample[]) => a.reduce((t, s) => t + (s.power_w || 0), 0) / (a.length || 1);
    const a1 = avg(mv.slice(0, half)), a2 = avg(mv.slice(half));
    const fade = a1 ? ((a1 - a2) / a1) * 100 : 0;
    if (fade > 10) notes.push({ id: 'pacing', tone: 'warn', title: `Faded ${Math.round(fade)}% in the second half`,
      text: `${Math.round(a1)} W in the first half, ${Math.round(a2)} W in the second. Start a little easier next time.` });
    else if (fade < -5) notes.push({ id: 'pacing', tone: 'good', title: 'Strong finish',
      text: `${Math.round(a2)} W in the second half against ${Math.round(a1)} W in the first.` });
  }

  // ---- workout
  const wr = workout && !ftpTest ? reviewWorkout(hist, workout, ftp, woStart) : null;
  if (wr) {
    const tone: Tone = wr.onPct >= 80 ? 'good' : wr.onPct >= 60 ? 'info' : 'warn';
    const miss = wr.missed.slice(0, 2).map(m => `${m.name} (${Math.round(m.avg)} W for ${Math.round(m.target)} W)`).join(' and ');
    notes.push({ id: 'workout', tone, title: `Workout ${pct(wr.onPct)} on target`,
      text: `${wr.name}: ${wr.done} of ${wr.total} steps ridden${wr.complete ? '' : ', stopped before the end'}.` +
        (miss ? ` Furthest off: ${miss}.` : ' Every step was close to its target.') });
  }

  // ---- FTP set too low?
  const b20 = bestPower(hist, 1200);
  if (!ftpTest && b20 && b20 * 0.95 > ftp * 1.03) {
    notes.push({ id: 'ftp', tone: 'info', title: 'Your FTP may be higher',
      text: `Your best 20 min was ${Math.round(b20)} W, which points to an FTP near ${Math.round(b20 * 0.95)} W against ${ftp} W set. ` +
        'Zones, TSS and this review use the set FTP: an FTP test would update it.' });
  }

  if (tooShort) notes.push({ id: 'short', tone: 'info', title: 'Short ride',
    text: 'Under 5 minutes of riding: too little to evaluate. Ride longer for a full review.' });

  // the workout first: when there was one, how it went matters most
  const ORDER = ['short', 'workout', 'intensity', 'load', 'hr', 'steady', 'pacing', 'ftp'];
  notes.sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));

  const summary = tooShort ? 'Too short to evaluate.'
    : ftpTest ? `FTP test${tss !== null ? `, TSS ${Math.round(tss)}` : ''}. ${loadText}`
    : `${kind}${tss !== null ? `, TSS ${Math.round(tss)}` : ''}. ${loadText}`;

  return { kind, load, summary: summary.trim(), IF, VI, tss, decoupling, ef, workout: wr, notes, tooShort };
}

// A workout with hard repeats (two or more power steps at least 15 % of FTP apart, ignoring
// warm-up and cool-down ramps) isn't steady, so decoupling isn't judged.
function hasIntervals(wo: Workout | null | undefined) {
  if (!wo) return false;
  const lv = wo.segs.filter(s => s.lo != null && s.unit === 'ftp' && s.lo === s.hi).map(s => s.lo as number);
  return lv.length > 1 && Math.max(...lv) - Math.min(...lv) >= 0.15;
}

export function reviewWorkout(hist: Sample[], wo: Workout, ftp: number, start = 0): WorkoutReview | null {
  const w = (v: number, unit: 'ftp' | 'w') => (unit === 'w' ? v : v * ftp);
  let t = start, on = 0, n = 0, done = 0, total = 0;
  const steps: StepResult[] = [];
  wo.segs.forEach((s, i) => {
    const t0 = t;
    t += s.dur;
    if (s.lo == null) return;
    total++;
    const lo = w(s.lo, s.unit), hi = w(s.hi ?? s.lo, s.unit);
    let son = 0, sn = 0, sp = 0, st = 0;
    for (let k = t0 + Math.min(GRACE_S, Math.floor(s.dur / 3)); k < Math.min(t, hist.length); k++) {
      const target = lo + ((hi - lo) * (k - t0)) / (s.dur || 1);
      const p = hist[k].power_w || 0;
      sn++; sp += p; st += target;
      if (Math.abs(p - target) <= powerTol(target)) son++;
    }
    if (!sn) return;
    if (hist.length >= t0 + s.dur * 0.9) done++;
    on += son; n += sn;
    steps.push({ i, name: s.name, target: st / sn, avg: sp / sn, onPct: (son / sn) * 100 });
  });
  if (!n) return null;
  const missed = steps.filter(s => s.onPct < MISS_PCT && s.target > 0)
    .sort((a, b) => Math.abs(b.avg - b.target) / b.target - Math.abs(a.avg - a.target) / a.target);
  return { name: wo.name, onPct: (on / n) * 100, done, total, missed, complete: hist.length >= start + wo.total };
}
