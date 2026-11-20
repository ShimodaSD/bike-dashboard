// Entry point: mounts the dashboard (app.tsx) into dashboard.html.
import { createRoot } from 'react-dom/client';
import { App } from './app';

createRoot(document.getElementById('root')!).render(<App />);
