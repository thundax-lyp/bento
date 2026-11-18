import { isAbsolute } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const listing = process.argv.includes('--list');
const endpoint = URL.parse(process.env.BENTO_WEB_A05_URL ?? '');
const state = process.env.BENTO_WEB_A05_STORAGE_STATE;
if (
    !listing &&
    (endpoint?.protocol !== 'https:' ||
        endpoint.username ||
        endpoint.password ||
        !state ||
        !isAbsolute(state))
)
    throw new Error(
        'WEB-A05 requires an isolated HTTPS origin and absolute browser state path',
    );

export default defineConfig({
    testDir: './acceptance',
    testMatch: '**/web-a05.spec.ts',
    workers: 1,
    retries: 0,
    timeout: 20 * 60 * 1000,
    projects: [{ name: 'chromium', use: devices['Desktop Chrome'] }],
    use: {
        baseURL: endpoint?.origin,
        storageState: state,
        trace: 'off',
        video: 'off',
        screenshot: 'off',
    },
});
