import { test } from 'node:test';
import { runCrashCase } from './provider-lifecycle/crash-fixture.ts';

for (const point of ['before-commit', 'after-commit'] as const) {
    test(`A2-04 ${point} SIGKILL is atomic`, { timeout: 60_000 }, async (t) => {
        await runCrashCase(point, t);
    });
}

for (const [point, name] of [
    ['after-stage', 'A2-05 caller SIGKILL after-stage is discovered'],
    [
        'after-append',
        'A2-05 caller SIGKILL after-append preserves original receipt',
    ],
] as const) {
    test(name, { timeout: 60_000 }, async (t) => {
        await runCrashCase(point, t);
    });
}
