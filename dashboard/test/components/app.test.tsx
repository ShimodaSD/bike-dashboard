// The whole dashboard against a fake logger stream: Start, Lap, Finish (two presses), keys,
// the ride strip and the finished screen. Charts are stubbed (uPlot needs a real canvas;
// the end-to-end tests cover them).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeEventSource, latestStream } from '../fixtures/eventsource';
import { ride } from '../fixtures/ride';
import { finished, recording, status } from '../fixtures/status';
import type { Status } from '../../src/types/feed';

vi.mock('../../src/charts/charts', () => ({ Charts: () => <div data-testid="charts" /> }));

const posted = () => vi.mocked(fetch).mock.calls.map(c => c[0]);

// Press a tab in the page bar; jsdom moves the hash like a browser.
async function openPage(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(within(screen.getByRole('navigation', { name: 'Pages' })).getByRole('link', { name: new RegExp(`^${name}`) }));
  await act(async () => { window.dispatchEvent(new HashChangeEvent('hashchange')); });
}

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
  window.location.hash = '';
});

describe('Start and Finish', () => {
  it('Start posts /start right away when nothing is unsaved', async () => {
    const user = await renderApp();
    expect(screen.getByRole('status', { name: '' })).toHaveTextContent('Nothing is saved until you press Start');
    await user.click(screen.getByRole('button', { name: /^Start/ }));
    expect(posted()).toContain('/start');
  });

  it('Start sends the weight from Settings, so it is saved with the ride', async () => {
    localStorage.setItem('x2max.kg', '72.5');
    const user = await renderApp();
    await user.click(screen.getByRole('button', { name: /^Start/ }));
    expect(posted()).toContain('/start?kg=72.5');
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
    await openPage(user, 'Settings');
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
    expect(document.querySelector('.strip')).toHaveTextContent('Lap 2 started');          // read out
    expect(document.querySelector('.lapnow')).toHaveTextContent('Lap 2 started');      // and seen in Ride time
  });

  it('Start on another page goes back to the live numbers', async () => {
    const user = await renderApp();
    await openPage(user, 'Settings');
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Start/ }));
    await act(async () => { window.dispatchEvent(new HashChangeEvent('hashchange')); });
    expect(window.location.hash).toBe('');
    expect(screen.getByTestId('charts')).toBeInTheDocument();
    expect(posted()).toContain('/start');
  });

  it('a ride keeps recording on other pages: Live shows the time, the ride keys still work', async () => {
    const user = await renderApp(recording(), ride(Array(75).fill(250)));
    await openPage(user, 'Past rides');
    expect(screen.queryByTestId('charts')).not.toBeInTheDocument();
    const live = within(screen.getByRole('navigation', { name: 'Pages' })).getByRole('link', { name: /^Live/ });
    expect(live).toHaveTextContent('1:15');
    expect(live).toHaveAccessibleName(/recording/);
    await user.keyboard('l');
    expect(posted()).toContain('/lap');
    expect(screen.getByRole('button', { name: /^Finish/ })).toBeInTheDocument();
  });
});

describe('pause', () => {
  const paused = () => recording({ ride: { state: 'recording', n: 1, fit: null, dir: 'x2max_20260301_090000', paused: true } });

  it('Pause posts /pause?on=1, Resume /pause?on=0, P toggles', async () => {
    const user = await renderApp(recording(), ride(Array(30).fill(200)));
    await user.click(screen.getByRole('button', { name: /^Pause/ }));
    expect(posted()).toContain('/pause?on=1');
    latestStream().emit('status', paused());
    expect(screen.getByRole('button', { name: /^Resume/ })).toHaveAttribute('aria-pressed', 'true');
    await user.keyboard('p');
    expect(posted()).toContain('/pause?on=0');
  });

  it('while paused the strip and the ride time say so and the numbers are live', async () => {
    await renderApp(paused(), ride(Array(75).fill(250)));
    expect(screen.getByText(/Ride 1 paused/)).toBeInTheDocument();
    const time = screen.getByText('Ride time').closest('.tile')!;
    expect(time).toHaveTextContent('Paused');
    expect(time).toHaveTextContent('1:15');
    expect(time).toHaveTextContent('Timer stopped');
    latestStream().emit('preview', { power_w: 0, cadence_rpm: 0, speed_kmh: 0, heart_rate_bpm: 120 });
    expect(screen.getByText('Heart rate').closest('.tile')).toHaveTextContent('120bpm');
  });
});

