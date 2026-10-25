import { defineConfig } from '@playwright/test';

// Real-WebGL tests of the built library. `pnpm test:e2e` always builds it first (`pnpm build:e2e` -> dist-e2e, the
// library build with the test hooks kept). Software GL (SwiftShader in Chromium, the browser's own in Firefox), so
// it needs no GPU in CI.
export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.spec.ts',
  timeout: 60_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:4179',
    viewport: { width: 800, height: 600 },
  },
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        launchOptions: {
          args: ['--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
        },
      },
    },
    // Another engine's WebGL2 and ImageBitmap uploads. CI runs it (`--project=firefox`); locally it needs
    // `playwright install firefox` and `E2E_FIREFOX=1`.
    ...(process.env.CI || process.env.E2E_FIREFOX
      ? [
          {
            name: 'firefox',
            use: {
              browserName: 'firefox' as const,
              // Headless Firefox on a GPU-less Linux runner exposes no WebGL2; headed under xvfb it gets Mesa's
              // software GL. CI runs this project with `xvfb-run` and E2E_HEADED=1.
              headless: !process.env.E2E_HEADED,
              launchOptions: { firefoxUserPrefs: { 'webgl.force-enabled': true, 'webgl.disabled': false } },
            },
          },
        ]
      : []),
  ],
  webServer: {
    command: 'pnpm exec vite --config e2e/vite.config.ts',
    url: 'http://localhost:4179/',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
