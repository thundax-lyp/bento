import { isAbsolute } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const listOnly = process.env.BENTO_WEB_A12_LIST_ONLY === '1';
if (listOnly && !process.argv.includes('--list'))
    throw new Error('A12 requires --list');
const origin = URL.parse(process.env.BENTO_WEB_A12_ORIGIN ?? '');
const login = process.env.BENTO_WEB_A12_LOGIN_FILE;
const chromium = process.env.BENTO_WEB_A12_CHROMIUM;
if (
    !listOnly &&
    (origin?.origin !== 'https://bento-a12.test:19443' ||
        origin.href !== origin.origin + '/' ||
        !login ||
        !isAbsolute(login) ||
        !chromium ||
        !isAbsolute(chromium) ||
        process.env.BENTO_WEB_A12_COMPOSE_PROJECT !== 'bento-a-web-a12')
) {
    throw new Error('A12 requires its private HTTPS lease and invited account');
}
export default defineConfig({
    testDir: '../acceptance',
    outputDir: '../../test-results',
    testMatch: '**/web-a12.spec.ts',
    projects: [{ name: 'chromium', use: devices['Desktop Chrome'] }],
    workers: 1,
    retries: 0,
    timeout: 240_000,
    use: {
        ...(listOnly ? {} : { baseURL: origin!.origin }),
        ignoreHTTPSErrors: false,
        ...(!listOnly
            ? {
                  launchOptions: {
                      ...(chromium ? { executablePath: chromium } : {}),
                      args: [
                          '--host-resolver-rules=MAP bento-a12.test 127.0.0.1,MAP s3.bento-a12.test 127.0.0.1,MAP gateway.bento-a12.test 127.0.0.1',
                      ],
                  },
              }
            : {}),
        trace: 'off',
        video: 'off',
        screenshot: 'off',
    },
});
