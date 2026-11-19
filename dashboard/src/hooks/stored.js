// Settings kept in this browser's localStorage (FTP, weight, chart window...), read through
// useSyncExternalStore so every component sees the same value and no effect copies it back.
// Reads are cached (localStorage is synchronous and slow); a change in another tab updates the cache.
import { useCallback, useSyncExternalStore } from 'react';

const PREFIX = 'x2max.';
const cache = new Map();                 // key -> parsed value (undefined = not stored)
const listeners = new Map();             // key -> Set of callbacks

function read(key) {
  if (!cache.has(key)) {
    let v;
    try { const s = localStorage.getItem(PREFIX + key); v = s === null || s === '' ? undefined : JSON.parse(s); }
    catch (e) { v = undefined; }         // private mode, quota, bad JSON
    cache.set(key, v);
  }
  return cache.get(key);
}

function write(key, v) {
  cache.set(key, v);
  try { localStorage.setItem(PREFIX + key, JSON.stringify(v)); } catch (e) { /* not available: keep it in memory */ }
  (listeners.get(key) || []).forEach(l => l());
}

if (typeof window !== 'undefined')
  window.addEventListener('storage', e => {
    if (!e.key || !e.key.startsWith(PREFIX)) return;
    const key = e.key.slice(PREFIX.length);
    cache.delete(key);
    (listeners.get(key) || []).forEach(l => l());
  });

function subscribe(key, cb) {
  if (!listeners.has(key)) listeners.set(key, new Set());
  listeners.get(key).add(cb);
  return () => listeners.get(key).delete(cb);
}

// [value, set] like useState; `set` takes a value or an updater and is stable.
export function useStored(key, initial) {
  const sub = useCallback(cb => subscribe(key, cb), [key]);
  const stored = useSyncExternalStore(sub, () => read(key));
  const value = stored === undefined ? initial : stored;
  const set = useCallback(next => {
    const cur = read(key);
    write(key, typeof next === 'function' ? next(cur === undefined ? initial : cur) : next);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps -- `initial` is a constant per key
  return [value, set];
}
