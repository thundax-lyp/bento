import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import {
    dirname,
    isAbsolute,
    join,
    posix,
    relative,
    resolve,
    sep,
} from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
    prepareSdk,
    type PreparedSdk,
} from '@/apps/orchestrator/openshell/binding-grants/sdk.ts';
import { probeSdk } from '@/apps/orchestrator/openshell/binding-grants/sdk-probe.ts';
import {
    schemaDecoder,
    schemaExecEventDecoder,
} from '@/apps/orchestrator/execution-service/command-host.ts';

type File = { path: string; bytes: number; sha256: string };
const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const digest = (bytes: Uint8Array) =>
    createHash('sha256').update(bytes).digest('hex');
const controls: readonly File[] = [
    {
        path: 'source.tar.gz',
        bytes: 8487132,
        sha256: 'ef434dd44746c5ee14a24e8dc4f09654134ee362f5a09fb08d31eb27c81b02ad',
    },
    {
        path: 'sdk-source-manifest.json',
        bytes: 6708,
        sha256: 'dea96c0430e92329c7a3989ad3a6c64306b44da403737011b017942cf27cce13',
    },
    {
        path: 'sdk-built-manifest.json',
        bytes: 180172,
        sha256: 'ea5b35268fe278d330f6578893be2c84c155de7262c66cf1a843bb2718fb6d2e',
    },
];

function failure(stage: string) {
    return new Error('Controlled SDK ' + stage + ' failed');
}
function outside(child: string, parent: string) {
    const rel = relative(parent, child);
    return rel.startsWith('..' + sep) || isAbsolute(rel);
}
function checkFile(file: File) {
    if (
        !file ||
        typeof file.path !== 'string' ||
        !file.path ||
        file.path.startsWith('/') ||
        /[\\\0]/.test(file.path) ||
        file.path
            .split('/')
            .some((part) => !part || part === '.' || part === '..') ||
        posix.normalize(file.path) !== file.path ||
        !Number.isSafeInteger(file.bytes) ||
        file.bytes < 0 ||
        !/^[a-f0-9]{64}$/.test(file.sha256)
    )
        throw failure('file identity');
}

async function inputRoot(path: string) {
    if (!isAbsolute(path)) throw failure('absolute input');
    const lexical = resolve(path);
    const root = await fs.realpath(lexical);
    if (
        !(await fs.lstat(lexical)).isDirectory() ||
        !outside(root, await fs.realpath(repo))
    )
        throw failure('external directory');
    return root;
}

async function readVerified(root: string, file: File): Promise<Buffer> {
    checkFile(file);
    const path = join(root, file.path);
    const before = await fs.lstat(path);
    if (
        !before.isFile() ||
        before.nlink !== 1 ||
        (await fs.realpath(path)) !== path
    )
        throw failure('regular member');
    const handle = await fs.open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
        const initial = await handle.stat();
        if (
            !initial.isFile() ||
            initial.nlink !== 1 ||
            initial.dev !== before.dev ||
            initial.ino !== before.ino ||
            initial.size !== file.bytes
        )
            throw failure('read identity');
        const chunks: Buffer[] = [];
        let total = 0;
        while (total <= file.bytes) {
            const chunk = Buffer.alloc(Math.min(65536, file.bytes + 1 - total));
            const { bytesRead } = await handle.read(chunk);
            if (!bytesRead) break;
            chunks.push(chunk.subarray(0, bytesRead));
            total += bytesRead;
        }
        const after = await handle.stat();
        const current = await fs.lstat(path);
        const bytes = Buffer.concat(chunks);
        if (
            total !== file.bytes ||
            after.dev !== initial.dev ||
            after.ino !== initial.ino ||
            after.size !== initial.size ||
            after.mtimeMs !== initial.mtimeMs ||
            after.nlink !== 1 ||
            current.dev !== initial.dev ||
            current.ino !== initial.ino ||
            !current.isFile() ||
            (await fs.realpath(path)) !== path ||
            digest(bytes) !== file.sha256
        )
            throw failure('content or read stability');
        return bytes;
    } finally {
        await handle.close();
    }
}

