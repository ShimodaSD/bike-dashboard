// Live feed from the logger (Server-Sent Events), as an external store read with useSyncExternalStore.
// The EventSource opens with the first subscriber and closes with the last; changing the rate
// reopens it. The ride history can be hours long, so it is one array that grows in place and
// `version` bumps on each change (components that need it memoize on `version`).
import { useCallback, useSyncExternalStore } from 'react';
import type { FeedEvents, LiveValues, Sample, Status } from '../types/feed';

const RECENT_MS = 6000;                  // instant numbers kept for 3 s / 5 s power

// The latest `live` packet, stamped with when it arrived here.
export interface LiveNow extends LiveValues { at: number }
export interface RecentPower { at: number; p: number }

export interface FeedSnapshot {
  hist: Sample[];                        // grows in place; see `version`
  laps: number[];
  status: Partial<Status>;               // {} until the first init
  online: boolean;
  version: number;
  preview: LiveValues | null;
  now: LiveNow | null;
  recent: RecentPower[];
}

// addEventListener for one SSE event, with its JSON payload parsed and typed.
function on<K extends keyof FeedEvents>(src: EventSource, event: K, fn: (data: FeedEvents[K]) => void) {
  src.addEventListener(event, e => fn(JSON.parse((e as MessageEvent<string>).data)));
}

function createFeed() {
  const hist: Sample[] = [], recent: RecentPower[] = [];
  let snap: FeedSnapshot = { hist, laps: [0], status: {}, online: true, version: 0, preview: null, now: null, recent };
  const listeners = new Set<() => void>();
  let es: EventSource | null = null, rate: number | null = null;

  const set = (patch: Partial<FeedSnapshot>) => { snap = { ...snap, ...patch }; listeners.forEach(l => l()); };

  function open() {
    const src = new EventSource(rate ? `/events?live=${rate}` : '/events');
    es = src;
    on(src, 'live', v => {
      const at = Date.now();
      recent.push({ at, p: v.power_w });
      while (recent.length && at - recent[0].at > RECENT_MS) recent.shift();
      set({ now: { ...v, at } });
    });
    on(src, 'init', d => {
      hist.length = 0; hist.push(...d.history);
      set({ laps: d.laps, status: d.status, online: true, version: snap.version + 1 });
    });
    on(src, 'sample', s => {
      if (s.t === hist.length) { hist.push(s); set({ version: snap.version + 1 }); }
      else if (s.t > hist.length) { close(); open(); }        // missed samples: resync via init
    });
    on(src, 'preview', p => set({ preview: p }));
    on(src, 'laps', laps => set({ laps, version: snap.version + 1 }));
    on(src, 'status', status => set({ status }));
    src.onerror = () => { if (snap.online) set({ online: false }); };  // EventSource retries by itself; init clears this
  }
  function close() { if (es) { es.close(); es = null; } }

  return {
    get: () => snap,
    subscribe(r: number, cb: () => void) {
      listeners.add(cb);
      if (!es || r !== rate) { close(); rate = r; open(); }
      return () => { listeners.delete(cb); if (!listeners.size) close(); };
    },
  };
}

const feed = createFeed();

// rate: 0 = every trainer packet, 2 = at most 2 live updates a second (phones).
export function useLiveFeed(rate: number): FeedSnapshot {
  const subscribe = useCallback((cb: () => void) => feed.subscribe(rate, cb), [rate]);
  return useSyncExternalStore(subscribe, feed.get);
}
