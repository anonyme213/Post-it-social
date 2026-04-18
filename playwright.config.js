import { defineConfig, devices } from '@playwright/test';

const useHttps = process.env.USE_HTTPS === 'true';
const protocol = useHttps ? 'https' : 'http';
const baseURL = process.env.PLAYWRIGHT_BASE_URL || `${protocol}://localhost:3000`;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL,
    trace: 'on-first-retry',
    ignoreHTTPSErrors: useHttps
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    }
  ],
  webServer: {
    command: 'npm run dev',
    url: `${protocol}://localhost:3000/health`,
    reuseExistingServer: !process.env.CI,
    ignoreHTTPSErrors: useHttps
  }
});