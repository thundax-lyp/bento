import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import { TextDecoder } from 'node:util';

type RecordBase = { kind: string; pid: number };
type Failure =
    | 'trace-json'
    | 'trace-record'
    | 'trace-utf8'
    | 'trace-incomplete-eof'
    | 'trace-truncated'
    | 'trace-rewritten'
    | 'trace-replaced'
    | 'trace-file'
    | 'trace-too-large'
    | 'trace-assertion'
    | 'trace-unknown'
    | `trace-io-${string}`;
class TraceFailure extends Error {
    readonly code: Failure;
    constructor(code: Failure) {
        super('Acceptance trace failure: ' + code);
        this.code = code;
    }
}
function fail(code: Failure): never {
    throw new TraceFailure(code);
}
export function traceFailureCode(error: unknown): Failure {
    if (error instanceof TraceFailure) return error.code;
    if (error instanceof SyntaxError) return 'trace-json';
    const code =
        error && typeof error === 'object' && 'code' in error
            ? error.code
            : undefined;
    if (code === 'ERR_ASSERTION') return 'trace-assertion';
    if (
        typeof code === 'string' &&
        [
            'ENOENT',
            'EACCES',
            'EPERM',
            'EMFILE',
            'ENFILE',
            'EIO',
            'ENOSPC',
            'ELOOP',
            'EISDIR',
            'EBADF',
        ].includes(code)
    )
        return `trace-io-${code}`;
    return 'trace-unknown';
}

/** Same-inode, append-only snapshots. Incomplete tails are pending until EOF. */
export class TraceCursor<T extends RecordBase> {
    private identity: string | undefined;
    private previous = Buffer.alloc(0);
    private offset = 0;
    private records: T[] = [];
    consume(bytes: Uint8Array, identity: string, eof = false): T[] {
        const snapshot = Buffer.from(bytes);
        if (this.identity !== undefined && identity !== this.identity)
            fail('trace-replaced');
        if (snapshot.length < this.previous.length) fail('trace-truncated');
        if (!snapshot.subarray(0, this.previous.length).equals(this.previous))
            fail('trace-rewritten');
        const end = snapshot.lastIndexOf(10) + 1;
        const fresh: T[] = [];
        let start = this.offset;
        while (start < end) {
            const next = snapshot.indexOf(10, start);
            let line: string;
            try {
                line = new TextDecoder('utf-8', { fatal: true }).decode(
                    snapshot.subarray(start, next),
                );
            } catch {
                fail('trace-utf8');
            }
            let value: unknown;
            try {
                value = JSON.parse(line);
            } catch {
                fail('trace-json');
            }
            if (
                !value ||
                typeof value !== 'object' ||
                Array.isArray(value) ||
                !('kind' in value) ||
                typeof value.kind !== 'string' ||
                !value.kind ||
                !('pid' in value) ||
                !Number.isSafeInteger(value.pid) ||
                Number(value.pid) <= 0
            )
                fail('trace-record');
            fresh.push(value as T);
            start = next + 1;
        }
        if (eof && end !== snapshot.length) fail('trace-incomplete-eof');
        this.identity = identity;
        this.previous = snapshot;
        this.offset = end;
        this.records.push(...fresh);
        return [...this.records];
    }
}

/** Serialize open/read/commit so concurrent consumers cannot apply stale snapshots. */
export function createTraceReader<T extends RecordBase>(path: string) {
    const cursor = new TraceCursor<T>();
    let queue: Promise<void> = Promise.resolve();
    return (eof = false): Promise<T[]> => {
        const result = queue
            .then(async () => {
                let file: Awaited<ReturnType<typeof fs.open>> | undefined;
                try {
                    file = await fs.open(
                        path,
                        constants.O_RDONLY | constants.O_NOFOLLOW,
                    );
                    const before = await file.stat({ bigint: true });
                    const limit = 4 * 1024 * 1024;
                    if (!before.isFile() || before.nlink !== 1n)
                        fail('trace-file');
                    if (before.size > BigInt(limit)) fail('trace-too-large');
                    const chunks: Buffer[] = [];
                    const buffer = Buffer.alloc(65536);
                    let size = 0;
                    while (true) {
                        const { bytesRead } = await file.read(
                            buffer,
                            0,
                            Math.min(buffer.length, limit + 1 - size),
                            null,
                        );
                        if (!bytesRead) break;
                        size += bytesRead;
                        if (size > limit) fail('trace-too-large');
                        chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
                    }
                    const after = await file.stat({ bigint: true });
                    const named = await fs.lstat(path, { bigint: true });
                    if (
                        !after.isFile() ||
                        after.nlink !== 1n ||
                        !named.isFile() ||
                        named.nlink !== 1n
                    )
                        fail('trace-file');
                    if (
                        before.dev !== after.dev ||
                        before.ino !== after.ino ||
                        before.dev !== named.dev ||
                        before.ino !== named.ino
                    )
                        fail('trace-replaced');
                    if (after.size > BigInt(limit)) fail('trace-too-large');
                    return cursor.consume(
                        Buffer.concat(chunks),
                        `${before.dev}:${before.ino}`,
                        eof,
                    );
                } finally {
                    await file?.close();
                }
            })
            .catch((error: unknown) => {
                throw new TraceFailure(traceFailureCode(error));
            });
        queue = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    };
}
