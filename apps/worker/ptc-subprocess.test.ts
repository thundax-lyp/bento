import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type ServerHttp2Session } from 'node:http2';
import { createRequire } from 'node:module';
import test, { before, after } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { createClient } from '@connectrpc/connect';
import { prepareReuseSdk } from '@/apps/orchestrator/orchestrator-execution-host/acceptance/worker-reuse/sdk.ts';
import { createRunSdkTransport } from './sdk-transport.ts';
import {
    openPtcProcess,
    PtcFrameReader,
    ptcFrame,
    ptcFrameBytes,
    type PtcSdk,
} from './ptc-subprocess.ts';

const nonce = Buffer.alloc(16, 1);

test('PTC framing preserves fragmented payloads and treats stdout as data', () => {
    const reader = new PtcFrameReader(nonce);
    const fakeStop = ptcFrame(6, nonce);
    const bytes = Buffer.concat([
        ptcFrame(1, nonce),
        ptcFrame(2, nonce, Buffer.from('binding reply')),
        ptcFrame(4, nonce, fakeStop),
        ptcFrame(3, nonce),
        ptcFrame(6, nonce),
    ]);
    const frames = Array.from(bytes).flatMap((byte) => [
        ...reader.read(Uint8Array.of(byte)),
    ]);
    assert.deepEqual(
        frames.map(({ tag }) => tag),
        [1, 2, 4, 3, 6],
    );
    assert.equal(frames[1]?.value.toString(), 'binding reply');
    assert.deepEqual(frames[2]?.value, fakeStop);
    reader.finish();
});

test('PTC rejects foreign nonce, protocol mixing, late control and incomplete stop', () => {
    for (const bytes of [
        ptcFrame(1, Buffer.alloc(16, 2)),
        ptcFrame(2, nonce, Buffer.from('control before hello')),
        Buffer.concat([ptcFrame(1, nonce), ptcFrame(1, nonce)]),
        Buffer.concat([
            ptcFrame(1, nonce),
            ptcFrame(3, nonce),
            ptcFrame(2, nonce),
        ]),
        Buffer.concat([
            ptcFrame(1, nonce),
            ptcFrame(6, nonce),
            ptcFrame(4, nonce),
        ]),
    ]) {
        const reader = new PtcFrameReader(nonce);
        assert.throws(() => [...reader.read(bytes)], /frame rejected/);
    }
    const truncated = new PtcFrameReader(nonce);
    assert.deepEqual(
        [...truncated.read(ptcFrame(1, nonce).subarray(0, 10))],
        [],
    );
    assert.throws(() => truncated.finish(), /Incomplete/);
    const unproven = new PtcFrameReader(nonce);
    assert.deepEqual(
        [...unproven.read(ptcFrame(1, nonce))].map(({ tag }) => tag),
        [1],
    );
    assert.throws(() => unproven.finish(), /Incomplete/);
    assert.throws(
        () => ptcFrame(2, nonce, Buffer.alloc(ptcFrameBytes + 1)),
        /Invalid PTC frame/,
    );
});

let sdk: Awaited<ReturnType<typeof prepareReuseSdk>>;
before(
    async () => {
        sdk = await prepareReuseSdk();
    },
    { timeout: 600_000 },
);
after(async () => sdk?.dispose());

test(
    'scoped SDK pulls PTC data only as the HTTP/2 peer reads',
    { timeout: 30_000 },
    async () => {
        const { OpenShell, ExecSandboxInputSchema } = await import(
            pathToFileURL(sdk.raw).href
        );
        const { fromBinary } = await import(
            pathToFileURL(createRequire(sdk.raw).resolve('@bufbuild/protobuf'))
                .href
        );
        const server = createServer({ settings: { initialWindowSize: 1024 } });
        const sessions = new Set<ServerHttp2Session>();
        server.on('session', (session) => {
            sessions.add(session);
            session.on('error', () => {});
            session.once('close', () => sessions.delete(session));
        });
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const address = server.address();
        assert(address && typeof address !== 'string');
        const run = createRunSdkTransport(
            'http://127.0.0.1:' + address.port,
            'test',
        );
        try {
            const incoming = once(server, 'stream');
            const client = createClient(
                OpenShell,
                run.transport,
            ) as unknown as PtcSdk;
            const process = openPtcProcess(
                {
                    getSandbox: async () => ({}),
                    execSandboxInteractive: client.execSandboxInteractive,
                },
                { sandbox: 'fixture' },
            );
            const pending = assert.rejects(process.done);
            const control = process.control!;
            const payloads = [
                Buffer.alloc(ptcFrameBytes, 17),
                Buffer.alloc(ptcFrameBytes, 42),
            ];
            let writes = 0;
            const flushed = Promise.all(
                payloads.map(
                    (payload) =>
                        new Promise<void>((resolve, reject) => {
                            control.write(payload, (error) => {
                                if (error) return reject(error);
                                writes++;
                                resolve();
                            });
                        }),
                ),
            );
            void flushed.catch(() => {});
            const [stream, headers] = await incoming;
            stream.on('error', () => {});
            assert.equal(
                headers[':path'],
                '/openshell.v1.OpenShell/ExecSandboxInteractive',
            );
            stream.pause();
            await delay(150);
            assert.equal(writes, 0);
            const received: Buffer[] = [];
            let buffered = Buffer.alloc(0);
            const read = new Promise<void>((resolve) => {
                stream.on('data', (chunk: Buffer) => {
                    buffered = Buffer.concat([buffered, chunk]);
                    while (buffered.length >= 5) {
                        const size = buffered.readUInt32BE(1);
                        if (buffered.length < size + 5) break;
                        const message = fromBinary(
                            ExecSandboxInputSchema,
                            buffered.subarray(5, size + 5),
                        );
                        if (message.payload.case === 'stdin')
                            received.push(Buffer.from(message.payload.value));
                        buffered = buffered.subarray(size + 5);
                    }
                    if (received.length >= 3) resolve();
                });
            });
            stream.resume();
            await Promise.all([read, flushed]);
            const nonce = received[0]!.subarray(2, 18);
            assert.deepEqual(received, [
                ptcFrame(1, nonce),
                ...payloads.map((payload) => ptcFrame(2, nonce, payload)),
            ]);
            process.terminate();
            stream.close();
            await pending;
        } finally {
            for (const session of sessions) session.destroy();
            await run.close();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    },
);
