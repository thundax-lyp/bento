import { isAbsolute } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const listOnly = process.argv.includes('--list');
const origin = URL.parse(process.env.BENTO_WEB_A10_ORIGIN ?? '');
const chromium = process.env.BENTO_WEB_A10_CHROMIUM;
const login = process.env.BENTO_WEB_A10_LOGIN_FILE;

if (
    !listOnly &&
    (origin?.origin !== 'http://127.0.0.1:8080' ||
        origin.href !== origin.origin + '/' ||
        !chromium ||
        !isAbsolute(chromium) ||
        !login ||
        !isAbsolute(login) ||
        process.env.BENTO_WEB_A10_COMPOSE_PROJECT !== 'bento-worker-a-web-a10')
) {
    throw new Error(
        'WEB-A10 requires its isolated deployment and three invited accounts',
    );
}

export default defineConfig({
    testDir: './acceptance',
    testMatch: '**/web-a10.spec.ts',
    projects: [{ name: 'chromium', use: devices['Desktop Chrome'] }],
    workers: 1,
    retries: 0,
    timeout: 300_000,
    use: {
        ...(listOnly
            ? {}
            : {
                  baseURL: origin!.origin,
                  launchOptions: { executablePath: chromium! },
              }),
        ignoreHTTPSErrors: false,
        trace: 'off',
        video: 'off',
        screenshot: 'off',
    },
});
