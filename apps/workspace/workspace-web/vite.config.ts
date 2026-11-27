import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
    resolve: { tsconfigPaths: true },
    plugins: [react(), tailwindcss()],
    server: {
        host: '127.0.0.1',
        port: 4185,
        strictPort: true,
        proxy: {
            ...(process.env.VITE_BENTO_KEYCLOAK_AUTH === '1'
                ? {
                      '^/auth(?:/|$|\\?)':
                          process.env.BENTO_API_TARGET ??
                          'http://127.0.0.1:4102',
                  }
                : {}),
            '/api': {
                target: process.env.BENTO_API_TARGET ?? 'http://127.0.0.1:4186',
            },
        },
    },
    test: {
        environment: 'jsdom',
        include: ['tests/**/*.test.{ts,tsx}'],
        exclude: [...configDefaults.exclude, 'tests/acceptance/**'],
    },
});
