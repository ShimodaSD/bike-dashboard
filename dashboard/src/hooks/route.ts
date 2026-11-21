// The page shown, from the URL hash: the live dashboard (no hash), Training, Past rides, Devices or
// Settings. The hash is an outside store (back / forward, links, another tab's link), read with
// useSyncExternalStore. The logger keeps recording whichever page is open.
import { useSyncExternalStore } from 'react';

export type Route = 'live' | 'train' | 'rides' | 'devices' | 'settings';
export const RIDES_HASH = '#rides';

export const PAGES: readonly { route: Route; hash: string; label: string }[] = [
  { route: 'live', hash: '#', label: 'Live' },
  { route: 'train', hash: '#train', label: 'Training' },
  { route: 'rides', hash: RIDES_HASH, label: 'Past rides' },
  { route: 'devices', hash: '#devices', label: 'Devices' },
  { route: 'settings', hash: '#settings', label: 'Settings' },
];

const subscribe = (cb: () => void) => { window.addEventListener('hashchange', cb); return () => window.removeEventListener('hashchange', cb); };
const read = (): Route => PAGES.find(p => p.hash === window.location.hash && p.route !== 'live')?.route ?? 'live';

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, read, () => 'live');
}

/** Back to the live numbers (Start, a new FTP test). */
export const goLive = () => { if (window.location.hash) window.location.hash = ''; };
