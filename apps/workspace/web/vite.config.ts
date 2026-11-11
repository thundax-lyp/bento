import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
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
                          'http://127.0.0.1:4101',
                  }
                : {}),
            '/api': {
                target: process.env.BENTO_API_TARGET ?? 'http://127.0.0.1:4186',
            },
        },
    },
    test: {
        environment: 'jsdom',
        include: ['src/**/*.test.{ts,tsx}'],
    },
});
