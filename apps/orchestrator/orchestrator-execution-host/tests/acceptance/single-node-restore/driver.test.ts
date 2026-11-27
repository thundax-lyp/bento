import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { Binding } from '@/apps/worker/src/protocol.ts';
import { backupSqlite } from './backup.ts';
import { assertSameLedger, readLedger, type Ledger } from './audit.ts';
import {
    assertHistoryPreserved,
    authoritySnapshot,
    executionPlan,
    executionSourceDigest,
    verifyExecutionInputs,
    enforceOrder,
    loadCase,
    restoreDatabaseLayout,
    validateGate,
    type CaseConfig,
    type GateProof,
} from './driver.ts';
const caseId = 'bento-a7-b-0123456789abcdef';
const image = 'sha256:' + 'a'.repeat(64);
const adapterSha = 'b'.repeat(64);
function inputs(root = '/tmp/' + caseId): {
    config: CaseConfig;
    proof: GateProof;
} {
    const config: CaseConfig = {
        schema: 1,
        caseId,
        root,
        dockerDaemonId: 'synthetic-daemon',
        runtimeImageId: image,
        workerImageId: image,
        hostConfig: join(root, 'host.json'),
        sdkModule: join(root, 'sdk.js'),
        gatewayWorkspace: 'default',
        gatewayOwner: caseId,
        gatewayEndpoint: 'https://127.0.0.1:12345',
        adapterManifest: join(root, 'adapter.json'),
        cli: join(root, 'cli'),
        cliConfigHome: join(root, 'cli-home'),
        policy: join(root, 'policy.yaml'),
        sourceCommit: '1'.repeat(40),
        environmentVersion: 'sha256:' + 'c'.repeat(64),
        serviceTokenFile: join(root, 'token'),
        controlBinary: join(root, 'control'),
        gateProof: join(root, 'gate.json'),
        temporal: {
            namespace: caseId + '-namespace',
            taskQueue: caseId + '-queue',
        },
    };
    const proof: GateProof = {
        schema: 1,
        sourceCommit: config.sourceCommit,
        sourceBaseCommit: '2'.repeat(40),
        dockerDaemonId: config.dockerDaemonId,
        environmentVersion: config.environmentVersion,
        adapterManifestSha256: adapterSha,
        sourceTreeSha256: 'a'.repeat(64),
        hostConfigSha256: 'b'.repeat(64),
        lockSha256: 'd'.repeat(64),
        dockerfileSha256: 'f'.repeat(64),
        builtAt: '2026-11-23T00:00:00Z',
        controlBinarySha256: 'e'.repeat(64),
        platform: 'linux/amd64',
        orchestratorImageId: 'sha256:' + 'e'.repeat(64),
        workerImageId: image,
        runtimeImageId: image,
        checks: {
            linuxImports: true,
            helpers: true,
            native: true,
            officialLifecycle: true,
            sameNameRecreate: true,
        },
    };
    return { config, proof };
}
test('both plans put gate and closure before any state restoration or report', () => {
    for (const mode of ['restart', 'restore'] as const) {
        const plan = executionPlan(mode);
        assert.equal(plan[0], 'verify_gate');
        assert(plan.indexOf('close_source') > plan.indexOf('first_run'));
        assert(
            plan.indexOf('publish_report') >
                plan.indexOf('cleanup_owned_resources'),
        );
        assert(
            plan.indexOf('continue_session') > plan.indexOf('replay_original'),
        );
        if (mode === 'restore') {
            assert(
                plan.indexOf('backup_four_databases') <
                    plan.indexOf('backup_and_preserve_volume'),
            );
            assert(
                plan.indexOf('backup_and_preserve_volume') <
                    plan.indexOf('restore_workspace'),
            );
            assert(
                plan.indexOf('confirm_binding') >
                    plan.indexOf('restore_workspace'),
            );
        } else assert(!plan.includes('restore_workspace'));
    }
});
for (const key of [
    'linuxImports',
    'helpers',
    'native',
    'officialLifecycle',
    'sameNameRecreate',
] as const)
    test('real gate rejects missing capability: ' + key, () => {
        const { config, proof } = inputs();
        const bad = structuredClone(proof);
        Object.assign(bad.checks, { [key]: false });
        assert.throws(
            () => validateGate(config, bad, adapterSha),
            /^Error: t0_remote_incomplete$/,
        );
    });
