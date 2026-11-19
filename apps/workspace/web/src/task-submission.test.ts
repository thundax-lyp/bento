import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { createTask, createTaskRun } from './api.ts';

let calls: { key: string; body: string; path: string }[];
let outcome: 'network' | number;
beforeEach(() => {
    sessionStorage.clear();
    calls = [];
    outcome = 'network';
    vi.stubGlobal('crypto', webcrypto);
    vi.stubGlobal(
        'fetch',
        vi.fn(async (path: string, init: RequestInit) => {
            calls.push({
                path,
                key: (init.headers as Record<string, string>)[
                    'Idempotency-Key'
                ]!,
                body: init.body as string,
            });
            if (outcome === 'network')
                throw new TypeError('Network interrupted');
            return new Response(
                JSON.stringify(
                    outcome >= 400
                        ? { error: { code: 'conflict', message: 'Rejected' } }
                        : { task: { id: 'task' }, run: { id: 'run' } },
                ),
                { status: outcome },
            );
        }),
    );
});
afterEach(() => vi.unstubAllGlobals());

for (const kind of ['task', 'run'] as const) {
    test(`${kind}: unknown responses retain the original key across module reload; success and 4xx clear it`, async () => {
        const submit = () =>
            kind === 'task'
                ? createTask('a', ' Name ', { kind: 'blank' })
                : createTaskRun('a', 'task', ' Prompt ');
        await expect(submit()).rejects.toThrow();
        const key = calls[0]!.key;
        expect(sessionStorage.length).toBe(1);
        outcome = 502;
        await expect(submit()).rejects.toThrow();
        expect(calls.at(-1)!.key).toBe(key);
        vi.resetModules();
        const reloaded = await import('./api.ts');
        outcome = 200;
        await (kind === 'task'
            ? reloaded.createTask('a', 'Name', { kind: 'blank' })
            : reloaded.createTaskRun('a', 'task', 'Prompt'));
        expect(calls.at(-1)!.key).toBe(key);
        expect(calls.at(-1)!.body).toBe(calls[0]!.body);
        expect(sessionStorage.length).toBe(0);
        outcome = 409;
        await expect(submit()).rejects.toThrow();
        const rejectedKey = calls.at(-1)!.key;
        expect(rejectedKey).not.toBe(key);
        expect(sessionStorage.length).toBe(0);
        await expect(submit()).rejects.toThrow();
        expect(calls.at(-1)!.key).not.toBe(rejectedKey);
    });
}

test('unknown Run keys are isolated by account, Task and normalized body', async () => {
    for (const [account, task, prompt] of [
        ['a', 'one', 'First'],
        ['b', 'one', 'First'],
        ['a', 'two', 'First'],
        ['a', 'one', 'Other'],
    ])
        await expect(createTaskRun(account!, task!, prompt!)).rejects.toThrow();
    expect(new Set(calls.map((c) => c.key)).size).toBe(4);
    await expect(createTaskRun('a', 'one', ' First ')).rejects.toThrow();
    expect(calls.at(-1)!.key).toBe(calls[0]!.key);
});

test('snapshot file order is canonical and distinct creation bodies and accounts are isolated', async () => {
    await expect(
        createTask('a', 'Name', {
            kind: 'space_snapshot',
            spaceId: 'space',
            fileIds: ['b', 'a'],
        }),
    ).rejects.toThrow();
    await expect(
        createTask('a', ' Name ', {
            kind: 'space_snapshot',
            spaceId: 'space',
            fileIds: ['a', 'b'],
        }),
    ).rejects.toThrow();
    expect(calls[1]!.key).toBe(calls[0]!.key);
    expect(JSON.parse(calls[1]!.body).source.fileIds).toEqual(['a', 'b']);
    await expect(
        createTask('b', 'Name', {
            kind: 'space_snapshot',
            spaceId: 'space',
            fileIds: ['a', 'b'],
        }),
    ).rejects.toThrow();
    await expect(
        createTask('a', 'Other', {
            kind: 'space_snapshot',
            spaceId: 'space',
            fileIds: ['a', 'b'],
        }),
    ).rejects.toThrow();
    expect(new Set(calls.map((c) => c.key)).size).toBe(3);
});
