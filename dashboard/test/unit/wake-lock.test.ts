// The screen wake lock store (hooks/wake-lock.ts) against a fake navigator.wakeLock.
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

class FakeSentinel extends EventTarget {
  released = false;
  async release() { if (!this.released) { this.released = true; this.dispatchEvent(new Event('release')); } }
}

let locks: FakeSentinel[] = [];
let refuse = false;
const request = vi.fn(async () => {
  if (refuse) throw new DOMException('not allowed', 'NotAllowedError');
  const l = new FakeSentinel(); locks.push(l); return l;
});

let visibility: DocumentVisibilityState = 'visible';
function setVisibility(v: DocumentVisibilityState) {
  visibility = v;
  document.dispatchEvent(new Event('visibilitychange'));
}
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

async function load() {
  vi.resetModules();                                   // a fresh store for each test
  return (await import('../../src/hooks/wake-lock')).useKeepScreenOn;
}

beforeEach(() => {
  locks = []; refuse = false; visibility = 'visible'; request.mockClear();
  Object.defineProperty(navigator, 'wakeLock', { value: { request }, configurable: true });
  Object.defineProperty(document, 'visibilityState', { get: () => visibility, configurable: true });
});

describe('keep the screen on', () => {
  it('takes a screen lock while mounted and lets it go on unmount', async () => {
    const useKeepScreenOn = await load();
    const { result, unmount } = renderHook(() => useKeepScreenOn());
    await flush();
    expect(request).toHaveBeenCalledWith('screen');
    expect(result.current).toBe('on');
    unmount();
    await flush();
    expect(locks[0].released).toBe(true);
  });

  it('asks again when the page is visible again after the browser dropped it', async () => {
    const useKeepScreenOn = await load();
    const { result } = renderHook(() => useKeepScreenOn());
    await flush();
    setVisibility('hidden');
    await act(() => locks[0].release());             // what the browser does with a hidden tab
    expect(result.current).toBe('off');
    await flush();
    expect(request).toHaveBeenCalledTimes(1);        // not while hidden
    setVisibility('visible');
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
    expect(result.current).toBe('on');
  });

  it('a refused lock is asked for again on the next click', async () => {
    refuse = true;
    const useKeepScreenOn = await load();
    const { result } = renderHook(() => useKeepScreenOn());
    await flush();
    expect(result.current).toBe('off');
    refuse = false;
    document.dispatchEvent(new Event('pointerdown'));
    await flush();
    expect(result.current).toBe('on');
  });

  it('says unsupported where the browser has no wake lock', async () => {
    Object.defineProperty(navigator, 'wakeLock', { value: undefined, configurable: true });
    delete (navigator as { wakeLock?: unknown }).wakeLock;
    const useKeepScreenOn = await load();
    const { result } = renderHook(() => useKeepScreenOn());
    await flush();
    expect(result.current).toBe('unsupported');
  });
});
