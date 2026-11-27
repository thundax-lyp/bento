import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { PreparedSdk } from '@/apps/orchestrator/orchestrator-execution-host/tests/openshell/binding-grants/sdk.ts';
import { probeSdk } from '@/apps/orchestrator/orchestrator-execution-host/tests/openshell/binding-grants/sdk-probe.ts';
import { isolateVerifiedSdkFiles, prepareReuseSdk } from './sdk.ts';

const options = { timeout: 120_000, concurrency: false };
const selectedInput = process.env.BENTO_A6_WORKER_REUSE_SDK_BUNDLE;
let sdk: PreparedSdk;
before(
    async () => {
        sdk = await prepareReuseSdk();
    },
    { timeout: 600_000 },
);
after(async () => sdk?.dispose());

async function exists(path: string) {
    try {
        await fs.lstat(path);
        return true;
    } catch {
        return false;
    }
}

async function data() {
    const input = await fs.realpath(
        await fs.mkdtemp(join(tmpdir(), 'bento-sdk-data-')),
    );
    const values = [
        { path: 'first.txt', value: 'first ordinary text\n' },
        { path: 'nested/second.txt', value: 'second ordinary text\n' },
    ];
    for (const file of values) {
        await fs.mkdir(join(input, file.path, '..'), { recursive: true });
        await fs.writeFile(join(input, file.path), file.value, { mode: 0o600 });
    }
    return {
        input,
        files: values.map(({ path, value }) => ({
            path,
            bytes: Buffer.byteLength(value),
            sha256: createHash('sha256').update(value).digest('hex'),
        })),
        close: () => fs.rm(input, { recursive: true, force: true }),
    };
}

test(
    'selected real SDK passes six probes and disposes only its owned tree',
    options,
    async () => {
        probeSdk(sdk);
        assert(await exists(sdk.raw));
        if (selectedInput !== undefined) {
            assert(
                !sdk.raw.startsWith((await fs.realpath(selectedInput)) + '/'),
            );
        }
        const first = sdk.dispose();
        assert.equal(sdk.dispose(), first);
        await first;
        assert.equal(await exists(sdk.raw), false);
        if (selectedInput !== undefined) assert(await exists(selectedInput));
        console.log(
            JSON.stringify({
                phase: 'reuse-sdk',
                source:
                    selectedInput === undefined
                        ? 'official-build'
                        : 'controlled-local',
                probes: 6,
            }),
        );
    },
);

test(
    'invalid explicit bundles cannot fall back to network or load code',
    options,
    async () => {
        const fixture = await data();
        const link = fixture.input + '-link';
        try {
            await fs.symlink(fixture.input, link);
            const repo = fileURLToPath(
                new URL('../../../../../', import.meta.url),
            );
            for (const input of [
                '',
                'relative-sdk',
                repo,
                link,
                link + '/',
                fixture.input,
            ]) {
                process.env.BENTO_A6_WORKER_REUSE_SDK_BUNDLE = input;
                await assert.rejects(prepareReuseSdk(), /Controlled SDK/);
            }
        } finally {
            if (selectedInput === undefined)
                delete process.env.BENTO_A6_WORKER_REUSE_SDK_BUNDLE;
            else process.env.BENTO_A6_WORKER_REUSE_SDK_BUNDLE = selectedInput;
            await fs.rm(link, { force: true });
            await fixture.close();
        }
    },
);

test(
    'ordinary data is isolated and disposal is single-shot and preserves input',
    options,
    async () => {
        const fixture = await data();
        let isolated:
            Awaited<ReturnType<typeof isolateVerifiedSdkFiles>> | undefined;
        try {
            isolated = await isolateVerifiedSdkFiles(
                fixture.input,
                fixture.files,
            );
            assert.notEqual(isolated.directory, fixture.input);
            assert.equal(
                (await fs.stat(isolated.directory)).mode & 0o777,
                0o700,
            );
            await fs.writeFile(
                join(fixture.input, 'first.txt'),
                'changed input',
            );
            assert.equal(
                await fs.readFile(
                    join(isolated.directory, 'first.txt'),
                    'utf8',
                ),
                'first ordinary text\n',
            );
            const first = isolated.dispose();
            assert.equal(isolated.dispose(), first);
            await first;
            assert.equal(await exists(isolated.directory), false);
            assert(await exists(fixture.input));
        } finally {
            await isolated?.dispose();
            await fixture.close();
        }
    },
);