test('real gate rejects changed source, image, daemon and adapter identities', () => {
    for (const change of [
        { sourceCommit: '3'.repeat(40) },
        { sourceBaseCommit: 'pending-other-task' },
        { dockerDaemonId: 'other' },
        { workerImageId: 'sha256:' + 'f'.repeat(64) },
        { adapterManifestSha256: 'f'.repeat(64) },
        { orchestratorImageId: 'pending-build' },
        { builtAt: '2026-11-23' },
        { sourceTreeSha256: '' },
        { hostConfigSha256: '' },
    ]) {
        const { config, proof } = inputs();
        assert.throws(() =>
            validateGate(config, { ...proof, ...change }, adapterSha),
        );
    }
    const { config, proof } = inputs();
    validateGate(config, proof, adapterSha); // Shape validation only; never runCase or a CaseReport.
});
test('CLI rejects missing configuration and unsupported case without launching a suite', () => {
    const path = fileURLToPath(new URL('./run.mjs', import.meta.url));
    const env = { ...process.env };
    delete env.BENTO_A7_CONFIG;
    for (const args of [[], ['--case', 'restart'], ['--case', 'fixture']])
        assert.throws(
            () =>
                execFileSync(process.execPath, [path, ...args], {
                    env,
                    stdio: 'pipe',
                }),
            (error) =>
                typeof error === 'object' &&
                error !== null &&
                'status' in error &&
                error.status === 2,
        );
});
test('invalid private proof is rejected before state directories or a report exist', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'bento-a7-driver-'));
    try {
        const root = join(temporary, caseId);
        await mkdir(root);
        const { config, proof } = inputs(root);
        await writeFile(config.adapterManifest, '{}', { mode: 0o600 });
        proof.adapterManifestSha256 = createHash('sha256')
            .update('{}')
            .digest('hex');
        Object.assign(proof.checks, { sameNameRecreate: false });
        await writeFile(config.gateProof, JSON.stringify(proof), {
            mode: 0o600,
        });
        const path = join(root, 'case.json');
        await writeFile(path, JSON.stringify(config), { mode: 0o600 });
        await assert.rejects(loadCase(path), /^Error: t0_remote_incomplete$/);
        for (const name of ['source', 'restore', 'evidence'])
            await assert.rejects(readFile(join(root, name, 'report.json')), {
                code: 'ENOENT',
            });
    } finally {
        await rm(temporary, { recursive: true, force: true });
    }
});
test('four-database restore stages three ledgers separately from Temporal without source writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bento-a7-layout-'));
    try {
        const source = join(root, 'source'),
            archive = join(root, 'backup'),
            target = join(root, 'restore'),
            temporal = join(root, 'temporal');
        await mkdir(source);
        await mkdir(archive);
        const names = [
            'business.sqlite',
            'authority.sqlite',
            'history.sqlite',
            'temporal.sqlite',
        ];
        for (const name of names) {
            const db = new DatabaseSync(join(source, name));
            db.exec('CREATE TABLE proof(value TEXT)');
            db.prepare('INSERT INTO proof VALUES(?)').run(name);
            db.close();
        }
        const digest = async (path: string) =>
            createHash('sha256')
                .update(await readFile(path))
                .digest('hex');
        const before = await Promise.all(
            names.map((name) => digest(join(source, name))),
        );
        const members = [];
        for (const name of names)
            members.push(
                await backupSqlite(join(source, name), join(archive, name)),
            );
        await restoreDatabaseLayout(archive, target, temporal, members);
        assert.deepEqual(
            (await readdir(target)).sort(),
            names.filter((name) => name !== 'temporal.sqlite').sort(),
        );
        assert.deepEqual(await readdir(temporal), ['temporal.sqlite']);
        assertSameLedger(await readLedger(source), await readLedger(target));
        assert.equal(
            await digest(join(temporal, 'temporal.sqlite')),
            members.find((member) => member.owner === 'temporal')!.sha256,
        );
        assert.deepEqual(
            await Promise.all(names.map((name) => digest(join(source, name)))),
            before,
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
test('history continuation requires unchanged original events and receipts plus real suffix', () => {
    const before: Ledger = {
        'history.sqlite/events': [
            {
                seq: { type: 'integer', value: '0' },
                event: { type: 'text', value: 'original' },
            },
        ],
        'history.sqlite/batch_receipts': [
            { batch: { type: 'text', value: 'first' } },
        ],
    };
    const after = structuredClone(before);
    after['history.sqlite/events'] = [
        ...after['history.sqlite/events']!,
        {
            seq: { type: 'integer', value: '1' },
            event: { type: 'text', value: 'next' },
        },
    ];
    after['history.sqlite/batch_receipts'] = [
        ...after['history.sqlite/batch_receipts']!,
        { batch: { type: 'text', value: 'second' } },
    ];
    assertHistoryPreserved(before, after);
    assert.throws(() => assertHistoryPreserved(before, before));
    const changed = structuredClone(after);
    changed['history.sqlite/events'] = [
        { event: 'replaced' },
        ...changed['history.sqlite/events']!.slice(1),
    ];
    assert.throws(() => assertHistoryPreserved(before, changed));
});
test('host lifecycle gets real authority generation and nullable state from canonical ledger', () => {
    const binding: Binding = {
        tenant: 'owner',
        project: 'project',
        session: 'session',
        sandbox: 'sandbox',
        volume: 'volume',
    };
    const text = (value: string) => ({ type: 'text', value });
    const ledger: Ledger = {
        'authority.sqlite/execution_sessions': [
            {
                tenant: text('owner'),
                project: text('project'),
                session: text('session'),
                sandbox: text('sandbox'),
                volume: text('volume'),
                generation: { type: 'integer', value: '7' },
                state: text('READY'),
                run: { type: 'null', value: null },
                expires: { type: 'null', value: null },
                capability: { type: 'null', value: null },
            },
        ],
    };
    const snapshot = authoritySnapshot(ledger, binding);
    assert.equal(snapshot.generation, 7);
    assert.equal(snapshot.run, null);
    assert.equal(snapshot.expires, null);
    assert.equal(snapshot.hasCapability, false);
    assert.throws(() =>
        authoritySnapshot(ledger, { ...binding, sandbox: 'other' }),
    );
});

test('the same order guard used by runCase rejects early report and skipped preservation', () => {
    const early = enforceOrder('restore');
    assert.throws(() => early('publish_report'), /^Error: case_phase_order$/);
    const plan = executionPlan('restore');
    const enter = enforceOrder('restore');
    for (const phase of plan.slice(
        0,
        plan.indexOf('backup_and_preserve_volume'),
    ))
        enter(phase);
    assert.throws(
        () => enter('restore_workspace'),
        /^Error: case_phase_order$/,
    );
    const complete = enforceOrder('restart');
    for (const phase of executionPlan('restart')) complete(phase);
    assert.throws(
        () => complete('publish_report'),
        /^Error: case_phase_order$/,
    );
});

test('execution proof rejects changed live source, host wiring and private adapter outputs before admission', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'bento-a7-identity-'));
    const root = join(temporary, caseId),
        tree = join(temporary, 'runtime');
    await mkdir(root);
    await mkdir(tree);
    const { config, proof } = inputs(root);
    config.adapterManifest = join(tree, 'adapter.json');
    const digest = (s: string) => createHash('sha256').update(s).digest('hex');
    const files: Record<string, string> = {
        'apps/orchestrator/service.ts': 'export const service = 1;',
        'apps/worker/src/worker.ts': 'export const worker = 1;',
        'shared/value.ts': 'export const value = 1;',
        'register-paths.mjs': '// loader',
        'package.json': '{}',
        'pnpm-lock.yaml': 'lock',
        'deploy/orchestrator/Dockerfile': 'FROM scratch',
    };
    try {
        for (const [path, body] of Object.entries(files)) {
            await mkdir(join(tree, path, '..'), { recursive: true });
            await writeFile(join(tree, path), body);
        }
        const names = [
            'a7-bootstrap.ts',
            'host-daemon.mjs',
            'worker-loopback.mjs',
            'base.candidate.ts',
            'model-relay.mjs',
            'volume-io.mjs',
        ];
        for (const name of names) await writeFile(join(tree, name), name);
        await writeFile(config.hostConfig, '{}');
        const manifest = JSON.stringify({
            schema: 1,
            outputs: names
                .slice(0, 3)
                .map((path) => ({ path, sha256: digest(path) })),
            sources: [{ role: 'base', sha256: digest('base.candidate.ts') }],
            sharedSources: Object.fromEntries(
                names.slice(4).map((name) => [name, digest(name)]),
            ),
        });
        await writeFile(config.adapterManifest, manifest, { mode: 0o600 });
        Object.assign(proof, {
            sourceTreeSha256: await executionSourceDigest(tree),
            lockSha256: digest('lock'),
            dockerfileSha256: digest('FROM scratch'),
            adapterManifestSha256: digest(manifest),
            hostConfigSha256: digest('{}'),
        });
        await verifyExecutionInputs(config, proof, tree);
        const originalManifest = config.adapterManifest;
        config.adapterManifest = join(root, 'adapter.json');
        await writeFile(config.adapterManifest, manifest, { mode: 0o600 });
        await assert.rejects(
            verifyExecutionInputs(config, proof, tree),
            /adapter_source_tree_mismatch/,
        );
        config.adapterManifest = originalManifest;
        for (const [path, body] of Object.entries(files)) {
            await writeFile(join(tree, path), body + '// changed');
            await assert.rejects(
                verifyExecutionInputs(config, proof, tree),
                /execution_source_mismatch/,
            );
            await writeFile(join(tree, path), body);
        }
        await writeFile(
            join(tree, 'apps/worker/src/added.ts'),
            'export const added = 1;',
        );
        await assert.rejects(
            verifyExecutionInputs(config, proof, tree),
            /execution_source_mismatch/,
        );
        await rm(join(tree, 'apps/worker/src/added.ts'));
        await writeFile(config.hostConfig, '{"changed":true}');
        await assert.rejects(
            verifyExecutionInputs(config, proof, tree),
            /host_config_identity_mismatch/,
        );
        await writeFile(config.hostConfig, '{}');
        for (const name of names) {
            await writeFile(join(tree, name), name + '// changed');
            await assert.rejects(
                verifyExecutionInputs(config, proof, tree),
                /adapter_output_identity_mismatch/,
            );
            await writeFile(join(tree, name), name);
        }
        await verifyExecutionInputs(config, proof, tree);
        for (const name of ['source', 'restore', 'evidence'])
            await assert.rejects(readdir(join(root, name)), { code: 'ENOENT' });
    } finally {
        await rm(temporary, { recursive: true, force: true });
    }
});
