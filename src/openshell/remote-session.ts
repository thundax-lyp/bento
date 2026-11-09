import { createHash, randomUUID } from 'node:crypto';
import {
    SessionAlreadyExistsError,
    SessionAlreadyOwnedError,
    SessionHandleClosedError,
    SessionOwnershipLostError,
    SessionPersistence,
    SessionPersistenceNotFoundError,
    SessionReadOnlyError,
    materializeAppendBatch,
    type SessionHandle,
    type SessionHeader,
} from '@deepseek-ai/dsh-session-persistence';

type Context = ConstructorParameters<typeof SessionPersistence>[0];
type SessionId = SessionHeader['id'];
type Event = Parameters<typeof materializeAppendBatch>[0][number];
type Snapshot = NonNullable<Awaited<ReturnType<SessionPersistence['stat']>>>;
type HandleData = Pick<
    SessionHandle,
    'id' | 'header' | 'access' | 'inheritedEventCount'
> & {
    key: string;
};
type Options = { url: string; token: string };
type Batch = {
    id: string;
    digest: string;
    events: readonly Event[];
    buffered: number;
    extra: string;
};
type Receipt = { batch: string; digest: string; first: number; count: number };

class RemoteSession extends SessionPersistence {
    private readonly writers = new Map<SessionId, Handle>();
    private readonly handles = new Set<Handle>();
    private readonly listeners: Array<() => void>;

    private readonly options: Options;

    constructor(ctx: Context, options: Options) {
        super(ctx);
        this.options = options;
        this.listeners = [
            ctx.on('session/event', (session, event) =>
                this.writers.get(session.id)?.enqueue(event),
            ),
            ctx.on('session/flush', (session) =>
                this.writers.get(session.id)?.flush(),
            ),
            ctx.on('session/disposed', (session) => {
                this.writers
                    .get(session.id)
                    ?.close()
                    .catch((error: unknown) => ctx.logger.warn(String(error)));
            }),
        ];
    }

