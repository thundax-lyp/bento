import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import imports from './scripts/import-rules.mjs';

export default tseslint.config(
    {
        ignores: [
            'dist/**',
            'coverage/**',
            '**/DRAFT.md',
            'debug-workspace/**',
            '**/.idea/**',
            '**/cache/**',
        ],
    },
    js.configs.recommended,
    tseslint.configs.recommended,
    prettier,
    {
        files: ['**/*.{ts,tsx,mts,cts,js,mjs,cjs}'],
        plugins: { bento: imports },
        rules: {
            'bento/public-workspace-imports': 'error',
            'bento/repository-import-paths': 'error',
        },
    },
);
