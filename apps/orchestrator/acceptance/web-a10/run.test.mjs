import assert from 'node:assert/strict';
import test from 'node:test';
import { assertCandidatePaths } from './run.mjs';

const spec = 'apps/workspace/workspace-web/acceptance/web-a10.spec.ts';

test('accepts a candidate with no changed paths', () => {
    assert.doesNotThrow(() => assertCandidatePaths([]));
});

test('accepts an individual approved candidate path', () => {
    assert.doesNotThrow(() => assertCandidatePaths([spec]));
});

test('rejects an unapproved path even alongside an approved path', () => {
    assert.throws(
        () => assertCandidatePaths([spec, 'deploy/compose.yaml']),
        /Unapproved candidate path: deploy\/compose\.yaml/,
    );
});
