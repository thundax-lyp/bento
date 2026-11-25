import { randomBytes } from 'node:crypto';
import { Duplex, PassThrough } from 'node:stream';
import { once } from 'node:events';
import type { Context } from '@deepseek-ai/cordis';
import { OpenShellSandboxProvider } from 'dsh-sandbox-openshell';
import {
    SubprocessRuntime,
    type SubprocessHandle,
    type SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess';

export const ptcFrameBytes = 65_536;
export const ptcPendingBytes = 262_144;
const headerBytes = 22;
const empty = Buffer.alloc(0);

export function ptcFrame(tag: number, nonce: Buffer, value: Buffer = empty) {
    if (
        nonce.length !== 16 ||
        !Number.isInteger(tag) ||
        tag < 1 ||
        tag > 6 ||
        value.length > ptcFrameBytes ||
        ([1, 3, 6].includes(tag) && value.length)
    )
        throw new Error('Invalid PTC frame');
    const header = Buffer.alloc(headerBytes);
    header[0] = 1;
    header[1] = tag;
    nonce.copy(header, 2);
    header.writeUInt32BE(value.length, 18);
    return Buffer.concat([header, value]);
}

export class PtcFrameReader {
    private input = Buffer.alloc(headerBytes);
    private offset = 0;
    private tag = 0;
    private ready = false;
    private ended = false;
    private stopped = false;

    private readonly nonce: Buffer;
    private readonly maxTag: number;
    constructor(nonce: Buffer, maxTag = 6) {
        this.nonce = nonce;
        this.maxTag = maxTag;
    }

    *read(chunk: Uint8Array): Generator<{ tag: number; value: Buffer }> {
        let cursor = 0;
        while (cursor < chunk.length) {
            const count = Math.min(
                chunk.length - cursor,
                this.input.length - this.offset,
            );
            this.input.set(chunk.subarray(cursor, cursor + count), this.offset);
            this.offset += count;
            cursor += count;
            if (this.offset !== this.input.length) continue;
            if (!this.tag) {
                const tag = this.input[1]!;
                const length = this.input.readUInt32BE(18);
                if (
                    this.input[0] !== 1 ||
                    !this.input.subarray(2, 18).equals(this.nonce) ||
                    tag < 1 ||
                    tag > this.maxTag ||
                    length > ptcFrameBytes ||
                    ([1, 3, 6].includes(tag) && length !== 0) ||
                    (!this.ready && tag !== 1) ||
                    (this.ready && tag === 1) ||
                    this.stopped ||
                    (this.ended && (tag === 2 || tag === 3))
                )
                    throw new Error('PTC frame rejected');
                if (tag === 1) this.ready = true;
                if (tag === 3) this.ended = true;
                if (tag === 6) this.stopped = true;
                if (!length) {
                    this.offset = 0;
                    yield { tag, value: empty };
                    continue;
                }
                this.tag = tag;
                this.input = Buffer.alloc(length);
                this.offset = 0;
                continue;
            }
            const frame = { tag: this.tag, value: this.input };
            this.tag = 0;
            this.input = Buffer.alloc(headerBytes);
            this.offset = 0;
            yield frame;
        }
    }

    finish() {
        if (
            this.offset ||
            this.tag ||
            !this.ready ||
            (this.maxTag === 6 && !this.stopped)
        )
            throw new Error('Incomplete PTC framing or stop observation');
    }
}

type Input = {
    payload:
        { case: 'start'; value: object } | { case: 'stdin'; value: Uint8Array };
};
type Event = {
    payload:
        | { case: 'stdout' | 'stderr'; value: { data: Uint8Array } }
        | { case: 'exit'; value: { exitCode: number } }
        | { case: undefined };
};
export type PtcSdk = {
    getSandbox(
        request: object,
        options: { signal: AbortSignal },
    ): Promise<unknown>;
    execSandboxInteractive(
        input: AsyncIterable<Input>,
        options: { signal: AbortSignal },
    ): AsyncIterable<Event>;
};

type Pending = { frame: Buffer; complete(error?: Error): void };
class InputFrames {
    private readonly queue: Pending[] = [];
    private bytes = 0;
    private wake: (() => void) | undefined;
    private closed = false;

    push(frame: Buffer, complete: Pending['complete'] = () => {}) {
        if (this.closed || this.bytes + frame.length > ptcPendingBytes)
            throw new Error('PTC input pending limit exceeded');
        this.bytes += frame.length;
        this.queue.push({ frame, complete });
        this.wake?.();
    }

    close(error?: Error) {
        if (this.closed) return;
        this.closed = true;
        const failure =
            error ?? new Error('PTC input closed before write acknowledgement');
        for (const item of this.queue.splice(0)) item.complete(failure);
        this.bytes = 0;
        this.wake?.();
    }

    async *pull(start: object): AsyncGenerator<Input> {
        yield { payload: { case: 'start', value: start } };
        while (!this.closed) {
            const item = this.queue.shift();
            if (!item) {
                await new Promise<void>((resolve) => {
                    this.wake = resolve;
                });
                this.wake = undefined;
                continue;
            }
            let confirmed = false;
            try {
                yield { payload: { case: 'stdin', value: item.frame } };
                confirmed = true;
            } finally {
                if (!this.closed) this.bytes -= item.frame.length;
                item.complete(
                    confirmed
                        ? undefined
                        : new Error(
                              'PTC transport stopped before write acknowledgement',
                          ),
                );
            }
        }
    }
}

export function openPtcProcess(
    sdk: PtcSdk,
    start: object,
    signal?: AbortSignal,
): SubprocessHandle {
    const nonce = randomBytes(16);
    const input = new InputFrames();
    const abort = new AbortController();
    abort.signal.addEventListener(
        'abort',
        () => input.close(new Error('PTC transport aborted')),
        { once: true },
    );
    const output = new PtcFrameReader(nonce);
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let inputEnded = false;
    let grace: NodeJS.Timeout | undefined;

    function endControl(callback: Pending['complete'] = () => {}) {
        if (inputEnded) return callback();
        inputEnded = true;
        input.push(ptcFrame(3, nonce), callback);
    }
    function terminate() {
        if (grace !== undefined) return;
        try {
            endControl();
        } catch {
            abort.abort();
        }
        grace = setTimeout(() => abort.abort(), 4000);
        grace.unref();
    }
    signal?.addEventListener('abort', terminate, { once: true });

    const control = new Duplex({
        read() {},
        write(chunk: Buffer, _encoding, callback) {
            try {
                if (this.writableLength > ptcPendingBytes)
                    throw new Error('PTC control pending limit exceeded');
                input.push(ptcFrame(2, nonce, chunk), callback);
            } catch (error) {
                abort.abort();
                callback(error as Error);
            }
        },
        final(callback) {
            try {
                endControl(callback);
            } catch (error) {
                abort.abort();
                callback(error as Error);
            }
        },
    });
    control.on('error', terminate);
    input.push(ptcFrame(1, nonce));
    const done = (async () => {
        try {
            const target = start as { sandbox: string; workspaceScope: object };
            await sdk.getSandbox(
                { name: target.sandbox, workspaceScope: target.workspaceScope },
                { signal: abort.signal },
            );
            let exit: number | undefined;
            let diagnosticBytes = 0;
            for await (const event of sdk.execSandboxInteractive(
                input.pull(start),
                { signal: abort.signal },
            )) {
                if (exit !== undefined)
                    throw new Error('PTC SDK event after exit');
                const { payload } = event;
                if (payload.case === 'exit') {
                    exit = payload.value.exitCode;
                    continue;
                }
                if (payload.case === 'stderr') {
                    diagnosticBytes += payload.value.data.length;
                    if (diagnosticBytes > ptcFrameBytes)
                        throw new Error('PTC diagnostics limit exceeded');
                    continue;
                }
                if (payload.case !== 'stdout')
                    throw new Error('Missing PTC SDK payload');
                for (const { tag, value } of output.read(payload.value.data)) {
                    if (tag === 2) {
                        if (control.destroyed) continue;
                        if (
                            !control.push(value) &&
                            control.readableLength > ptcPendingBytes
                        )
                            throw new Error(
                                'PTC control output limit exceeded',
                            );
                    } else if (tag === 3) control.push(null);
                    else if (tag === 4 || tag === 5) {
                        const stream = tag === 4 ? stdout : stderr;
                        if (!stream.write(value))
                            await once(stream, 'drain', {
                                signal: abort.signal,
                            });
                    } else if (tag === 6) input.close();
                }
            }
            output.finish();
            if (exit === undefined)
                throw new Error('PTC SDK exit not observed');
            return { exitCode: exit, signal: null };
        } catch (error) {
            abort.abort();
            input.close(
                error instanceof Error
                    ? error
                    : new Error('PTC transport failed'),
            );
            throw error;
        } finally {
            clearTimeout(grace);
            signal?.removeEventListener('abort', terminate);
            input.close();
            if (!control.destroyed) control.push(null);
            stdout.end();
            stderr.end();
        }
    })();
    void done.catch(() => {});
    if (signal?.aborted) terminate();
    return {
        stdin: undefined,
        stdout,
        stderr,
        control,
        collected: {},
        done,
        terminate,
        async waitForExit(waitSignal) {
            if (waitSignal?.aborted) return false;
            if (!waitSignal) {
                await done;
                return true;
            }
            return await new Promise<boolean>((resolve, reject) => {
                const cancel = () => resolve(false);
                waitSignal.addEventListener('abort', cancel, { once: true });
                done.then(() => resolve(true), reject).finally(() =>
                    waitSignal.removeEventListener('abort', cancel),
                );
            });
        },
    };
}

export const ptcHelper = '/opt/dsh-runtime/bento-ptc/process.js';
const bridge = '/opt/dsh-runtime/bento-ptc/bridge.mjs';

type RuntimeConfig = {
    sdk: PtcSdk;
    sandbox: string;
    root: string;
    node: string;
    confine: SubprocessRuntime['resolveExecutable'];
};
type Confine = OpenShellSandboxProvider['confine'];

export class PtcSandbox extends OpenShellSandboxProvider {
    private readonly confineInParent: Confine;

    constructor(ctx: Context, confineInParent: Confine) {
        super(ctx);
        this.confineInParent = confineInParent;
    }

    override confine(...args: Parameters<Confine>) {
        return this.confineInParent(...args);
    }
}

export class PtcSubprocess extends SubprocessRuntime {
    private readonly config: RuntimeConfig;
    private expected: readonly string[] | undefined;
    constructor(ctx: Context, config: RuntimeConfig) {
        super(ctx);
        this.config = config;
    }

    stage(argv: readonly string[]) {
        if (this.expected) throw new Error('PTC launch already staged');
        this.expected = argv;
        return () => {
            this.expected = undefined;
        };
    }

    resolveExecutable(
        command: string,
        _env?: Readonly<Record<string, string>>,
        signal?: AbortSignal,
    ) {
        if (command !== this.config.node)
            throw new Error('PTC executable denied');
        return this.config.confine(command, undefined, signal);
    }

    async terminalEnvironment(): Promise<never> {
        throw new Error('PTC terminal denied');
    }
    async spawnTerminal(): Promise<never> {
        throw new Error('PTC terminal denied');
    }

    spawn(spec: SubprocessSpawnSpec) {
        if (
            !this.expected ||
            spec.argv.length !== this.expected.length ||
            !spec.argv.every(
                (value, index) => value === this.expected?.[index],
            ) ||
            spec.cwd !== this.config.root ||
            Object.values(spec.env ?? {}).some(
                (value) => value !== undefined,
            ) ||
            spec.stdio.control !== 'pipe' ||
            spec.stdio.stdin !== 'ignore' ||
            spec.stdio.stdout !== 'pipe' ||
            spec.stdio.stderr !== 'pipe'
        )
            throw new Error('PTC confined launch denied');
        this.expected = undefined;
        return openPtcProcess(
            this.config.sdk,
            {
                sandbox: this.config.sandbox,
                workspaceScope: {
                    selection: { case: 'workspace', value: 'default' },
                },
                command: [
                    this.config.node,
                    bridge,
                    Buffer.from(JSON.stringify(spec.argv)).toString('base64'),
                ],
                workdir: this.config.root,
                tty: false,
                noLoginShell: true,
            },
            spec.signal,
        );
    }
}
