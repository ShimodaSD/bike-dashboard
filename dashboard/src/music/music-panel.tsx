// Music panel: pick a Spotify or YouTube Music playlist, album or song and play it in the service's
// own player. It floats over the corner of the page when open and stays mounted (only hidden) when
// closed and on every page, so the music keeps playing while you ride. Nothing from Spotify or
// YouTube loads until the panel is first opened, so the dashboard still starts offline.
import { useState, type FormEvent } from 'react';
import { useStored } from '../hooks/stored';
import { SERVICE_NAME, addPick, embedUrl, kindWord, openSmallWindow, openUrl, parseMusicLink, type MusicPick } from './music';
import { clearYouTubeError, listenTo, useYouTubeError, youTubeErrorText } from './youtube';

const Note = () => (
  <svg className="note" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <path d="M6 12.2V3.4l7-1.6v8.6" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
    <circle cx="4.2" cy="12.4" r="2" fill="currentColor" /><circle cx="11.2" cy="10.8" r="2" fill="currentColor" />
  </svg>
);

/** The Music button for the header (in the ride dock on a phone). */
export function MusicButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button className={'music-btn' + (open ? ' on' : '')} onClick={onToggle} aria-expanded={open} aria-controls="music"
            aria-keyshortcuts="M" title="Music">
      <Note /><span className="music-word">Music</span><kbd aria-hidden="true">M</kbd>
    </button>
  );
}

// Spotify's player shows the track list (to pick a song) at 352 px, a single song needs 152.
const playerHeight = (p: MusicPick) =>
  p.service === 'spotify' ? (p.kind === 'track' || p.kind === 'episode' ? 152 : 352) : undefined;

export function MusicPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [picks, setPicks] = useStored<MusicPick[]>('musicPicks', []);
  const [nowKey, setNowKey] = useStored<string | null>('musicNow', null);
  const now = picks.find(p => p.key === nowKey) ?? null;
  const ytError = useYouTubeError(now?.service === 'youtube' ? now.key : null);
  // The panel (and its player) is only put on the page once opened, then kept: closing hides it.
  const [loaded, setLoaded] = useState(open);
  if (open && !loaded) setLoaded(true);
  const [link, setLink] = useState('');
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const add = (e: FormEvent) => {
    e.preventDefault();
    const r = parseMusicLink(link, name);
    if ('error' in r) { setErr(r.error); return; }
    setPicks(ps => addPick(ps, r.pick));
    setNowKey(r.pick.key);
    setLink(''); setName(''); setErr(null);
  };
  const remove = (p: MusicPick) => {
    setPicks(ps => ps.filter(x => x.key !== p.key));
    if (p.key === nowKey) setNowKey(null);
  };

  if (!loaded) return null;
  return (
    <aside id="music" className={'music' + (open ? ' open' : '')} aria-labelledby="music-h" aria-hidden={!open}
           onKeyDown={e => { if (e.key === 'Escape') onClose(); }}>
      <div className="music-head">
        <h2 id="music-h"><Note />Music</h2>
        {now && <button className="quiet music-open" onClick={() => openSmallWindow(now)}
                        title={`Open ${SERVICE_NAME[now.service]} in a small window: everything plays there, with your sign-in`}>
          Small window</button>}
        <button className="quiet music-close" onClick={onClose} aria-label="Close music">
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
        </button>
      </div>

      {now && ytError != null ? (
        <div className="music-blocked" role="alert">
          <p>{youTubeErrorText(ytError)}</p>
          <p className="help">A small window of YouTube Music plays it with your sign-in and keeps playing while you ride.</p>
          <div className="acts">
            <button className="primary" onClick={() => openSmallWindow(now)}>Play in a small window</button>
            <a className="btn" href={openUrl(now)} target="_blank" rel="noopener noreferrer">Open in YouTube Music</a>
            <button className="quiet" onClick={() => clearYouTubeError(now.key)}>Try again</button>
          </div>
        </div>
      ) : now ? (
        <iframe key={now.key} className={'music-player ' + now.service} title={`${now.name} (${SERVICE_NAME[now.service]} player)`}
                src={embedUrl(now)} height={playerHeight(now)} referrerPolicy="strict-origin-when-cross-origin"
                allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
                onLoad={now.service === 'youtube' ? e => listenTo(e.currentTarget, now.key) : undefined} />
      ) : (
        <p className="music-empty">{picks.length ? 'Pick something to play.'
          : <>Paste a playlist, album or song from Spotify or YouTube Music. In the app: <b>Share › Copy link</b>.</>}</p>
      )}

      {picks.length > 0 && (
        <ul className="music-picks" aria-label="Your music">
          {picks.map(p => (
            <li key={p.key}>
              <button className={'music-pick' + (p.key === nowKey ? ' on' : '')} aria-pressed={p.key === nowKey} onClick={() => setNowKey(p.key)}>
                <span className={'svc ' + p.service} aria-hidden="true" />
                <span className="what">{p.name}<small>{SERVICE_NAME[p.service]} · {kindWord(p)}</small></span>
              </button>
              <button className="quiet music-remove" onClick={() => remove(p)} aria-label={`Remove ${p.name}`}>
                <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
              </button>
            </li>
          ))}
        </ul>
      )}

      <form className="music-add" onSubmit={add}>
        <input type="text" inputMode="url" autoComplete="off" spellCheck={false} value={link} aria-label="Spotify or YouTube Music link" aria-invalid={!!err}
               placeholder="Paste a Spotify or YouTube Music link" aria-describedby="music-help"
               onChange={e => { setLink(e.target.value); setErr(null); }} />
        <input type="text" value={name} aria-label="Name (optional)" placeholder="Name (optional)" maxLength={60}
               onChange={e => setName(e.target.value)} />
        <button type="submit" className="primary">Add</button>
      </form>
      <p id="music-help" className={'help' + (err ? ' err' : '')} role={err ? 'alert' : undefined}>
        {err ?? <>Signed in to Spotify in this browser: whole songs (otherwise 30 s previews). YouTube plays ads unless you have Premium and are signed in here.</>}
      </p>
    </aside>
  );
}
