import { expect } from '@playwright/test';

async function register(
    page: import('@playwright/test').Page,
    account: string,
    password: string,
) {
    await page.getByRole('link', { name: '使用邀请码注册' }).click();
    const form = page.locator('form').filter({
        has: page.getByRole('heading', { name: '受邀注册', exact: true }),
    });
    await expect(form).toBeVisible();
    await form.getByLabel('账号').fill(account);
    await form.getByLabel('邀请码').fill('demo-invite');
    await form.getByLabel('新密码').fill(password);
    await form.getByRole('button', { name: '注册', exact: true }).click();
    await expect(page).toHaveURL(/\/login(?:\?|$)/);
}

const recoveryProject = {
    id: 'recovery',
    name: '恢复项目',
    status: 'ready',
    createdAt: '2026-11-12T00:00:00Z',
};

const recoveryRoot = '/api/projects/recovery/runs';

const recoveryPatch =
    '--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+new\n';

function recoveryRun(id: string, status: string) {
    return {
        id,
        projectId: recoveryProject.id,
        sessionId: 'recovery-session',
        createdAt: recoveryProject.createdAt,
        updatedAt: recoveryProject.createdAt,
        status,
        summary: '摘要 ' + id,
        prompt: '原要求 ' + id,
    };
}

async function recoveryRoutes(
    target:
        | import('@playwright/test').Page
        | import('@playwright/test').BrowserContext,
    runs: ReturnType<typeof recoveryRun>[] = [],
) {
    await target.route('**/api/session', (route) =>
        route.fulfill({ json: { account: 'recovery-fixture' } }),
    );
    await target.route('**/api/projects', (route) =>
        route.fulfill({ json: { projects: [recoveryProject] } }),
    );
    await target.route('**' + recoveryRoot, (route) =>
        route.fulfill({ json: { runs } }),
    );
}

export {
    register,
    recoveryProject,
    recoveryRoot,
    recoveryPatch,
    recoveryRun,
    recoveryRoutes,
};