async function members(root: string, files: readonly File[]) {
    const expected = new Set(files.map((file) => file.path));
    const dirs = new Set<string>();
    for (const file of files) {
        let path = posix.dirname(file.path);
        while (path !== '.') {
            dirs.add(path);
            path = posix.dirname(path);
        }
    }
    let count = 0;
    async function walk(prefix: string) {
        for (const name of await fs.readdir(join(root, prefix))) {
            const rel = prefix ? prefix + '/' + name : name;
            const stat = await fs.lstat(join(root, rel));
            if (stat.isDirectory() && dirs.has(rel)) await walk(rel);
            else if (stat.isFile() && stat.nlink === 1 && expected.has(rel))
                count++;
            else throw failure('member whitelist');
        }
    }
    await walk('');
    if (count !== expected.size) throw failure('missing members');
}

/** Data only: this primitive never authorizes or imports an SDK module. */
export async function isolateVerifiedSdkFiles(
    path: string,
    files: readonly File[],
): Promise<{ directory: string; dispose(): Promise<void> }> {
    if (!files.length || files.length > 738) throw failure('file count');
    for (const file of files) checkFile(file);
    if (
        new Set(files.map((file) => file.path)).size !== files.length ||
        files.reduce((sum, file) => sum + file.bytes, 0) > 13058270
    )
        throw failure('inventory bounds');
    let source: string;
    let directory: string;
    try {
        source = await inputRoot(path);
        await members(source, files);
        directory = await fs.mkdtemp(join(tmpdir(), 'bento-worker-reuse-sdk-'));
    } catch {
        throw failure('input validation');
    }
    let disposal: Promise<void> | undefined;
    const dispose = () =>
        (disposal ??= Promise.resolve()
            .then(() => fs.rm(directory, { recursive: true, force: true }))
            .catch(() => {
                throw failure('cleanup');
            }));
    try {
        directory = await fs.realpath(directory);
        await fs.chmod(directory, 0o700);
        for (const file of files) {
            const bytes = await readVerified(source, file);
            const target = join(directory, file.path);
            await fs.mkdir(dirname(target), { recursive: true, mode: 0o700 });
            await fs.writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
            await readVerified(directory, file);
        }
        await members(source, files);
        await members(directory, files);
        return { directory, dispose };
    } catch {
        try {
            await dispose();
        } catch (cleanup) {
            throw new AggregateError(
                [failure('copy or validation'), cleanup],
                'Controlled SDK copy and cleanup failed',
                { cause: cleanup },
            );
        }
        throw failure('copy or validation');
    }
}

async function controlledFiles(root: string): Promise<File[]> {
    const sourceBytes = await readVerified(root, controls[1]!);
    const builtBytes = await readVerified(root, controls[2]!);
    await readVerified(root, controls[0]!);
    // Raw-byte identities above authenticate these historical manifests.
    const source = JSON.parse(sourceBytes.toString()) as File[];
    const built = JSON.parse(builtBytes.toString()) as {
        sourceRevision: string;
        lockSha256: string;
        bufConfigSha256: string;
        runtime: { name: string; version: string }[];
        files: File[];
    };
    if (
        source.length !== 44 ||
        built.files.length !== 697 ||
        built.sourceRevision !== 'ac7f615cd12d5cc49cb16eb1f5f10ffeb1e90f47' ||
        built.lockSha256 !==
            '256dbfb9d87fe8a89a3e8a8fe9c60fc70bab4446bd1f6fa066a8a77a670ca38a' ||
        built.bufConfigSha256 !==
            '6fd9a0b948f988cd73c6bf19d48ff8292369d3aaeea0ec8e6fc0053c3c387595' ||
        JSON.stringify(
            built.runtime.map(({ name, version }) => [name, version]),
        ) !==
            JSON.stringify([
                ['@bufbuild/protobuf', '2.12.1'],
                ['@connectrpc/connect', '2.1.2'],
                ['@connectrpc/connect-node', '2.1.2'],
            ])
    )
        throw failure('fixed manifest metadata');
    const union = new Map<string, File>();
    for (const file of [...source, ...built.files]) {
        checkFile(file);
        const previous = union.get(file.path);
        if (
            previous &&
            (previous.bytes !== file.bytes || previous.sha256 !== file.sha256)
        )
            throw failure('overlapping inventory');
        union.set(file.path, {
            path: file.path,
            bytes: file.bytes,
            sha256: file.sha256,
        });
    }
    if (
        union.size !== 735 ||
        [...union.values()].reduce((n, file) => n + file.bytes, 0) !== 4384258
    )
        throw failure('fixed inventory bounds');
    return [
        ...controls,
        ...[...union.values()].map((file) => ({
            ...file,
            path: 'tree/' + file.path,
        })),
    ];
}

