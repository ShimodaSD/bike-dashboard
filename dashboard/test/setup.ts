// Shared setup for the Vitest tests: jest-dom matchers, a clean DOM and fresh fetch spies.
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

// jsdom has no matchMedia; the dashboard reads it once at import (Tap / Click wording, phone rate).
if (!window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  }) as MediaQueryList;
}

// Testing Library flushes React work with a setTimeout(0) and only advances it when it sees Jest's
// fake timers. Point it at Vitest's, so tests with vi.useFakeTimers() don't hang on a click.
(globalThis as unknown as { jest: unknown }).jest = { advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms) };

// jsdom's File has no .text() (browsers do); the workout loader reads files with it.
if (!Blob.prototype.text) {
  Blob.prototype.text = function text(this: Blob) {
    return new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result as string);
      r.onerror = () => reject(r.error);
      r.readAsText(this);
    });
  };
}

// jsdom can't download files: keep the dashboard's Download / Send links from trying to navigate.
document.addEventListener('click', e => { if ((e.target as Element).closest?.('a[download]')) e.preventDefault(); });

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('ok'))));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
