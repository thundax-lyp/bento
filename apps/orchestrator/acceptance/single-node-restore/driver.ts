import { createHash } from 'node:crypto';
import {
    lstat,
    mkdir,
    open,
    readFile,
    rename,
    writeFile,
} from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { commandHost } from '@/apps/orchestrator/src/execution-service/command-host.ts';
import { acquireTemporal } from '@/apps/orchestrator/acceptance/temporal-retry/tool.ts';
import {
    freePort,
    startServer,
    type TemporalServer,
} from '@/apps/orchestrator/acceptance/temporal-retry/process.ts';
import type { Binding } from '@/apps/worker/protocol.ts';
import { startAcceptanceHost } from './host.ts';
import {
    backupSqlite,
    restoreSqlite,
    verifyBackup,
    type BackupMember,
} from './backup.ts';
import {
    assertSameLedger,
    lostAcknowledgedRecords,
    readLedger,
    reportJson,
    type CaseReport,
    type Ledger,
} from './audit.ts';
import {
    backupWorkspace,
    execute,
    inventoryVolume,
    restoreWorkspace,
    validateConfig,
    type A7Config,
} from './resources.ts';

export type Mode = 'restart' | 'restore';
export type CaseConfig = A7Config & {
    sourceCommit: string;
    environmentVersion: string;
    serviceTokenFile: string;
    controlBinary: string;
    gateProof: string;
    temporal: { namespace: string; taskQueue: string };
};
export type GateProof = {
    schema: 1;
    sourceCommit: string;
    aIntegratedCommit: string;
    dockerDaemonId: string;
    environmentVersion: string;
    adapterManifestSha256: string;
    lockSha256: string;
    dockerfileSha256: string;
    builtAt: string;
    controlBinarySha256: string;
    platform: 'linux/amd64';
    orchestratorImageId: string;
    workerImageId: string;
    runtimeImageId: string;
    checks: {
        linuxImports: true;
        helpers: true;
        native: true;
        officialLifecycle: true;
        sameNameRecreate: true;
    };
};
const hash = (value: Uint8Array | string) =>
    createHash('sha256').update(value).digest('hex');
