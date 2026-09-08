import { defineConfig } from '@playwright/test';

const PORT = process.env.PORT || 4173;

export default defineConfig({
  testDir: './tests',
  testMatch: /.*\.spec\.js/,
  timeout: 90_000,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    headless: true,
    viewport: { width: 960, height: 540 },
  },
  webServer: {
    command: `node tools/serve.js ${PORT} ${process.env.SERVE_ROOT || '.'}`,
    url: `http://localhost:${PORT}/index.html`,
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
