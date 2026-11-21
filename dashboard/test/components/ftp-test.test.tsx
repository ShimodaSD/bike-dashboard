// FTP test on the dashboard: the start buttons, the band while it runs, the result
// (Use / Keep) and the saved results in Settings.
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FtpTestSettings } from '../../src/ftp/ftp';
import { FakeEventSource, latestStream } from '../fixtures/eventsource';
import { ftpStatus, result } from '../fixtures/ftp';
import { ride } from '../fixtures/ride';
import { finished, recording, status } from '../fixtures/status';
import type { FtpStatus, Sample, Status } from '../../src/types/feed';

vi.mock('../../src/charts/charts', () => ({ Charts: () => <div data-testid="charts" /> }));

const posted = () => vi.mocked(fetch).mock.calls.map(c => c[0]);

async function renderApp(st: Status, history: Sample[] = []) {
  vi.resetModules();
  const { App } = await import('../../src/app');
  const user = userEvent.setup({ delay: null });
  render(<App />);
  latestStream().emit('init', { history, laps: [0], status: st });
  return user;
}
const band = () => screen.getByRole('region', { name: 'FTP test' });

beforeEach(() => {
  FakeEventSource.all = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  localStorage.clear();
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(new Date('2026-11-19T09:00:00Z'));
});

describe('starting a test', () => {
  it('the ready strip has a Start FTP test button that sends the current FTP', async () => {
    localStorage.setItem('x2max.ftp', '230');
    const user = await renderApp(status({ ftp: ftpStatus() }));
    await user.click(screen.getByRole('button', { name: 'Start FTP test' }));
    expect(posted()).toEqual(['/ftp-test/start?ftp=230']);
  });

  it('no button when the logger has no FTP test (older logger)', async () => {
    await renderApp(status());
    expect(screen.queryByRole('button', { name: 'Start FTP test' })).not.toBeInTheDocument();
  });

  it('over an unsaved finished ride it needs a second press', async () => {
    const user = await renderApp({ ...finished(), ftp: ftpStatus() }, ride([200, 200]));
    act(() => { window.location.hash = '#train'; window.dispatchEvent(new HashChangeEvent('hashchange')); });
    const start = () => screen.getByRole('button', { name: /start ftp test|again to start/i });
    await user.click(start());
    expect(start()).toHaveTextContent('Click again to start');
    expect(posted()).not.toContain('/ftp-test/start?ftp=200');
    act(() => vi.advanceTimersByTime(600));
    await user.click(start());
    expect(posted()).toContain('/ftp-test/start?ftp=200');
  });
});

