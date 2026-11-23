import { ApiError, closeAccount } from '@/apps/workspace/web/src/api.ts';
import { Button, Notice } from '@/apps/workspace/web/src/ui.tsx';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router';

const errorMessage = (error: unknown) =>
    error instanceof ApiError ? error.message : '暂时无法连接，请稍后重试。';
const fieldClass = 'mt-1 block w-full';

export function AccountSettings() {
    const client = useQueryClient();
    const navigate = useNavigate();
    const close = useMutation({
        mutationFn: closeAccount,
        async onSuccess() {
            await client.cancelQueries();
            client.clear();
            await navigate('/login?closed=1', { replace: true });
        },
    });
    function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        if (data.get('confirm') === 'on')
            close.mutate(String(data.get('password') ?? ''));
    }
    return (
        <main className="mx-auto max-w-3xl space-y-5 px-5 py-10">
            <h1 className="text-2xl font-semibold">账号设置</h1>
            <form
                onSubmit={submit}
                className="space-y-4 rounded-xl border border-zinc-200 p-5"
            >
                <h2 className="text-lg font-semibold">注销账号</h2>
                <p className="text-sm text-zinc-700">
                    确认后立即失去登录权限。已提交的任务会先结束，随后清理项目、工作区、文件、任务记录和
                    diff。清理完成后无法恢复。
                </p>
                <label>
                    密码
                    <input
                        className={fieldClass}
                        name="password"
                        type="password"
                        autoComplete="current-password"
                        required
                    />
                </label>
                <label className="flex items-center gap-2">
                    <input name="confirm" type="checkbox" required />
                    我已了解注销后果
                </label>
                <Button primary disabled={close.isPending}>
                    确认注销账号
                </Button>
                {close.error && <Notice message={errorMessage(close.error)} />}
            </form>
        </main>
    );
}
