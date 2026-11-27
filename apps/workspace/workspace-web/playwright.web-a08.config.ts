import { defineConfig, devices } from '@playwright/test';

const url = URL.parse(process.env.BENTO_WEB_A08_URL ?? '');
if (
    !process.argv.includes('--list') &&
    (url?.protocol !== 'https:' || url.username || url.password)
)
    throw new Error('WEB-A08 requires the isolated HTTPS deployment');

export default defineConfig({
    testDir: './acceptance',
    testMatch: '**/web-a08.spec.ts',
    workers: 1,
    retries: 0,
    timeout: 20 * 60 * 1000,
    projects: [{ name: 'chromium', use: devices['Desktop Chrome'] }],
    use: {
        ...(url ? { baseURL: url.origin } : {}),
        trace: 'off',
        video: 'off',
        screenshot: 'off',
    },
});
