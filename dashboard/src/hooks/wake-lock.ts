// Keeps the screen on while the dashboard is open (Screen Wake Lock API), so the Mac's display
// doesn't dim or sleep mid-ride while nobody touches the keyboard. An external store read with
// useSyncExternalStore: the lock is asked for with the first subscriber and let go with the last.
//
// The browser drops the lock whenever the tab is hidden (another tab, minimized, screen locked),
// so it is asked for again when the page is visible again. Some browsers only grant it after a
// click or key press, so those ask again too. Needs a secure page: http://localhost (the laptop)
// works; a phone on http://192.168.x.x doesn't get it and reads 'unsupported'.
// The logger also keeps the Mac itself awake while it runs (logger/keep_awake.py).
import { useSyncExternalStore } from 'react';

export type WakeLockState = 'on' | 'off' | 'unsupported';

const ASK_AGAIN = ['visibilitychange', 'pointerdown', 'keydown'] as const;

function createWakeLock() {
  let state: WakeLockState = 'off';
  let lock: WakeLockSentinel | null = null;
  let asking = false;
  const listeners = new Set<() => void>();

  const supported = () => typeof navigator !== 'undefined' && 'wakeLock' in navigator && window.isSecureContext !== false;
  const set = (s: WakeLockState) => { if (s !== state) { state = s; listeners.forEach(l => l()); } };

  async function ask() {
    if (!supported()) { set('unsupported'); return; }
    if (lock || asking || !listeners.size || document.visibilityState !== 'visible') return;
    asking = true;
    try {
      const l = await navigator.wakeLock.request('screen');
      if (!listeners.size) { await l.release(); return; }      // page closed while asking
      lock = l;
      l.addEventListener('release', () => { if (lock === l) { lock = null; set('off'); } });
      set('on');
    } catch {
      set('off');                     // refused (no click yet, battery saver): asked again on the next one
    } finally {
      asking = false;
    }
  }
  const onEvent = () => { void ask(); };

  return {
    get: () => state,
    subscribe(cb: () => void) {
      listeners.add(cb);
      if (listeners.size === 1) {
        ASK_AGAIN.forEach(e => document.addEventListener(e, onEvent));
        void ask();
      }
      return () => {
        listeners.delete(cb);
        if (listeners.size) return;
        ASK_AGAIN.forEach(e => document.removeEventListener(e, onEvent));
        const l = lock;
        lock = null;
        state = 'off';
        void l?.release().catch(() => {});
      };
    },
  };
}

const wakeLock = createWakeLock();

/** Keep the screen on while the calling component is mounted. 'on' while the lock is held. */
export function useKeepScreenOn(): WakeLockState {
  return useSyncExternalStore(wakeLock.subscribe, wakeLock.get, () => 'off');
}
