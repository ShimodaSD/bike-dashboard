// FTP test: a guided 20-minute test run by the logger (logger/ftp_test.py).
//   POST /ftp-test/start?ftp=   start a ride with the test (ftp = the FTP the targets use now)
//   POST /ftp-test/cancel       stop the test, keep riding
//   POST /ftp-test/delete?id=   remove a saved result
// status.ftp = { test, results, protocol, factor }. The logger works out the result when the
// 20 minutes end and saves it in config/ftp_tests.json, so every browser sees the history.
// FTP itself stays a setting of this browser: a result changes it only when you press Use.
import { useState } from 'react';
import { useArmed } from '../hooks/hooks';
import { useStored } from '../hooks/stored';
import { fmtT } from '../util/ride';
import type { FtpResult, FtpStatus, FtpStep, FtpTestRun, RideState, Sample } from '../types/feed';
import type { Workout } from '../types/workout';

const post = (path: string) => fetch(path, { method: 'POST' }).catch(() => {});
const PRESS = typeof window !== 'undefined' && window.matchMedia('(hover: none)').matches ? 'Tap' : 'Click';

export const startFtpTest = (ftp: number, kg: number | null = null) =>
  post(`/ftp-test/start?ftp=${Math.round(ftp)}${kg ? `&kg=${kg}` : ''}`);
export const cancelFtpTest = () => post('/ftp-test/cancel');
export const deleteFtpResult = (id: string) => post(`/ftp-test/delete?id=${encodeURIComponent(id)}`);

// The protocol as a workout, so the workout band, its beeps and the chart targets follow it.
export function protocolWorkout(steps: FtpStep[]): Workout {
  return {
    name: 'FTP test',
    segs: steps.map(s => ({ dur: s.dur, lo: s.lo, hi: s.hi, unit: 'ftp' as const, cad: null, name: s.name,
                            ...(s.lo == null ? { note: 'All out' } : {}) })),
    total: steps.reduce((t, s) => t + s.dur, 0),
  };
}

// Start / end of the 20 minutes, in seconds from the start of the test.
export function testWindow(steps: FtpStep[]): { start: number; end: number } {
  let t = 0;
  for (const s of steps) {
    if (s.test) return { start: t, end: t + s.dur };
    t += s.dur;
  }
  return { start: t, end: t };
}

export const totalMinutes = (steps: FtpStep[]) => Math.round(steps.reduce((t, s) => t + s.dur, 0) / 60);

// Where the ride is in the test: before the 20 minutes (seconds to go), in them (average so
// far and the FTP it gives) or past them.
export type TestProgress =
  | { phase: 'before'; until: number }
  | { phase: 'test'; into: number; left: number; avg: number | null; ftp: number | null }
  | { phase: 'after' };
export function testProgress(hist: Sample[], run: FtpTestRun, steps: FtpStep[], factor: number): TestProgress {
  const { start, end } = testWindow(steps);
  const t = hist.length - run.t0;
  if (t < start) return { phase: 'before', until: start - t };
  if (t >= end || run.state === 'done') return { phase: 'after' };
  const a = hist.slice(run.t0 + start, run.t0 + t);
  const avg = a.length ? a.reduce((s, x) => s + (x.power_w || 0), 0) / a.length : null;
  return { phase: 'test', into: t - start, left: end - t, avg, ftp: avg ? Math.round(avg * factor) : null };
}

// ------------------------------------------------------------------ guidance for the rider
// What to do now, step by step and through the 20 minutes. `ref` is the FTP the test started
// with; `ref / factor` is the 20 min power that would confirm it, a fair place to start pacing.
export function riderTip(hist: Sample[], run: FtpTestRun, steps: FtpStep[], factor: number, ref: number): string {
  const t = hist.length - run.t0, pace = Math.round(ref / factor / 5) * 5;
  let start = 0;
  for (const s of steps) {
    const into = t - start;
    if (into < s.dur) {
      if (s.test) {
        const left = s.dur - into;
        if (into < 300) return `Start a little conservative, near ${pace} W. Going out too hard is the most common mistake; you can raise it later.`;
        if (left <= 60) return 'Last minute: empty the tank.';
        if (left <= 300) return 'Last 5 minutes: if you have more, raise the power a little now.';
        return 'Hold it steady: small changes, no surges. Stay seated, smooth cadence, breathe.';
      }
      return STEP_TIP[s.name] ?? '';
    }
    start += s.dur;
  }
  return 'Spin easy for a few minutes, then Finish.';
}
const STEP_TIP: Record<string, string> = {
  'Warm-up': 'Easy spin, building up. Fan on, bottle in reach. Use the same bike, gearing and trainer setup each time you test.',
  '5 min hard': 'Hard but controlled: what you could hold for 5 minutes. It uses up the fresh legs that would make the 20 minutes read too high.',
  'Easy': 'Recover: spin easy, drink. Then 20 minutes at the hardest pace you can hold to the end.',
  'Cool-down': 'Spin easy for a few minutes, then Finish.',
};

