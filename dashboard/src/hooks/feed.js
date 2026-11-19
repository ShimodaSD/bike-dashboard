// Live feed from the logger (Server-Sent Events), as an external store read with useSyncExternalStore.
// The EventSource opens with the first subscriber and closes with the last; changing the rate
// reopens it. The ride history can be hours long, so it is one array that grows in place and
// `version` bumps on each change (components that need it memoize on `version`).
import { useCallback, useSyncExternalStore } from 'react';

const RECENT_MS = 6000;                  // instant numbers kept for 3 s / 5 s power

function createFeed() {
  const hist = [], recent = [];
  let snap = { hist, laps: [0], status: {}, online: true, version: 0, preview: null, now: null, recent };
  const listeners = new Set();
  let es = null, rate = null;

  const set = patch => { snap = { ...snap, ...patch }; listeners.forEach(l => l()); };

  function open() {
    const src = new EventSource(rate ? `/events?live=${rate}` : '/events');
    es = src;
    src.addEventListener('live', e => {
      const v = JSON.parse(e.data), at = Date.now();
      recent.push({ at, p: v.power_w });
      while (recent.length && at - recent[0].at > RECENT_MS) recent.shift();
      set({ now: { ...v, at } });
    });
    src.addEventListener('init', e => {
      const d = JSON.parse(e.data);
      hist.length = 0; hist.push(...d.history);
      set({ laps: d.laps, status: d.status, online: true, version: snap.version + 1 });
    });
    src.addEventListener('sample', e => {
      const s = JSON.parse(e.data);
      if (s.t === hist.length) { hist.push(s); set({ version: snap.version + 1 }); }
      else if (s.t > hist.length) { close(); open(); }        // missed samples: resync via init
    });
    src.addEventListener('preview', e => set({ preview: JSON.parse(e.data) }));
    src.addEventListener('laps', e => set({ laps: JSON.parse(e.data), version: snap.version + 1 }));
    src.addEventListener('status', e => set({ status: JSON.parse(e.data) }));
    src.onerror = () => { if (snap.online) set({ online: false }); };  // EventSource retries by itself; init clears this
  }
  function close() { if (es) { es.close(); es = null; } }

  return {
    get: () => snap,
    subscribe(r, cb) {
      listeners.add(cb);
      if (!es || r !== rate) { close(); rate = r; open(); }
      return () => { listeners.delete(cb); if (!listeners.size) close(); };
    },
  };
}

const feed = createFeed();

// rate: 0 = every trainer packet, 2 = at most 2 live updates a second (phones).
export function useLiveFeed(rate) {
  const subscribe = useCallback(cb => feed.subscribe(rate, cb), [rate]);
  return useSyncExternalStore(subscribe, feed.get);
}