const fail: (code: string) => never = (code) => {
    throw new Error(code);
};
export const prompts = [
    'Read README.md, then create a7-proof.txt containing exactly "a7-first\\n" (one newline). Do not change other files.',
    'Read a7-proof.txt and confirm its current content, then set it to exactly "a7-first\\na7-second\\n" (two lines). Do not change other files.',
] as const;
export function executionPlan(mode: Mode): readonly string[] {
    return [
        'verify_gate',
        'exclusive_state',
        'start_temporal',
        'start_source',
        'first_run',
        'close_source',
        'stop_workspace',
        ...(mode === 'restore'
            ? [
                  'close_temporal',
                  'backup_four_databases',
                  'backup_and_preserve_volume',
                  'restore_empty_state',
                  'restore_workspace',
                  'reopen_temporal',
              ]
            : []),
        'confirm_binding',
        'reopen_host',
        'replay_original',
        'continue_session',
        'close_restored',
        'verify_history_and_files',
        'cleanup_owned_resources',
        'publish_report',
    ];
}
export function enforceOrder(mode: Mode) {
    const plan = executionPlan(mode);
    let index = 0;
    return (phase: string) => {
        if (plan[index] !== phase) fail('case_phase_order');
        index++;
    };
}
function same(a: unknown, b: unknown, code: string) {
    if (JSON.stringify(a) !== JSON.stringify(b)) fail(code);
}
export function validateGate(
    config: CaseConfig,
    proof: GateProof,
    adapterSha: string,
): void {
    validateConfig(config);
    if (
        !/^[a-f0-9]{40}$/.test(config.sourceCommit) ||
        basename(config.root) !== config.caseId ||
        !isAbsolute(config.gateProof) ||
        !isAbsolute(config.serviceTokenFile) ||
        !isAbsolute(config.controlBinary) ||
        !/^sha256:[a-f0-9]{64}$/.test(config.environmentVersion) ||
        !config.temporal?.namespace.startsWith(config.caseId) ||
        !config.temporal.taskQueue.startsWith(config.caseId)
    )
        fail('case_config_invalid');
    if (
        proof.schema !== 1 ||
        proof.sourceCommit !== config.sourceCommit ||
        !/^[a-f0-9]{40}$/.test(proof.aIntegratedCommit) ||
        proof.dockerDaemonId !== config.dockerDaemonId ||
        proof.environmentVersion !== config.environmentVersion ||
        proof.adapterManifestSha256 !== adapterSha ||
        !/^[a-f0-9]{64}$/.test(proof.lockSha256) ||
        !/^[a-f0-9]{64}$/.test(proof.dockerfileSha256) ||
        typeof proof.builtAt !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(proof.builtAt) ||
        !Number.isFinite(Date.parse(proof.builtAt)) ||
        !/^[a-f0-9]{64}$/.test(proof.controlBinarySha256) ||
        proof.platform !== 'linux/amd64' ||
        proof.workerImageId !== config.workerImageId ||
        proof.runtimeImageId !== config.runtimeImageId ||
        !/^sha256:[a-f0-9]{64}$/.test(proof.orchestratorImageId)
    )
        fail('t0_remote_proof_invalid');
    for (const key of [
        'linuxImports',
        'helpers',
        'native',
        'officialLifecycle',
        'sameNameRecreate',
    ] as const)
        if (proof.checks?.[key] !== true) fail('t0_remote_incomplete');
}
async function privateJson(path: string) {
    const stat = await lstat(path);
    if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        (stat.mode & 0o077) !== 0 ||
        stat.size > 1024 * 1024
    )
        fail('private_input_invalid');
    return JSON.parse(await readFile(path, 'utf8'));
}
export async function loadCase(
    path: string,
): Promise<{ config: CaseConfig; proof: GateProof }> {
    if (!isAbsolute(path)) fail('case_config_absolute_required');
    const config = (await privateJson(path)) as CaseConfig;
    const proof = (await privateJson(config.gateProof)) as GateProof;
    validateGate(config, proof, hash(await readFile(config.adapterManifest)));
    return { config, proof };
}
async function verifyRuntime(config: CaseConfig, proof: GateProof) {
    const control = await lstat(config.controlBinary);
    if (
        !control.isFile() ||
        control.isSymbolicLink() ||
        !(control.mode & 0o111) ||
        hash(await readFile(config.controlBinary)) !== proof.controlBinarySha256
    )
        fail('control_binary_identity_mismatch');
    if (
        (await execute('docker', ['info', '--format', '{{.ID}}'])) !==
        config.dockerDaemonId
    )
        fail('runtime_daemon_mismatch');
    for (const id of [
        proof.orchestratorImageId,
        config.workerImageId,
        config.runtimeImageId,
    ]) {
        const [image] = JSON.parse(
            await execute('docker', ['image', 'inspect', id]),
        );
        if (
            image.Id !== id ||
            image.Os !== 'linux' ||
            image.Architecture !== 'amd64'
        )
            fail('runtime_image_mismatch');
        if (
            id !== config.runtimeImageId &&
            image.Config?.Labels?.['org.opencontainers.image.revision'] !==
                config.sourceCommit
        )
            fail('runtime_source_mismatch');
    }
}
type HttpResult = {
    status: number;
    body: Record<string, unknown>;
    text: string;
};
async function request(
    url: string,
    token: string,
    owner: string,
    path: string,
    method = 'GET',
    body?: unknown,
    key?: string,
): Promise<HttpResult> {
    const response = await fetch(url + '/v1/projects' + path, {
        method,
        headers: {
            authorization: 'Bearer ' + token,
            'x-bento-owner-id': owner,
            ...(body === undefined
                ? {}
                : { 'content-type': 'application/json' }),
            ...(key ? { 'idempotency-key': key } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(5000),
    });
    const text = await response.text();
    return {
        status: response.status,
        body: response.headers.get('content-type')?.includes('json')
            ? JSON.parse(text)
            : {},
        text,
    };
}
async function until<T>(
    action: () => Promise<T>,
    ready: (value: T) => boolean,
    timeout = 180000,
): Promise<T> {
    const end = performance.now() + timeout;
    do {
        const value = await action();
        if (ready(value)) return value;
        await new Promise((resolve) => setTimeout(resolve, 100));
    } while (performance.now() < end);
    return fail('case_phase_timeout');
}
function value(row: Record<string, unknown>, key: string): string {
    const cell = row[key] as { type?: string; value?: unknown } | undefined;
    if (cell?.type !== 'text' || typeof cell.value !== 'string')
        return fail('ledger_binding_invalid');
    return cell.value;
}
type AuthoritySnapshot = Parameters<
    Awaited<ReturnType<typeof commandHost>>['stop']
>[0];
export function authoritySnapshot(
    ledger: Ledger,
    binding: Binding,
): AuthoritySnapshot {
    const row = ledger['authority.sqlite/execution_sessions']?.find(
        (row) => value(row, 'session') === binding.session,
    );
    if (!row) return fail('authority_binding_missing');
    for (const key of ['tenant', 'project', 'sandbox', 'volume'] as const)
        if (value(row, key) !== binding[key])
            fail('authority_binding_mismatch');
    const integer = (key: string, nullable = false): number | null => {
        const cell = row[key] as { type: string; value: unknown };
        if (nullable && cell.type === 'null') return null;
        if (cell.type !== 'integer' || typeof cell.value !== 'string')
            return fail('authority_integer_invalid');
        const number = Number(cell.value);
        if (!Number.isSafeInteger(number))
            return fail('authority_integer_invalid');
        return number;
    };
    const run = row.run as { type: string; value: unknown },
        capability = row.capability as { type: string; value: unknown };
    return {
        ...binding,
        generation: integer('generation')!,
        state: value(row, 'state'),
        run: run.type === 'null' ? null : value(row, 'run'),
        expires: integer('expires', true),
        hasCapability: capability.type !== 'null',
    };
}
function runIds(ledger: Ledger): string[] {
    return (ledger['business.sqlite/runs'] ?? []).map((row) =>
        value(row, 'id'),
    );
}
function projectBinding(ledger: Ledger, id: string): Binding {
    const row = ledger['business.sqlite/projects']?.find(
        (row) => value(row, 'id') === id,
    );
    if (!row) return fail('project_binding_missing');
    return {
        tenant: value(row, 'owner'),
        project: id,
        session: value(row, 'sessionId'),
        sandbox: value(row, 'sandbox'),
        volume: value(row, 'volume'),
    };
}
export function assertHistoryPreserved(before: Ledger, after: Ledger) {
    for (const table of ['events', 'batch_receipts']) {
        const key = 'history.sqlite/' + table;
        const first = before[key] ?? [],
            second = after[key] ?? [];
        if (!first.length || second.length <= first.length)
            fail('history_not_continued');
        const rows = new Set(second.map((row) => JSON.stringify(row)));
        if (first.some((row) => !rows.has(JSON.stringify(row))))
            fail('original_history_changed');
    }
}
export async function restoreDatabaseLayout(
    archive: string,
    target: string,
    temporal: string,
    members: readonly BackupMember[],
) {
    if (members.length !== 4) fail('four_databases_required');
    await restoreSqlite(archive, target, members);
    await mkdir(temporal, { mode: 0o700 });
    await rename(
        join(target, 'temporal.sqlite'),
        join(temporal, 'temporal.sqlite'),
    );
    await verifyBackup(
        target,
        members.filter((member) => member.owner !== 'temporal'),
    );
    await verifyBackup(
        temporal,
        members.filter((member) => member.owner === 'temporal'),
    );
}
const readyScript = String.raw`
import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {resolve,dirname} from 'node:path';import {pathToFileURL} from 'node:url';
try{const [file,module,name,owner]=process.argv.slice(1);const c=JSON.parse(await readFile(file,'utf8'));assert(c.workspace==='default');const {SandboxClient}=await import(pathToFileURL(module).href);const root=dirname(file);const sdk=await SandboxClient.connect({gateway:c.gateway,caCert:await readFile(resolve(root,c.ca)),clientCert:await readFile(resolve(root,c.cert)),clientKey:await readFile(resolve(root,c.key))});const ref=await sdk.waitReady(name,60,{workspace:c.workspace});assert(ref.name===name&&ref.workspace===c.workspace&&ref.phase==='ready'&&ref.labels?.['bento.web08']===owner);console.log(JSON.stringify({id:ref.id,name:ref.name,workspace:ref.workspace}));process.exit(0);}catch{process.exit(1);}`;
async function confirmBinding(config: CaseConfig, binding: Binding) {
    const ref = JSON.parse(
        await execute(process.execPath, [
            '--input-type=module',
            '-e',
            readyScript,
            config.hostConfig,
            config.sdkModule,
            binding.sandbox,
            config.caseId,
        ]),
    );
    const ids = (
        await execute('docker', [
            'ps',
            '-aq',
            '--no-trunc',
            '--filter',
            'volume=' + binding.volume,
        ])
    )
        .split(/\r?\n/)
        .filter(Boolean);
    if (ids.length !== 1) fail('restored_mount_not_unique');
    const [container] = JSON.parse(
        await execute('docker', ['container', 'inspect', ids[0]!]),
    );
    const labels = container.Config?.Labels;
    const mounts = container.Mounts.filter(
        (m: { Type: string; Name: string }) =>
            m.Type === 'volume' && m.Name === binding.volume,
    );
    if (
        container.Id !== ids[0] ||
        container.Image !== config.runtimeImageId ||
        !container.State.Running ||
        labels?.['openshell.ai/sandbox-name'] !== binding.sandbox ||
        labels?.['openshell.ai/sandbox-id'] !== ref.id ||
        labels?.['openshell.ai/sandbox-workspace'] !==
            config.gatewayWorkspace ||
        labels?.['openshell.ai/sandbox-namespace'] !== config.gatewayOwner ||
        mounts.length !== 1 ||
        mounts[0].Destination !== '/sandbox/project/bento-workspace' ||
        mounts[0].RW !== true
    )
        fail('restored_binding_mismatch');
    const path = join(config.root, 'web08-manifest.json');
    const deployment = await privateJson(path);
    if (deployment.owner !== config.caseId) fail('deployment_owner_mismatch');
    const row = deployment.volumeBindings?.[binding.project];
    if (
        !row ||
        JSON.stringify(row.binding) !== JSON.stringify(binding) ||
        row.stage !== 'ready'
    )
        fail('deployment_binding_mismatch');
    row.container = container.Id;
    row.sandboxId = ref.id;
    const temporary = path + '.a7-pending';
    await writeFile(temporary, JSON.stringify(deployment) + '\n', {
        flag: 'wx',
        mode: 0o600,
    });
    const file = await open(temporary, 'r');
    try {
        await file.sync();
    } finally {
        await file.close();
    }
    await rename(temporary, path);
}
async function history(binary: string, server: TemporalServer, id: string) {
    return JSON.parse(
        await execute(binary, [
            '--disable-config-env',
            '--disable-config-file',
            '--env-file',
            join(server.directory, 'env.yaml'),
            '--address',
            server.address,
            '--namespace',
            server.namespace,
            '--output',
            'json',
            'workflow',
            'show',
            '--workflow-id',
            'bento-run-' + id,
        ]),
    );
}
export async function runCase(
    config: CaseConfig,
    proof: GateProof,
    mode: Mode,
): Promise<CaseReport> {
    const enter = enforceOrder(mode);
    enter('verify_gate');
    validateGate(config, proof, hash(await readFile(config.adapterManifest)));
    const rootStat = await lstat(config.root);
    if (
        !rootStat.isDirectory() ||
        rootStat.isSymbolicLink() ||
        (rootStat.mode & 0o077) !== 0
    )
        fail('case_root_invalid');
    await verifyRuntime(config, proof); // Before any service/volume/process creation.
    const source = join(config.root, 'source', 'state'),
        restored = join(config.root, 'restore', 'state');
    const sourceTemporal = join(config.root, 'temporal', 'source'),
        restoredTemporal = join(config.root, 'temporal', 'restore');
    enter('exclusive_state');
    for (const path of [
        join(config.root, 'source'),
        join(config.root, 'restore'),
        join(config.root, 'backup'),
        join(config.root, 'evidence'),
        join(config.root, 'temporal'),
    ])
        await mkdir(path, { mode: 0o700 });
    await mkdir(source, { mode: 0o700 });
    const signal = AbortSignal.timeout(15 * 60 * 1000);
    const tool = await acquireTemporal(join(config.root, 'tool'), signal);
    const port = await freePort();
    const tokenStat = await lstat(config.serviceTokenFile);
    if (
        !tokenStat.isFile() ||
        tokenStat.isSymbolicLink() ||
        tokenStat.nlink !== 1 ||
        (tokenStat.mode & 0o077) !== 0 ||
        tokenStat.size > 2048
    )
        fail('service_token_invalid');
    const token = (await readFile(config.serviceTokenFile, 'utf8')).trim();
    if (!/^[!-~]{32,1024}$/.test(token)) fail('service_token_invalid');
    const owner = config.caseId + '-owner';
    const trusted = await commandHost(config.hostConfig);
    let server: TemporalServer | undefined,
        service: Awaited<ReturnType<typeof startAcceptanceHost>> | undefined;
    let binding: Binding | undefined,
        success = false;
    let sourceStopped: boolean;
    let restoredStopped: boolean;
    let completed: CaseReport | undefined;
    let state = source;
    const startHost = (state: string, temporal: TemporalServer) =>
        startAcceptanceHost({
            state,
            token,
            hostConfig: config.hostConfig,
            environmentVersion: config.environmentVersion,
            temporal: {
                address: temporal.address,
                namespace: temporal.namespace,
                taskQueue: config.temporal.taskQueue,
            },
        });
    const priorControl = process.env.BENTO_GO_CONTROL;
    process.env.BENTO_GO_CONTROL = config.controlBinary;
    try {
        enter('start_temporal');
        server = await startServer(
            tool,
            sourceTemporal,
            {
                port,
                namespace: config.temporal.namespace,
                createNamespace: true,
            },
            signal,
        );
        enter('start_source');
        service = await startHost(source, server);
        const api = (
            path: string,
            method = 'GET',
            body?: unknown,
            key?: string,
            who = owner,
        ) => request(service!.url, token, who, path, method, body, key);
        enter('first_run');
        const created = await api('', 'POST', {
            name: 'A7 isolated project',
            files: [{ path: 'README.md', text: '# A7 persistent project\n' }],
        });
        if (created.status !== 201 || typeof created.body.id !== 'string')
            fail('project_create_failed');
        const project = '/' + created.body.id;
        await until(
            () => api(project),
            (r) => r.status === 200 && r.body.status === 'ready',
        );
        const firstKey = config.caseId + '-first';
        const accepted = await api(
            project + '/runs',
            'POST',
            { prompt: prompts[0] },
            firstKey,
        );
        if (accepted.status !== 202 || typeof accepted.body.id !== 'string')
            fail('first_run_not_accepted');
        const firstId = accepted.body.id,
            runPath = project + '/runs/' + firstId;
        const first = await until(
            () => api(runPath),
            (r) => {
                if (
                    ['failed', 'needs_review', 'cancelled'].includes(
                        String(r.body.status),
                    )
                )
                    fail('first_run_failed');
                return r.body.status === 'succeeded';
            },
        );
        const firstDiff = await api(runPath + '/diff');
        if (firstDiff.status !== 200) fail('first_diff_missing');
        const acknowledgedAt = new Date().toISOString();
        const firstHistory = await until(
            () => history(tool.binary, server!, firstId),
            (h) =>
                Array.isArray(h.events) &&
                h.events.some(
                    (e: { eventType?: string }) =>
                        e.eventType ===
                        'EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED',
                ),
        );
        const startedAt = new Date().toISOString(),
            startedTick = performance.now();
        enter('close_source');
        await service.close();
        service = undefined;
        sourceStopped = true;
        const before = await readLedger(source);
        binding = projectBinding(before, created.body.id);
        if (
            !before['history.sqlite/events']?.length ||
            !before['history.sqlite/batch_receipts']?.length ||
            (before['history.sqlite/batch_intents']?.length ?? 0) !== 0
        )
            fail('history_not_flushed');
        const sourceAuthority = authoritySnapshot(before, binding);
        enter('stop_workspace');
        await trusted.stop(sourceAuthority);
        await until(() => trusted.stopped(sourceAuthority), Boolean, 60000);
        const firstFiles = await inventoryVolume(config, binding);
        if (
            firstFiles.find((file) => file.path === 'a7-proof.txt')?.sha256 !==
            hash('a7-first\n')
        )
            fail('first_file_mismatch');
        state = source;
        if (mode === 'restore') {
            enter('close_temporal');
            await server.close();
            server = undefined;
            const archive = join(config.root, 'backup');
            enter('backup_four_databases');
            const members: BackupMember[] = [];
            for (const name of [
                'business.sqlite',
                'authority.sqlite',
                'history.sqlite',
            ])
                members.push(
                    await backupSqlite(join(source, name), join(archive, name)),
                );
            members.push(
                await backupSqlite(
                    join(sourceTemporal, 'temporal.sqlite'),
                    join(archive, 'temporal.sqlite'),
                ),
            );
            await writeFile(
                join(archive, 'manifest.json'),
                JSON.stringify({
                    schema: 1,
                    caseId: config.caseId,
                    sourceCommit: config.sourceCommit,
                    deploymentScope: 'single-execution-node-stopped',
                    environmentVersion: config.environmentVersion,
                    quiescedAt: startedAt,
                    completedAt: new Date().toISOString(),
                    members,
                }) + '\n',
                { flag: 'wx', mode: 0o600 },
            );
            enter('backup_and_preserve_volume');
            await backupWorkspace(config, binding);
            enter('restore_empty_state');
            await restoreDatabaseLayout(
                archive,
                restored,
                restoredTemporal,
                members,
            );
            assertSameLedger(before, await readLedger(restored));
            enter('restore_workspace');
            await restoreWorkspace(
                config,
                binding,
                join(archive, 'workspace.tar'),
            );
            enter('reopen_temporal');
            server = await startServer(
                tool,
                restoredTemporal,
                {
                    port,
                    namespace: config.temporal.namespace,
                    createNamespace: false,
                },
                signal,
            );
            state = restored;
        } else await trusted.start(sourceAuthority);
        enter('confirm_binding');
        await confirmBinding(config, binding);
        assertSameLedger(before, await readLedger(state));
        same(
            firstHistory,
            await history(tool.binary, server!, firstId),
            'original_workflow_changed',
        );
        enter('reopen_host');
        service = await startHost(state, server!);
        enter('replay_original');
        const replay = await api(
            project + '/runs',
            'POST',
            { prompt: prompts[0] },
            firstKey,
        );
        if (replay.status !== 200) fail('original_replay_failed');
        if (
            replay.body.id !== firstId ||
            replay.body.status !== first.body.status ||
            replay.body.sessionId !== first.body.sessionId
        )
            fail('original_replay_changed');
        same((await api(runPath)).body, first.body, 'original_run_changed');
        same(
            (await api(runPath + '/diff')).text,
            firstDiff.text,
            'original_diff_changed',
        );
        if (
            (
                await api(
                    project + '/runs',
                    'POST',
                    { prompt: prompts[1] },
                    firstKey,
                )
            ).status !== 409
        )
            fail('idempotency_conflict_missing');
        if (
            (await api(runPath, 'GET', undefined, undefined, owner + '-other'))
                .status !== 404
        )
            fail('cross_owner_visibility');
        enter('continue_session');
        const acceptedSecond = await api(
            project + '/runs',
            'POST',
            { prompt: prompts[1] },
            config.caseId + '-second',
        );
        if (
            acceptedSecond.status !== 202 ||
            typeof acceptedSecond.body.id !== 'string'
        )
            fail('continuation_not_accepted');
        if (acceptedSecond.body.sessionId !== first.body.sessionId)
            fail('session_identity_changed');
        await until(
            () => api(project + '/runs/' + acceptedSecond.body.id),
            (r) => {
                if (
                    ['failed', 'needs_review', 'cancelled'].includes(
                        String(r.body.status),
                    )
                )
                    fail('continuation_failed');
                return r.body.status === 'succeeded';
            },
        );
        same(
            (await api(runPath)).body,
            first.body,
            'original_run_changed_after_continuation',
        );
        const readyAt = new Date().toISOString(),
            milliseconds = performance.now() - startedTick;
        enter('close_restored');
        await service.close();
        service = undefined;
        restoredStopped = true;
        enter('verify_history_and_files');
        const finalAuthority = authoritySnapshot(
            await readLedger(state),
            binding,
        );
        await trusted.stop(finalAuthority);
        await until(() => trusted.stopped(finalAuthority), Boolean, 60000);
        const finalFiles = await inventoryVolume(config, binding);
        if (
            finalFiles.find((file) => file.path === 'a7-proof.txt')?.sha256 !==
            hash('a7-first\na7-second\n')
        )
            fail('continued_file_mismatch');
        const after = await readLedger(state);
        assertHistoryPreserved(before, after);
        same(
            before['business.sqlite/runs']?.find(
                (row) => value(row, 'id') === firstId,
            ),
            after['business.sqlite/runs']?.find(
                (row) => value(row, 'id') === firstId,
            ),
            'original_receipt_changed',
        );
        const lost = lostAcknowledgedRecords(runIds(before), runIds(after));
        if (lost) fail('acknowledged_run_lost');
        same(
            firstHistory,
            await history(tool.binary, server!, firstId),
            'original_workflow_reexecuted',
        );
        enter('cleanup_owned_resources');
        await server!.close();
        server = undefined;
        await trusted.purge!(binding);
        if (mode === 'restore') {
            const name = config.caseId + '-source-preserved';
            const [volume] = JSON.parse(
                await execute('docker', ['volume', 'inspect', name]),
            );
            if (
                volume.Labels?.['bento.web08'] !== config.caseId ||
                volume.Labels?.['bento.web08.project'] !== binding.project
            )
                fail('preserved_owner_mismatch');
            if (
                await execute('docker', [
                    'ps',
                    '-aq',
                    '--filter',
                    'volume=' + name,
                ])
            )
                fail('preserved_volume_attached');
            await execute('docker', ['volume', 'rm', name]);
        }
        success = true;
        completed = {
            schema: 1,
            case: mode === 'restore' ? 'A7-01' : 'A7-02',
            sourceCommit: config.sourceCommit,
            restoreCommit: config.sourceCommit,
            assertions: [
                'ledger',
                'original_receipt',
                'original_workflow',
                'session_history',
                'workspace_bytes',
                'idempotency',
                'owner_visibility',
                'continued_execution',
            ].map((name) => ({ name, passed: true })),
            rpo: {
                lastAcknowledgedAt: acknowledgedAt,
                restoredThroughAt: acknowledgedAt,
                lostAcknowledgedRecords: lost,
            },
            rto: { startedAt, readyAt, milliseconds },
            cleanup: {
                sourceStopped,
                restoredStopped,
                ownedResourcesOnly: true,
            },
        };
    } finally {
        const errors: unknown[] = [];
        if (service)
            try {
                await service.close();
            } catch (error) {
                errors.push(error);
            }
        if (server)
            try {
                await server.close();
            } catch (error) {
                errors.push(error);
            }
        if (!success && binding)
            try {
                await trusted.stop(
                    authoritySnapshot(await readLedger(state), binding),
                );
            } catch (error) {
                errors.push(error);
            }
        if (priorControl === undefined) delete process.env.BENTO_GO_CONTROL;
        else process.env.BENTO_GO_CONTROL = priorControl;
        if (errors.length) fail('case_cleanup_incomplete');
    }
    if (!completed) return fail('case_report_missing');
    enter('publish_report');
    await writeFile(
        join(config.root, 'evidence', completed.case + '.json'),
        reportJson(completed),
        { flag: 'wx', mode: 0o600 },
    );
    return completed;
}
