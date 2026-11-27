import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test, type TestContext } from 'node:test';
import { localHost } from '@orchestrator/execution-service/local.ts';
import { serveExecution } from '@orchestrator/execution-service/service.ts';
import {
    client,
    project,
    submit,
    testToken,
    until,
} from './fixtures/service.ts';

type AppFixture = {
    url: string;
    owner: string;
    subject: string;
    workspaceToken: string;
    adminToken: string;
    a: string;
    b: string;
    bRun: string;
    readLedger(id: string): unknown | Promise<unknown>;
    snapshot(): unknown | Promise<unknown>;
    close(): Promise<void>;
};

async function localFixture(t: TestContext): Promise<AppFixture> {
    const state = await mkdtemp(join(tmpdir(), 'bento-app-boundaries-'));
    t.after(() => rm(state, { recursive: true, force: true }));
    const goControl =
        process.env.BENTO_TEST_GO_CONTROL ?? join(state, 'bento-orchestrator');
    if (!process.env.BENTO_TEST_GO_CONTROL)
        execFileSync('go', ['build', '-o', goControl, './src/control'], {
            cwd: fileURLToPath(
                new URL('../../../orchestrator-control/', import.meta.url),
            ),
            timeout: 120_000,
        });
    const options = {
        state,
        token: testToken,
        goControl,
        host: localHost(join(state, 'host')),
    };
    const owner = 'workspace-account';
    const seed = await serveExecution(options);
    let a: string;
    let b: string;
    let bRun: string;
    try {
        a = await project(client(seed.url, owner));
        const bApi = client(seed.url, owner);
        b = await project(bApi);
        bRun = await submit(bApi, b, 'Fixture', randomUUID());
        await until(
            () => bApi(bRun),
            (r) => r.json().status === 'succeeded',
            'workspace B run',
        );
    } finally {
        await seed.close();
    }
    const adminToken = 'fixture-only-admin-service-bearer';
    const service = await serveExecution({
        ...options,
        adminDiagnostics: {
            token: adminToken,
            grants: [{ subject: 'admin-a', owner, workspace: a.slice(1) }],
        },
    });
    const readLedger = (id: string) => {
        const db = new DatabaseSync(join(state, 'business.sqlite'), {
            readOnly: true,
        });
        try {
            return db
                .prepare('SELECT id, projectId, status FROM runs WHERE id=?')
                .get(id);
        } finally {
            db.close();
        }
    };
    const snapshot = () => {
        return ['business.sqlite', 'authority.sqlite'].map((name) => {
            const db = new DatabaseSync(join(state, name), {
                readOnly: true,
            });
            try {
                return db
                    .prepare(
                        "SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name",
                    )
                    .all()
                    .map(({ name }) => [
                        name,
                        db
                            .prepare(
                                'SELECT * FROM "' +
                                    String(name).replaceAll('"', '""') +
                                    '" ORDER BY rowid',
                            )
                            .all(),
                    ]);
            } finally {
                db.close();
            }
        });
    };
    return {
        url: service.url,
        owner,
        subject: 'admin-a',
        workspaceToken: testToken,
        adminToken,
        a,
        b,
        bRun,
        readLedger,
        snapshot,
        close: () => service.close(),
    };
}

test('APP-01 internal service authorization and independent Run reads', async (t) => {
    const adapterPath = process.env.BENTO_APP_ACCEPTANCE_ADAPTER;
    const create = adapterPath
        ? (
              (await import(pathToFileURL(resolve(adapterPath)).href)) as {
                  default: (t: TestContext) => Promise<AppFixture>;
              }
          ).default
        : localFixture;
    const {
        url,
        owner,
        subject,
        workspaceToken,
        adminToken,
        a,
        b,
        bRun,
        readLedger,
        snapshot,
        close,
    } = await create(t);
    try {
        const api = client(url, owner, workspaceToken);
        const namespace = '/v1/admin/workspaces';
        const diag = namespace + a + '/diagnostic-runs';
        const invoke = (
            path: string,
            method: string,
            token = adminToken,
            key = randomUUID(),
        ) =>
            fetch(url + path, {
                method,
                headers: {
                    authorization: 'Bearer ' + token,
                    'x-bento-admin-subject': subject,
                    'idempotency-key': key,
                },
                signal: AbortSignal.timeout(5000),
            });
        const personal = await submit(api, a, 'Fixture', randomUUID());
        const personalRun = await until(
            () => api(personal),
            (r) => r.json().status === 'succeeded',
            'personal run',
        );
        const personalId = personalRun.json().id;
        assert.deepEqual(
            { ...((await readLedger(personalId)) as object) },
            { id: personalId, projectId: a.slice(1), status: 'succeeded' },
        );

        const key = randomUUID();
        const created = await invoke(diag, 'POST', adminToken, key);
        assert.equal(created.status, 202);
        const { id } = (await created.json()) as { id: string };
        const replay = await invoke(diag, 'POST', adminToken, key);
        assert.equal(replay.status, 200);
        assert.equal(((await replay.json()) as { id: string }).id, id);
        assert.notEqual(id, personalId);
        const adminRun = await until(
            async () => {
                const response = await invoke(diag + '/' + id, 'GET');
                assert.equal(response.status, 200);
                return (await response.json()) as {
                    id: string;
                    projectId: string;
                    status: string;
                };
            },
            (r) => r.status === 'succeeded',
            'diagnostic run',
        );
        assert.deepEqual(
            { ...((await readLedger(id)) as object) },
            {
                id: adminRun.id,
                projectId: adminRun.projectId,
                status: adminRun.status,
            },
        );

        const before = await snapshot();
        for (const [path, method, token, code] of [
            [diag, 'POST', workspaceToken, 'caller_denied'],
            [diag + '/' + id, 'DELETE', adminToken, 'operation_denied'],
            [
                namespace + b + '/diagnostic-runs',
                'POST',
                adminToken,
                'workspace_scope_denied',
            ],
            [
                namespace + b + '/diagnostic-runs/' + bRun.split('/').at(-1),
                'GET',
                adminToken,
                'workspace_scope_denied',
            ],
        ] as const) {
            const response = await invoke(path, method, token);
            assert.equal(response.status, 403);
            assert.equal(
                ((await response.json()) as { error: { code: string } }).error
                    .code,
                code,
            );
            assert.deepEqual(await snapshot(), before);
        }
        assert.equal(
            (await invoke(diag + '/' + personalId, 'GET')).status,
            404,
        );
    } finally {
        await close();
    }
});
