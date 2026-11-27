import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ESLint } from 'eslint';

const eslint = new ESLint();
const message = 'Use an explicit file extension for repository imports.';
for (const specifier of [
    './api',
    '../draft.test',
    '@/shared/text-snapshot',
    '@worker/protocol',
    '@orchestrator/openshell/single-host',
    '@workspace-web/api',
    '@workspace-api-fixture/protocol',
    '@bento/worker/protocol',
]) {
    for (const source of [
        `import { value } from '${specifier}';`,
        `export { value } from '${specifier}';`,
        `export * from '${specifier}';`,
        `import '${specifier}';`,
        `const value = import('${specifier}');`,
        `type Value = import('${specifier}').Value;`,
    ]) {
        test(`rejects ${source}`, async () => {
            const [result] = await eslint.lintText(source, {
                filePath: 'apps/worker/src/import-probe.ts',
            });
            assert(result.messages.some((item) => item.message === message));
        });
    }
}
test('accepts explicit source and asset extensions and package imports', async () => {
    const [result] = await eslint.lintText(
        `
        import './module.ts'; import './view.tsx'; import './style.css';
        export * from '@/shared/text-snapshot.ts';
        const value = import('./module.test.ts');
        type Value = import('./module.ts').Value;
        import 'node:fs'; import '@tanstack/react-query';
    `,
        { filePath: 'apps/worker/src/import-probe.ts' },
    );
    assert(!result.messages.some((item) => item.message === message));
});

const boundaryRule = 'bento/public-workspace-imports';
const pathRule = 'bento/repository-import-paths';
const hostSource =
    'apps/orchestrator/orchestrator-execution-host/src/import-probe.ts';

async function messages(source, filePath = hostSource) {
    const [result] = await eslint.lintText(source, { filePath });
    return result.messages;
}

for (const specifier of [
    '@/apps/worker/src/protocol.ts',
    '@worker/protocol.ts',
    '../../../worker/src/protocol.ts',
    '@bento/worker/src/protocol.ts',
    '@bento/worker/runtime/private.ts',
]) {
    for (const source of [
        `import type { Binding } from '${specifier}';`,
        `export * from '${specifier}';`,
        `export type { Binding } from '${specifier}';`,
        `const api = import('${specifier}');`,
        `type Binding = import('${specifier}').Binding;`,
    ]) {
        test(`enforces workspace exports for ${source}`, async () => {
            assert(
                (await messages(source)).some(
                    (item) => item.ruleId === boundaryRule,
                ),
            );
        });
    }
}

test('accepts a declared Worker export and an alias within the same package', async () => {
    const result = await messages(`
        export type { Binding } from '@bento/worker/protocol.ts';
        export * from '@orchestrator/execution-service/types.ts';
    `);
    assert.deepEqual(result, []);
});

test('allows fixture aliases and rejects direct src paths in tests', async () => {
    const file = 'apps/worker/tests/import-probe.test.ts';
    assert.deepEqual(
        await messages(
            "import '@orchestrator/openshell/single-host.ts';",
            file,
        ),
        [],
    );
    const direct = await messages("export * from '../src/protocol.ts';", file);
    assert(
        direct.some(
            (item) =>
                item.ruleId === pathRule && item.messageId === 'sourceAlias',
        ),
    );
    assert(!direct.some((item) => item.ruleId === boundaryRule));
});

test('applies the public entry rule to JavaScript source too', async () => {
    const result = await messages(
        "export * from '@worker/protocol.ts';",
        hostSource.replace(/\.ts$/, '.mjs'),
    );
    assert(result.some((item) => item.ruleId === boundaryRule));
});
