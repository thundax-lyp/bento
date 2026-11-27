import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

async function login(page: Page) {
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
    try {
        await page.locator('#username').fill(credentials.username);
        const password = page.locator('#password');
        if (!(await password.isVisible()))
            await page.locator('#kc-login').click();
        await password.fill(credentials.password);
        await page.locator('#kc-login').click();
    } catch {
        throw new Error('Could not submit the isolated A5 login');
    }
    await expect(page).toHaveURL('http://127.0.0.1:24881/');
    expect((await page.request.get('/api/session')).status()).toBe(200);
}

async function post(page: Page, route: string, button: string) {
    const reply = page.waitForResponse(
        (response) =>
            new URL(response.url()).pathname === route &&
            response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: button, exact: true }).click();
    const accepted = await reply;
    expect(accepted.status()).toBe(202);
    return accepted.json();
}

async function exerciseTools(page: Page, ptc: boolean) {
    await login(page);
    const marker = 'a5-' + randomUUID();
    await page
        .getByLabel('任务名称')
        .fill(ptc ? 'A5 真实四工具' : 'A5 真实工具前缀');
    const { task } = await post(page, '/api/tasks', '创建空白任务');
    const taskPath = '/tasks/' + encodeURIComponent(task.id);
    await expect(page).toHaveURL('http://127.0.0.1:24881' + taskPath);
    const input = page.getByLabel('任务要求');
    await expect(input).toBeEnabled({ timeout: 90_000 });
    await input.fill(
        [
            '请严格按顺序执行' +
                (ptc ? '四' : '三') +
                '个工具，并等待上一个工具的真实结果。',
            '先调用 a5_file，marker 为 ' + marker + '。',
            '接着调用 a5_bash，使用完全相同的 marker。',
            '接着调用 a5_child，让子 Agent 读取同一个 Bash marker。',
            ...(ptc
                ? [
                      '最后调用 a5_ptc。program 填写以下 TypeScript 函数体：const marker = await a5.read({}); await a5.verify({marker}); return marker;',
                  ]
                : []),
            '完成后仅回复 A5 完成。',
        ].join('\n'),
    );
    const route = '/api' + taskPath + '/runs';
    const { run } = await post(page, route, '发送要求');
    expect(run).toMatchObject({ taskId: task.id, sequence: 1 });
    let terminal: string | undefined;
    await expect
        .poll(
            async () => {
                const response = await page.request.get(
                    route + '/' + encodeURIComponent(run.id),
                );
                expect(response.status()).toBe(200);
                const payload = await response.json();
                terminal = (payload.run ?? payload).status;
                return [
                    'succeeded',
                    'failed',
                    'cancelled',
                    'needs_review',
                ].includes(terminal ?? '');
            },
            { timeout: 180_000 },
        )
        .toBe(true);
    expect(terminal).toBe('succeeded');
    const response = await page.request.get(
        '/api' + taskPath + '/events?after=0',
    );
    expect(response.status()).toBe(200);
    const { items } = (await response.json()) as {
        items: { runId: string; text?: string }[];
    };
    const events = items
        .filter((event) => event.runId === run.id)
        .map((event) => event.text);
    for (const name of ['file', 'bash', 'child', ...(ptc ? ['ptc'] : [])])
        expect(
            events.filter((text) => text === 'A5 ' + name + ' 工具完成'),
        ).toHaveLength(1);
    console.log(
        ptc
            ? 'A5 four tools candidate evidence'
            : 'A5 prefix candidate evidence',
        JSON.stringify({ taskId: task.id, runId: run.id, marker }),
    );
}

test('A5 prefix calls the file, Bash and child tools in one model turn', async ({
    page,
}) => {
    await exerciseTools(page, false);
});

test('A5 four tools complete in one real model turn', async ({ page }) => {
    await exerciseTools(page, true);
});
