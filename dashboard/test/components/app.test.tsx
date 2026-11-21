// The whole dashboard against a fake logger stream: Start, Lap, Finish (two presses), keys,
// the ride strip and the finished screen. Charts are stubbed (uPlot needs a real canvas;
// the end-to-end tests cover them).
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeEventSource, latestStream } from '../fixtures/eventsource';
import { ride } from '../fixtures/ride';
import { finished, recording, status } from '../fixtures/status';
import type { Status } from '../../src/types/feed';

vi.mock('../../src/charts/charts', () => ({ Charts: () => <div data-testid="charts" /> }));

const posted = () => vi.mocked(fetch).mock.calls.map(c => c[0]);

async function renderApp(st: Status = status(), history = ride([])) {
  vi.resetModules();                                // fresh feed and settings stores
  const { App } = await import('../../src/app');
  const user = userEvent.setup({ delay: null });
  render(<App />);
  latestStream().emit('init', { history, laps: [0], status: st });
  return user;
}

beforeEach(() => {
  FakeEventSource.all = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  localStorage.clear();
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(new Date('2026-03-01T09:00:00Z'));
});

describe('Start and Finish', () => {
  it('Start posts /start right away when nothing is unsaved', async () => {
    const user = await renderApp();
    expect(screen.getByRole('status', { name: '' })).toHaveTextContent('Nothing is saved until you press Start');
    await user.click(screen.getByRole('button', { name: /^Start/ }));
    expect(posted()).toContain('/start');
  });

  it('Finish needs a second press, not a double tap, within 4 s', async () => {
    const user = await renderApp(recording(), ride([200, 210, 220]));
    const finish = () => screen.getByRole('button', { name: /finish/i });
    await user.click(finish());
    expect(finish()).toHaveTextContent('Click again to finish');
    await user.click(finish());                       // double tap: ignored
    expect(posted()).not.toContain('/finish');
    act(() => vi.advanceTimersByTime(600));
    await user.click(finish());
    expect(posted()).toContain('/finish');
  });

  it('Finish disarms by itself after 4 s', async () => {
    const user = await renderApp(recording(), ride([200]));
    await user.click(screen.getByRole('button', { name: /finish/i }));
    act(() => vi.advanceTimersByTime(4100));
    expect(screen.getByRole('button', { name: /finish/i })).toHaveTextContent(/^Finish/);
  });

  it('keys: L lap, F twice to finish, S start', async () => {
    const user = await renderApp(recording(), ride([200]));
    await user.keyboard('l');
    expect(posted()).toContain('/lap');
    await user.keyboard('f');
    act(() => vi.advanceTimersByTime(600));
    await user.keyboard('f');
    expect(posted()).toContain('/finish');
    latestStream().emit('status', status());
    await user.keyboard('s');
    expect(posted()).toContain('/start');
  });

  it('keys typed into a field are not shortcuts', async () => {
    const user = await renderApp();
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await user.type(screen.getByLabelText('Weight'), 's');
    expect(posted()).not.toContain('/start');
  });
});

describe('recording', () => {
  it('shows REC, the ride time and the current lap', async () => {
    await renderApp(recording(), ride(Array(75).fill(250)));
    expect(screen.getAllByText('REC').length).toBeGreaterThan(0);
    expect(screen.getByText('Recording ride 1 · saved every second to')).toBeInTheDocument();
    const time = screen.getByText('Ride time').closest('.tile')!;
    expect(time).toHaveTextContent('1:15');
    expect(within(screen.getByLabelText('Current lap')).getByText('Lap 1')).toBeInTheDocument();
    expect(document.documentElement.dataset.ride).toBe('recording');
  });

  it('new samples update the numbers', async () => {
    await renderApp(recording(), ride([]));
    const h = ride(Array(31).fill(300));
    h.forEach(s => latestStream().emit('sample', s));
    expect(screen.getByText('Normalized power').closest('.tile')).toHaveTextContent('300W');
  });

  it('a lap flashes "Lap 2 started"', async () => {
    await renderApp(recording(), ride(Array(10).fill(200)));
    latestStream().emit('laps', [0, 10]);
    expect(screen.getByText('Lap 2 started')).toBeInTheDocument();
  });

  it('starting a ride closes an open panel', async () => {
    const user = await renderApp();
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByRole('complementary', { name: 'Settings' })).toBeInTheDocument();
    latestStream().emit('status', recording());
    expect(screen.queryByRole('complementary', { name: 'Settings' })).not.toBeInTheDocument();
  });
});

