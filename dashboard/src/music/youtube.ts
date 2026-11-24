// What the embedded YouTube player reports back, and skipping songs that won't play. With enablejsapi=1 the player posts JSON messages
// to this page once told we are listening (the same protocol YouTube's IFrame API script uses, so no
// script has to be loaded). Only errors are kept: many official YouTube Music songs and albums block
// playing outside YouTube, and the player then shows little more than "Video unavailable".
import { useSyncExternalStore } from 'react';

export const YT_ORIGIN = 'https://www.youtube.com';

const errors = new Map<string, number>();         // player id -> last error code
const skips = new Map<string, number>();          // player id -> songs skipped in a row because they wouldn't play
// In a playlist a blocked song is skipped, so a mixed playlist still plays the songs that allow it.
// After this many in a row the playlist is taken as blocked (official albums often block every song).
export const MAX_SKIPS = 4;
const listeners = new Set<() => void>();
let version = 0;

function onMessage(e: MessageEvent) {
  if (e.origin !== YT_ORIGIN || typeof e.data !== 'string') return;
  let m: { event?: string; id?: unknown; info?: unknown };
  try { m = JSON.parse(e.data); } catch { return; }
  if (typeof m.id !== 'string') return;
  if (m.event === 'onStateChange' && m.info === 1) { skips.delete(m.id); return; }      // playing
  if (m.event !== 'onError' || typeof m.info !== 'number') return;
  const n = skips.get(m.id) ?? 0;
  if (m.id.startsWith('youtube:playlist:') && n < MAX_SKIPS && e.source && 'postMessage' in e.source) {
    skips.set(m.id, n + 1);
    (e.source as Window).postMessage(JSON.stringify({ event: 'command', func: 'nextVideo', args: [], id: m.id, channel: 'widget' }), YT_ORIGIN);
    return;
  }
  skips.delete(m.id);
  errors.set(m.id, m.info); version++;
  listeners.forEach(l => l());
}

function subscribe(cb: () => void) {
  if (!listeners.size) window.addEventListener('message', onMessage);
  listeners.add(cb);
  return () => { listeners.delete(cb); if (!listeners.size) window.removeEventListener('message', onMessage); };
}

/** The error the player with this id reported, if any. */
export function useYouTubeError(id: string | null): number | null {
  useSyncExternalStore(subscribe, () => version, () => 0);
  return id == null ? null : errors.get(id) ?? null;
}

/** Forget a player's error (to try it again). */
export function clearYouTubeError(id: string) {
  if (errors.delete(id)) { version++; listeners.forEach(l => l()); }
}

/** Tell a just-loaded player that we listen. Sent a few times: the player may not be ready at load. */
export function listenTo(frame: HTMLIFrameElement, id: string) {
  const hello = () => frame.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id, channel: 'widget' }), YT_ORIGIN);
  hello();
  [400, 1200, 3000].forEach(ms => setTimeout(hello, ms));
}

/** What a YouTube player error means for the rider. */
export function youTubeErrorText(code: number): string {
  if (code === 101 || code === 150 || code === 152) return 'The owner of this music doesn’t allow it to play outside YouTube. Many official songs and albums are like that, even with Premium.';
  if (code === 100) return 'YouTube says this music is private or was removed.';
  if (code === 153) return 'YouTube refused to play on this page address.';
  return `YouTube couldn’t play this (error ${code}).`;
}
