// Music remote: play / pause, previous, next and volume for whatever plays on the logger's Mac
// (YouTube Music in the browser, Spotify, Music), from the laptop or a phone. The logger presses
// the Mac's media keys (logger/media_control.py); no embedded player, no account.
import type { MediaAction, MediaStatus } from '../types/feed';

export const sendMedia = (action: MediaAction) => fetch(`/media?do=${action}`, { method: 'POST' }).catch(() => {});

const Note = () => (
  <svg className="note" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <path d="M6 12.2V3.4l7-1.6v8.6" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
    <circle cx="4.2" cy="12.4" r="2" fill="currentColor" /><circle cx="11.2" cy="10.8" r="2" fill="currentColor" />
  </svg>
);
const ICON = {
  play: <path d="M7 4.5v15l12-7.5z" fill="currentColor" />,
  pause: <path d="M6.5 4.5h4v15h-4zM13.5 4.5h4v15h-4z" fill="currentColor" />,
  next: <path d="M5 5v14l9-7zM15.5 5h3v14h-3z" fill="currentColor" />,
  previous: <path d="M19 5v14l-9-7zM5.5 5h3v14h-3z" fill="currentColor" />,
};
const Icon = ({ name }: { name: keyof typeof ICON }) =>
  <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" focusable="false">{ICON[name]}</svg>;

/** The Music button for the header (in the ride dock on a phone). */
export function MusicButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button className={'music-btn' + (open ? ' on' : '')} onClick={onToggle} aria-expanded={open} aria-controls="music"
            aria-keyshortcuts="M" title="Music">
      <Note /><span className="music-word">Music</span><kbd aria-hidden="true">M</kbd>
    </button>
  );
}

export function MusicPanel({ media, onClose }: { media: MediaStatus | undefined; onClose: () => void }) {
  const ok = !!media?.available;
  const now = media?.now ?? null;
  const playing = !!now?.playing;
  return (
    <aside id="music" className="music" aria-labelledby="music-h" onKeyDown={e => { if (e.key === 'Escape') onClose(); }}>
      <div className="music-head">
        <h2 id="music-h"><Note />Music</h2>
        <button className="quiet music-close" onClick={onClose} aria-label="Close music">
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
        </button>
      </div>

      <p className="music-now" aria-live="polite">
        {!ok ? 'Music controls work when the logger runs on a Mac.'
          : now ? <><b>{now.title}</b><small>{now.artist} · {now.app}{playing ? '' : ' · paused'}</small></>
          : <>Controls what plays on the Mac<small>YouTube Music in the browser, Spotify or Music</small></>}
      </p>

      <div className="music-keys" role="group" aria-label="Playback">
        <button onClick={() => sendMedia('previous')} disabled={!ok} aria-label="Previous"><Icon name="previous" /></button>
        <button className="primary play" onClick={() => sendMedia('playpause')} disabled={!ok}
                aria-label={playing ? 'Pause' : now ? 'Play' : 'Play / pause'}>
          <Icon name={playing ? 'pause' : 'play'} /></button>
        <button onClick={() => sendMedia('next')} disabled={!ok} aria-label="Next"><Icon name="next" /></button>
      </div>

      <div className="music-vol" role="group" aria-label="Volume">
        <button onClick={() => sendMedia('voldown')} disabled={!ok} aria-label="Volume down">−</button>
        <span className="vol-bar" aria-hidden="true"><i style={{ width: `${media?.volume ?? 0}%` }} /></span>
        <span className="vol-val">{media?.volume != null ? `${media.volume}%` : '–'}<span className="sr-only"> volume</span></span>
        <button onClick={() => sendMedia('volup')} disabled={!ok} aria-label="Volume up">+</button>
      </div>

      {ok && media?.keys === false && (
        <p className="help">For YouTube Music in the browser, allow <b>Terminal</b> in System Settings › Privacy &amp; Security ›
          Accessibility, then restart the logger. Spotify and Music work without it.</p>
      )}
    </aside>
  );
}
