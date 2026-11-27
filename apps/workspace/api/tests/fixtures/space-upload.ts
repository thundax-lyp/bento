import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { mockAccounts } from '@/apps/workspace/api/src/account-store.ts';
import { sessionAuth } from '@/apps/workspace/api/src/auth.ts';
import { taskEntryServer } from '@/apps/workspace/api/src/server.ts';
import { mockBackend } from '@/apps/workspace/api/src/mock.ts';
import { mySpace } from '@/apps/workspace/api/src/space/index.ts';
import { spaceStorage } from '@/apps/workspace/api/src/space/storage.ts';

export const recoveryDownload = 'https://fixture.invalid/download';

export const spaceFixtureOrigin = 'http://127.0.0.1:1';

export async function openSpaceHttpFixture(
    storage: ReturnType<typeof spaceStorage>,
    prefix: string,
) {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    const dbPath = join(dir, 'space.sqlite');
    const origin = spaceFixtureOrigin;
    const accounts = {
        a: { ownerId: 'owner-a', account: 'a', inviteSha256: '' },
        b: { ownerId: 'owner-b', account: 'b', inviteSha256: '' },
    };
    const auth = sessionAuth(mockAccounts(Object.values(accounts)), false);
    const cookies = new Map<string, string>();
    function renewSession(actor: 'a' | 'b'): void {
        const session = auth.startSession(
            { headers: {} } as Parameters<typeof auth.startSession>[0],
            accounts[actor],
        );
        cookies.set(actor, session.cookie.split(';')[0]!);
    }
    renewSession('a');
    renewSession('b');
    const backend = mockBackend();
    let web: Awaited<ReturnType<typeof taskEntryServer>> | undefined;
    async function reopen() {
        await web?.close();
        web = undefined;
        web = await taskEntryServer({
            port: 0,
            origin,
            auth,
            backend,
            space: mySpace(dbPath, storage, backend),
        });
    }
    async function request(
        path: string,
        method = 'GET',
        input?: unknown,
        signal?: AbortSignal,
        actor: 'a' | 'b' = 'a',
    ) {
        assert(web);
        const timeout = AbortSignal.timeout(5000);
        const response = await fetch(web.origin + path, {
            method,
            headers: {
                Cookie: cookies.get(actor)!,
                Origin: origin,
                'Content-Type': 'application/json',
            },
            ...(input === undefined ? {} : { body: JSON.stringify(input) }),
            redirect: 'manual',
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        const text = await response.text();
        return {
            status: response.status,
            location: response.headers.get('location'),
            json: text ? JSON.parse(text) : null,
        };
    }
    async function close() {
        await web?.close();
        web = undefined;
    }
    const dispose = async () => {
        try {
            await close();
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    };
    return { dbPath, request, renewSession, reopen, close, dispose };
}

export function assertUploadError(
    response: { status: number; json: { error: { code: string } } },
    status: number,
    code: string,
) {
    assert.equal(response.status, status);
    assert.equal(response.json.error.code, code);
}

export function recoveryClock(t: TestContext) {
    t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1800000000000 });
    return {
        async sweep() {
            t.mock.timers.tick(30000);
            await new Promise<void>((resolve) => setImmediate(resolve));
        },
        advanceTo(now: number) {
            t.mock.timers.setTime(now);
        },
        expireSignature(f: { row(): Record<string, unknown> }) {
            const signedUntil = f.row().signedUntil;
            assert(typeof signedUntil === 'number');
            t.mock.timers.setTime(signedUntil + 1);
        },
    };
}

export function recoveryBarrier() {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
        enter = resolve;
    });
    const released = new Promise<void>((resolve) => {
        release = resolve;
    });
    return {
        async waitForEntry() {
            await Promise.race([
                entered,
                delay(5000, undefined, { ref: false }).then(() =>
                    assert.fail('Storage barrier was not entered'),
                ),
            ]);
        },
        async pause() {
            enter();
            await released;
        },
        release,
    };
}
