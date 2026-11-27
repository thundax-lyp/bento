import { ApiError, register } from '@/apps/workspace/workspace-web/src/api.ts';
import { Button, Notice } from '@/apps/workspace/workspace-web/src/ui.tsx';
import { useMutation } from '@tanstack/react-query';
import type { FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';

const errorMessage = (error: unknown) =>
    error instanceof ApiError ? error.message : '暂时无法连接，请稍后重试。';
const fieldClass = 'mt-1 block w-full';

export function Register() {
    const navigate = useNavigate();
    const [search] = useSearchParams();
    const loginUrl = '/login' + (search.size ? '?' + search : '');
    const mutation = useMutation({
        mutationFn: (data: FormData) =>
            register(
                String(data.get('account') ?? ''),
                String(data.get('invite') ?? ''),
                String(data.get('password') ?? ''),
            ),
        onSuccess() {
            return navigate(loginUrl, { replace: true });
        },
    });
    function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        mutation.mutate(new FormData(event.currentTarget));
    }
    return (
        <main className="grid min-h-screen place-items-center bg-zinc-50 px-5">
            <form
                onSubmit={submit}
                className="w-full max-w-sm space-y-5 rounded-2xl border border-zinc-200 bg-white p-8"
            >
                <h1 className="text-2xl font-semibold">受邀注册</h1>
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
                    邀请码
                    <input className={fieldClass} name="invite" required />
                </label>
                <label>
                    新密码
                    <input
                        className={fieldClass}
                        type="password"
                        name="password"
                        autoComplete="new-password"
                        minLength={15}
                        maxLength={128}
                        required
                    />
                </label>
                <p className="text-sm text-zinc-600">
                    使用至少 15 个字符且不同于邀请码的密码。
                </p>
                {mutation.error && (
                    <Notice message={errorMessage(mutation.error)} />
                )}
                <Button primary disabled={mutation.isPending}>
                    注册
                </Button>
                <Link className="ml-3 text-sm underline" to={loginUrl}>
                    返回登录
                </Link>
            </form>
        </main>
    );
}
