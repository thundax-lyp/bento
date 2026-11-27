import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
    testDir: '../acceptance',
    outputDir: '../../test-results',
    testMatch: '**/web-terminal-results.spec.ts',
    workers: 1,
    retries: 0,
    timeout: 120000,
    projects: [{ name: 'chromium', use: devices['Desktop Chrome'] }],
    use: {
        baseURL: 'http://127.0.0.1:4334',
        trace: 'off',
        video: 'off',
        screenshot: 'off',
    },
    webServer: {
        command: 'pnpm dev --host 127.0.0.1 --port 4334 --strictPort',
        cwd: fileURLToPath(new URL('../../', import.meta.url)),
        url: 'http://127.0.0.1:4334',
        env: { BENTO_API_TARGET: 'http://127.0.0.1:4333' },
        reuseExistingServer: false,
    },
});
