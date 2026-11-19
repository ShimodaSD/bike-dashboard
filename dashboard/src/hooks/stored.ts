// Settings kept in this browser's localStorage (FTP, weight, chart window...), read through
// useSyncExternalStore so every component sees the same value and no effect copies it back.
// Reads are cached (localStorage is synchronous and slow); a change in another tab updates the cache.
import { useCallback, useSyncExternalStore } from 'react';

const PREFIX = 'x2max.';
const cache = new Map<string, unknown>();                 // key -> parsed value (undefined = not stored)
const listeners = new Map<string, Set<() => void>>();             // key -> Set of callbacks

function read(key: string): unknown {
  if (!cache.has(key)) {
    let v: unknown;
    try { const s = localStorage.getItem(PREFIX + key); v = s === null || s === '' ? undefined : JSON.parse(s); }
    catch (e) { v = undefined; }         // private mode, quota, bad JSON
    cache.set(key, v);
  }
  return cache.get(key);
}

function write(key: string, v: unknown) {
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

function subscribe(key: string, cb: () => void) {
  if (!listeners.has(key)) listeners.set(key, new Set());
  listeners.get(key)!.add(cb);
  return () => { listeners.get(key)!.delete(cb); };
}

// [value, set] like useState; `set` takes a value or an updater and is stable.
// The stored value is trusted to be a T: only this page writes these keys.
export function useStored<T>(key: string, initial: T): [T, (next: T | ((cur: T) => T)) => void] {
  const sub = useCallback((cb: () => void) => subscribe(key, cb), [key]);
  const stored = useSyncExternalStore(sub, () => read(key));
  const value = stored === undefined ? initial : (stored as T);
  const set = useCallback((next: T | ((cur: T) => T)) => {
    const cur = read(key) as T | undefined;
    write(key, typeof next === 'function' ? (next as (cur: T) => T)(cur === undefined ? initial : cur) : next);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps -- `initial` is a constant per key
  return [value, set];
}
