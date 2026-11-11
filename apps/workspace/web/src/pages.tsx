import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { FormEvent } from 'react';
import {
    Link,
    Navigate,
    NavLink,
    Outlet,
    useLoaderData,
    useLocation,
    useNavigate,
    useOutletContext,
    useParams,
    useSearchParams,
} from 'react-router';
import {
    ApiError,
    closeAccount,
    register,
    createProject,
    createRun,
    diffQuery,
    downloadUrl,
    login,
    logout,
    projectsQuery,
    runLabels,
    runQuery,
    runsQuery,
    runUrl,
    sessionQuery,
} from './api';
import type { Run, Session } from './api';
import { loadDraft, prepareSubmission, saveDraft } from './draft';
import type { Draft } from './draft';
import { SpaceList } from './space';
import { Button, DiffPreview, Notice } from './ui';

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
            invite,
        }: {
            account: string;
            invite: string;
        }) => login(account, invite),
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
            invite: String(data.get('invite') ?? ''),
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
                        使用密码登录。尚未注册的旧账号可以继续使用邀请码。
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
                    密码或邀请码
                    <input
                        className={fieldClass}
                        name="invite"
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
                    密码或旧账号邀请码
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
                    </div>
                </header>
                {exit.error && <Notice message={errorMessage(exit.error)} />}
                <Outlet context={account} />
            </div>
        </div>
    );
}

export function Dashboard() {
    const account = useOutletContext<string>();
    return <Composer key={account} account={account} />;
}

function Composer({ account }: { account: string }) {
    const client = useQueryClient();
    const navigate = useNavigate();
    const [search] = useSearchParams();
    const projects = useQuery(projectsQuery(account));
    const [draft, setDraft] = useState(() => {
        const stored = loadDraft(account);
        return stored.pending
            ? stored
            : { ...stored, project: search.get('project') ?? stored.project };
    });
    const ready =
        projects.data?.filter((project) => project.status === 'ready') ?? [];
    const selected = draft.project
        ? ready.find((project) => project.id === draft.project)
        : ready[0];
    const runs = useQuery({
        ...runsQuery(account, selected?.id ?? ''),
        enabled: !!selected,
    });
    const submit = useMutation({
        mutationFn: (pending: Draft & { pending: string }) =>
            createRun(pending.project, pending.prompt, pending.pending),
        onError(error, pending) {
            if (
                error instanceof ApiError &&
                [400, 404, 409, 413, 415, 422, 429].includes(error.status)
            ) {
                update({ project: pending.project, prompt: pending.prompt });
            }
        },
        async onSuccess(run) {
            update({ project: run.projectId, prompt: '' });
            client.setQueryData(
                runQuery(account, run.projectId, run.id).queryKey,
                run,
            );
            void client.invalidateQueries({
                queryKey: runsQuery(account, run.projectId).queryKey,
            });
            await navigate(runUrl(run.projectId, run.id));
        },
    });

    function update(value: Draft) {
        setDraft(value);
        saveDraft(account, value);
    }
    function send(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!selected || !draft.prompt.trim() || submit.isPending) return;
        const pending = prepareSubmission({ ...draft, project: selected.id });
        update(pending);
        submit.mutate(pending);
    }
    return (
        <main className="mx-auto max-w-4xl space-y-8 px-5 py-12">
            <div className="space-y-2 text-center">
                <h1 className="text-3xl font-semibold tracking-tight">
                    今天想让 Bento 做什么？
                </h1>
                <p className="text-sm text-zinc-600">
                    选好项目，交代任务。执行完成后回来审阅改动。
                </p>
            </div>
            {projects.error && (
                <Notice message={errorMessage(projects.error)} />
            )}
            <form
                onSubmit={send}
                className="space-y-3 rounded-2xl border border-zinc-200 p-4 shadow-sm"
            >
                <label>
                    任务要求
                    <textarea
                        className={fieldClass + ' min-h-24 resize-y'}
                        placeholder="例如，为 README.md 补充安装说明"
                        value={draft.prompt}
                        onChange={(event) =>
                            update({ ...draft, prompt: event.target.value })
                        }
                        maxLength={8000}
                        readOnly={!!draft.pending}
                        required
                    />
                </label>
                <div className="flex flex-wrap items-end justify-between gap-3">
                    <label>
                        执行项目
                        <select
                            className={fieldClass}
                            value={selected?.id ?? ''}
                            onChange={(event) =>
                                update({
                                    ...draft,
                                    project: event.target.value,
                                })
                            }
                            disabled={!!draft.pending}
                        >
                            <option value="" disabled>
                                请选择项目
                            </option>
                            {ready.map((project) => (
                                <option key={project.id} value={project.id}>
                                    {project.name}
                                </option>
                            ))}
                        </select>
                    </label>
                    <Button
                        primary
                        disabled={
                            !selected ||
                            !draft.prompt.trim() ||
                            submit.isPending
                        }
                    >
                        {submit.isPending
                            ? '正在确认…'
                            : draft.pending
                              ? '确认上次提交'
                              : '发送任务'}
                    </Button>
                </div>
                {!ready.length && !projects.isPending && (
                    <p className="text-sm text-zinc-600">
                        还没有就绪的项目。
                        <Link className="ml-1 underline" to="/workspaces">
                            去 Workspace 导入文件
                        </Link>
                    </p>
                )}
                {submit.error && (
                    <Notice message={errorMessage(submit.error)} />
                )}
                {draft.pending && !submit.isPending && (
                    <p className="text-sm text-zinc-600">
                        再次确认会沿用原提交标识，找回已受理的任务。
                    </p>
                )}
            </form>
            <section aria-label="最近任务" className="space-y-2">
                <h2 className="text-lg font-semibold">最近任务</h2>
                {runs.error && <Notice message={errorMessage(runs.error)} />}
                {selected && runs.isPending && (
                    <p className="text-sm text-zinc-600">正在读取任务…</p>
                )}
                {selected && runs.data?.length === 0 && (
                    <p className="text-sm text-zinc-600">
                        这个项目还没有任务。
                    </p>
                )}
                <ul className="divide-y divide-zinc-200 border-t border-zinc-200">
                    {runs.data?.map((run) => (
                        <li key={run.id}>
                            <Link
                                className="flex justify-between gap-3 px-2 py-3 hover:bg-zinc-50"
                                to={runUrl(run.projectId, run.id)}
                            >
                                <span className="truncate">
                                    {run.summary ??
                                        '任务 ' + run.id.slice(0, 8)}
                                </span>
                                <span className="shrink-0 text-sm text-zinc-600">
                                    {runLabels[run.status]}
                                </span>
                            </Link>
                        </li>
                    ))}
                </ul>
            </section>
        </main>
    );
}