async function codecs(
    raw: string,
    dispose: () => Promise<void>,
): Promise<PreparedSdk> {
    const api = await import(
        pathToFileURL(join(dirname(raw), 'index.js')).href
    );
    assert.equal(typeof api.SandboxClient, 'function');
    assert.equal(
        typeof api.SandboxClient.prototype.execInteractive,
        'function',
    );
    const schemas = await import(pathToFileURL(raw).href);
    const protobufPath = await fs.realpath(
        createRequire(raw).resolve('@bufbuild/protobuf'),
    );
    const protobufRoot = join(
        dirname(dirname(raw)),
        'node_modules/@bufbuild/protobuf',
    );
    if (outside(protobufPath, protobufRoot) || protobufPath === protobufRoot)
        throw failure('protobuf closure');
    const protobuf = await import(pathToFileURL(protobufPath).href);
    const binary = (schema: unknown, input: object) =>
        protobuf.toBinary(schema, protobuf.create(schema, input));
    return {
        raw,
        encode(method, input, sandbox) {
            if (input === 'stdin') {
                assert.equal(method, 'ExecSandboxInteractive');
                return binary(schemas.ExecSandboxInputSchema, {
                    payload: { case: 'stdin', value: new Uint8Array([65]) },
                });
            }
            const workspaceScope = {
                selection: { case: 'workspace', value: 'default' },
            };
            if (method === 'GetSandbox')
                return binary(schemas.GetSandboxRequestSchema, {
                    name: sandbox,
                    workspaceScope,
                });
            const request = {
                sandbox,
                workspaceScope,
                command: [method === 'ExecSandbox' ? 'true' : 'cat'],
                tty: false,
            };
            return method === 'ExecSandbox'
                ? binary(schemas.ExecSandboxRequestSchema, request)
                : binary(schemas.ExecSandboxInputSchema, {
                      payload: { case: 'start', value: request },
                  });
        },
        exit: (code) =>
            binary(schemas.ExecSandboxEventSchema, {
                payload: { case: 'exit', value: { exitCode: code } },
            }),
        decode: await schemaDecoder(raw),
        decodeExecEvent: await schemaExecEventDecoder(raw),
        dispose,
    };
}

export async function prepareReuseSdk(): Promise<PreparedSdk> {
    const input = process.env.BENTO_A6_WORKER_REUSE_SDK_BUNDLE;
    if (input === undefined) {
        const sdk = await prepareSdk();
        let disposal: Promise<void> | undefined;
        const dispose = () =>
            (disposal ??= Promise.resolve().then(() => sdk.dispose()));
        try {
            probeSdk(sdk);
            return { ...sdk, dispose };
        } catch (error) {
            try {
                await dispose();
            } catch (cleanup) {
                throw new AggregateError(
                    [error, cleanup],
                    'SDK probe and cleanup failed',
                    { cause: cleanup },
                );
            }
            throw error;
        }
    }
    let isolated:
        Awaited<ReturnType<typeof isolateVerifiedSdkFiles>> | undefined;
    try {
        const root = await inputRoot(input);
        isolated = await isolateVerifiedSdkFiles(
            root,
            await controlledFiles(root),
        );
        const sdk = await codecs(
            join(isolated.directory, 'tree/sdk/typescript/dist/raw.js'),
            isolated.dispose,
        );
        probeSdk(sdk);
        return sdk;
    } catch {
        try {
            await isolated?.dispose();
        } catch (cleanup) {
            throw new AggregateError(
                [failure('identity or preparation'), cleanup],
                'Controlled SDK preparation and cleanup failed',
                { cause: cleanup },
            );
        }
        throw failure('identity or preparation');
    }
}
