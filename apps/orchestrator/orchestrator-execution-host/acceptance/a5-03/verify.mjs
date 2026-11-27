import { error, log } from 'node:console';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import process from 'node:process';

const check = (condition, message) => {
    if (!condition) throw new Error(message);
};
const sha256 = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const count = (value) => Number.isSafeInteger(value) && value >= 0;

async function main() {
    const [
        leaseId,
        imageId,
        runId,
        browserPath,
        beforePath,
        afterPath,
        proofPath,
    ] = process.argv.slice(2);
    check(
        process.argv.length === 9 &&
            uuid.test(leaseId) &&
            uuid.test(runId) &&
            /^sha256:[a-f0-9]{64}$/.test(imageId),
        'Usage: node verify.mjs LEASE_ID IMAGE_ID RUN_ID BROWSER_JSON BEFORE_JSON AFTER_JSON PROOF_JSON',
    );
    const read = async (path) => JSON.parse(await readFile(path, 'utf8'));
    const [browser, before, after, physical] = await Promise.all(
        [browserPath, beforePath, afterPath, proofPath].map(read),
    );
    check(
        browser.fault?.runId === runId &&
            sha256.test(browser.fault.markerSha256) &&
            browser.fault.oldGenerationWriteDenied === true,
        'Browser evidence must identify the fault Run and marker and record old-generation write denial',
    );
    for (const snapshot of [before, after]) {
        check(
            snapshot.leaseId === leaseId &&
                snapshot.imageId === imageId &&
                snapshot.runId === runId &&
                snapshot.markerSha256 === browser.fault.markerSha256,
            'Observation does not match the lease, running image, Run and marker',
        );
        check(
            snapshot.status === 'needs_review' &&
                snapshot.receipt === 0 &&
                snapshot.workerStopped === true &&
                snapshot.workerExitCode === 137 &&
                snapshot.oldGenerationWriteDenied === true,
            'Expected needs_review, no receipt, original Worker exit and old-generation write denial',
        );
        check(
            count(snapshot.oldGeneration) &&
                snapshot.oldGeneration > 0 &&
                count(snapshot.authority?.generation) &&
                snapshot.authority.generation > snapshot.oldGeneration &&
                snapshot.authority.state === 'READY' &&
                snapshot.authority.capable === 0,
            'Expected a newer READY generation without an active capability',
        );
        check(
            snapshot.operations?.length === 1 &&
                snapshot.operations[0]?.state === 'UNKNOWN' &&
                /^sdk:[a-f0-9-]{36}$/.test(snapshot.operations[0]?.id) &&
                snapshot.operations[0].id === browser.fault.unknownOperationId,
            'Expected one UNKNOWN operation in the original generation',
        );
        check(
            count(snapshot.runCount) &&
                count(snapshot.upstreamExecRequests) &&
                snapshot.readOnlyVolumeMarkerCount === 1,
            'Expected valid counters and one independently observed volume marker',
        );
    }
    check(
        before.replayHttp === null &&
            after.replayHttp === 200 &&
            after.replayReturnedOriginal === true,
        'Expected snapshots bracketing a same-key replay that returned the original Run',
    );
    check(
        before.oldGeneration === after.oldGeneration &&
            before.operations[0].id === after.operations[0].id &&
            before.runCount === after.runCount &&
            before.upstreamExecRequests === after.upstreamExecRequests,
        'Original attempt or UNKNOWN operation changed, or replay added a Run or Exec',
    );
    check(
        physical.leaseId === leaseId &&
            physical.imageId === imageId &&
            typeof physical.canonicalJson === 'string',
        'Expected persisted proof from the same lease and image',
    );
    const proof = JSON.parse(physical.canonicalJson);
    const digest = createHash('sha256')
        .update(physical.canonicalJson)
        .digest('hex');
    const exitedAt = Date.parse(proof.workerExitedAt);
    check(
        physical.sha256 === digest &&
            proof.runId === runId &&
            proof.generation === before.oldGeneration &&
            Number.isFinite(exitedAt) &&
            Date.parse(proof.observedAt) >= exitedAt &&
            proof.sandboxStopped === true &&
            proof.volumeWriters === 0 &&
            proof.restoreIdle === true &&
            proof.grantRevoked === true,
        'Persisted proof does not establish both stops, zero writers and grant revocation for the original attempt',
    );
    log(
        JSON.stringify({
            scenario: 'A5-03',
            result: 'passed',
            leaseId,
            imageId,
            runId,
            proofSha256: digest,
            additionalRuns: 0,
            upstreamExecDelta: 0,
            markerCountBefore: 1,
            markerCountAfter: 1,
        }),
    );
}

try {
    await main();
} catch (failure) {
    // JSON parse errors can include bytes from a private input file.
    error(
        failure instanceof SyntaxError
            ? 'Invalid JSON evidence'
            : failure.message,
    );
    process.exitCode = 1;
}
