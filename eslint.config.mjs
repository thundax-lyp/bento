import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

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
        files: ['**/*.{ts,tsx,mts,cts}'],
        rules: {
            'no-restricted-imports': [
                'error',
                {
                    patterns: [
                        {
                            regex: '^\\.\\./\\.\\.(?:/|$)',
                            message:
                                'Use @/ for imports that cross two or more parent directories.',
                        },
                    ],
                },
            ],
            'no-restricted-syntax': [
                'error',
                {
                    selector:
                        ':matches(ImportExpression > .source, TSImportType > .source)[value=/^\\.\\.\\/\\.\\.(?:\\/|$)/]',
                    message:
                        'Use @/ for imports that cross two or more parent directories.',
                },
            ],
        },
    },
);
