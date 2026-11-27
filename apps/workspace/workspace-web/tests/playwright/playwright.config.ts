import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const webOrigin = 'http://127.0.0.1:4320';
const apiOrigin = 'http://127.0.0.1:4319';
const root = fileURLToPath(new URL('../../../../../', import.meta.url));

export default defineConfig({
    testDir: '../../e2e',
    outputDir: '../../test-results',
    use: { baseURL: webOrigin },
    projects: [{ name: 'chromium', use: devices['Desktop Chrome'] }],
    webServer: [
        {
            command:
                'node --import ./register-paths.mjs apps/workspace/workspace-web/tests/acceptance/fixtures/workspace-api/start-mock.ts',
            cwd: root,
            url: apiOrigin + '/api/session',
            env: {
                BENTO_ONE_PORT: '4319',
                BENTO_ONE_ORIGIN: webOrigin,
            },
        },
        {
            command: 'pnpm dev --port 4320',
            cwd: fileURLToPath(new URL('../../', import.meta.url)),
            url: webOrigin,
            env: { BENTO_API_TARGET: apiOrigin },
        },
    ],
});
