// The page shown: the live dashboard, or Past rides at #rides. The URL hash is an outside store
// (back / forward, links, another tab's link), read with useSyncExternalStore.
import { useSyncExternalStore } from 'react';

export type Route = 'live' | 'rides';
export const RIDES_HASH = '#rides';

const subscribe = (cb: () => void) => { window.addEventListener('hashchange', cb); return () => window.removeEventListener('hashchange', cb); };
const read = (): Route => (window.location.hash === RIDES_HASH ? 'rides' : 'live');

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, read, () => 'live');
}
