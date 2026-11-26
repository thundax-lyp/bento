/* global AbortSignal, fetch */
import { Buffer } from 'node:buffer';
import console from 'node:console';
import process from 'node:process';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { commandHost } from '../../src/execution-service/command-host.ts';
import { serveExecution } from '../../src/execution-service/service.ts';

const [hostConfig, sdkRaw, state] = process.argv.slice(2);
assert(
    hostConfig && sdkRaw && state,
    'usage: real.mjs HOST_CONFIG SDK_RAW EMPTY_STATE',
);
await assert.rejects(stat(join(state, 'business.sqlite')), { code: 'ENOENT' });
const { OpenShell } = await import(pathToFileURL(sdkRaw).href);
const require = createRequire(sdkRaw);
const { createClient } = require('@connectrpc/connect');
const { createGrpcTransport } = require('@connectrpc/connect-node');
const host = await commandHost(hostConfig);
const token = randomBytes(32).toString('hex');
const owner = 'a4-owner-' + randomUUID();
const otherOwner = 'a4-other-' + randomUUID();
const workspace = '/sandbox/project/workspace';
const workspaceScope = {
    selection: { case: 'workspace', value: host.sdk.workspace },
};
const files = [
    { path: 'README.md', text: '# Shared workspace\n' },
    { path: 'src/app.txt', text: 'initial\n' },
];
const input = { name: 'A4 shared volume acceptance', files };
const hash = (value) => createHash('sha256').update(value).digest('hex');
const docker = (...args) =>
    execFileSync('docker', args, { encoding: 'utf8', timeout: 45_000 }).trim();
const exists = (volume) =>
    docker('volume', 'ls', '--format', '{{.Name}}')
        .split('\n')
        .includes(volume);
const id = (volume) =>
    docker(
        'volume',
        'inspect',
        '--format',
        '{{.Name}} {{.CreatedAt}} {{.Mountpoint}}',
        volume,
    );
const identity = (volume) => hash(id(volume));
const manifestScript = `
const { createHash } = require('node:crypto');
const { readdirSync, readFileSync, statSync } = require('node:fs');
const { join } = require('node:path');
function walk(dir, prefix = '') {
  return readdirSync(dir).sort().flatMap(name => {
    const absolute = join(dir, name);
    const path = prefix + name;
    const stat = statSync(absolute);
    return stat.isDirectory() ? walk(absolute, path + '/') :
      [{path, mode: stat.mode & 0o777, sha256: createHash('sha256').update(readFileSync(absolute)).digest('hex')}];
  });
}
console.log(JSON.stringify(walk('/vol')));
`;
const manifest = (volume) =>
    JSON.parse(
        docker(
            'run',
            '--rm',
            '--pull',
            'never',
            '--network',
            'none',
            '--mount',
            'type=volume,src=' + volume + ',dst=/vol,readonly',
            '--entrypoint',
            'node',
            'node:22-bookworm-slim',
            '-e',
            manifestScript,
        ),
    );
const containers = (binding) =>
    docker(
        'ps',
        '-q',
        '--filter',
        'volume=' + binding.volume,
        '--filter',
        'label=openshell.ai/sandbox-name=' + binding.sandbox,
    )
        .split('\n')
        .filter(Boolean);
const evidence = (scenario, facts) =>
    console.log(JSON.stringify({ scenario, ...facts }));

function readAuthority(query, value) {
    const db = new DatabaseSync(join(state, 'authority.sqlite'), {
        readOnly: true,
    });
    try {
        return db.prepare(query).get(value)?.result;
    } finally {
        db.close();
    }
}
const reclaimReceipt = (volume) =>
    readAuthority(
        'SELECT reclaimed AS result FROM volume_reclaims WHERE volume=?',
        volume,
    );