describe('workout targets on the tiles', () => {
  const sweetSpot = (over = {}) => localStorage.setItem('x2max.workout', JSON.stringify({ name: 'Sweet spot', total: 600,
    segs: [{ dur: 600, lo: 0.9, hi: 0.9, unit: 'ftp', cad: 90, hr: 150, name: 'Steady', ...over }] }));

  it('shows the target now next to the live number, coloured when off', async () => {
    sweetSpot();
    await renderApp(recording(), ride(Array(40).fill(150), { cadence_rpm: 91, heart_rate_bpm: 150 }));
    const power = screen.getByText('Power · 3 s').closest('.tile')!;          // one number for power and target
    expect(power.querySelector('.tgt')).toHaveTextContent('Target 180 W');
    expect(power.querySelector('.tgt')).toHaveClass('low');                  // 150 W vs 180 W
    expect(power.querySelector('.delta')).toHaveTextContent('−30 W push harder');   // big, under the number
    expect(power).toHaveClass('off');                                        // amber frame
    expect(screen.getByText('Cadence').closest('.tile')).not.toHaveClass('off');
    expect(screen.getByText('Cadence').closest('.tile')!.querySelector('.tgt')).toHaveClass('ok');
    expect(screen.getByText('Heart rate').closest('.tile')!.querySelector('.tgt')).toHaveTextContent('150 bpm');
    expect(screen.getByText('Speed').closest('.tile')!.querySelector('.tgt')).toBeNull();   // no speed target
  });

  it('the workout comes from the logger, so a phone follows the laptop', async () => {
    const wo = { name: 'From the laptop', total: 600, segs: [{ dur: 600, lo: 0.9, hi: 0.9, unit: 'ftp' as const, cad: null, name: 'Steady' }] };
    await renderApp(recording({ workout: wo }), ride(Array(40).fill(180)));
    expect(screen.getByRole('region', { name: 'Workout' })).toHaveTextContent('From the laptop');
    expect(document.querySelector('.hero .power .delta')).toHaveTextContent('On target');
  });

  it('loading or removing a workout goes to the logger', async () => {
    const wo = { name: 'Sweet spot', total: 600, segs: [{ dur: 600, lo: 0.9, hi: 0.9, unit: 'ftp' as const, cad: null, name: 'Steady' }] };
    const user = await renderApp(status({ workout: wo }), ride([]));
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    const call = vi.mocked(fetch).mock.calls.find(c => c[0] === '/workout');
    expect(call?.[1]).toMatchObject({ method: 'POST', body: '' });
  });

  it('no targets without a workout or before Start', async () => {
    await renderApp(recording(), ride(Array(40).fill(150)));
    expect(document.querySelector('.hero .tgt')).toBeNull();
    sweetSpot();
    await renderApp(status(), ride([]));
    expect(document.querySelector('.hero .tgt')).toBeNull();
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
    expect(screen.getByText('Calories').closest('.tile')).toHaveTextContent('27kcal22 kJ of work');
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

  it("rates the ride's peaks in W/kg with the weight saved with the ride", async () => {
    localStorage.setItem('x2max.kg', '90');                         // changed since: the ride keeps 75 kg
    const st = finished();
    await renderApp({ ...st, ride: { ...st.ride, kg: 75 } }, ride(Array(1500).fill(300)));
    const review = screen.getByRole('region', { name: 'Ride review' });
    expect(review).toHaveTextContent('Power profile at 75 kg, saved with this ride');
    const peak = (label: string) => within(review).getByText(label).closest('div')!;
    expect(peak('Best 5 min')).toHaveTextContent('4.00 W/kg300 W · Cat 4');      // men's 5 min: Moderate ≥ 3.46
    expect(peak('Best 20 min')).toHaveTextContent('4.00 W/kg300 W · Cat 3');     // as FTP: 3.80 W/kg, Good ≥ 3.38
    expect(peak('Normalized')).toHaveTextContent('4.00 W/kgavg 4.00 · 6.0 kJ/kg');
  });

  it('without a weight the peaks are in watts, with a pointer to Settings', async () => {
    await renderApp(finished(), ride(Array(600).fill(200)));
    const review = screen.getByRole('region', { name: 'Ride review' });
    expect(within(review).getByText('Best 5 min').closest('div')).toHaveTextContent('200 W');
    expect(review).toHaveTextContent('Set your weight in Settings to see W/kg');
  });

  it('reviews a ride file without touching the live ride', async () => {
    window.location.hash = '#rides';
    const user = await renderApp();
    const page = screen.getByRole('region', { name: 'Past rides' });
    await user.click(within(page).getByText('Or review a ride file from this computer'));
    const fit = readFileSync(join(import.meta.dirname, '../fixtures/ride.fit'));
    await user.upload(within(page).getByLabelText('Choose a ride file'), new File([fit], 'ride.fit'));
    const review = await within(page).findByRole('region', { name: 'Ride review' }, { timeout: 3000 });
    expect(review).toHaveTextContent('Sweet spot ride');            // FTP 200: 15 min at 150 W, 15 at 200 W
    expect(review).toHaveTextContent('Heart-rate drift not judged');  // power stepped up halfway
    expect(page).toHaveTextContent('29:30');
    expect(posted()).toEqual([]);                                     // nothing sent to the logger
  });

  it('says when a file cannot be read', async () => {
    window.location.hash = '#rides';
    const user = await renderApp();
    const page = screen.getByRole('region', { name: 'Past rides' });
    await user.upload(within(page).getByLabelText('Choose a ride file'), new File(['nope'], 'ride.fit'));
    expect(await within(page).findByRole('alert', {}, { timeout: 3000 })).toHaveTextContent('This .fit file is empty or cut short.');
  });

  it('is only on the finished screen', async () => {
    await renderApp(recording(), ride(Array(600).fill(150)));
    expect(screen.queryByRole('region', { name: 'Ride review' })).not.toBeInTheDocument();
  });
});

describe('Ask Claude', () => {
  const coachOn = { ...finished(), coach: { claude: true, garmin: true, model: 'claude-opus-5-5' } };
  const result = {
    review: { headline: 'Solid tempo hour.', verdict: 'good', went_well: ['Even pacing'], to_improve: ['Start easier'],
              load: 'Three rides this week, moderate load.', next_session: '60 min Z2 at 140-160 W.' },
    recent: [{ date: '2026-11-17 18:00:00', name: 'Zwift', type: 'virtual_ride', cycling: true, duration_min: 60, tss: 55, np_w: 170 }],
    garmin_note: null, model: 'claude-opus-5-5',
  };

  it('sends the ride summary and shows the coach\'s review', async () => {
    const user = await renderApp(coachOn, ride(Array(3600).fill(150)));
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(result), { status: 200 }));
    expect(screen.getByText(/Sends this ride's summary and your recent Garmin activities, sleep and HRV to Anthropic/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Ask Claude/ }));
    const card = await screen.findByRole('region', { name: "Claude's review" });
    expect(card).toHaveTextContent('Solid tempo hour.');
    expect(card).toHaveTextContent('60 min Z2 at 140-160 W.');
    expect(card).toHaveTextContent('your last 1 Garmin activity');
    const [url, init] = vi.mocked(fetch).mock.calls.at(-1)!;
    expect(url).toBe('/coach');
    const sent = JSON.parse(String(init!.body));
    expect(sent.ride).toMatchObject({ duration_min: 60, np_w: 150, ftp_w: 200, tss: 56 });
    expect(sent.ride.profile_1min).toHaveLength(60);
    expect(sent.local_review.kind).toBe('Tempo ride');
  });

  it('shows the logger\'s error and lets you try again', async () => {
    const user = await renderApp(coachOn, ride(Array(600).fill(150)));
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Anthropic refused the API key.' }), { status: 503 }));
    await user.click(screen.getByRole('button', { name: /Ask Claude/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Anthropic refused the API key.');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
  });

  it('without an API key it says how to set it up and sends nothing', async () => {
    await renderApp({ ...finished(), coach: { claude: false, garmin: false, model: 'claude-opus-5-5' } }, ride(Array(600).fill(150)));
    expect(screen.getByText(/Add/).closest('p')).toHaveTextContent('Add ANTHROPIC_API_KEY to the .env file');
    expect(screen.queryByRole('button', { name: /Ask Claude/ })).not.toBeInTheDocument();
  });
});

describe('Past rides page', () => {
  const garminOn = { ...status(), coach: { claude: true, garmin: true, model: 'claude-opus-5-5' } };
  const rides = [
    { id: 111, date: '2026-11-18 18:30:00', name: 'Sweet spot', type: 'virtual_ride', cycling: true, duration_min: 30, distance_km: 15.2, np_w: 180, tss: 40, avg_hr: 140 },
    { id: 222, date: '2026-11-16 07:00:00', name: 'Long ride', type: 'road_biking', cycling: true, duration_min: 120, distance_km: 60, np_w: 160, tss: 110, avg_hr: 130 },
  ];

  it('is linked from the ready screen and swaps the live dashboard out', async () => {
    await renderApp();
    expect(screen.getByRole('link', { name: 'Past rides' })).toHaveAttribute('href', '#rides');
    expect(screen.getByRole('link', { name: 'Live' })).toHaveAttribute('aria-current', 'page');
    act(() => { window.location.hash = '#rides'; window.dispatchEvent(new HashChangeEvent('hashchange')); });
    expect(screen.getByRole('heading', { name: 'Past rides' })).toBeInTheDocument();
    expect(screen.queryByTestId('charts')).not.toBeInTheDocument();
    await act(async () => { window.location.hash = ''; window.dispatchEvent(new HashChangeEvent('hashchange')); });
    expect(screen.getByTestId('charts')).toBeInTheDocument();
  });

  it('without a Garmin key it says how to set it up', async () => {
    window.location.hash = '#rides';
    await renderApp({ ...status(), coach: { claude: true, garmin: false, model: 'claude-opus-5-5' } });
    expect(screen.getByRole('region', { name: 'Past rides' })).toHaveTextContent('Add GARMIN_API_KEY to the .env file');
    expect(screen.queryByRole('button', { name: /Load my last 10 rides/ })).not.toBeInTheDocument();
  });

  it('loads the last rides, downloads the picked one and reviews it', async () => {
    window.location.hash = '#rides';
    const user = await renderApp(garminOn);
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ rides }), { status: 200 }));
    await user.click(screen.getByRole('button', { name: 'Load my last 10 rides' }));
    const pick = await screen.findByRole('button', { name: /Long ride/ });
    expect(pick).toHaveTextContent('120 min');
    expect(pick).toHaveTextContent('TSS 110');
    expect(vi.mocked(fetch).mock.calls.at(-1)![0]).toBe('/garmin/rides');
    const fit = readFileSync(join(import.meta.dirname, '../fixtures/ride.fit'));
    vi.mocked(fetch).mockResolvedValueOnce(new Response(fit, { status: 200 }));
    await user.click(screen.getByRole('button', { name: /Sweet spot/ }));
    expect(vi.mocked(fetch).mock.calls.at(-1)![0]).toBe('/garmin/activity.fit?id=111');
    const review = await screen.findByRole('region', { name: 'Ride review' }, { timeout: 3000 });
    expect(review).toHaveTextContent('Sweet spot ride');
    expect(screen.getByRole('button', { name: /Sweet spot/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Ask Claude/ })).toBeInTheDocument();
  });

  it('shows Garmin\'s error with a way to try again', async () => {
    window.location.hash = '#rides';
    const user = await renderApp(garminOn);
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Garmin refused the API key: it may have expired.' }), { status: 503 }));
    await user.click(screen.getByRole('button', { name: 'Load my last 10 rides' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Garmin refused the API key');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
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
    expect(screen.getByRole('heading', { name: 'Devices' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Devices' })).toHaveAttribute('aria-current', 'page');
    expect(posted()).toContain('/devices/scan');
  });

  it('the logo goes back to Live', async () => {
    const user = await renderApp();
    await openPage(user, 'Settings');
    await user.click(screen.getByRole('link', { name: /go to Live/ }));
    await act(async () => { window.dispatchEvent(new HashChangeEvent('hashchange')); });
    expect(screen.getByTestId('charts')).toBeInTheDocument();
  });

  it('first-start Devices gives way when Live is pressed', async () => {
    const user = await renderApp(status({ devices: { trainer: { mode: 'auto' }, hr: { mode: 'auto' } } }));
    await openPage(user, 'Live');
    expect(screen.queryByRole('heading', { name: 'Devices' })).not.toBeInTheDocument();
    expect(screen.getByTestId('charts')).toBeInTheDocument();
  });

  it('header pills show trainer and heart-rate state', async () => {
    await renderApp(status({ state: 'reconnecting', hr: { state: 'searching', device: null } }));
    const pills = screen.getByRole('link', { name: /Open Devices/ });
    expect(pills).toHaveAttribute('href', '#devices');
    expect(pills).toHaveTextContent('Trainer lost · reconnecting (timer paused)');
    expect(pills).toHaveTextContent('HR · looking for watch or strap');
  });
});
