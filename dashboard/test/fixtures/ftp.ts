// FTP test payloads (status.ftp, logger/ftp_test.py) for the tests.
import type { FtpResult, FtpStatus, FtpStep, FtpTestRun } from '../../src/types/feed';

export const PROTOCOL: FtpStep[] = [
  { name: 'Warm-up', dur: 600, lo: 0.5, hi: 0.7 },
  { name: '5 min hard', dur: 300, lo: null, hi: null },
  { name: 'Easy', dur: 600, lo: 0.5, hi: 0.5 },
  { name: '20 min test', dur: 1200, lo: null, hi: null, test: true },
  { name: 'Cool-down', dur: 600, lo: 0.5, hi: 0.4 },
];

export function result(over: Partial<FtpResult> = {}): FtpResult {
  return { id: '20261119-073000', date: '2026-11-19T07:30:00', ftp: 247, avg_w: 260, max_w: 410,
           avg_hr: 168, max_hr: 181, avg_cad: 92, ftp_before: 220, ride: 'x2max_20261119_064000', ...over };
}

export function ftpStatus(test: Partial<FtpTestRun> | null = null, results: FtpResult[] = []): FtpStatus {
  return { test: test && { state: 'running', t0: 0, ftp_before: 220, result: null, ...test },
           results, protocol: PROTOCOL, factor: 0.95 };
}
