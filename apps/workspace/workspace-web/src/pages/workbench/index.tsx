import type { Session } from '@/apps/workspace/workspace-web/src/api.ts';
import {
    ApiError,
    logout,
    sessionQuery,
} from '@/apps/workspace/workspace-web/src/api.ts';
import { Button, Notice } from '@/apps/workspace/workspace-web/src/ui.tsx';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
    Link,
    Navigate,
    NavLink,
    Outlet,
    useLoaderData,
    useLocation,
    useNavigate,
} from 'react-router';

const errorMessage = (error: unknown) =>
    error instanceof ApiError ? error.message : '暂时无法连接，请稍后重试。';

export function Workbench() {
    const initial = useLoaderData<Session>();
    const session = useQuery({ ...sessionQuery, initialData: initial });
    const client = useQueryClient();
    const navigate = useNavigate();
    const location = useLocation();
    const exit = useMutation({
        mutationFn: logout,
        async onSuccess() {
            await client.cancelQueries();
            client.clear();
            await navigate('/login', { replace: true });
        },
    });
    if (session.error instanceof ApiError && session.error.status === 401) {
        return (
            <Navigate
                to={
                    '/login?' +
                    new URLSearchParams({
                        next: location.pathname + location.search,
                    })
                }
                replace
            />
        );
    }
    const account = session.data.account;
    const menu = ({ isActive }: { isActive: boolean }) =>
        'block rounded-lg px-3 py-2 text-sm ' +
        (isActive
            ? 'bg-zinc-200 font-medium text-zinc-900'
            : 'text-zinc-700 hover:bg-zinc-100');
    return (
        <div className="min-h-screen md:grid md:grid-cols-[13rem_minmax(0,1fr)]">
            <aside className="border-b border-zinc-200 bg-zinc-50 p-4 md:border-r md:border-b-0">
                <Link to="/" className="mb-5 block text-lg font-semibold">
                    ◇ Bento
                </Link>
                <nav
                    aria-label="工作台导航"
                    className="flex flex-wrap gap-1 md:block md:space-y-1"
                >
                    <NavLink end to="/" className={menu}>
                        对话
                    </NavLink>
                    <NavLink end to="/runs" className={menu}>
                        任务
                    </NavLink>
                    <NavLink to="/workspaces" className={menu}>
                        Workspace
                    </NavLink>
                    <span className="block px-3 py-2 text-sm text-zinc-500">
                        计划任务 · 待接入
                    </span>
                    <span className="block px-3 py-2 text-sm text-zinc-500">
                        Skill · 待接入
                    </span>
                </nav>
            </aside>
            <div className="min-w-0">
                <header className="flex min-h-15 items-center justify-between gap-3 border-b border-zinc-200 px-5 md:px-8">
                    <span className="text-sm text-zinc-600">云端工作台</span>
                    <div className="flex items-center gap-3 text-sm">
                        {import.meta.env.VITE_BENTO_KEYCLOAK_AUTH === '1' ? (
                            <>
                                <a
                                    className="underline"
                                    href="/auth"
                                    aria-label="账号设置"
                                >
                                    {account}
                                </a>
                                <form method="post" action="/api/oidc/logout">
                                    <Button type="submit">退出登录</Button>
                                </form>
                            </>
                        ) : (
                            <>
                                <Link
                                    className="underline"
                                    to="/account"
                                    aria-label="账号设置"
                                >
                                    {account}
                                </Link>
                                <Button
                                    type="button"
                                    disabled={exit.isPending}
                                    onClick={() => exit.mutate()}
                                >
                                    退出登录
                                </Button>
                            </>
                        )}
                    </div>
                </header>
                {exit.error && <Notice message={errorMessage(exit.error)} />}
                <Outlet context={account} />
            </div>
        </div>
    );
}
