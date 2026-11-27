import { mockAccounts } from '@workspace-api-fixture/account-store.ts';
import { demoAccounts, sessionAuth } from '@workspace-api-fixture/auth.ts';
import { mockBackend } from '@workspace-api-fixture/mock.ts';
import { taskEntryServer } from '@workspace-api-fixture/server.ts';

const port = Number(process.env.BENTO_ONE_PORT ?? 4186);
const origin = new URL(process.env.BENTO_ONE_ORIGIN ?? 'http://127.0.0.1:4185');
if (
    origin.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)
) {
    throw new Error(
        'The Workspace browser fixture requires a local HTTP origin',
    );
}
const server = await taskEntryServer({
    port,
    origin: origin.origin,
    auth: sessionAuth(mockAccounts(demoAccounts()), false),
    backend: mockBackend(),
});
const stop = () => {
    void server.close().catch(() => {
        process.exitCode = 1;
    });
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
