import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadCase, runCase, type Mode } from './driver.ts';
const mode = process.env.BENTO_A7_CASE;
if (mode !== 'restart' && mode !== 'restore')
    throw new Error('Explicit real A7 case required');
// Register exactly the requested real case: unavailable prerequisites fail, never skip.
test(
    mode === 'restore'
        ? 'A7-01 real stopped backup restore'
        : 'A7-02 real execution process restart',
    async () => {
        const path = process.env.BENTO_A7_CONFIG;
        assert(path, 'Explicit private deployment config required');
        const { config, proof } = await loadCase(path);
        const report = await runCase(config, proof, mode as Mode);
        assert(
            report.assertions.length >= 8 &&
                report.assertions.every((item) => item.passed),
        );
        assert.equal(report.rpo.lostAcknowledgedRecords, 0);
        assert(report.rto.milliseconds > 0);
        assert(
            report.cleanup.sourceStopped &&
                report.cleanup.restoredStopped &&
                report.cleanup.ownedResourcesOnly,
        );
    },
);