export function Workspace() {
    const account = useOutletContext<string>();
    const client = useQueryClient();
    const projects = useQuery(projectsQuery(account));
    const { workspaceId } = useParams();
    const project = projects.data?.find((item) => item.id === workspaceId);
    const create = useMutation({
        async mutationFn(form: FormData) {
            const files = form
                .getAll('files')
                .filter(
                    (value): value is File =>
                        value instanceof File && !!value.name,
                );
            if (!files.length)
                throw new ApiError(400, '请选择至少一个 UTF-8 文本文件。');
            if (
                files.length > 100 ||
                files.reduce((total, file) => total + file.size, 0) >
                    1024 * 1024
            ) {
                throw new ApiError(
                    400,
                    '每个项目最多 100 个文件，文本总量不超过 1 MiB。',
                );
            }
            const decoder = new TextDecoder('utf-8', {
                fatal: true,
                ignoreBOM: true,
            });
            const inputs = await Promise.all(
                files.map(async (file) => {
                    const data = await file.arrayBuffer();
                    try {
                        return { path: file.name, text: decoder.decode(data) };
                    } catch {
                        throw new ApiError(
                            400,
                            file.name + ' 不是有效的 UTF-8 文本。',
                        );
                    }
                }),
            );
            return createProject(String(form.get('name') ?? '').trim(), inputs);
        },
        onSuccess() {
            return client.invalidateQueries({
                queryKey: projectsQuery(account).queryKey,
            });
        },
    });
    function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        create.mutate(new FormData(event.currentTarget));
    }
    return (
        <main className="mx-auto max-w-4xl space-y-6 px-5 py-10">
            <h1 className="text-2xl font-semibold">Workspace</h1>
            <SpaceList />
            {projects.error && (
                <Notice message={errorMessage(projects.error)} />
            )}
            {workspaceId && !projects.isPending && !project && (
                <Notice message="找不到这个项目。" />
            )}
            <ul className="divide-y divide-zinc-200 border-t border-zinc-200">
                {projects.data?.map((item) => (
                    <li
                        key={item.id}
                        className="flex items-center justify-between gap-3 py-3"
                    >
                        <Link
                            to={'/workspaces/' + encodeURIComponent(item.id)}
                            className="underline"
                        >
                            {item.name}
                        </Link>
                        {item.status === 'ready' ? (
                            <Button asChild>
                                <Link
                                    to={
                                        '/?' +
                                        new URLSearchParams({
                                            project: item.id,
                                        })
                                    }
                                >
                                    在对话中使用
                                </Link>
                            </Button>
                        ) : (
                            <span className="text-sm text-zinc-600">
                                {item.status === 'importing'
                                    ? '正在准备'
                                    : '导入失败'}
                            </span>
                        )}
                    </li>
                ))}
            </ul>
            <form
                onSubmit={submit}
                className="space-y-4 rounded-xl border border-zinc-200 p-5"
            >
                <h2 className="text-lg font-semibold">导入文本项目</h2>
                <p className="text-sm text-zinc-600">
                    选择 UTF-8 文本文件，最多 100 个，合计不超过 1 MiB。
                </p>
                <label>
                    项目名称
                    <input className={fieldClass} name="name" required />
                </label>
                <label>
                    项目文件
                    <input
                        className={fieldClass}
                        name="files"
                        type="file"
                        multiple
                        required
                    />
                </label>
                <Button primary disabled={create.isPending}>
                    {create.isPending ? '正在导入…' : '导入项目'}
                </Button>
                {create.error && (
                    <Notice message={errorMessage(create.error)} />
                )}
                {create.isSuccess && (
                    <p role="status" className="text-sm text-zinc-600">
                        已提交「{create.data.name}」的导入。
                    </p>
                )}
            </form>
        </main>
    );
}

