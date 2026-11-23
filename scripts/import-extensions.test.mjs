import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ESLint } from 'eslint';

const eslint = new ESLint();
const message = 'Use an explicit file extension for repository imports.';
for (const specifier of ['./api', '../draft.test', '@/shared/text-snapshot']) {
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
                filePath: 'apps/worker/import-probe.ts',
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
        { filePath: 'apps/worker/import-probe.ts' },
    );
    assert(!result.messages.some((item) => item.message === message));
});
