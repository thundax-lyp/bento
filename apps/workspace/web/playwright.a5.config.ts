import { defineConfig, devices } from '@playwright/test';

const origin = 'http://127.0.0.1:24881';
const configured = process.env.BENTO_A5_ORIGIN;
if (configured !== origin && !process.argv.includes('--list'))
    throw new Error('A5 requires its isolated loopback candidate');

export default defineConfig({
    testDir: './acceptance',
    testMatch: 'a5-*.spec.ts',
    workers: 1,
    retries: 0,
    timeout: 240_000,
    projects: [{ name: 'chromium', use: devices['Desktop Chrome'] }],
    use: {
        baseURL: origin,
        trace: 'off',
        video: 'off',
        screenshot: 'off',
    },
});
