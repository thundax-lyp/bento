import assert from 'node:assert/strict';
import test from 'node:test';
import type { PublicWorkerEvent } from '@worker/protocol.ts';
import {
    projectTaskChecks,
    type TrustedTaskCheck,
} from '@worker/task/task-projection.ts';

const reply = { offset: 4, kind: 'agent_reply', text: 'base' } as const;
const pass = { version: 1, offset: 0, outcome: 'pass' } as const;

test('projects the four outcomes, replaces one visible slot, and sorts by offset', () => {
    const visible = [
        reply,
        { offset: 0, kind: 'command', text: '检查' },
    ] as const;
    const checks = [
        { version: 1, offset: 3, outcome: 'unavailable' },
        { version: 1, offset: 2, outcome: 'skip' },
        { version: 1, offset: 1, outcome: 'fail' },
        pass,
    ] as const;
    const name = '工作区内容检查';
    assert.deepEqual(projectTaskChecks(5, visible, checks), [
        {
            offset: 0,
            kind: 'check',
            name,
            status: 'passed',
            output: '内容与预期一致',
        },
        {
            offset: 1,
            kind: 'check',
            name,
            status: 'failed',
            output: '内容与预期不同',
        },
        { offset: 2, kind: 'check', name, status: 'not_run', output: null },
        {
            offset: 3,
            kind: 'check',
            name,
            status: 'unavailable',
            output: '无法读取检查目标',
        },
        reply,
    ]);
    assert.equal(visible.length, 2);
    assert.equal(checks[0].offset, 3);
});

test('keeps a read-only reply without inventing a check', () => {
    assert.deepEqual(projectTaskChecks(5, [reply], []), [reply]);
});

test('rejects invalid counts, offsets, duplicate slots and already projected checks', () => {
    for (const count of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1])
        assert.throws(
            () => projectTaskChecks(count, [], []),
            /Invalid Task event count/,
        );
    for (const offset of [-1, 0.5, 5]) {
        assert.throws(() => projectTaskChecks(5, [{ ...reply, offset }], []));
        assert.throws(() => projectTaskChecks(5, [], [{ ...pass, offset }]));
    }
    assert.throws(() => projectTaskChecks(5, [reply, reply], []));
    assert.throws(() => projectTaskChecks(5, [], [pass, pass]));
    assert.throws(() =>
        projectTaskChecks(
            5,
            [
                {
                    offset: 0,
                    kind: 'check',
                    name: 'existing',
                    status: 'passed',
                    output: null,
                },
            ],
            [],
        ),
    );
});

test('rejects invalid proof versions, outcomes and private fields without echoing them', () => {
    const secret = 'synthetic-task-projection-secret';
    const invalid = [
        { ...pass, version: 2 },
        { ...pass, outcome: 'toString' },
        { ...pass, privateOutput: secret },
    ];
    for (const proof of invalid) {
        assert.throws(
            () => projectTaskChecks(5, [], [proof as TrustedTaskCheck]),
            { message: 'Invalid trusted Task check' },
        );
    }
    const privateEvent = { ...reply, rawArguments: secret };
    assert.throws(
        () => projectTaskChecks(5, [privateEvent as PublicWorkerEvent], []),
        { message: 'Invalid Task event' },
    );
});
