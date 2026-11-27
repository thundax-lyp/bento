import { defineConfig } from '@playwright/test';
import acceptanceConfig from './playwright.web-a13.config.ts';

export default defineConfig(acceptanceConfig, {
    testMatch: '**/web-05-environment.spec.ts',
});
