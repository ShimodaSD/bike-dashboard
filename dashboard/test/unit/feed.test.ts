// The live feed store (hooks/feed.ts) against a fake EventSource: init, samples, resync, live rate.
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ride, sample } from '../fixtures/ride';
import { FakeEventSource } from '../fixtures/eventsource';

const current = () => FakeEventSource.all.filter(e => !e.closed).at(-1)!;

async function load() {
  vi.resetModules();                                   // a fresh store for each test
  return (await import('../../src/hooks/feed')).useLiveFeed;
}

beforeEach(() => {
  FakeEventSource.all = [];
  vi.stubGlobal('EventSource', FakeEventSource);
});

describe('live feed', () => {
  it('opens /events and takes the ride from init', async () => {
    const useLiveFeed = await load();
    const { result } = renderHook(() => useLiveFeed(0));
    expect(current().url).toBe('/events');
    current().emit('init', { history: ride([200, 210]), laps: [0], status: { connected: true } });
    expect(result.current.hist).toHaveLength(2);
    expect(result.current.status).toEqual({ connected: true });
    expect(result.current.version).toBe(1);
  });

  it('appends samples in order and bumps the version', async () => {
    const useLiveFeed = await load();
    const { result } = renderHook(() => useLiveFeed(0));
    current().emit('init', { history: [], laps: [0], status: {} });
    current().emit('sample', sample(0));
    current().emit('sample', sample(1));
    current().emit('sample', sample(1));                // duplicate: ignored
    expect(result.current.hist.map(s => s.t)).toEqual([0, 1]);
    expect(result.current.version).toBe(3);
  });

  it('a gap in the samples reopens the stream to resync', async () => {
    const useLiveFeed = await load();
    renderHook(() => useLiveFeed(0));
    const first = current();
    first.emit('init', { history: [], laps: [0], status: {} });
    first.emit('sample', sample(3));                    // 0-2 were missed
    expect(first.closed).toBe(true);
    expect(current()).not.toBe(first);
  });

  it('live packets keep 6 s of power for the 3 s / 5 s average', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const useLiveFeed = await load();
    const { result } = renderHook(() => useLiveFeed(0));
    for (let i = 0; i < 10; i++) {
      vi.setSystemTime(1_000_000 + i * 1000);
      current().emit('live', { power_w: 100 + i, cadence_rpm: 90, speed_kmh: 30, heart_rate_bpm: null });
    }
    expect(result.current.now).toMatchObject({ power_w: 109, at: 1_009_000 });
    expect(result.current.recent.map(r => r.p)).toEqual([103, 104, 105, 106, 107, 108, 109]);
  });

  it('goes offline on error and back online with the next init', async () => {
    const useLiveFeed = await load();
    const { result } = renderHook(() => useLiveFeed(0));
    act(() => current().onerror!());
    expect(result.current.online).toBe(false);
    current().emit('init', { history: [], laps: [0], status: {} });
    expect(result.current.online).toBe(true);
  });

  it('battery saver asks for 2 updates a second; closes with the last subscriber', async () => {
    const useLiveFeed = await load();
    const { rerender, unmount } = renderHook(({ rate }) => useLiveFeed(rate), { initialProps: { rate: 0 } });
    rerender({ rate: 2 });
    expect(current().url).toBe('/events?live=2');
    expect(FakeEventSource.all[0].closed).toBe(true);
    unmount();
    expect(FakeEventSource.all.every(e => e.closed)).toBe(true);
  });

  it('laps and status events', async () => {
    const useLiveFeed = await load();
    const { result } = renderHook(() => useLiveFeed(0));
    current().emit('laps', [0, 60]);
    current().emit('status', { connected: false });
    current().emit('preview', { power_w: 150, cadence_rpm: 80, speed_kmh: null, heart_rate_bpm: null });
    expect(result.current.laps).toEqual([0, 60]);
    expect(result.current.status).toEqual({ connected: false });
    expect(result.current.preview!.power_w).toBe(150);
  });
});
