// A stand-in for the browser's EventSource, so tests can play the logger's /events stream.
import { act } from '@testing-library/react';

export class FakeEventSource {
  static all: FakeEventSource[] = [];
  listeners: Record<string, ((e: { data: string }) => void)[]> = {};
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) { FakeEventSource.all.push(this); }
  addEventListener(name: string, fn: (e: { data: string }) => void) { (this.listeners[name] ||= []).push(fn); }
  close() { this.closed = true; }
  // send one event, as the logger would (inside act, so React renders the result)
  emit(name: string, data: unknown) { act(() => this.listeners[name]?.forEach(fn => fn({ data: JSON.stringify(data) }))); }
}

export const latestStream = () => FakeEventSource.all.filter(e => !e.closed).at(-1)!;