describe('finished', () => {
  it('shows the saved file, Resume and the Send buttons', async () => {
    const user = await renderApp(finished(), ride(Array(90).fill(200)));
    expect(screen.getByText('ride_20260301_090000.fit in x2max_20260301_090000/')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Resume ride' }));
    expect(posted()).toContain('/resume');
    const strava = screen.getByRole('link', { name: 'Send to Strava' });
    expect(strava).toHaveAttribute('href', '/ride.fit');
  });

  it('Send to Strava opens the upload page and marks the download done', async () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    const user = await renderApp(finished(), ride(Array(90).fill(200)));
    await user.click(screen.getByRole('link', { name: 'Send to Strava' }));
    expect(open).toHaveBeenCalledWith('https://www.strava.com/upload/select', '_blank', 'noopener');
    expect(screen.getByRole('link', { name: 'Send to Strava (done)' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Download .FIT (done)' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Start new ride/ }));
    expect(posted()).toContain('/start');            // downloaded: no second press needed
  });

  it('Start over a ride that was never downloaded asks twice', async () => {
    const user = await renderApp(finished(), ride(Array(90).fill(200)));
    await user.click(screen.getByRole('button', { name: /Start new ride/ }));
    expect(posted()).not.toContain('/start');
    expect(screen.getByText(/Starting again clears these buttons/)).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(600));
    await user.click(screen.getByRole('button', { name: /again to start/ }));
    expect(posted()).toContain('/start');
  });

  it('nothing recorded', async () => {
    await renderApp(finished(null), ride([]));
    expect(screen.getByText('Ride finished. Nothing was recorded.')).toBeInTheDocument();
  });

  it('shows the ride summary', async () => {
    await renderApp(finished(), ride(Array(120).fill(180)));
    expect(screen.getByText('Avg power · ride')).toBeInTheDocument();
    expect(screen.getByText('Best 1 min').closest('.tile')).toHaveTextContent('180W');
  });
});

describe('ride review', () => {
  it('evaluates the finished ride', async () => {
    await renderApp(finished(), ride(Array(3600).fill(150)));
    const review = screen.getByRole('region', { name: 'Ride review' });
    expect(within(review).getByText('Tempo ride')).toBeInTheDocument();
    expect(review).toHaveTextContent('Moderate load');
    expect(review).toHaveTextContent('Heart rate held');
  });

  it('is only on the finished screen', async () => {
    await renderApp(recording(), ride(Array(600).fill(150)));
    expect(screen.queryByRole('region', { name: 'Ride review' })).not.toBeInTheDocument();
  });
});

describe('connection', () => {
  it('says when the logger is gone', async () => {
    await renderApp();
    act(() => latestStream().onerror!());
    expect(screen.getByRole('alert')).toHaveTextContent('lost contact with the logger');
  });

  it('opens Devices on first start (no trainer remembered)', async () => {
    await renderApp(status({ devices: { trainer: { mode: 'auto' }, hr: { mode: 'auto' } } }));
    expect(screen.getByRole('complementary', { name: 'Devices' })).toBeInTheDocument();
    expect(posted()).toContain('/devices/scan');
  });

  it('header pills show trainer and heart-rate state', async () => {
    await renderApp(status({ state: 'reconnecting', hr: { state: 'searching', device: null } }));
    const pills = screen.getByRole('button', { name: /Devices/ });
    expect(pills).toHaveTextContent('Trainer lost · reconnecting (timer paused)');
    expect(pills).toHaveTextContent('HR · looking for watch or strap');
  });
});