export function RunDetails() {
    const account = useOutletContext<string>();
    const { project, run: runId } = useLoaderData<{
        project: string;
        run: string;
    }>();
    const run = useQuery(runQuery(account, project, runId));
    const projects = useQuery(projectsQuery(account));
    const diff = useQuery({
        ...diffQuery(account, project, runId),
        enabled: run.data?.status === 'succeeded',
    });
    const name = projects.data?.find((item) => item.id === project)?.name;
    const status: Run['status'] | undefined = run.data?.status;
    return (
        <main className="mx-auto max-w-6xl space-y-5 px-5 py-10">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h1 className="text-2xl font-semibold">任务详情</h1>
                    <p className="mt-1 text-sm text-zinc-600">
                        {[name, status && runLabels[status]]
                            .filter(Boolean)
                            .join(' · ')}
                    </p>
                </div>
                {diff.data !== undefined && (
                    <Button asChild>
                        <a href={downloadUrl(project, runId)}>下载 diff</a>
                    </Button>
                )}
            </div>
            {run.error && <Notice message={errorMessage(run.error)} />}
            <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
                <section className="space-y-3 rounded-xl border border-zinc-200 p-4">
                    <h2 className="font-semibold">任务记录</h2>
                    {run.data?.prompt && (
                        <div className="rounded-lg bg-zinc-50 p-3 text-sm">
                            <p className="mb-1 font-medium">任务要求</p>
                            <p className="whitespace-pre-wrap break-words">
                                {run.data.prompt}
                            </p>
                        </div>
                    )}
                    <p aria-live="polite" className="text-sm text-zinc-700">
                        {run.data?.summary ??
                            (status ? runLabels[status] : '正在读取任务…')}
                    </p>
                    <Link
                        className="text-sm underline"
                        to={'/?' + new URLSearchParams({ project })}
                    >
                        在此项目发起新任务
                    </Link>
                </section>
                <section className="min-w-0 space-y-3 rounded-xl border border-zinc-200 p-4">
                    <h2 className="font-semibold">文件变更</h2>
                    {diff.error && (
                        <Notice message={errorMessage(diff.error)} />
                    )}
                    {diff.data !== undefined ? (
                        <DiffPreview text={diff.data} />
                    ) : (
                        !diff.error && (
                            <p className="text-sm text-zinc-600">
                                {status === 'succeeded'
                                    ? '正在读取变更…'
                                    : '当前没有可审阅的补丁。'}
                            </p>
                        )
                    )}
                </section>
            </div>
        </main>
    );
}
