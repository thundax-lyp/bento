import { Buffer } from 'node:buffer';
import {
    connect,
    constants,
    createServer,
    type ClientHttp2Session,
    type ClientHttp2Stream,
    type IncomingHttpHeaders,
    type ServerHttp2Stream,
} from 'node:http2';
import type { WorkerGate, WorkerGrant } from './worker-gate.ts';

const prefix = '/openshell.v1.OpenShell/';
const methods = [
    'GetSandbox',
    'ExecSandbox',
    'ExecSandboxInteractive',
] as const;
type Method = (typeof methods)[number];
type Target = { sandbox: string; workspace: string; tty?: boolean };
type Frame = Target | 'stdin';

export interface SdkIngressOptions {
    upstream: URL;
    credentials: { ca: Buffer; cert: Buffer; key: Buffer };
    workspace: string;
    /** Decode one protobuf message using the pinned official OpenShell SDK schemas. */
    decode(method: Method, payload: Uint8Array): Frame;
    audit?: (event: {
        outcome: 'allow' | 'deny';
        method?: Method;
        generation?: number;
    }) => void;
}

type Binding = ReturnType<WorkerGate['require']>;

function audit(
    options: SdkIngressOptions,
    event: Parameters<NonNullable<SdkIngressOptions['audit']>>[0],
) {
    try {
        options.audit?.(event);
    } catch {
        // A failed audit sink must not interrupt rejection or stream cleanup.
    }
}

export function createSdkIngress(
    gate: WorkerGate,
    grantFor: (header: string | undefined) => WorkerGrant,
    options: SdkIngressOptions,
) {
    if (
        options.upstream.protocol !== 'https:' ||
        options.upstream.username ||
        options.upstream.password
    )
        throw new Error('a trusted mTLS Gateway is required');
    const server = createServer();
    server.on('sessionError', () => {});
    server.on('stream', (stream, headers) => {
        stream.on('error', () => {});
        const method = methods.find(
            (name) => headers[':path'] === prefix + name,
        );
        if (
            !method ||
            headers[':method'] !== 'POST' ||
            typeof headers['content-type'] !== 'string' ||
            !/^application\/grpc(?:\+proto)?(?:;|$)/.test(
                headers['content-type'],
            ) ||
            (headers['grpc-encoding'] !== undefined &&
                headers['grpc-encoding'] !== 'identity')
        ) {
            audit(options, { outcome: 'deny' });
            reject(stream, 7);
            return;
        }
        try {
            const grant = grantFor(headers.authorization);
            void gate
                .channel(grant, (binding, signal) =>
                    forward(stream, method, binding, signal, options, () =>
                        gate.require(grant),
                    ),
                )
                .catch(() => {
                    audit(options, {
                        outcome: 'deny',
                        method,
                        generation: grant.generation,
                    });
                    reject(stream, 7);
                });
        } catch {
            audit(options, { outcome: 'deny', method });
            reject(stream, 16);
        }
    });
    return server;
}

function reject(stream: ServerHttp2Stream, status: number) {
    if (stream.closed || stream.destroyed) return;
    if (stream.headersSent) stream.close(constants.NGHTTP2_CANCEL);
    else {
        stream.respond({
            ':status': 200,
            'content-type': 'application/grpc',
            'grpc-status': String(status),
        });
        stream.end();
    }
}

function forward(
    stream: ServerHttp2Stream,
    method: Method,
    binding: Binding,
    signal: AbortSignal,
    options: SdkIngressOptions,
    authorize: () => void,
) {
    return new Promise<void>((resolve) => {
        let transport: ClientHttp2Session | undefined;
        let upstream: ClientHttp2Stream | undefined;
        let trailers: IncomingHttpHeaders = { 'grpc-status': '13' };
        let buffer = Buffer.alloc(0);
        let started = false;
        let finished = false;
        const maxFrame = 1024 * 1024;
        const record = (outcome: 'allow' | 'deny') =>
            audit(options, { outcome, method, generation: binding.generation });
        let disposed = false;
        let transportClosed = false;
        const dispose = () => {
            if (disposed) return;
            disposed = true;
            clearTimeout(deadline);
            signal.removeEventListener('abort', revoke);
            if (transport && !transportClosed) transport.destroy();
            else resolve();
        };
        const deny = (status: number) => {
            if (finished) return;
            finished = true;
            record('deny');
            reject(stream, status);
            dispose();
        };
        const revoke = () => deny(7);
        const deadline = setTimeout(() => deny(4), 10000);
        signal.addEventListener('abort', revoke, { once: true });
        stream.once('close', () => {
            finished = true;
            dispose();
        });
        stream.on('wantTrailers', () => {
            if (!stream.destroyed) stream.sendTrailers(trailers);
        });

        function open() {
            transport = connect(options.upstream, {
                ...options.credentials,
                rejectUnauthorized: true,
            });
            transport.once('close', () => {
                transportClosed = true;
                if (disposed) resolve();
            });
            transport.on('error', () => deny(14));
            const call = transport.request({
                ':method': 'POST',
                ':path': prefix + method,
                'content-type': 'application/grpc',
                te: 'trailers',
            });
            call.on('error', () => deny(14));
            call.once('response', (headers) => {
                if (finished) return;
                const { 'grpc-status': status, 'grpc-message': message } =
                    headers;
                if (status !== undefined)
                    trailers = {
                        'grpc-status': status,
                        ...(message === undefined
                            ? {}
                            : { 'grpc-message': message }),
                    };
                stream.respond(
                    {
                        ':status': headers[':status'] ?? 200,
                        'content-type': 'application/grpc',
                    },
                    { waitForTrailers: true },
                );
            });
            call.on('trailers', (value) => {
                trailers = value;
            });
            call.on('data', (chunk: Buffer) => {
                if (!finished && !stream.write(chunk)) {
                    call.pause();
                    stream.once('drain', () => call.resume());
                }
            });
            call.once('end', () => {
                if (finished) return;
                finished = true;
                stream.end();
            });
            call.once('close', () => {
                if (!finished) deny(14);
            });
            record('allow');
            return call;
        }

        stream.on('data', (chunk: Buffer) => {
            if (finished) return;
            try {
                buffer = Buffer.concat([buffer, chunk]);
                while (buffer.length >= 5) {
                    const length = buffer.readUInt32BE(1);
                    if (buffer[0] !== 0 || length > maxFrame) return deny(3);
                    if (buffer.length < length + 5) return;
                    const frame = buffer.subarray(0, length + 5);
                    const request = options.decode(method, frame.subarray(5));
                    authorize();
                    if (started) {
                        if (
                            method !== 'ExecSandboxInteractive' ||
                            request !== 'stdin'
                        )
                            return deny(7);
                    } else {
                        if (
                            request === 'stdin' ||
                            request.tty ||
                            request.sandbox !== binding.sandbox ||
                            request.workspace !== options.workspace
                        )
                            return deny(7);
                        started = true;
                        clearTimeout(deadline);
                        upstream = open();
                    }
                    if (!upstream?.write(frame)) {
                        stream.pause();
                        upstream?.once('drain', () => stream.resume());
                    }
                    buffer = buffer.subarray(length + 5);
                }
            } catch {
                deny(7);
            }
        });
        stream.once('end', () => {
            if (finished) return;
            if (!started || buffer.length) deny(3);
            else upstream?.end();
        });
    });
}
