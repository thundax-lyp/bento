import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { isAbsolute, join, resolve } from 'node:path';
import { readFile, lstat, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

type RunInput = { taskId: string; runId: string };
type Phase = 'preparing' | 'workspace_restored' | 'history_restored';
export type A12Writes = {
    attempts: number;
    restoreWrites: number;
    admissions: number;
    workerCreations: number;
    volumeSha256: string;
    historySha256: string;
    checkpointWorkspaceSha256: string | null;
    checkpointHistorySha256: string | null;
    workspaceCheckpointValid: boolean;
    historyCheckpointValid: boolean;
    phase: Phase | 'blocked' | 'queued' | 'closed' | null;
    lastConfirmedPhase: Phase | null;
    sdkWriteDenied: boolean;
    sessionWriteDenied: boolean;
};
type Inputs = {
    holdExit: { taskId: string };
    provePartial: RunInput;
    releaseExit: RunInput;
    inspectBeforeAdmit: RunInput & { retryRunId: string };
    inspectWrites: RunInput;
    armRestore: RunInput;
    waitRestore: RunInput;
    releaseRestore: RunInput;
    invalidateCheckpoint: RunInput & {
        checkpoint: 'workspace' | 'history';
        fault: 'missing' | 'corrupt';
        attemptId: string | null;
    };
};
type Outputs = {
    holdExit: { held: true };
    provePartial: { workspaceFsynced: true; historyCommitted: true };
    releaseExit: {
        verifiedExit: true;
        revoked: true;
        sdkWriteDenied: true;
        sessionWriteDenied: true;
    };
    inspectBeforeAdmit: {
        attemptId: string;
        workspaceCheckpointSha256: string;
        workspaceActualSha256: string;
        historyCheckpointSha256: string;
        historyActualSha256: string;
        workspaceMatches: true;
        historyMatches: true;
        priorPreserved: true;
        partialRemoved: true;
        historyPrefixPreserved: true;
        historySuffixRemoved: true;
        admitWasHeld: true;
    };
    inspectWrites: A12Writes;
    armRestore: { armed: true };
    waitRestore: { held: true; attemptId: string; newRunId: string };
    releaseRestore: { released: true; attemptId: string };
    invalidateCheckpoint: { rows: 1; stopProof: true };
};
const inputFields: Record<keyof Inputs, readonly string[]> = {
    holdExit: ['taskId'],
    provePartial: ['taskId', 'runId'],
    releaseExit: ['taskId', 'runId'],
    inspectBeforeAdmit: ['taskId', 'runId', 'retryRunId'],
    inspectWrites: ['taskId', 'runId'],
    armRestore: ['taskId', 'runId'],
    waitRestore: ['taskId', 'runId'],
    releaseRestore: ['taskId', 'runId'],
    invalidateCheckpoint: [
        'taskId',
        'runId',
        'checkpoint',
        'fault',
        'attemptId',
    ],
};
const schemas: Record<keyof Inputs, Record<string, string>> = {
    holdExit: { held: 'true' },
    provePartial: { workspaceFsynced: 'true', historyCommitted: 'true' },
    releaseExit: {
        verifiedExit: 'true',
        revoked: 'true',
        sdkWriteDenied: 'true',
        sessionWriteDenied: 'true',
    },
    inspectBeforeAdmit: {
        attemptId: 'uuid',
        workspaceCheckpointSha256: 'digest',
        workspaceActualSha256: 'digest',
        historyCheckpointSha256: 'digest',
        historyActualSha256: 'digest',
        workspaceMatches: 'true',
        historyMatches: 'true',
        priorPreserved: 'true',
        partialRemoved: 'true',
        historyPrefixPreserved: 'true',
        historySuffixRemoved: 'true',
        admitWasHeld: 'true',
    },
    inspectWrites: {
        attempts: 'count',
        restoreWrites: 'count',
        admissions: 'count',
        workerCreations: 'count',
        volumeSha256: 'digest',
        historySha256: 'digest',
        checkpointWorkspaceSha256: 'nullableDigest',
        checkpointHistorySha256: 'nullableDigest',
        workspaceCheckpointValid: 'boolean',
        historyCheckpointValid: 'boolean',
        phase: 'phase',
        lastConfirmedPhase: 'confirmedPhase',
        sdkWriteDenied: 'boolean',
        sessionWriteDenied: 'boolean',
    },
    armRestore: { armed: 'true' },
    waitRestore: { held: 'true', attemptId: 'uuid', newRunId: 'uuid' },
    releaseRestore: { released: 'true', attemptId: 'uuid' },
    invalidateCheckpoint: { rows: 'one', stopProof: 'true' },
};
const uuid =
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const exec = promisify(execFile);
function record(value: unknown): Record<string, unknown> {
    assert(value && typeof value === 'object' && !Array.isArray(value));
    return value as Record<string, unknown>;
}
async function nativeConnection() {
    const entry = process.env.BENTO_WEB_A12_BROWSER_HOOK;
    const lease = process.env.BENTO_WEB_A12_LEASE_FILE;
    assert(entry && lease && isAbsolute(entry) && isAbsolute(lease));
    assert(lease.endsWith('/.bento-web-a12-r6/registry/lease.json'));
    assert.equal(await realpath(lease), lease);
    const st = await lstat(lease);
    assert(
        st.isFile() &&
            st.uid === process.getuid?.() &&
            (st.mode & 0o777) === 0o600 &&
            st.nlink === 1,
    );
    const bytes = await readFile(lease);
    assert.equal(
        createHash('sha256').update(bytes).digest('hex'),
        'e06ed2996c52d1fb4030a0c8a021f2bf3b6cafdca6c056b898e6dcfcef35f983',
    );
    const binding = JSON.parse(bytes.toString()) as {
        leaseId: string;
        lockedCommit: string;
        stateDir: string;
    };
    assert.equal(binding.leaseId, 'a6fdb0ab-6614-4ede-9c35-02fd79774a59');
    assert.equal(
        binding.lockedCommit,
        '640bc24ff1adcd3f9b7a7b8a1eb02fb197b92e88',
    );
    assert.equal(resolve(binding.stateDir, '../../registry/lease.json'), lease);
    assert.equal(
        entry,
        join(binding.stateDir, 'archive/debug-workspace/web-a12/hook.mjs'),
    );
    assert.equal(
        createHash('sha256')
            .update(await readFile(entry))
            .digest('hex'),
        'e342eb64f164be486cff04bfc9bf5c50392e8bd665a14423ffd1a71506bdf171',
    );
    return {
        entry,
        lease,
        registration: join(binding.stateDir, 'archive/register-paths.mjs'),
        env: {
            PATH: '/usr/local/bin:/usr/bin:/bin',
            HOME: resolve(binding.stateDir, '../../..'),
            NODE_NO_WARNINGS: '1',
            NODE_OPTIONS:
                '--import=' + join(binding.stateDir, 'private/resolve-a12.mjs'),
            NODE_EXTRA_CA_CERTS: join(
                binding.stateDir,
                'private/foundation/tls/ca.crt',
            ),
        },
    };
}
export async function recordA12BrowserEvidence(
    value: Record<string, unknown>,
): Promise<void> {
    const connection = await nativeConnection();
    const payload = JSON.stringify(value);
    assert(Buffer.byteLength(payload) <= 16384);
    const code =
        'const {recordBrowserEvidence}=await import(process.argv[1]);await recordBrowserEvidence(process.argv[2],JSON.parse(process.argv[3]));';
    const { stdout } = await exec(
        process.execPath,
        [
            '--import',
            connection.registration,
            '--experimental-strip-types',
            '--input-type=module',
            '-e',
            code,
            pathToFileURL(connection.entry).href,
            connection.lease,
            payload,
        ],
        { timeout: 30000, maxBuffer: 16 * 1024, env: connection.env },
    );
    assert.equal(stdout, '');
}

export async function callA12Hook<A extends keyof Inputs>(
    action: A,
    input: Inputs[A],
): Promise<Outputs[A]> {
    try {
        assert.deepEqual(
            Object.keys(input).sort(),
            [...inputFields[action]].sort(),
        );
        for (const [name, value] of Object.entries(input)) {
            if (name === 'checkpoint')
                assert(value === 'workspace' || value === 'history');
            else if (name === 'fault')
                assert(value === 'missing' || value === 'corrupt');
            else if (name === 'attemptId' && value === null) continue;
            else assert(typeof value === 'string' && uuid.test(value));
        }
        const connection = await nativeConnection();
        const { entry, lease } = connection;
        const { stdout } = await exec(
            process.execPath,
            [
                '--import',
                connection.registration,
                '--experimental-strip-types',
                entry,
                lease,
                action,
                JSON.stringify(input),
            ],
            {
                timeout: 30_000,
                maxBuffer: 16 * 1024,
                env: connection.env,
            },
        );
        const reply = record(JSON.parse(stdout));
        assert.deepEqual(
            Object.keys(reply).sort(),
            ['ok', 'action', 'input', 'evidence'].sort(),
        );
        assert.equal(reply.ok, true);
        assert.equal(reply.action, action);
        assert.deepEqual(reply.input, input);
        const value: unknown = reply.evidence;
        const evidence = record(value);
        assert.deepEqual(
            Object.keys(evidence).sort(),
            Object.keys(schemas[action]).sort(),
        );
        for (const [name, type] of Object.entries(schemas[action])) {
            const v = evidence[name];
            if (type === 'true') assert.equal(v, true);
            else if (type === 'one') assert.equal(v, 1);
            else if (type === 'count')
                assert(
                    typeof v === 'number' && Number.isSafeInteger(v) && v >= 0,
                );
            else if (type === 'boolean') assert.equal(typeof v, 'boolean');
            else if (type === 'uuid')
                assert(typeof v === 'string' && uuid.test(v));
            else if (
                type === 'digest' ||
                (type === 'nullableDigest' && v !== null)
            )
                assert(typeof v === 'string' && digest.test(v));
            else if (type === 'nullableDigest') assert.equal(v, null);
            else if (type === 'phase')
                assert(
                    v === null ||
                        [
                            'preparing',
                            'workspace_restored',
                            'history_restored',
                            'blocked',
                            'queued',
                            'closed',
                        ].includes(String(v)),
                );
            else if (type === 'confirmedPhase')
                assert(
                    v === null ||
                        [
                            'preparing',
                            'workspace_restored',
                            'history_restored',
                        ].includes(String(v)),
                );
            else assert.fail('Unknown evidence field');
        }
        return value as Outputs[A];
    } catch {
        throw new Error('A12_BROWSER_HOOK_REJECTED');
    }
}