// What the number means and when to test again (shown with the result and in Settings).
export const MEANING = 'FTP is an estimate of the power you can hold for about 35 to 50 minutes, not a full hour. ' +
  '95 % of the 20 min average reads a little high for many riders: if threshold work feels too hard, set it 2 to 4 % lower.';
const addWeeks = (iso: string, w: number) => { const d = new Date(iso); d.setDate(d.getDate() + w * 7); return d.toISOString(); };

export const fmtDate = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};
const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : '±'}${Math.abs(n)}`;

// ------------------------------------------------------------------ band above the workout while a test is on
interface FtpTestBandProps {
  ftpStatus: FtpStatus; hist: Sample[]; mode: RideState; ftp: number; setFtp: (v: number) => void;
}
export function FtpTestBand({ ftpStatus, hist, mode, ftp, setFtp }: FtpTestBandProps) {
  const run = ftpStatus.test!;
  const [stopArmed, pressStop] = useArmed(run.state);
  // Hide the running average and FTP so far (ride by feel); remembered in this browser.
  const [hideLive, setHideLive] = useStored('ftpHideLive', false);
  // "Keep" hides the new-FTP question for this result (a new result asks again)
  const [kept, setKept] = useState<string | null>(null);
  const res = run.result;

  if (run.state === 'stopped')
    return <section className="ftptest stopped" aria-label="FTP test">
      <span className="badge">FTP test</span>
      <span>Stopped before the 20 minutes ended, so no FTP was saved. <b>Resume ride</b> to carry on.</span>
    </section>;

  if (run.state === 'done')
    return <section className="ftptest done" aria-label="FTP test" aria-live="polite">
      <span className="badge done">FTP test</span>
      {!res ? <span>No power in the 20 minutes, so no FTP was saved.</span>
        : <>
          <span className="ft-result">
            <span className="ft-label">{ftp === res.ftp ? 'Your FTP' : 'New FTP'}</span>
            <b className="ft-big">{res.ftp}<small> W</small></b>
            <span className="ft-sub">95 % of {Math.round(res.avg_w)} W for 20 min
              {res.ftp_before ? <> · {signed(res.ftp - res.ftp_before)} W from {res.ftp_before} W</> : null}</span>
          </span>
          {ftp === res.ftp
            ? <span className="ft-note">Saved. Power zones and targets use {res.ftp} W now.</span>
            : kept === res.id
              ? <span className="ft-note">Saved in the test history. FTP kept at {ftp} W.</span>
              : <span className="ft-actions">
                  <button className="primary" onClick={() => setFtp(res.ftp)}>Use {res.ftp} W</button>
                  <button onClick={() => setKept(res.id)}>Keep {ftp} W</button>
                </span>}
        </>}
      {res && <p className="ft-hint">{MEANING} Test again in 4 to 8 weeks
        ({fmtDate(addWeeks(res.date, 4))} to {fmtDate(addWeeks(res.date, 8))}), rested and with the same setup, so the numbers compare.</p>}
      {mode === 'recording' && <span className="ft-hint">Cool down easy, then Finish.</span>}
    </section>;

  const p = testProgress(hist, run, ftpStatus.protocol, ftpStatus.factor);
  const tip = riderTip(hist, run, ftpStatus.protocol, ftpStatus.factor, run.ftp_before ?? ftp);
  return <section className={'ftptest ' + p.phase} aria-label="FTP test">
    <span className="badge">FTP test</span>
    {p.phase === 'before' && <span className="ft-msg">
      The 20 minutes start in <b>{fmtT(p.until)}</b>. {tip}</span>}
    {p.phase === 'test' && <>
      {hideLive ? <span className="ft-stat ft-hidden"><span className="ft-label">20 min avg · FTP so far</span><b>Hidden</b></span> : <>
        <span className="ft-stat"><span className="ft-label">20 min avg</span><b>{p.avg == null ? '–' : Math.round(p.avg)}<small> W</small></b></span>
        <span className="ft-stat"><span className="ft-label">FTP so far</span><b>{p.ftp ?? '–'}<small> W</small></b></span>
      </>}
      <span className="ft-stat"><span className="ft-label">Left</span><b>{fmtT(p.left)}</b></span>
      <span className="ft-msg ft-tip">{tip}</span>
    </>}
    {p.phase === 'after' && <span className="ft-msg">Working out your FTP…</span>}
    {p.phase !== 'after' && <button className="quiet ft-toggle" aria-pressed={hideLive} onClick={() => setHideLive(!hideLive)}
            title="The running average and FTP so far, during the 20 minutes">
      {hideLive ? 'Show FTP numbers' : 'Hide FTP numbers'}</button>}
    <button className={'quiet ft-stop' + (stopArmed ? ' danger armed' : '')} onClick={() => pressStop(cancelFtpTest)}>
      {stopArmed ? `${PRESS} again to stop the test` : 'Stop test'}</button>
  </section>;
}

// ------------------------------------------------------------------ Settings: start a test, saved results
export interface FtpTestSettingsProps {
  ftpStatus: FtpStatus | undefined; ftp: number; setFtp: (v: number) => void;
  recording: boolean; startArmed: boolean; onStart: () => void;
}
const SHOW = 4;
export function FtpTestSettings({ ftpStatus, ftp, setFtp, recording, startArmed, onStart }: FtpTestSettingsProps) {
  const [all, setAll] = useState(false);
  const results = ftpStatus?.results || [];
  const shown = all ? results : results.slice(0, SHOW);
  const mins = ftpStatus ? totalMinutes(ftpStatus.protocol) : 55;
  return <>
    <div className="inline">
      <button className={startArmed ? 'danger armed' : 'primary'} onClick={onStart} disabled={recording || !ftpStatus}>
        {startArmed ? `${PRESS} again to start` : 'Start FTP test'}</button>
    </div>
    <p className="help">{recording ? 'Finish the ride first. The test is a ride of its own.'
      : startArmed ? 'Starting clears the finished ride from the screen. Its files stay in the ride folder.'
      : <>About {mins} min: warm-up, 5 min hard, easy, then <b>20 min as hard as you can hold</b>. FTP = 95 % of the 20 min average. Starts recording.</>}</p>
    <FtpGuide />
    {results.length > 0 && <ul className="ftp-history" aria-label="FTP test results">
      {shown.map(r => <FtpRow key={r.id} r={r} inUse={r.ftp === ftp} onUse={() => setFtp(r.ftp)} />)}
    </ul>}
    {results.length > SHOW && <button className="quiet" onClick={() => setAll(a => !a)} aria-expanded={all}>
      {all ? 'Show fewer' : `Show all ${results.length} tests`}</button>}
  </>;
}

function FtpRow({ r, inUse, onUse }: { r: FtpResult; inUse: boolean; onUse: () => void }) {
  const [armed, press] = useArmed();
  return <li>
    <span className="fh-when">{fmtDate(r.date)}</span>
    <span className="fh-ftp"><b>{r.ftp} W</b><small>20 min {Math.round(r.avg_w)} W{r.avg_hr ? ` · ${r.avg_hr} bpm` : ''}</small></span>
    <span className="fh-act">
      {inUse ? <span className="badge done">In use</span>
        : <button onClick={onUse} aria-label={`Use ${r.ftp} W as FTP`}>Use</button>}
      <button className={'quiet' + (armed ? ' danger armed' : '')} onClick={() => press(() => deleteFtpResult(r.id))}
              aria-label={armed ? undefined : `Delete the test from ${fmtDate(r.date)}`}>
        {armed ? `${PRESS} again` : 'Delete'}</button>
    </span>
  </li>;
}

// How to do the test: before, during, the number, when to test again.
export function FtpGuide() {
  return <details className="ftp-guide">
    <summary>How to get a good test</summary>
    <h3>Before</h3>
    <ul>
      <li>Rested: no hard training the day before. Eat normally 2 to 3 hours before and bring a bottle.</li>
      <li>A fan on you. Heat alone can cost several percent.</li>
      <li>Same bike, gearing, trainer and time of day each time, so tests compare.</li>
      <li>Trainer control off or in Climb works best: you set the power. In ERG the hard efforts switch to Climb by themselves.</li>
    </ul>
    <h3>The 20 minutes</h3>
    <ul>
      <li>Even pacing gives the best number. Start a little conservative, near your current FTP ÷ 0.95, and raise it in the last 5 minutes if you can.</li>
      <li>Avoid surges and coasting: every second at 0 W lowers the average.</li>
      <li>The band shows the average so far and the FTP it gives.</li>
    </ul>
    <h3>The number</h3>
    <p>{MEANING}</p>
    <h3>When to test again</h3>
    <p>Every 4 to 8 weeks, or after a block of training or a long break. Same protocol each time: the trend matters more than any single result.</p>
  </details>;
}
