// Unit and component tests (Vitest + React Testing Library in jsdom). End-to-end tests are in
// test/e2e and run with Playwright: pnpm test:e2e
import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'jsdom',
    include: ['test/unit/**/*.test.ts', 'test/components/**/*.test.tsx'],
    setupFiles: ['test/setup.ts'],
    restoreMocks: true,
  },
});
