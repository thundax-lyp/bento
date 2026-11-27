import assert from 'node:assert/strict';
import { appendFileSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type {
    Session,
    SessionEvent,
    SessionStore,
} from '@deepseek-ai/dsh-session';
import base from '@worker/runtime/base-bootstrap.ts';
import type { DshWorkerBootstrap } from '@worker/runtime/dsh-worker.ts';

type Runtime = Awaited<ReturnType<DshWorkerBootstrap>>;
type Target = Awaited<ReturnType<Runtime['ctx']['fs']['resolve']>>;
type Prior = {
    store: SessionStore;
    target: Target;
    event: [Session, SessionEvent] | undefined;
    emit(): void;
    callbacks(): number;
};
let previous: Prior | undefined;
const bootstrap: DshWorkerBootstrap = async (request, effect) => {
    const record = (value: object) => {
        const path = process.env.BENTO_REUSE_TRACE;
        assert(path);
        appendFileSync(
            path,
            JSON.stringify({
                kind: 'runtime',
                pid: process.pid,
                session: request.binding.session,
                run: request.grant.run,
                generation: request.grant.generation,
                ...value,
            }) + '\n',
            { mode: 0o600 },
        );
    };
    async function acknowledge(phase: string, signal: AbortSignal) {
        const path = process.env.BENTO_REUSE_TRACE;
        assert(path);
        const deadline = Date.now() + 5000;
        while (true) {
            signal.throwIfAborted();
            let ack: { session?: string; phase?: string } | undefined;
            try {
                ack = JSON.parse(await readFile(path + '.ack', 'utf8'));
            } catch {
                /* Writer can be replacing a private ACK. */
            }
            if (ack?.session === request.binding.session && ack.phase === phase)
                return;
            if (Date.now() >= deadline) {
                record({ phase: 'ack-timeout-' + phase });
                throw new Error('Listener probe acknowledgement timed out');
            }
            await delay(5, undefined, { signal });
        }
    }
    let listenerProof: boolean | null = null;
    if (previous) {
        assert.equal(previous.store.list().length, 0);
        record({ phase: 'old-event-ready' });
        await acknowledge('ready', AbortSignal.timeout(5000));
        const before = previous.callbacks();
        previous.emit();
        assert.equal(previous.callbacks(), before);
        await delay(100, undefined, { signal: AbortSignal.timeout(5000) });
        record({ phase: 'old-event-ended' });
        await acknowledge('done', AbortSignal.timeout(5000));
        listenerProof = true;
    }
    record({ phase: 'before-base' });
    const runtime = await base(request, effect);
    const { ctx } = runtime;
    let current: Prior | undefined;
    let callbacks = 0;
    let captured: [Session, SessionEvent] | undefined;
    let disposed: Promise<void> | undefined;
    return {
        ...runtime,
        async initialize() {
            await runtime.initialize?.();
            ctx.on('session/event', (session, event) => {
                callbacks++;
                captured = [session, event];
            });
            let probed = false;
            ctx.on('agent/request', async (payload, next) => {
                if (probed) return next();
                probed = true;
                let listener: boolean | null = null;
                let cache: boolean | null = null;
                if (previous) {
                    assert.equal(previous.store.list().length, 0);
                    assert.notEqual(previous.store, ctx.sessions);
                    assert.equal(listenerProof, true);
                    listener = listenerProof;
                    assert.throws(() => ctx.fs.processPath(previous!.target));
                    cache = true;
                }
                const target = await ctx.fs.resolve('/sandbox/project/marker');
                assert.equal(await ctx.fs.readText(target), request.prompt);
                assert.equal(ctx.sessions.list().length, 1);
                current = {
                    store: ctx.sessions,
                    target,
                    get event() {
                        return captured;
                    },
                    emit() {
                        assert(captured);
                        ctx.emit('session/event', captured[0], captured[1]);
                    },
                    callbacks: () => callbacks,
                };
                record({
                    phase: 'probe',
                    predecessor: previous !== undefined,
                    listener,
                    cache,
                });
                const hold = process.env.BENTO_REUSE_HOLD_FILE;
                if (hold && existsSync(hold)) {
                    assert(runtime.provider);
                    const call =
                        await runtime.provider.interactiveClient.execInteractive(
                            request.binding.sandbox,
                            ['/usr/local/bin/node', '/runtime/fs.mjs'],
                            {
                                workdir: '/sandbox/project',
                                tty: false,
                                noLoginShell: true,
                                timeoutSecs: 30,
                                signal: payload.signal,
                            },
                        );
                    const collected = (async () => {
                        for await (const _event of call.output) {
                            void _event;
                        }
                    })();
                    const settled = Promise.allSettled([call.done, collected]);
                    call.write(
                        Buffer.from(
                            JSON.stringify({
                                version: '0.2.1-rc.4',
                                method: 'streamText',
                                path: '/sandbox/project/hold',
                                workspaceRoot: '/sandbox/project',
                                defaultMode: 'workspace-write',
                            }),
                        ),
                    );
                    const result = await settled;
                    assert.equal(result[0]!.status, 'rejected');
                    assert.throws(() =>
                        call.write(Buffer.from('post-revocation')),
                    );
                    record({ phase: 'revoked-input', rejected: true });
                    throw new Error('Fixture held stream revoked');
                }
                return next();
            });
        },
        async flush(agent) {
            await runtime.flush(agent);
            assert(current?.event);
            record({ phase: 'flushed', callbacks });
        },
        dispose() {
            disposed ??= (async () => {
                try {
                    await runtime.dispose();
                } finally {
                    if (current) {
                        assert.equal(current.store.list().length, 0);
                        const before = callbacks;
                        current.emit();
                        assert.equal(callbacks, before);
                        previous = current;
                    }
                    record({
                        phase: 'disposed',
                        callbacks,
                        empty: !current || current.store.list().length === 0,
                    });
                }
            })();
            return disposed;
        },
    };
};
export default bootstrap;