test(
    'deleting a private input copy does not change the isolated ordinary data',
    options,
    async () => {
        const fixture = await data();
        const isolated = await isolateVerifiedSdkFiles(
            fixture.input,
            fixture.files,
        );
        try {
            await fixture.close();
            assert.equal(
                await fs.readFile(
                    join(isolated.directory, 'nested/second.txt'),
                    'utf8',
                ),
                'second ordinary text\n',
            );
        } finally {
            await isolated.dispose();
            await fixture.close();
        }
    },
);

for (const kind of [
    'same-size',
    'short',
    'long',
    'extra',
    'empty-directory',
    'symlink',
    'hardlink',
    'parent-path',
    'absolute-path',
] as const) {
    test('ordinary data rejects ' + kind, options, async () => {
        const fixture = await data();
        try {
            const first = join(fixture.input, 'first.txt');
            if (kind === 'same-size') {
                const bytes = await fs.readFile(first);
                bytes[0] = bytes[0]! ^ 1;
                await fs.writeFile(first, bytes);
            } else if (kind === 'short') await fs.writeFile(first, 'x');
            else if (kind === 'long') await fs.appendFile(first, 'x');
            else if (kind === 'extra')
                await fs.writeFile(join(fixture.input, 'extra.txt'), 'extra');
            else if (kind === 'empty-directory')
                await fs.mkdir(join(fixture.input, 'extra'));
            else if (kind === 'symlink') {
                await fs.unlink(first);
                await fs.symlink(
                    join(fixture.input, 'nested/second.txt'),
                    first,
                );
            } else if (kind === 'hardlink')
                await fs.link(first, join(fixture.input, 'extra.txt'));
            else
                fixture.files[0]!.path =
                    kind === 'parent-path'
                        ? '../escape.txt'
                        : resolve(fixture.input, 'first.txt');
            await assert.rejects(
                isolateVerifiedSdkFiles(fixture.input, fixture.files),
                /Controlled SDK/,
            );
        } finally {
            await fixture.close();
        }
    });
}

test(
    'a file identity change during a bounded read is rejected',
    options,
    async (t) => {
        const fixture = await data();
        const open = fs.open.bind(fs);
        let observed = false;
        t.mock.method(
            fs,
            'open',
            async (...args: Parameters<typeof fs.open>) => {
                const handle = await open(...args);
                if (!observed) {
                    observed = true;
                    const stat = handle.stat.bind(handle);
                    let calls = 0;
                    t.mock.method(handle, 'stat', async () => {
                        const result = await stat();
                        if (++calls > 1) result.ino++;
                        return result;
                    });
                }
                return handle;
            },
        );
        try {
            await assert.rejects(
                isolateVerifiedSdkFiles(fixture.input, fixture.files),
                /Controlled SDK/,
            );
            assert(observed);
        } finally {
            t.mock.restoreAll();
            await fixture.close();
        }
    },
);

for (const cleanupFails of [false, true]) {
    test(
        'partial ordinary-data copy cleans or reports cleanup failure: ' +
            cleanupFails,
        options,
        async (t) => {
            const fixture = await data();
            const write = fs.writeFile.bind(fs);
            const rm = fs.rm.bind(fs);
            const removed: string[] = [];
            let writes = 0;
            t.mock.method(
                fs,
                'writeFile',
                async (...args: Parameters<typeof fs.writeFile>) => {
                    if (++writes === 2)
                        throw new Error('fixture-private-copy-value');
                    return write(...args);
                },
            );
            t.mock.method(
                fs,
                'rm',
                async (...args: Parameters<typeof fs.rm>) => {
                    removed.push(String(args[0]));
                    if (cleanupFails)
                        throw new Error('fixture-private-cleanup-value');
                    return rm(...args);
                },
            );
            try {
                await assert.rejects(
                    isolateVerifiedSdkFiles(fixture.input, fixture.files),
                    (error: Error) => {
                        assert.equal(
                            error instanceof AggregateError,
                            cleanupFails,
                        );
                        assert(!String(error).includes('private'));
                        if (error instanceof AggregateError) {
                            assert.equal(error.errors.length, 2);
                            for (const nested of error.errors)
                                assert(!String(nested).includes('private'));
                        }
                        return true;
                    },
                );
                assert.equal(removed.length, 1);
                assert.equal(await exists(removed[0]!), cleanupFails);
            } finally {
                t.mock.restoreAll();
                for (const path of removed)
                    await fs.rm(path, { recursive: true, force: true });
                await fixture.close();
            }
        },
    );
}
