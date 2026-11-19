import assert from 'node:assert/strict';
import console from 'node:console';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareSdk, type PreparedSdk } from './sdk.ts';

export function probeSdk(sdk: PreparedSdk): void {
    const sandbox = 'a103-sandbox';
    for (const method of [
        'GetSandbox',
        'ExecSandbox',
        'ExecSandboxInteractive',
    ] as const) {
        const bytes = sdk.encode(method, 'start', sandbox);
        assert.equal(
            bytes.length,
            method === 'GetSandbox' ? 25 : method === 'ExecSandbox' ? 31 : 32,
        );
        assert.deepEqual(sdk.decode(method, bytes), {
            sandbox,
            workspace: 'default',
            ...(method === 'ExecSandboxInteractive' ? { tty: false } : {}),
        });
    }
    const stdin = sdk.encode('ExecSandboxInteractive', 'stdin', sandbox);
    assert.equal(stdin.length, 3);
    assert.equal(sdk.decode('ExecSandboxInteractive', stdin), 'stdin');
    for (const code of [0, 17])
        assert.deepEqual(sdk.decodeExecEvent(sdk.exit(code)), {
            kind: 'exit',
            code,
        });
}

if (
    process.argv[1] &&
    resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
    const sdk = await prepareSdk();
    const root = resolve(dirname(sdk.raw), '../../..');
    try {
        probeSdk(sdk);
    } finally {
        await sdk.dispose();
    }
    assert.equal(existsSync(root), false);
    console.log('Official SDK wire probes: 6 PASS; temporary tool removed');
}
