import hooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import base from '../../../eslint.config.mjs';

export default [
    {
        ignores: [
            'dist/**',
            'coverage/**',
            'playwright-report/**',
            'test-results/**',
        ],
    },
    ...base,
    {
        files: ['src/**/*.{ts,tsx}'],
        languageOptions: { globals: globals.browser },
        plugins: { 'react-hooks': hooks },
        rules: {
            'react-hooks/rules-of-hooks': 'error',
            'react-hooks/exhaustive-deps': 'error',
        },
    },
];
