import { constants } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

async function authenticate(page: Page) {
    const path = process.env.BENTO_A5_LOGIN_FILE;
    if (!path || !isAbsolute(path)) throw new Error('A5 login input missing');
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let credentials: { username: string; password: string };
    try {
        const stat = await file.stat();
        if (!stat.isFile() || (stat.mode & 0o777) !== 0o600)
            throw new Error('A5 login input must be a private regular file');
        credentials = JSON.parse(await file.readFile('utf8'));
    } finally {
        await file.close();
    }
    await page.goto('/auth');
    await page.getByRole('link', { name: '受邀用户登录' }).click();
    await page.locator('#username').fill(credentials.username);
    const password = page.locator('#password');
    if (!(await password.isVisible())) await page.locator('#kc-login').click();
    await password.fill(credentials.password);
    await page.locator('#kc-login').click();
    await expect(page).toHaveURL('http://127.0.0.1:24881/');
    expect((await page.request.get('/api/session')).status()).toBe(200);
}

test('A5 denies disabled PTY and SSH to a live Task lease', async ({
    page,
}) => {
    const evidence = process.env.BENTO_A5_DISABLED_EVIDENCE;
    if (!evidence || !isAbsolute(evidence))
        throw new Error('A5 disabled-entrypoint evidence path missing');
    await authenticate(page);
    const resumeTask = process.env.BENTO_A5_T2_RESUME_EMPTY_TASK;
    let task: { id: string };
    if (resumeTask) {
        expect(resumeTask).toMatch(/^[a-f0-9-]{36}$/);
        task = { id: resumeTask };
        await page.goto('/tasks/' + encodeURIComponent(task.id));
    } else {
        await page.getByLabel('任务名称').fill('A5 禁用入口验证');
        const create = page.waitForResponse(
            (response) =>
                new URL(response.url()).pathname === '/api/tasks' &&
                response.request().method() === 'POST',
        );
        await page.getByRole('button', { name: '创建空白任务' }).click();
        const created = await create;
        expect(created.status()).toBe(202);
        ({ task } = await created.json());
    }
    const route = '/api/tasks/' + encodeURIComponent(task.id) + '/runs';
    await expect
        .poll(
            async () =>
                (await readFile(evidence, 'utf8'))
                    .split('\n')
                    .includes(
                        'A5_T2_BEFORE ' + task.id + ' sdk=0 ssh=0 marker=0',
                    ),
            { timeout: 90_000 },
        )
        .toBe(true);
    const prompt = page.getByLabel('任务要求');
    await expect(prompt).toBeEnabled({ timeout: 90_000 });
    const marker = process.env.BENTO_A5_T2_SENTINEL;
    if (!marker || !/^[a-f0-9-]{36}$/.test(marker))
        throw new Error('A5 T2 acceptance sentinel missing');
    await prompt.fill('A5-T2 ' + marker + '\n请仅回复 A5 完成，不执行工具。');
    const submit = page.waitForResponse(
        (response) =>
            new URL(response.url()).pathname === route &&
            response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: '发送要求' }).click();
    const accepted = await submit;
    expect(accepted.status()).toBe(202);
    const { run } = await accepted.json();
    expect(run).toMatchObject({ taskId: task.id, sequence: 1 });
    await expect
        .poll(
            async () => {
                const lines = await readFile(evidence, 'utf8');
                return lines
                    .split('\n')
                    .filter(
                        (line) =>
                            line ===
                            `A5_T2 ${run.id} ${marker} get=ok pty=7 ssh=7 get=ok`,
                    ).length;
            },
            { timeout: 90_000 },
        )
        .toBe(1);
    await expect
        .poll(
            async () =>
                (await readFile(evidence, 'utf8'))
                    .split('\n')
                    .includes(
                        'A5_T2_AFTER ' +
                            run.id +
                            ' sdk=0 ssh=0 marker=0 same-containers=1',
                    ),
            { timeout: 90_000 },
        )
        .toBe(true);
});
