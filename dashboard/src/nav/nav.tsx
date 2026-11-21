// Page navigation: one row of tabs under the header, on every screen size. The ride buttons stay in
// the header (pinned to the bottom on a phone), so Lap, Pause and Finish work from any page, and
// the Live tab carries a red dot and the ride time while a ride records somewhere else.
import type { ReactNode } from 'react';
import { PAGES, type Route } from '../hooks/route';
import { fmtT } from '../util/ride';

interface NavProps {
  page: Route;
  recording: boolean;
  paused: boolean;
  seconds: number;
  onNavigate: () => void;          // a tab was pressed (also when it is the page already)
}

export function Nav({ page, recording, paused, seconds, onNavigate }: NavProps) {
  return (
    <nav className="nav" aria-label="Pages">
      <ul>
        {PAGES.map(p => {
          const rec = p.route === 'live' && recording;
          return (
            <li key={p.route}>
              <a href={p.hash} aria-current={page === p.route ? 'page' : undefined} onClick={onNavigate}>
                {rec && <span className={'nav-rec' + (paused ? ' paused' : '')} aria-hidden="true" />}
                {p.label}
                {rec && <span className="sr-only">{paused ? ', ride paused' : ', recording'}</span>}
                {rec && page !== 'live' && <span className="nav-time">{fmtT(seconds)}</span>}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

// Heading row shared by the pages behind the tabs.
export function PageHead({ id, title, children }: { id: string; title: string; children?: ReactNode }) {
  return (
    <div className="page-head">
      <h2 id={id}>{title}</h2>
      {children && <p className="help">{children}</p>}
    </div>
  );
}
