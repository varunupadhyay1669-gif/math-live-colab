import { defineConfig, devices } from '@playwright/test';

// Chromium only, on purpose.
//
// The learners are on iPad Safari, so WebKit is the browser that matters most
// — and it is the one this cannot honestly cover: Playwright's WebKit is not
// Safari, and the failures worth catching (canvas capture, blob: frames, the
// gestures) are exactly where the two differ. Running it would buy the feeling
// of coverage rather than the coverage.
//
// So this is the smoke test for "did we break the mirror", which is engine
// behaviour and reproduces in Chromium, and the iPad remains something a person
// checks after an iOS release (PLAN.md Step 7.4 R4).
export default defineConfig({
  testDir: './tests',
  // Serial: every test drives two contexts through one Socket.IO server holding
  // rooms in memory on a 1 GB box. Parallel would test the box, not the mirror.
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: process.env.SMOKE_BASE_URL || 'http://localhost:4000',
    // Kept only for a failure: a passing run leaving a trace behind is a
    // gigabyte of CI artefacts nobody opens.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
