import { publicTaskEventBatch, type PublicWorkerEvent } from './protocol.ts';

export type TrustedTaskCheck = {
    version: 1;
    offset: number;
    outcome: 'pass' | 'fail' | 'skip' | 'unavailable';
};

type Check = Extract<PublicWorkerEvent, { kind: 'check' }>;
const outcomes = {
    pass: { status: 'passed', output: '内容与预期一致' },
    fail: { status: 'failed', output: '内容与预期不同' },
    skip: { status: 'not_run', output: null },
    unavailable: { status: 'unavailable', output: '无法读取检查目标' },
} as const satisfies Record<
    TrustedTaskCheck['outcome'],
    Pick<Check, 'status' | 'output'>
>;

export function projectTaskChecks(
    eventCount: number,
    visible: readonly PublicWorkerEvent[],
    checks: readonly TrustedTaskCheck[],
): readonly PublicWorkerEvent[] {
    if (!Number.isSafeInteger(eventCount) || eventCount < 0)
        throw new Error('Invalid Task event count');

    function validOffset(offset: number) {
        return (
            Number.isSafeInteger(offset) && offset >= 0 && offset < eventCount
        );
    }

    const events = new Map<number, PublicWorkerEvent>();
    for (const input of visible) {
        const [event] = publicTaskEventBatch({ items: [input] });
        if (
            !event ||
            event.kind === 'check' ||
            !validOffset(event.offset) ||
            events.has(event.offset)
        )
            throw new Error('Invalid visible Task event');
        events.set(event.offset, event);
    }

    const checked = new Set<number>();
    for (const proof of checks) {
        if (
            !proof ||
            typeof proof !== 'object' ||
            Array.isArray(proof) ||
            Reflect.ownKeys(proof).length !== 3 ||
            !Object.hasOwn(proof, 'version') ||
            !Object.hasOwn(proof, 'offset') ||
            !Object.hasOwn(proof, 'outcome') ||
            proof.version !== 1 ||
            !validOffset(proof.offset) ||
            checked.has(proof.offset) ||
            typeof proof.outcome !== 'string' ||
            !Object.hasOwn(outcomes, proof.outcome)
        )
            throw new Error('Invalid trusted Task check');
        checked.add(proof.offset);
        events.set(proof.offset, {
            offset: proof.offset,
            kind: 'check',
            name: '工作区内容检查',
            ...outcomes[proof.outcome],
        });
    }

    return [...events.values()].sort((a, b) => a.offset - b.offset);
}
