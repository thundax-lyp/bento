import { createHash, randomUUID } from 'node:crypto';
import { SessionLogOffset } from '@deepseek-ai/dsh-session';
import {
    SessionAlreadyExistsError,
    SessionAlreadyOwnedError,
    SessionHandleClosedError,
    SessionOwnershipLostError,
    SessionPersistence,
    SessionPersistenceNotFoundError,
    SessionPersistenceRevision,
    assertContiguous,
    assertVersion,
    materializeCreateHeader,
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
type Reconciliation = {
    handle?: Handle;
    result?: { value: unknown };
    inFlight?: Promise<unknown>;
};

type ChildRecord = {
    header: SessionHeader;
    events: Event[];
    revision: string;
    writer?: MemoryHandle;
};

class MemoryHandle implements SessionHandle {
    readonly inheritedEventCount = SessionLogOffset(0);
    private closed = false;

    private readonly record: ChildRecord;
    readonly access: SessionHandle['access'];
    private readonly release: () => void;

    constructor(
        record: ChildRecord,
        access: SessionHandle['access'],
        release: () => void,
    ) {
        this.record = record;
        this.access = access;
        this.release = release;
    }

    get id() {
        return this.record.header.id;
    }

    get header() {
        return materializeCreateHeader(this.record.header);
    }

    private assertOpen(operation: string, signal?: AbortSignal) {
        signal?.throwIfAborted();
        if (this.closed) throw new SessionHandleClosedError(this.id, operation);
    }

    private assertWriter(operation: string, signal?: AbortSignal) {
        this.assertOpen(operation, signal);
        if (this.access !== 'write')
            throw new SessionReadOnlyError(this.id, operation);
        if (this.record.writer !== this)
            throw new SessionOwnershipLostError(this.id);
    }

    async read(
        offset = 0,
        length?: number,
        options?: Parameters<SessionHandle['read']>[2],
    ) {
        this.assertOpen('read', options?.signal);
        if (
            !Number.isSafeInteger(offset) ||
            offset < 0 ||
            (length !== undefined &&
                (!Number.isSafeInteger(length) || length < 0))
        )
            throw new TypeError('Invalid Session read bounds');
        const end = length === undefined ? undefined : offset + length;
        return {
            eventState: 'detached' as const,
            events: materializeAppendBatch(
                this.record.events.slice(offset, end),
            ),
        };
    }

    enqueue(event: Event) {
        if (!this.closed) this.write([event]);
    }

    private write(events: readonly Event[]) {
        const batch = materializeAppendBatch(events);
        assertContiguous(this.id, batch, this.record.events.length);
        for (const event of batch) this.record.events.push(event);
        if (batch.length) this.record.revision = randomUUID();
    }

    async append(
        events: readonly Event[],
        options?: Parameters<SessionHandle['append']>[1],
    ) {
        this.assertWriter('append', options?.signal);
        this.write(events);
    }

    async flush(options?: Parameters<SessionHandle['flush']>[0]) {
        this.assertWriter('flush', options?.signal);
    }

    async close() {
        if (this.closed) return;
        if (this.access === 'write') this.assertWriter('close');
        this.closed = true;
        if (this.record.writer === this) delete this.record.writer;
        this.release();
    }

    [Symbol.asyncDispose]() {
        return this.close();
    }
}

class RemoteSession extends SessionPersistence {
    private readonly writers = new Map<SessionId, Handle | MemoryHandle>();
    private readonly handles = new Set<Handle | MemoryHandle>();
    private readonly reconciliations = new Map<SessionId, Reconciliation>();
    private readonly listeners: Array<() => void>;

    private readonly options: Options;
    private parentId?: SessionId;
    private readonly children = new Map<SessionId, ChildRecord | undefined>();

    bindParent(id: SessionId) {
        if (this.parentId !== undefined)
            throw new Error('Session scope already bound');
        this.parentId = id;
    }

    registerChild(id: SessionId) {
        if (
            this.parentId === undefined ||
            id === this.parentId ||
            this.children.has(id)
        )
            throw new Error('Invalid child Session identity');
        this.children.set(id, undefined);
        return async () => {
            await Promise.all(
                [...this.handles]
                    .filter((handle) => handle.id === id)
                    .map((handle) => handle.close()),
            );
            this.children.delete(id);
        };
    }

    private memoryHandle(record: ChildRecord, access: SessionHandle['access']) {
        if (access === 'write' && record.writer)
            throw new SessionAlreadyOwnedError(record.header.id);
        const handle = new MemoryHandle(record, access, () => {
            this.handles.delete(handle);
            if (this.writers.get(handle.id) === handle)
                this.writers.delete(handle.id);
        });
        this.handles.add(handle);
        if (access === 'write') {
            this.writers.set(handle.id, handle);
            record.writer = handle;
        }
        return handle;
    }

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
        if (
            this.parentId !== undefined &&
            ((id !== undefined && id !== this.parentId) ||
                (fields.header !== undefined &&
                    (fields.header as SessionHeader).id !== this.parentId))
        )
            throw new SessionOwnershipLostError(id ?? this.parentId);
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
        if (this.children.has(header.id)) {
            options?.signal?.throwIfAborted();
            if (this.children.get(header.id))
                throw new SessionAlreadyExistsError(header.id);
            if (header.isSeeded || (options?.inheritedEventCount ?? 0) !== 0)
                throw new Error('Child Session cannot be seeded');
            const stored = materializeCreateHeader(header);
            assertVersion(stored);
            const record = {
                header: stored,
                events: [],
                revision: randomUUID(),
            };
            this.children.set(header.id, record);
            return this.memoryHandle(record, 'write');
        }
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
        if (this.children.has(id)) {
            options?.signal?.throwIfAborted();
            const record = this.children.get(id);
            if (!record) throw new SessionPersistenceNotFoundError(id);
            return this.memoryHandle(record, access);
        }
        return this.openRemote(id, access, options);
    }

    private async openRemote(
        id: SessionId,
        access: SessionHandle['access'],
        options?: Parameters<SessionPersistence['open']>[2],
    ) {
        return this.adopt(
            await this.rpc<HandleData>('open', id, { access }, options?.signal),
        );
    }

    private childSnapshot(record: ChildRecord): Snapshot {
        return {
            header: materializeCreateHeader(record.header),
            formatStatus: 'current',
            revision: SessionPersistenceRevision(record.revision),
            eventCount: record.events.length,
        };
    }

    async stat(
        id: SessionId,
        options?: Parameters<SessionPersistence['stat']>[1],
    ) {
        options?.signal?.throwIfAborted();
        if (this.parentId !== undefined && id !== this.parentId) {
            const record = this.children.get(id);
            return record && this.childSnapshot(record);
        }
        return this.rpc<Snapshot | undefined>('stat', id, {}, options?.signal);
    }

    async list(options?: Parameters<SessionPersistence['list']>[0]) {
        const parent = await this.rpc<readonly Snapshot[]>(
            'list',
            undefined,
            {},
            options?.signal,
        );
        const children = [...this.children.values()].flatMap((record) =>
            record ? [this.childSnapshot(record)] : [],
        );
        return [...parent, ...children];
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

    reconcilePending(id: SessionId) {
        let recovery = this.reconciliations.get(id);
        if (!recovery) {
            recovery = {};
            this.reconciliations.set(id, recovery);
        }
        const pending = recovery;
        pending.inFlight ??= this.finishReconciliation(id, pending).finally(
            () => {
                delete pending.inFlight;
            },
        );
        return pending.inFlight;
    }

    private async finishReconciliation(id: SessionId, pending: Reconciliation) {
        // The server can reject close while a durable batch still needs reconciliation.
        pending.handle ??= await this.openRemote(id, 'write');
        pending.result ??= { value: await pending.handle.reconcile() };
        await pending.handle.close(true);
        this.reconciliations.delete(id);
        return pending.result.value;
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

    async close(allowReleased = false) {
        if (this.closed) return;
        this.closing ??= this.closeOnce(allowReleased).finally(() => {
            this.closing = undefined;
        });
        await this.closing;
    }

    private async closeOnce(allowReleased: boolean) {
        clearTimeout(this.timer);
        if (this.access === 'write') await this.drain();
        try {
            await this.call('close');
        } catch (error) {
            // Reconciliation already succeeded and an earlier close may have lost its reply.
            if (!allowReleased || !(error instanceof SessionHandleClosedError))
                throw error;
        }
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

export function bindWorkerSession(service: SessionPersistence, id: SessionId) {
    if (!(service instanceof RemoteSession))
        throw new Error('Bento Session persistence required');
    service.bindParent(id);
    return (childId: SessionId) => service.registerChild(childId);
}

/** Reconcile durable log batches before handing the original Session to DSH AgentLoop. */
export function reconcileSessionPersistence(
    service: SessionPersistence,
    id: SessionId,
) {
    if (!(service instanceof RemoteSession))
        throw new Error('Bento Session persistence required');
    return service.reconcilePending(id);
}
