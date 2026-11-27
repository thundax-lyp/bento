import { isAbsolute } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const listOnly = process.env.BENTO_WEB_A13_LIST_ONLY === '1';
const continuation = !listOnly && process.env.BENTO_WEB_A11 === '1';
if (listOnly && !process.argv.includes('--list'))
    throw new Error('WEB-A13 list-only mode requires --list');

const endpoint = listOnly ? undefined : process.env.BENTO_WEB_A13_URL;
const storageState = listOnly
    ? undefined
    : process.env.BENTO_WEB_A13_STORAGE_STATE;
const baseURL = endpoint ? URL.parse(endpoint) : null;
if (
    !listOnly &&
    (baseURL?.protocol !== 'https:' ||
        baseURL.username ||
        baseURL.password ||
        !storageState ||
        !isAbsolute(storageState))
)
    throw new Error(
        'WEB-A13 requires an HTTPS URL and absolute storage state path',
    );

export default defineConfig({
    testDir: '../acceptance',
    outputDir: '../../test-results',
    testMatch: '**/web-a13.spec.ts',
    workers: 1,
    retries: 0,
    timeout: 15 * 60 * 1000,
    projects: [{ name: 'chromium', use: devices['Desktop Chrome'] }],
    use: {
        ...(baseURL ? { baseURL: baseURL.origin } : {}),
        ...(storageState ? { storageState } : {}),
        ...(continuation
            ? {
                  launchOptions: {
                      executablePath: '/usr/bin/google-chrome',
                      args: [
                          '--no-proxy-server',
                          '--host-resolver-rules=MAP bento-a11.test 127.0.0.1,MAP s3.bento-a11.test 127.0.0.1,EXCLUDE localhost',
                      ],
                  },
              }
            : {}),
        trace: 'off',
        video: 'off',
        screenshot: 'off',
    },
});
