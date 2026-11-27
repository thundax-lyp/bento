import { connect, constants, type ClientHttp2Stream } from 'node:http2';
import type { Transport } from '@connectrpc/connect';
import { createGrpcTransport } from '@connectrpc/connect-node';

/** One Run owns this connection; the Orchestrator owns the remote mTLS hop. */
export function createRunSdkTransport(
    gateway: string,
    token: string,
): { transport: Transport; close(): Promise<void> } {
    const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/?$/.exec(gateway);
    if (!match || Number(match[1]) > 65535)
        throw new Error('SDK gateway must be the trusted loopback ingress');
    if (typeof token !== 'string' || !/^[!-~]{1,1024}$/.test(token))
        throw new Error('Invalid Run SDK credential');

    const authority = new URL(gateway).origin;
    const session = connect(authority);
    const streams = new Map<ClientHttp2Stream, Promise<void>>();
    let closing = false;
    let disposal: Promise<void> | undefined;
    let connected = false;
    let connectionError: Error | undefined;
    let observedClosed = false;
    const closed = new Promise<void>((resolve) =>
        session.once('close', () => {
            observedClosed = true;
            resolve();
        }),
    );
    const ready = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            connectionError = new Error('Run SDK connection deadline exceeded');
            session.destroy();
            reject(connectionError);
        }, 5000);
        timer.unref();
        session.once('connect', () => {
            clearTimeout(timer);
            connected = true;
            resolve();
        });
        session.once('close', () => {
            clearTimeout(timer);
            if (!connected) reject(new Error('Run SDK connection closed'));
        });
        session.on('error', () => {
            clearTimeout(timer);
            connectionError = new Error('Run SDK connection failed');
            reject(connectionError);
        });
    });
    // Bootstrap can fail before the first RPC. close() still owns the socket.
    void ready.catch(() => undefined);
    let goaway = false;
    session.on('goaway', () => {
        goaway = true;
    });

    const transport = createGrpcTransport({
        baseUrl: authority,
        interceptors: [
            (next) => async (request) => {
                if (closing) throw new Error('Run SDK transport is closed');
                request.header.set('authorization', 'Bearer ' + token);
                return next(request);
            },
        ],
        sessionManager: {
            authority,
            async request(method, path, headers, options) {
                if (closing) throw new Error('Run SDK transport is closed');
                await ready;
                if (
                    closing ||
                    connectionError ||
                    goaway ||
                    session.closed ||
                    session.destroyed
                )
                    throw new Error('Run SDK connection is unavailable');
                const stream = session.request(
                    { ...headers, ':method': method, ':path': path },
                    options,
                );
                streams.set(
                    stream,
                    new Promise<void>((resolve) => {
                        stream.once('close', () => {
                            streams.delete(stream);
                            resolve();
                        });
                    }),
                );
                return stream;
            },
            notifyResponseByteRead() {
                // No keepalive or connection cache exists outside this Run.
            },
        },
    });

    return {
        transport,
        close() {
            disposal ??= (async () => {
                closing = true;
                const pending = [...streams.values()];
                for (const stream of streams.keys())
                    stream.close(constants.NGHTTP2_CANCEL);
                if (!session.closed && !session.destroyed) session.close();
                let force: NodeJS.Timeout | undefined;
                let deadline: NodeJS.Timeout | undefined;
                try {
                    await Promise.race([
                        Promise.all([closed, ...pending]),
                        new Promise<never>((_resolve, reject) => {
                            force = setTimeout(() => session.destroy(), 2000);
                            deadline = setTimeout(() => {
                                session.destroy();
                                reject(
                                    new Error(
                                        'Run SDK resources remained after close deadline: ' +
                                            JSON.stringify({
                                                phase: 'sdk-close',
                                                streams: streams.size,
                                                closed: observedClosed,
                                                destroyed: session.destroyed,
                                            }),
                                    ),
                                );
                            }, 5000);
                        }),
                    ]);
                } finally {
                    clearTimeout(force);
                    clearTimeout(deadline);
                }
            })();
            return disposal;
        },
    };
}
