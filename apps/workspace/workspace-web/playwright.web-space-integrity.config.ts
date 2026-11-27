import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
    testDir: './acceptance',
    testMatch: '**/web-space-integrity.spec.ts',
    workers: 1,
    retries: 0,
    timeout: 120000,
    projects: [{ name: 'chromium', use: devices['Desktop Chrome'] }],
    use: {
        baseURL: 'http://127.0.0.1:4354',
        trace: 'off',
        video: 'off',
        screenshot: 'off',
    },
    webServer: {
        command: 'pnpm dev --host 127.0.0.1 --port 4354 --strictPort',
        url: 'http://127.0.0.1:4354',
        env: { BENTO_API_TARGET: 'http://127.0.0.1:4353' },
        reuseExistingServer: false,
    },
});
