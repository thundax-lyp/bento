import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    chmod,
    mkdtemp,
    mkdir,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    schemaDecoder,
    schemaExecEventDecoder,
} from '@/apps/orchestrator/execution-service/command-host.ts';
import type { SdkIngressOptions } from '../sdk-ingress.ts';

export const sdkRevision = 'ac7f615cd12d5cc49cb16eb1f5f10ffeb1e90f47';
const archiveDigest =
    '4c14a574c0bd2feccbc5198ef9fc64f6e75c7f5ef89b5f2fe478f7688fefa43f';
const lockDigest =
    '256dbfb9d87fe8a89a3e8a8fe9c60fc70bab4446bd1f6fa066a8a77a670ca38a';
const configDigest =
    '6fd9a0b948f988cd73c6bf19d48ff8292369d3aaeea0ec8e6fc0053c3c387595';
export type SdkMethod = 'GetSandbox' | 'ExecSandbox' | 'ExecSandboxInteractive';
export type PreparedSdk = {
    raw: string;
    encode(
        method: SdkMethod,
        input: 'start' | 'stdin',
        sandbox: string,
    ): Uint8Array;
    exit(code: number): Uint8Array;
    decode: SdkIngressOptions['decode'];
    decodeExecEvent: NonNullable<SdkIngressOptions['decodeExecEvent']>;
    dispose(): Promise<void>;
};

export async function prepareSdk(): Promise<PreparedSdk> {
    const root = await mkdtemp(join(tmpdir(), 'bento-a103-sdk-'));
    const deadline = Date.now() + 600_000;
    await chmod(root, 0o700);
    const dispose = () => rm(root, { recursive: true, force: true });
    async function run(
        stage: string,
        command: string,
        args: string[],
        cwd: string,
        timeout: number,
        env: NodeJS.ProcessEnv = process.env,
    ) {
        const remaining = Math.min(timeout, deadline - Date.now());
        if (remaining <= 0)
            throw new Error('SDK preparation deadline exceeded');
        const child = spawn(command, args, {
            cwd,
            env,
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const chunks: Buffer[] = [];
        let size = 0;
        let failed = false;
        function kill() {
            failed = true;
            if (child.pid) {
                try {
                    process.kill(-child.pid, 'SIGKILL');
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
                        throw error;
                }
            }
        }
        const timer = setTimeout(kill, remaining);
        for (const stream of [child.stdout, child.stderr])
            stream.on('data', (chunk: Buffer) => {
                size += chunk.length;
                if (size > 8 * 1024 * 1024) kill();
                else chunks.push(chunk);
            });
        try {
            await new Promise<void>((resolve, reject) => {
                child.once('error', () =>
                    reject(new Error(stage + ' spawn failed')),
                );
                child.once('close', (code, signal) => {
                    if (!failed && code === 0 && signal === null) resolve();
                    else reject(new Error(stage + ' failed or timed out'));
                });
            });
        } finally {
            clearTimeout(timer);
            await writeFile(join(root, stage + '.log'), Buffer.concat(chunks), {
                mode: 0o600,
            });
        }
    }
    const hash = (bytes: Uint8Array) =>
        createHash('sha256').update(bytes).digest('hex');
    try {
        const archive = join(root, 'source.tar.gz');
        await run(
            'download',
            'curl',
            [
                '--fail',
                '--location',
                '--silent',
                '--show-error',
                '--max-time',
                '120',
                '--output',
                archive,
                'https://codeload.github.com/NVIDIA/OpenShell/tar.gz/' +
                    sdkRevision,
            ],
            root,
            125_000,
        );
        assert.equal(hash(await readFile(archive)), archiveDigest);
        const source = join(root, 'source');
        await mkdir(source, { mode: 0o700 });
        await run(
            'extract',
            'tar',
            [
                '-xzf',
                archive,
                '-C',
                source,
                '--strip-components=1',
                ...['sdk/typescript', 'proto', 'buf.yaml', 'LICENSE'].map(
                    (name) => 'openshell-' + sdkRevision + '/' + name,
                ),
            ],
            root,
            30_000,
        );
        const sdk = join(source, 'sdk/typescript');
        assert.equal(
            hash(await readFile(join(sdk, 'package-lock.json'))),
            lockDigest,
        );
        assert.equal(
            hash(await readFile(join(sdk, 'buf.gen.yaml'))),
            configDigest,
        );
        await run(
            'install',
            'npm',
            [
                'ci',
                '--ignore-scripts',
                '--no-audit',
                '--no-fund',
                '--cache',
                join(root, 'npm-cache'),
                '--fetch-timeout=20000',
                '--fetch-retries=1',
            ],
            sdk,
            240_000,
        );
        await run('generate', 'npm', ['run', 'gen'], sdk, 120_000, {
            ...process.env,
            BUF_CACHE_DIR: join(root, 'buf-cache'),
        });
        await run('build', 'npm', ['run', 'build'], sdk, 120_000);
        const raw = join(sdk, 'dist/raw.js');
        const schemas = (await import(pathToFileURL(raw).href)) as Record<
            string,
            unknown
        >;
        for (const name of [
            'WorkspaceSelectorSchema',
            'GetSandboxRequestSchema',
            'ExecSandboxRequestSchema',
            'ExecSandboxInputSchema',
            'ExecSandboxEventSchema',
        ])
            assert(schemas[name], name);
        const require = createRequire(raw);
        const protobuf = (await import(
            pathToFileURL(require.resolve('@bufbuild/protobuf')).href
        )) as {
            create(schema: unknown, input: object): object;
            toBinary(schema: unknown, message: object): Uint8Array;
        };
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
    } catch (error) {
        try {
            await dispose();
        } catch (cleanupError) {
            throw new AggregateError(
                [error, cleanupError],
                'SDK preparation and cleanup failed',
                { cause: cleanupError },
            );
        }
        throw error;
    }
}
