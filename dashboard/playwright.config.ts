// End-to-end tests: the real logger in --demo mode (simulated trainer and watch, no Bluetooth)
// serving the built dashboard, driven in Chromium at laptop and phone size.
//   pnpm build && pnpm test:e2e        (needs uv; first time: pnpm exec playwright install chromium)
import { defineConfig, devices } from '@playwright/test';

const PORT = 8765;                         // not 8000, so a logger you have running doesn't clash

export default defineConfig({
  testDir: 'test/e2e',
  fullyParallel: false,
  workers: 1,                              // one logger, one ride at a time
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'off', screenshot: 'only-on-failure' },
  projects: [
    { name: 'laptop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    { name: 'phone', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: `uv run ../logger/thinkrider_logger.py --demo --no-browser --port ${PORT} --out test-results/e2e-rides`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'ignore',
  },
});