describe('while the test runs', () => {
  it('counts down to the 20 minutes and shows the protocol as the workout', async () => {
    await renderApp(recording({ ftp: ftpStatus({}) }), ride(new Array(60).fill(110)));
    expect(band()).toHaveTextContent('The 20 minutes start in 24:00');
    expect(band()).toHaveTextContent('Fan on, bottle in reach');
    const wo = screen.getByRole('region', { name: 'Workout' });
    expect(wo).toHaveTextContent('FTP test');
    expect(wo).toHaveTextContent('Step 1/5 · Warm-up');
    expect(within(wo).queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
    expect(screen.getByText(/Recording FTP test 1/)).toBeInTheDocument();
  });

  it('in the 20 minutes: average so far, FTP so far and time left', async () => {
    const hist = ride([...new Array(1500).fill(120), ...new Array(600).fill(260)]);
    await renderApp(recording({ ftp: ftpStatus({}) }), hist);
    expect(band()).toHaveTextContent('20 min avg260 W');
    expect(band()).toHaveTextContent('FTP so far247 W');
    expect(band()).toHaveTextContent('Left10:00');
    expect(band()).toHaveTextContent('Hold it steady');
    expect(screen.getByRole('region', { name: 'Workout' })).toHaveTextContent('Your pace');
  });

  it('Hide FTP numbers hides the running average and FTP so far, and is remembered', async () => {
    const hist = ride([...new Array(1500).fill(120), ...new Array(600).fill(260)]);
    const user = await renderApp(recording({ ftp: ftpStatus({}) }), hist);
    await user.click(screen.getByRole('button', { name: 'Hide FTP numbers' }));
    expect(band()).not.toHaveTextContent('260 W');
    expect(band()).not.toHaveTextContent('247 W');
    expect(band()).toHaveTextContent('Hidden');
    expect(band()).toHaveTextContent('Left10:00');
    expect(screen.getByRole('button', { name: 'Show FTP numbers' })).toHaveAttribute('aria-pressed', 'true');
    expect(localStorage.getItem('x2max.ftpHideLive')).toBe('true');
    await user.click(screen.getByRole('button', { name: 'Show FTP numbers' }));
    expect(band()).toHaveTextContent('FTP so far247 W');
  });

  it('a hidden choice from an earlier test stays hidden', async () => {
    localStorage.setItem('x2max.ftpHideLive', 'true');
    await renderApp(recording({ ftp: ftpStatus({}) }), ride([...new Array(1500).fill(120), ...new Array(60).fill(250)]));
    expect(band()).not.toHaveTextContent('250 W');
    expect(band()).toHaveTextContent('Hidden');
    expect(screen.getByRole('button', { name: 'Show FTP numbers' })).toBeInTheDocument();
  });

  it('the result still shows the FTP', async () => {
    localStorage.setItem('x2max.ftpHideLive', 'true');
    await renderApp({ ...finished(), ftp: ftpStatus({ state: 'done', result: result() }, [result()]) }, ride([200]));
    expect(band()).toHaveTextContent('New FTP247 W');
  });

  it('Stop test needs a second press and keeps the ride going', async () => {
    const user = await renderApp(recording({ ftp: ftpStatus({}) }), ride([100]));
    await user.click(screen.getByRole('button', { name: 'Stop test' }));
    act(() => vi.advanceTimersByTime(600));
    await user.click(screen.getByRole('button', { name: /again to stop the test/ }));
    expect(posted()).toEqual(['/ftp-test/cancel']);
  });

  it('a loaded workout comes back once the test is off', async () => {
    localStorage.setItem('x2max.workout', JSON.stringify({ name: 'Sweet spot', total: 60,
      segs: [{ dur: 60, lo: 0.9, hi: 0.9, unit: 'ftp', cad: null, name: 'Steady' }] }));
    await renderApp(recording({ ftp: ftpStatus({}) }), ride([100]));
    expect(screen.getByRole('region', { name: 'Workout' })).toHaveTextContent('FTP test');
    latestStream().emit('status', recording({ ftp: ftpStatus(null) }));
    expect(screen.getByRole('region', { name: 'Workout' })).toHaveTextContent('Sweet spot');
  });
});

describe('the result', () => {
  const done = (over = {}) => ftpStatus({ state: 'done', result: result(over) }, [result(over)]);

  it('asks to use the new FTP; Use changes it and the zones', async () => {
    const user = await renderApp(recording({ ftp: done() }), ride(new Array(2710).fill(200)));
    expect(band()).toHaveTextContent('New FTP247 W');
    expect(band()).toHaveTextContent('95 % of 260 W for 20 min · +27 W from 220 W');
    expect(band()).toHaveTextContent('about 35 to 50 minutes');
    expect(band()).toHaveTextContent('Test again in 4 to 8 weeks (Dec 17, 2026 to Jan 14, 2027)');
    await user.click(within(band()).getByRole('button', { name: 'Use 247 W' }));
    expect(localStorage.getItem('x2max.ftp')).toBe('247');
    expect(band()).toHaveTextContent('Your FTP247 W');
    expect(band()).toHaveTextContent('Power zones and targets use 247 W now.');
  });

  it('Keep leaves the FTP as it is', async () => {
    const user = await renderApp({ ...finished(), ftp: done() }, ride([200]));
    await user.click(within(band()).getByRole('button', { name: 'Keep 200 W' }));
    expect(localStorage.getItem('x2max.ftp')).toBeNull();
    expect(band()).toHaveTextContent('Saved in the test history. FTP kept at 200 W.');
  });

  it('a lower FTP shows the drop', async () => {
    await renderApp({ ...finished(), ftp: done({ ftp: 209, avg_w: 220 }) }, ride([200]));
    expect(band()).toHaveTextContent('−11 W from 220 W');
  });

  it('stopped early: no FTP, Resume carries on', async () => {
    await renderApp({ ...finished(), ftp: ftpStatus({ state: 'stopped' }) }, ride([200]));
    expect(band()).toHaveTextContent('Stopped before the 20 minutes ended, so no FTP was saved');
  });

  it('no power in the 20 minutes', async () => {
    await renderApp({ ...finished(), ftp: ftpStatus({ state: 'done', result: null }) }, ride([0]));
    expect(band()).toHaveTextContent('No power in the 20 minutes');
  });
});

describe('saved results in Settings', () => {
  function Harness({ st, recording = false }: { st: FtpStatus; recording?: boolean }) {
    const [ftp, setFtp] = useState(247);
    return <>
      <FtpTestSettings ftpStatus={st} ftp={ftp} setFtp={setFtp} recording={recording} startArmed={false}
                       onStart={() => fetch('/start-test', { method: 'POST' })} />
      <output data-testid="ftp">{ftp}</output>
    </>;
  }
  const list = [result(), result({ id: 'b', date: '2026-10-01T07:00:00', ftp: 231, avg_w: 243, avg_hr: null }),
                result({ id: 'c', date: '2026-09-01T07:00:00', ftp: 225 }), result({ id: 'd', ftp: 220 }),
                result({ id: 'e', ftp: 215 })];

  it('lists them newest first; Use sets the FTP; the one in use says so', async () => {
    const user = userEvent.setup({ delay: null });
    render(<Harness st={ftpStatus(null, list)} />);
    const rows = within(screen.getByRole('list', { name: 'FTP test results' })).getAllByRole('listitem');
    expect(rows).toHaveLength(4);                       // the rest behind "Show all"
    expect(rows[0]).toHaveTextContent('247 W');
    expect(rows[0]).toHaveTextContent('In use');
    expect(rows[1]).toHaveTextContent('231 W20 min 243 W');
    await user.click(screen.getByRole('button', { name: 'Use 231 W as FTP' }));
    expect(screen.getByTestId('ftp')).toHaveTextContent('231');
    await user.click(screen.getByRole('button', { name: 'Show all 5 tests' }));
    expect(within(screen.getByRole('list', { name: 'FTP test results' })).getAllByRole('listitem')).toHaveLength(5);
  });

  it('a guide on how to get a good test', async () => {
    const user = userEvent.setup({ delay: null });
    render(<Harness st={ftpStatus()} />);
    await user.click(screen.getByText('How to get a good test'));
    expect(screen.getByText(/A fan on you/)).toBeVisible();
    expect(screen.getByText(/Every 4 to 8 weeks/)).toBeVisible();
  });

  it('Delete needs a second press', async () => {
    const user = userEvent.setup({ delay: null });
    render(<Harness st={ftpStatus(null, [result({ id: 'a b' })])} />);
    await user.click(screen.getByRole('button', { name: /^Delete the test/ }));
    expect(posted()).toEqual([]);
    act(() => vi.advanceTimersByTime(600));
    await user.click(screen.getByRole('button', { name: 'Click again' }));
    expect(posted()).toEqual(['/ftp-test/delete?id=a%20b']);
  });

  it('can’t start during a ride', () => {
    render(<Harness st={ftpStatus()} recording />);
    expect(screen.getByRole('button', { name: 'Start FTP test' })).toBeDisabled();
    expect(screen.getByText('Finish the ride first. The test is a ride of its own.')).toBeInTheDocument();
  });
});