let service;
let ingress;
const connections = new Set();
let first;
let second;
let reclaimBlocked = false;
const actualReclaim = host.sharedVolume.reclaim;
host.sharedVolume.reclaim = async (binding) => {
    if (reclaimBlocked)
        throw new Error('Reclaim interrupted before Docker removal');
    return actualReclaim(binding);
};
async function start() {
    service = await serveExecution({
        state,
        token,
        host,
        workerTimeoutMs: 90_000,
    });
}
async function closeIngress() {
    if (!ingress) return;
    const closing = new Promise((resolve) => ingress.close(resolve));
    for (const connection of connections) connection.destroy();
    await closing;
    ingress = undefined;
}
async function api(path, method = 'GET', body, key, principal = owner) {
    const response = await fetch(service.url + '/v1/projects' + path, {
        method,
        headers: {
            authorization: 'Bearer ' + token,
            'x-bento-owner-id': principal,
            ...(body === undefined
                ? {}
                : { 'content-type': 'application/json' }),
            ...(key ? { 'idempotency-key': key } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
    });
    return {
        status: response.status,
        body: response.status === 204 ? undefined : await response.json(),
    };
}
function grant(binding) {
    const control = service.sharedSessions;
    return control.admit(
        binding.session,
        control.inspect(binding.session).generation,
        randomUUID(),
    );
}
function client(grant, gateway = 'http://127.0.0.1:' + ingress.address().port) {
    return createClient(
        OpenShell,
        createGrpcTransport({
            baseUrl: gateway,
            httpVersion: '2',
            interceptors: [
                (next) => async (request) => {
                    request.header.set(
                        'authorization',
                        'Bearer ' + grant.token,
                    );
                    return next(request);
                },
            ],
        }),
    );
}
async function run(
    binding,
    grant,
    script,
    onOutput = () => {},
    sdkClient = client(grant),
) {
    let result = '';
    let exit;
    for await (const { payload } of sdkClient.execSandbox(
        {
            sandbox: binding.sandbox,
            workspaceScope,
            workdir: workspace,
            command: ['/bin/sh', '-c', script],
        },
        { timeoutMs: 30_000 },
    )) {
        if (payload.case === 'stdout') {
            result += Buffer.from(payload.value.data).toString();
            onOutput(result);
        }
        if (payload.case === 'exit') exit = payload.value.exitCode;
    }
    assert.equal(exit, 0);
    return result;
}
host.worker = async ({ binding, grant, gateway, mode, prompt }) => {
    assert.equal(mode, 'execute');
    assert.equal(prompt, 'Write final acceptance marker.');
    assert.deepEqual(binding, second);
    assert.equal(
        await run(
            binding,
            grant,
            'cat survivor.txt; printf final > final.txt',
            undefined,
            client(grant, gateway),
        ),
        'survived\n',
    );
    return 'completed';
};
try {
    await start();
    const created = await api('', 'POST', input, 'a4-project');
    assert.equal(created.status, 201);
    assert.equal(created.body.status, 'importing');
    const project = created.body.id;
    let current;
    for (let attempt = 0; attempt < 100; attempt++) {
        current = await api('/' + project);
        if (current.body.status !== 'importing') break;
        await delay(250);
    }
    assert.equal(current.body.status, 'ready', 'project did not reach READY');
    const control = service.sharedSessions;
    first = control.projectBinding(owner, project);
    const { volume } = first;
    second = {
        ...first,
        sandbox: 'b-' + randomBytes(8).toString('hex'),
        session: randomUUID(),
    };
    assert.equal(
        (await api('/' + project, 'GET', undefined, undefined, otherOwner))
            .status,
        404,
    );
    await assert.rejects(
        control.attach(first, { ...second, tenant: otherOwner }),
        /binding denied/,
    );
    const initial = manifest(volume);
    assert.deepEqual(
        initial.map(({ path, sha256 }) => ({ path, sha256 })),
        files.map(({ path, text }) => ({ path, sha256: hash(text) })),
    );
    assert(initial.every(({ mode }) => mode === 0o644));
    const initialIdentity = identity(volume);
    assert.equal((await control.attach(first, second)).state, 'READY');
    assert.equal((await control.attach(first, second)).state, 'READY');
    assert.equal(containers(first).length, 1);
    const beforeRebuild = containers(second);
    assert.equal(beforeRebuild.length, 1);
    await control.rebuild(second);
    const afterRebuild = containers(second);
    assert.equal(afterRebuild.length, 1);
    assert.notDeepEqual(afterRebuild, beforeRebuild);
    assert.equal(identity(volume), initialIdentity);
    assert.deepEqual(manifest(volume), initial);
    evidence('A4-01', {
        volumeIdentitySha256: initialIdentity,
        initial,
        mounts: 2,
        importStates: [created.body.status, current.body.status],
        rebuiltWithNewContainer: true,
        crossOwnerDenied: true,
    });

    ingress = control.ingress();
    ingress.on('session', (connection) => {
        connections.add(connection);
        connection.once('close', () => connections.delete(connection));
    });
    await new Promise((resolve, reject) =>
        ingress.once('error', reject).listen(0, '127.0.0.1', resolve),
    );
    const firstGrant = grant(first);
    await run(
        first,
        firstGrant,
        "printf 'edited\\n' > README.md; printf 'draft\\n' > draft.txt",
    );
    await control.finish(first.session, firstGrant.generation);
    const localChanges = manifest(volume);
    assert.equal(
        localChanges.find(({ path }) => path === 'README.md').sha256,
        hash('edited\n'),
    );
    assert.equal(
        localChanges.find(({ path }) => path === 'draft.txt').sha256,
        hash('draft\n'),
    );
    const replay = await api('', 'POST', input, 'a4-project');
    const conflict = await api(
        '',
        'POST',
        { ...input, name: 'different' },
        'a4-project',
    );
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body, current.body);
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, 'idempotency_conflict');
    assert.deepEqual(manifest(volume), localChanges);
    assert.equal(identity(volume), initialIdentity);
    evidence('A4-02', {
        replay: replay.status,
        conflict: conflict.status,
        unchangedAfterReplay: localChanges,
    });

    const writer = grant(first);
    const entered = Promise.withResolvers();
    const running = run(
        first,
        writer,
        "echo entered; sleep 6; printf 'first\\n' > winner.txt",
        (chunk) => {
            if (chunk.includes('entered')) entered.resolve();
        },
    );
    await Promise.race([
        entered.promise,
        running.then(() => {
            throw new Error('Writer ended before barrier');
        }),
    ]);
    assert.throws(() => grant(second), { code: 'volume_busy' });
    const busy = await api(
        '/' + first.project + '/runs',
        'POST',
        { prompt: 'Competing write.', sessionId: second.session },
        'busy-run',
    );
    assert.equal(busy.status, 409);
    assert.equal(busy.body.error.code, 'volume_busy');
    assert.equal(
        readAuthority(
            'SELECT COUNT(*) AS result FROM operations WHERE session=?',
            second.session,
        ),
        0,
    );
    assert(!manifest(volume).some(({ path }) => path === 'rejected.txt'));
    await running;
    await control.finish(first.session, writer.generation);
    const retry = grant(second);
    assert.equal(
        await run(
            second,
            retry,
            "cat winner.txt; printf 'second\\n' > retry.txt",
        ),
        'first\n',
    );
    await control.finish(second.session, retry.generation);
    const afterConflict = manifest(volume);
    assert.equal(
        afterConflict.find(({ path }) => path === 'retry.txt').sha256,
        hash('second\n'),
    );
    for (const file of localChanges)
        assert.deepEqual(
            afterConflict.find(({ path }) => path === file.path),
            file,
        );
    evidence('A4-03', {
        conflict: 'volume_busy',
        ordinaryRunConflict: busy.status,
        establishedWriter: true,
        rejectedFileAbsent: true,
        rejectedOperations: 0,
        unrelatedHashesPreserved: true,
        retryHash: hash('second\n'),
    });

    const retired = grant(first);
    const establishedClient = client(retired);
    await run(first, retired, 'cat README.md', undefined, establishedClient);
    await control.revoke(first);
    await assert.rejects(
        run(
            first,
            retired,
            'printf denied > revoked.txt',
            undefined,
            establishedClient,
        ),
        (error) => [7, 16].includes(error.code),
    );
    await assert.rejects(
        run(first, retired, 'printf denied > revoked.txt'),
        (error) => [7, 16].includes(error.code),
    );
    assert.throws(() => grant(first), /admission denied/);
    const survivor = grant(second);
    await run(
        second,
        survivor,
        "cat README.md; printf 'survived\\n' > survivor.txt",
    );
    await control.finish(second.session, survivor.generation);
    assert(!manifest(volume).some(({ path }) => path === 'revoked.txt'));
    evidence('A1-05', {
        establishedClientDenied: true,
        reconnectedClientDenied: true,
        newGrantDenied: true,
        survivorWriteHash: hash('survived\n'),
    });

    assert.equal(await control.release(first), 'released');
    assert.equal(await control.release(first), 'released');
    assert.equal(reclaimReceipt(volume), undefined);
    assert.equal(identity(volume), initialIdentity);
    assert.equal(containers(first).length, 0);
    const runs = '/' + first.project + '/runs';
    const prompt = 'Write final acceptance marker.';
    const key = 'shared-session-run';
    assert.equal(
        (await api(runs, 'POST', { prompt, sessionId: randomUUID() }, key))
            .status,
        404,
    );
    const runRequest = { prompt, sessionId: second.session };
    const accepted = await api(runs, 'POST', runRequest, key);
    assert.equal(accepted.status, 202);
    assert.equal(accepted.body.sessionId, second.session);
    let result;
    for (let attempt = 0; attempt < 100; attempt++) {
        result = await api(runs + '/' + accepted.body.id);
        if (result.body.status === 'succeeded') break;
        await delay(100);
    }
    assert.equal(result.body.status, 'succeeded');
    assert.equal((await api(runs, 'POST', runRequest, key)).status, 200);
    assert.equal(
        (await api(runs, 'POST', { prompt, sessionId: first.session }, key))
            .status,
        409,
    );
    assert.equal(
        manifest(volume).find(({ path }) => path === 'final.txt').sha256,
        hash('final'),
    );
    reclaimBlocked = true;
    await assert.rejects(control.release(second), /interrupted/);
    assert(exists(volume));
    assert.equal(reclaimReceipt(volume), 0);
    assert.equal(containers(second).length, 0);
    assert.equal(docker('ps', '-aq', '--filter', 'volume=' + volume), '');
    await closeIngress();
    await service.close();
    reclaimBlocked = false;
    await start();
    for (
        let attempt = 0;
        attempt < 100 && reclaimReceipt(volume) !== 1;
        attempt++
    )
        await delay(100);
    assert.equal(reclaimReceipt(volume), 1);
    assert.equal(await service.sharedSessions.release(second), 'reclaimed');
    assert(!exists(volume));
    const deletionKey = randomUUID();
    assert.equal(
        (await api('/' + first.project, 'DELETE', undefined, deletionKey))
            .status,
        204,
    );
    assert.equal((await api('/' + first.project, 'GET')).status, 404);
    evidence('A4-04', {
        sameVolumeAfterFirstRelease: true,
        survivorWriteHash: hash('final'),
        zeroAttachmentsBeforeReclaim: true,
        recoveredAfterRestart: true,
        finalVolumeAbsent: true,
        durableReclaimReceipt: 1,
        projectDeletion: 204,
        ordinaryRunOnSurvivor: result.body.status,
    });
} finally {
    reclaimBlocked = false;
    await closeIngress();
    if (service) {
        for (const binding of [first, second].filter(Boolean))
            await service.sharedSessions?.release(binding).catch(() => {});
        await service.close();
    }
}
