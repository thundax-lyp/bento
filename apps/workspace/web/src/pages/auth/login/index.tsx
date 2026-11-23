import { ApiError, login, sessionQuery } from '@/apps/workspace/web/src/api.ts';
import { Button, Notice } from '@/apps/workspace/web/src/ui.tsx';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';

const errorMessage = (error: unknown) =>
    error instanceof ApiError ? error.message : '暂时无法连接，请稍后重试。';
const fieldClass = 'mt-1 block w-full';

export function Login() {
    const client = useQueryClient();
    const navigate = useNavigate();
    const [search] = useSearchParams();
    const mutation = useMutation({
        mutationFn: ({
            account,
            password,
        }: {
            account: string;
            password: string;
        }) => login(account, password),
        async onSuccess(session) {
            await client.cancelQueries();
            client.clear();
            client.setQueryData(sessionQuery.queryKey, session);
            const next = search.get('next');
            await navigate(
                next?.startsWith('/') &&
                    !next.startsWith('//') &&
                    !next.includes('\\') &&
                    !next.startsWith('/login')
                    ? next
                    : '/',
                { replace: true },
            );
        },
    });
    function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        mutation.mutate({
            account: String(data.get('account') ?? ''),
            password: String(data.get('password') ?? ''),
        });
    }
    return (
        <main className="grid min-h-screen place-items-center bg-zinc-50 px-5">
            <form
                onSubmit={submit}
                className="w-full max-w-sm space-y-5 rounded-2xl border border-zinc-200 bg-white p-8"
            >
                <div className="space-y-2">
                    <p className="font-semibold">◇ Bento</p>
                    <h1 className="text-2xl font-semibold">登录工作台</h1>
                    <p className="text-sm text-zinc-600">
                        使用注册时设置的密码登录。
                    </p>
                </div>
                <label>
                    账号
                    <input
                        className={fieldClass}
                        name="account"
                        autoComplete="username"
                        required
                    />
                </label>
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
                {mutation.error && (
                    <Notice message={errorMessage(mutation.error)} />
                )}
                <Button
                    primary
                    className="w-full"
                    disabled={mutation.isPending}
                >
                    {mutation.isPending ? '正在登录…' : '登录'}
                </Button>
                <Link
                    className="block text-sm underline"
                    to={'/register' + (search.size ? '?' + search : '')}
                >
                    使用邀请码注册
                </Link>
                {search.get('closed') === '1' && (
                    <p role="status" className="text-sm">
                        账号已关闭，已提交的任务结束后会清理数据。
                    </p>
                )}
            </form>
        </main>
    );
}
