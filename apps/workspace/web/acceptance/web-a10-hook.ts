import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, realpath, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const sha = /^[a-f0-9]{64}$/;

type Action =
    | 'armQueueBarrier'
    | 'awaitQueueBarrier'
    | 'proveQueued'
    | 'releaseQueueBarrier'
    | 'armWriteFreeze'
    | 'lookupSdkUnknown'
    // Existing hook name. Inject an exit only into the frozen Run attempt.
    // Never signal host PIDs or stop or restart shared containers.
    | 'killFrozenWorker'
    | 'readRunEvidence'
    | 'releaseRetryObservation'
    | 'confirmSuccess'
    | 'confirmFailed'
    | 'closeUnconfirmed'
    | 'readClosure'
    | 'readNotifications';

async function privateBytes(path: string) {
    const info = await lstat(path);
    assert(
        info.isFile() &&
            info.uid === process.getuid?.() &&
            (info.mode & 0o777) === 0o600,
    );
    assert.equal(await realpath(path), path);
    return readFile(path);
}

type BarrierInputs = {
    armQueueBarrier: {
        caseId: string;
        aMarkerSha256: string;
        bMarkerSha256: string;
    };
    awaitQueueBarrier: { caseId: string; aRunId: string; bRunId: string };
    proveQueued: { caseId: string; cRunId: string };
    releaseQueueBarrier: { caseId: string; role: 'A' | 'B' };
    armWriteFreeze: { runId: string; markerSha256: string };
};

export async function callA10Hook<A extends Action>(
    action: A,
    input: A extends keyof BarrierInputs ? BarrierInputs[A] : { runId: string },
    timeout = 30_000,
): Promise<Record<string, boolean | number | string>> {
    try {
        for (const [key, value] of Object.entries(input)) {
            if (key.endsWith('Sha256')) assert.match(value, sha);
            else if (key === 'role') assert(value === 'A' || value === 'B');
            else assert.match(value, uuid);
        }
        const checkout = fileURLToPath(new URL('../../../..', import.meta.url));
        // Playwright may run from the frozen candidate under the same lease.
        const frozenCheckout =
            /^(.+\/bento-debug\/web-a10)\/state\/([a-f0-9-]+)\/candidate\/source$/.exec(
                checkout,
            );
        const root =
            frozenCheckout?.[1] ??
            join(dirname(checkout), 'bento-debug', 'web-a10');
        const leasePath = join(root, 'lease.json');
        assert.equal(process.env.BENTO_WEB_A10_CONFIG, leasePath);
        const lease = JSON.parse((await privateBytes(leasePath)).toString());
        assert.equal(lease.project, 'bento-worker-a-web-a10');
        assert.match(lease.leaseId, uuid);
        if (frozenCheckout) assert.equal(frozenCheckout[2], lease.leaseId);
        assert.match(lease.sourceTree, /^[a-f0-9]{40}$/);
        assert.match(lease.archiveSha256, sha);
        assert.equal(lease.leaseId, lease.composeApproval.leaseId);
        assert.equal(lease.sourceTree, lease.composeApproval.sourceTree);
        assert.equal(lease.archiveSha256, lease.composeApproval.archiveSha256);
        const entry = join(root, 'trusted-entry.mjs');
        assert.equal(lease.trustedEntryPath, entry);
        assert.equal(
            createHash('sha256')
                .update(await privateBytes(entry))
                .digest('hex'),
            lease.configSha256['trusted-entry.mjs'],
        );
        const source = join(
            root,
            'state',
            lease.leaseId,
            'candidate',
            'source',
        );
        assert.equal(await realpath(source), source);
        const { stdout } = await exec(
            process.execPath,
            [
                '--import',
                join(source, 'register-paths.mjs'),
                '--experimental-strip-types',
                entry,
                leasePath,
                action,
                JSON.stringify(input),
            ],
            { cwd: source, timeout, maxBuffer: 16 * 1024 },
        );
        const result = JSON.parse(stdout);
        assert(result && typeof result === 'object' && !Array.isArray(result));
        for (const value of Object.values(result)) {
            assert(
                typeof value === 'boolean' ||
                    (typeof value === 'number' &&
                        Number.isSafeInteger(value) &&
                        value >= 0) ||
                    (typeof value === 'string' &&
                        (sha.test(value) ||
                            uuid.test(value) ||
                            (value.startsWith('sdk:') &&
                                uuid.test(value.slice(4))))),
            );
        }
        return result;
    } catch {
        throw new Error('WEB-A10 trusted operation refused: ' + action);
    }
}