    async rpc<T>(
        method: string,
        id?: SessionId,
        fields: Record<string, unknown> = {},
        signal?: AbortSignal,
    ): Promise<T> {
        const timeout = AbortSignal.timeout(10000);
        const response = await fetch(new URL('/rpc', this.options.url), {
            method: 'POST',
            headers: {
                authorization: 'Bearer ' + this.options.token,
                'content-type': 'application/json',
            },
            body: JSON.stringify({ method, id, ...fields }),
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        const result = (await response.json()) as {
            ok: boolean;
            value: T;
            error?: { name: string };
        };
        if (result.ok && response.ok) return result.value;
        const name = result.error?.name;
        if (id) {
            if (response.status === 403 || name === 'SessionOwnershipLostError')
                throw new SessionOwnershipLostError(id);
            if (name === 'SessionAlreadyExistsError')
                throw new SessionAlreadyExistsError(id);
            if (name === 'SessionAlreadyOwnedError')
                throw new SessionAlreadyOwnedError(id);
            if (name === 'SessionPersistenceNotFoundError')
                throw new SessionPersistenceNotFoundError(id);
            if (name === 'SessionReadOnlyError')
                throw new SessionReadOnlyError(id, method);
            if (name === 'SessionHandleClosedError')
                throw new SessionHandleClosedError(id, method);
        }
        throw new Error(
            'Session persistence ' +
                method +
                ' failed: ' +
                (name ?? response.status),
        );
    }

    async create(
        header: SessionHeader,
        options?: Parameters<SessionPersistence['create']>[1],
    ) {
        return this.adopt(
            await this.rpc<HandleData>(
                'create',
                header.id,
                {
                    header,
                    options: {
                        inheritedEventCount: options?.inheritedEventCount,
                    },
                },
                options?.signal,
            ),
        );
    }

    async open(
        id: SessionId,
        access: SessionHandle['access'],
        options?: Parameters<SessionPersistence['open']>[2],
    ) {
        return this.adopt(
            await this.rpc<HandleData>('open', id, { access }, options?.signal),
        );
    }

    stat(id: SessionId, options?: Parameters<SessionPersistence['stat']>[1]) {
        return this.rpc<Snapshot | undefined>('stat', id, {}, options?.signal);
    }

    list(options?: Parameters<SessionPersistence['list']>[0]) {
        return this.rpc<readonly Snapshot[]>(
            'list',
            undefined,
            {},
            options?.signal,
        );
    }

    async flush() {
        const results = await Promise.allSettled(
            [...this.writers.values()].map((handle) => handle.flush()),
        );
        const failures = results.flatMap((result) =>
            result.status === 'rejected' ? [result.reason] : [],
        );
        if (failures.length)
            throw new AggregateError(
                failures,
                'Session persistence flush failed',
            );
    }

    async reconcilePending(id: SessionId) {
        const handle = await this.open(id, 'write');
        const result = await handle.reconcile();
        await handle.close();
        return result;
    }

    async dispose() {
        for (const dispose of this.listeners) dispose();
        const results = await Promise.allSettled(
            [...this.handles].map((handle) => handle.close()),
        );
        const failures = results.flatMap((result) =>
            result.status === 'rejected' ? [result.reason] : [],
        );
        if (failures.length)
            throw new AggregateError(
                failures,
                'Session persistence close failed',
            );
    }

    private adopt(data: HandleData) {
        const handle = new Handle(this, data, () => {
            this.handles.delete(handle);
            if (this.writers.get(handle.id) === handle)
                this.writers.delete(handle.id);
        });
        this.handles.add(handle);
        if (handle.access === 'write') this.writers.set(handle.id, handle);
        return handle;
    }
}

class Handle implements SessionHandle {
    readonly id: SessionId;
    readonly header: SessionHeader;
    readonly inheritedEventCount: SessionHandle['inheritedEventCount'];
    readonly access: SessionHandle['access'];
    private readonly buffer: Event[] = [];
    private chain = Promise.resolve();
    private pending: Batch | undefined;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private closing: Promise<void> | undefined;
    private closed = false;
    private lost = false;

    private readonly service: RemoteSession;
    private readonly data: HandleData;
    private readonly release: () => void;

    constructor(service: RemoteSession, data: HandleData, release: () => void) {
        this.service = service;
        this.data = data;
        this.release = release;
        this.id = data.id;
        this.header = Object.freeze(data.header);
        this.inheritedEventCount = data.inheritedEventCount;
        this.access = data.access;
    }

    enqueue(event: Event) {
        if (this.closed || this.lost) return;
        this.buffer.push(event);
        this.timer ??= setTimeout(() => {
            this.timer = undefined;
            void this.flush().catch(() => {});
        }, 200);
    }

    private async call<T>(
        method: string,
        fields: Record<string, unknown> = {},
        signal?: AbortSignal,
    ) {
        if (this.lost) throw new SessionOwnershipLostError(this.id);
        if (this.closed) throw new SessionHandleClosedError(this.id, method);
        try {
            return await this.service.rpc<T>(
                method,
                this.id,
                { ...fields, key: this.data.key },
                signal,
            );
        } catch (error) {
            if (error instanceof SessionOwnershipLostError) this.lost = true;
            throw error;
        }
    }

    private drain(events: readonly Event[] = []) {
        const extra = JSON.stringify(events);
        const task = this.chain.then(async () => {
            const retry = this.pending;
            if (retry && events.length && retry.extra !== extra)
                throw new Error(
                    'reconcile the previous batch before appending',
                );
            if (retry) await this.settle(retry);
            if (retry && events.length) return;
            const buffered = this.buffer.length;
            const batch = materializeAppendBatch([...this.buffer, ...events]);
            if (!batch.length) return;
            const pending = {
                id: randomUUID(),
                buffered,
                events: batch,
                extra,
                digest: createHash('sha256')
                    .update(JSON.stringify(batch))
                    .digest('hex'),
            };
            this.pending = pending;
            await this.settle(pending);
        });
        this.chain = task.catch(() => {});
        return task;
    }

    private async settle(pending: Batch) {
        const fields = { batch: pending.id, events: pending.events };
        await this.call('stage', fields);
        const receipt = await this.call<Receipt>('append', fields);
        if (
            receipt.batch !== pending.id ||
            receipt.digest !== pending.digest ||
            receipt.first !== pending.events[0]?.seq ||
            receipt.count !== pending.events.length
        )
            throw new Error('Session batch receipt mismatch');
        await this.call('reconcile', { batch: pending.id });
        this.buffer.splice(0, pending.buffered);
        this.pending = undefined;
    }

    reconcile() {
        return this.call('reconcile');
    }

    read(
        offset = 0,
        length?: number,
        options?: Parameters<SessionHandle['read']>[2],
    ) {
        return this.call<Awaited<ReturnType<SessionHandle['read']>>>(
            'read',
            { offset, length },
            options?.signal,
        );
    }

    async append(
        events: readonly Event[],
        options?: Parameters<SessionHandle['append']>[1],
    ) {
        options?.signal?.throwIfAborted();
        if (this.access !== 'write')
            throw new SessionReadOnlyError(this.id, 'append');
        if (this.closed) throw new SessionHandleClosedError(this.id, 'append');
        if (this.lost) throw new SessionOwnershipLostError(this.id);
        await this.drain(events);
    }

    async flush(options?: Parameters<SessionHandle['flush']>[0]) {
        options?.signal?.throwIfAborted();
        if (this.access !== 'write')
            throw new SessionReadOnlyError(this.id, 'flush');
        await this.drain();
        await this.call('flush');
    }

    async close() {
        if (this.closed) return;
        this.closing ??= this.closeOnce().finally(() => {
            this.closing = undefined;
        });
        await this.closing;
    }

    private async closeOnce() {
        clearTimeout(this.timer);
        if (this.access === 'write') await this.drain();
        await this.call('close');
        this.closed = true;
        this.release();
    }

    [Symbol.asyncDispose]() {
        return this.close();
    }
}

export const remoteSessionPersistence = {
    name: 'bento-remote-session-persistence',
    apply(ctx: Context, options: Options) {
        const service = new RemoteSession(ctx, options);
        ctx.effect(() => () => service.dispose(), 'Bento Session persistence');
    },
};

/** Reconcile durable log batches before handing the original Session to DSH AgentLoop. */
export function reconcileSessionPersistence(
    service: SessionPersistence,
    id: SessionId,
) {
    if (!(service instanceof RemoteSession))
        throw new Error('Bento Session persistence required');
    return service.reconcilePending(id);
}
