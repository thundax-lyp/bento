import {
    onlineManager,
    useMutation,
    useQuery,
    useQueryClient,
} from '@tanstack/react-query';
import { useState, useSyncExternalStore } from 'react';
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
    createTask,
    createTaskRun,
    cancelTaskRun,
    prepareTask,
    retryTaskRun,
    taskDetailsQuery,
    taskEventsQuery,
    taskRunsQuery,
    taskListQuery,
    taskResultQuery,
    taskDiffUrl,
    taskUrl,
    tasksUnavailable,
    request,
    cancelRun,
    closeAccount,
    register,
    createProject,
    createRun,
    isUnavailableRun,
    login,
    logout,
    projectsQuery,
    runLabels,
    runQuery,
    runsQuery,
    runUrl,
    sessionQuery,
} from './api';
import type { Run, Session, TaskRun, DiffView } from './api';
import { loadDraft, prepareSubmission, saveDraft } from './draft';
import type { Draft } from './draft';
import { SpaceList } from './space';
import { Button, DiffPreview, Notice, ReadFailure, RunResult } from './ui';

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

export function TaskList() {
    const account = useOutletContext<string>();
    return <TaskListContent key={account} account={account} />;
}

const taskTime = new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
});

function TaskListContent({ account }: { account: string }) {
    const tasks = useQuery(taskListQuery(account));
    const [selectedProject, setSelectedProject] = useState('');
    const [status, setStatus] = useState<Run['status'] | ''>('');
    const [search, setSearch] = useState('');
    const projects = useQuery(projectsQuery(account));
    const project = projects.isError
        ? ''
        : (projects.data?.find((item) => item.id === selectedProject)?.id ??
          projects.data?.[0]?.id ??
          '');
    const runs = useQuery({
        ...runsQuery(account, project),
        enabled: Boolean(project),
    });
    const keyword = search.trim().toLowerCase();
    const results = runs.data
        ?.filter(
            (run) =>
                (!status || run.status === status) &&
                (run.id.toLowerCase().includes(keyword) ||
                    run.summary?.toLowerCase().includes(keyword)),
        )
        .sort(
            (left, right) =>
                right.updatedAt.localeCompare(left.updatedAt) ||
                left.id.localeCompare(right.id),
        );

    return (
        <main className="mx-auto max-w-4xl space-y-5 px-5 py-10">
            <h1 className="text-2xl font-semibold">任务</h1>
            {!!tasks.data?.length && (
                <ul aria-label="任务" className="divide-y divide-zinc-200">
                    {tasks.data
                        .filter(
                            (task) =>
                                !keyword ||
                                task.name.toLowerCase().includes(keyword) ||
                                task.id.includes(keyword),
                        )
                        .map((task) => (
                            <li key={task.id} className="py-2">
                                <Link
                                    className="underline"
                                    to={taskUrl(task.id)}
                                >
                                    {task.name}
                                </Link>
                                <span className="ml-2 text-sm text-zinc-600">
                                    {taskStatusLabel[task.status]}
                                </span>
                            </li>
                        ))}
                </ul>
            )}

            <div className="grid gap-3 sm:grid-cols-3">
                <label>
                    执行项目
                    <select
                        className={fieldClass}
                        value={project}
                        disabled={!project}
                        onChange={(event) =>
                            setSelectedProject(event.target.value)
                        }
                    >
                        {projects.isSuccess &&
                            projects.data.map((item) => (
                                <option key={item.id} value={item.id}>
                                    {item.name}
                                </option>
                            ))}
                    </select>
                </label>
                <label>
                    任务状态
                    <select
                        className={fieldClass}
                        value={status}
                        onChange={(event) =>
                            setStatus(event.target.value as Run['status'] | '')
                        }
                    >
                        <option value="">全部状态</option>
                        {Object.entries(runLabels).map(([value, label]) => (
                            <option key={value} value={value}>
                                {label}
                            </option>
                        ))}
                    </select>
                </label>
                <label>
                    搜索任务
                    <input
                        type="search"
                        className={fieldClass}
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                    />
                </label>
            </div>
            {projects.isPending && <p role="status">正在读取项目…</p>}
            {projects.isError && (
                <>
                    <Notice message={errorMessage(projects.error)} />
                    <Button
                        disabled={projects.isFetching}
                        onClick={() => void projects.refetch()}
                    >
                        重新读取项目
                    </Button>
                </>
            )}
            {projects.isSuccess && !project && <p>还没有执行项目。</p>}
            {project && runs.isPending && <p role="status">正在读取任务…</p>}
            {project && runs.isError && (
                <>
                    <Notice message={errorMessage(runs.error)} />
                    <Button
                        disabled={runs.isFetching}
                        onClick={() => void runs.refetch()}
                    >
                        重新读取任务
                    </Button>
                </>
            )}
            {project &&
                runs.isSuccess &&
                (results?.length ? (
                    <ul
                        aria-label="任务列表"
                        className="divide-y divide-zinc-200 border-t border-zinc-200"
                    >
                        {results.map((run) => (
                            <li key={run.id}>
                                <Link
                                    className="flex flex-wrap justify-between gap-2 px-2 py-3 hover:bg-zinc-50"
                                    to={runUrl(project, run.id)}
                                >
                                    <span>{run.summary ?? run.id}</span>
                                    <span className="text-sm text-zinc-600">
                                        {runLabels[run.status]}
                                        {' · '}
                                        <time dateTime={run.updatedAt}>
                                            {taskTime.format(
                                                new Date(run.updatedAt),
                                            )}
                                        </time>
                                    </span>
                                </Link>
                            </li>
                        ))}
                    </ul>
                ) : (
                    <p>
                        {runs.data.length
                            ? '没有符合条件的任务。'
                            : '这个项目还没有任务。'}
                    </p>
                ))}
        </main>
    );
}

export function Dashboard() {
    const account = useOutletContext<string>();
    const [params] = useSearchParams();
    const legacyProject = params.has('project');
    const tasks = useQuery({
        ...taskListQuery(account),
        enabled: !legacyProject,
    });
    if (legacyProject || tasksUnavailable(tasks.error))
        return <Composer key={account} account={account} />;
    if (tasks.error) return <Notice message={errorMessage(tasks.error)} />;
    if (!tasks.isSuccess)
        return (
            <p className="p-6" role="status">
                正在读取任务…
            </p>
        );
    return <TaskComposer key={account} account={account} />;
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

const subscribeOnline = (listener: () => void) =>
    onlineManager.subscribe(listener);
const isOnline = () => onlineManager.isOnline();

export function RunDetails() {
    const account = useOutletContext<string>();
    const { project, run: runId } = useLoaderData<{
        project: string;
        run: string;
    }>();
    const client = useQueryClient();
    const details = runQuery(account, project, runId);
    const run = useQuery(details);
    const online = useSyncExternalStore(subscribeOnline, isOnline);
    const detailReady = run.isSuccess && run.fetchStatus === 'idle' && online;
    const cancel = useMutation({
        mutationFn: (target: {
            account: string;
            project: string;
            runId: string;
        }) => cancelRun(target.project, target.runId),
        async onSuccess(result, target) {
            const queryKey = runQuery(
                target.account,
                target.project,
                target.runId,
            ).queryKey;
            await client.cancelQueries({ queryKey, exact: true });
            client.setQueryData(queryKey, result);
            await client.invalidateQueries({
                queryKey: runsQuery(target.account, target.project).queryKey,
                exact: true,
            });
        },
        async onError(_error, target) {
            await client.invalidateQueries({
                queryKey: runQuery(target.account, target.project, target.runId)
                    .queryKey,
                exact: true,
            });
        },
    });
    const cancelHere =
        cancel.variables?.account === account &&
        cancel.variables.project === project &&
        cancel.variables.runId === runId;
    const projects = useQuery(projectsQuery(account));
    const name = projects.data?.find((item) => item.id === project)?.name;
    const status: Run['status'] | undefined = run.data?.status;
    if (isUnavailableRun(run.error)) {
        if (run.error instanceof ApiError && run.error.status === 401) {
            return null;
        }
        return (
            <main className="mx-auto max-w-xl space-y-4 px-6 py-20">
                <h1 className="text-2xl font-semibold">
                    找不到这个页面或任务。
                </h1>
                <Link className="underline" to="/runs">
                    返回任务
                </Link>
            </main>
        );
    }
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
                {detailReady &&
                    (status === 'queued' || status === 'running') && (
                        <Button
                            type="button"
                            disabled={cancelHere && cancel.isPending}
                            onClick={() =>
                                cancel.mutate({ account, project, runId })
                            }
                        >
                            {status === 'queued' ? '取消排队' : '请求停止'}
                        </Button>
                    )}
            </div>
            {(!online || run.fetchStatus === 'paused') && (
                <p role="status">连接中断，正在等待重新连接。</p>
            )}
            {run.isError && (
                <ReadFailure
                    message="暂时无法读取任务状态。"
                    label="重新读取任务"
                    pending={run.isFetching}
                    onRetry={() => void run.refetch()}
                />
            )}
            {cancelHere &&
                cancel.error &&
                status !== 'cancelling' &&
                status !== 'cancelled' &&
                status !== 'needs_review' && (
                    <Notice message={errorMessage(cancel.error)} />
                )}
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
                    {status === 'needs_review' && <p>上一次操作结果未确认</p>}
                    <Link
                        className="text-sm underline"
                        to={'/?' + new URLSearchParams({ project })}
                    >
                        在此项目发起新任务
                    </Link>
                </section>
                <section className="min-w-0 space-y-3 rounded-xl border border-zinc-200 p-4">
                    <h2 className="font-semibold">文件变更</h2>
                    {detailReady && status === 'succeeded' ? (
                        <RunResult
                            key={JSON.stringify([account, project, runId])}
                            account={account}
                            project={project}
                            runId={runId}
                        />
                    ) : (
                        <p className="text-sm text-zinc-600">
                            当前没有可审阅的补丁。
                        </p>
                    )}
                </section>
            </div>
        </main>
    );
}

const taskStatusLabel = {
    preparing: '准备中',
    ready: '已就绪',
    failed: '准备失败',
    deleting: '正在删除',
};
const retryReasonLabels: Record<string, string> = {
    task_closed: '任务已结案。',
    not_latest: '只能重试最近一次执行。',
    not_terminal: '当前执行尚不可重试。',
    needs_review: '上一次操作结果未确认。',
    stop_unconfirmed: '缺少可信停止证据，无法安全重试。',
    checkpoint_unavailable: '缺少完整检查点，无法安全重试。',
    environment_unavailable: '原运行环境暂不可用。',
    task_busy: '任务仍有尚未结束的执行。',
    task_not_ready: '任务尚未准备好。',
};
const taskEventLabels = {
    user_message: '你',
    agent_reply: 'Agent',
    step: '步骤',
    command: '命令',
    check: '检查',
};
const checkLabels = {
    passed: '通过',
    failed: '失败',
    not_run: '未运行',
    unavailable: '无法运行',
};

function TaskComposer({ account }: { account: string }) {
    const [name, setName] = useState('');
    const navigate = useNavigate();
    const client = useQueryClient();
    const mutation = useMutation({
        mutationFn: () => createTask(account, name, { kind: 'blank' }),
        async onSuccess(task) {
            await client.invalidateQueries({
                queryKey: taskListQuery(account).queryKey,
            });
            await navigate(taskUrl(task.id));
        },
    });
    return (
        <main className="mx-auto max-w-3xl space-y-5 px-5 py-10">
            <h1 className="text-2xl font-semibold">新建任务</h1>
            <form
                className="space-y-4 rounded-xl border border-zinc-200 p-5"
                onSubmit={(event) => {
                    event.preventDefault();
                    if (name.trim() && !mutation.isPending) mutation.mutate();
                }}
            >
                <label>
                    任务名称
                    <input
                        className={fieldClass}
                        required
                        maxLength={120}
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                    />
                </label>
                <Button primary disabled={!name.trim() || mutation.isPending}>
                    创建空白任务
                </Button>
                {mutation.error && (
                    <Notice message={errorMessage(mutation.error)} />
                )}
            </form>
        </main>
    );
}

export function TaskDetails() {
    const account = useOutletContext<string>();
    const { taskId } = useParams();
    if (!taskId) return null;
    return (
        <TaskDetailsContent
            key={JSON.stringify([account, taskId])}
            account={account}
            id={taskId}
        />
    );
}

function TaskDetailsContent({ account, id }: { account: string; id: string }) {
    const client = useQueryClient();
    const navigate = useNavigate();
    const [params] = useSearchParams();
    const [prompt, setPrompt] = useState('');
    const [pendingSubmission, setPendingSubmission] = useState<string | null>(
        null,
    );
    const [confirmRetry, setConfirmRetry] = useState<string | null>(null);
    const [confirmNewTask, setConfirmNewTask] = useState(false);
    const online = useSyncExternalStore(subscribeOnline, isOnline);
    const task = useQuery(taskDetailsQuery(account, id));
    const runs = useQuery({
        ...taskRunsQuery(account, id),
        enabled: task.isSuccess,
    });
    const events = useQuery({
        ...taskEventsQuery(account, id),
        enabled: task.isSuccess,
    });
    const last = runs.data?.at(-1);
    const selectedId = params.get('run');
    const selected = selectedId
        ? runs.data?.find((run) => run.id === selectedId)
        : last;
    const [recentRetry, setRecentRetry] = useState<{
        runId: string;
        sourceRunId: string;
    } | null>(null);
    const queuedRetry =
        recentRetry && runs.data?.find((run) => run.id === recentRetry.runId);
    async function refresh() {
        await Promise.all([
            client.invalidateQueries({
                queryKey: taskDetailsQuery(account, id).queryKey,
            }),
            client.invalidateQueries({
                queryKey: taskRunsQuery(account, id).queryKey,
            }),
            client.invalidateQueries({
                queryKey: taskEventsQuery(account, id).queryKey,
            }),
        ]);
    }
    const sending = useMutation({
        mutationFn: (submittedPrompt: string) =>
            createTaskRun(account, id, submittedPrompt),
        async onSuccess(run) {
            setPendingSubmission(null);
            setPrompt('');
            await refresh();
            await navigate(taskUrl(id, run.id));
        },
        async onError(error, submittedPrompt) {
            setPendingSubmission(
                error instanceof ApiError &&
                    error.status >= 400 &&
                    error.status < 500
                    ? null
                    : submittedPrompt,
            );
            await refresh();
        },
    });
    const prepare = useMutation({
        mutationFn: () => prepareTask(id),
        onSettled: refresh,
    });
    const cancel = useMutation({
        mutationFn: (runId: string) => cancelTaskRun(id, runId),
        onSettled: refresh,
    });
    const retry = useMutation({
        mutationFn: (runId: string) => retryTaskRun(account, id, runId),
        async onSuccess(receipt, sourceRunId) {
            setConfirmRetry(null);
            setRecentRetry(
                receipt.state === 'preparing' || receipt.state === 'queued'
                    ? { runId: receipt.runId, sourceRunId }
                    : null,
            );
            await refresh();
            if (receipt.state === 'queued')
                await navigate(taskUrl(id, receipt.runId));
        },
        onError: refresh,
    });
    if ([task.error, runs.error, events.error].some(isUnavailableRun))
        return (
            <main className="mx-auto max-w-4xl space-y-3 px-5 py-10">
                <h1 className="text-2xl font-semibold">任务不可访问</h1>
                <Link className="underline" to="/runs">
                    返回任务
                </Link>
            </main>
        );
    if (!task.data)
        return (
            <main className="mx-auto max-w-4xl px-5 py-10">
                {task.isError ? (
                    <ReadFailure
                        message={errorMessage(task.error)}
                        label="重新读取任务"
                        pending={task.isFetching}
                        onRetry={() => void task.refetch()}
                    />
                ) : (
                    <p role="status">正在读取任务…</p>
                )}
            </main>
        );
    const data = task.data;
    const mutable =
        online && !task.isError && runs.isSuccess && !events.isError;
    const canSend =
        mutable &&
        pendingSubmission === null &&
        data.status === 'ready' &&
        !data.closedReason &&
        !data.reconciliation &&
        (!last || last.canContinue);
    const failures = [
        sending.error,
        prepare.error,
        cancel.error,
        retry.error,
    ].filter((error) => error !== null);
    const pending =
        sending.isPending ||
        prepare.isPending ||
        cancel.isPending ||
        retry.isPending;
    return (
        <main className="mx-auto max-w-6xl space-y-5 px-5 py-10">
            <Link className="text-sm underline" to="/runs">
                返回任务
            </Link>
            <header>
                <h1 className="text-2xl font-semibold">{data.name}</h1>
                <p className="text-sm text-zinc-600" role="status">
                    {taskStatusLabel[data.status]}
                    {last ? ' · ' + runLabels[last.status] : ''}
                </p>
            </header>
            <section className="space-y-2 rounded-xl border border-zinc-200 p-4">
                <h2 className="font-semibold">冻结输入</h2>
                {data.sourceSpaceId ? (
                    <Link
                        className="underline"
                        to={'/space/' + encodeURIComponent(data.sourceSpaceId)}
                    >
                        查看来源项目
                    </Link>
                ) : (
                    <p>空白工作区</p>
                )}
                {data.inputs.length > 0 && (
                    <ul className="text-sm">
                        {data.inputs.map((file) => (
                            <li key={file.fileId}>
                                {file.path} · {file.bytes} 字节
                            </li>
                        ))}
                    </ul>
                )}
                <p className="break-all text-sm">
                    环境版本 {data.environmentVersion}
                </p>
            </section>
            {!online && <p role="status">连接中断，正在等待重新连接。</p>}
            {(task.isError || runs.isError || events.isError) && (
                <ReadFailure
                    message="暂时无法更新任务，已确认记录仍可查看。"
                    label="重新读取任务"
                    pending={
                        task.isFetching || runs.isFetching || events.isFetching
                    }
                    onRetry={() => void refresh()}
                />
            )}
            {data.status === 'failed' && (
                <section className="space-y-2">
                    <Notice
                        message={
                            data.prepareError === 'environment_unavailable'
                                ? '原运行环境暂不可用。'
                                : '任务准备失败。'
                        }
                    />
                    <Button
                        type="button"
                        disabled={!mutable || pending}
                        onClick={() => prepare.mutate()}
                    >
                        按原输入重新准备
                    </Button>
                    <Button
                        type="button"
                        disabled={!mutable || pending}
                        onClick={() => setConfirmNewTask(true)}
                    >
                        更换输入或环境，另建任务
                    </Button>
                    {confirmNewTask && mutable && !pending && (
                        <div className="space-y-2">
                            <p>
                                另建任务将使用重新选择的输入和当前运行环境，原任务及失败记录会保留。
                            </p>
                            <Link
                                className="underline"
                                to={
                                    data.sourceSpaceId
                                        ? '/space/' +
                                          encodeURIComponent(data.sourceSpaceId)
                                        : '/'
                                }
                            >
                                确认另建
                            </Link>
                            <Button
                                type="button"
                                onClick={() => setConfirmNewTask(false)}
                            >
                                返回
                            </Button>
                        </div>
                    )}
                </section>
            )}
            {data.closedReason && (
                <Notice message="该任务已结案，执行结果无法确认。历史交付仍可查看。" />
            )}
            {data.reconciliation && (
                <Notice message="恢复证据不一致，等待可信侧核对。" />
            )}
            {failures.map((error, index) => (
                <Notice key={index} message={errorMessage(error)} />
            ))}
            <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <section className="space-y-3 rounded-xl border border-zinc-200 p-4">
                    <h2 className="font-semibold">任务记录</h2>
                    <ol className="divide-y divide-zinc-200">
                        {events.data?.map((event) => (
                            <li key={event.id} className="py-2 text-sm">
                                <p className="font-medium">
                                    {taskEventLabels[event.kind]}
                                </p>
                                <p className="whitespace-pre-wrap break-words">
                                    {event.text}
                                </p>
                                {event.check && (
                                    <p>
                                        {checkLabels[event.check.status]}
                                        {event.check.output
                                            ? ' · ' + event.check.output
                                            : ''}
                                    </p>
                                )}
                            </li>
                        ))}
                    </ol>
                    {last &&
                        [
                            'queued',
                            'running',
                            'recovering',
                            'needs_review',
                            'cancelling',
                        ].includes(last.status) && (
                            <p role="status">
                                任务已有执行，请等待完成或取消。
                            </p>
                        )}
                    {pendingSubmission !== null && (
                        <div className="space-y-2">
                            <p role="status">提交结果未确认，请重试原提交。</p>
                            <Button
                                type="button"
                                disabled={!online || task.isError || pending}
                                onClick={() =>
                                    sending.mutate(pendingSubmission)
                                }
                            >
                                重试提交
                            </Button>
                        </div>
                    )}
                    <form
                        className="space-y-3"
                        onSubmit={(event) => {
                            event.preventDefault();
                            if (canSend && prompt.trim() && !pending)
                                sending.mutate(prompt.trim());
                        }}
                    >
                        <label>
                            {last ? '后续要求' : '任务要求'}
                            <textarea
                                className={fieldClass}
                                value={prompt}
                                maxLength={8000}
                                disabled={!canSend}
                                onChange={(event) =>
                                    setPrompt(event.target.value)
                                }
                            />
                        </label>
                        <Button
                            primary
                            disabled={!canSend || !prompt.trim() || pending}
                        >
                            发送要求
                        </Button>
                    </form>
                </section>
                <section className="space-y-3 rounded-xl border border-zinc-200 p-4">
                    <h2 className="font-semibold">执行与结果</h2>
                    {!!runs.data?.length && (
                        <label>
                            执行轮次
                            <select
                                className={fieldClass}
                                value={selected?.id ?? ''}
                                onChange={(event) =>
                                    void navigate(
                                        taskUrl(id, event.target.value),
                                    )
                                }
                            >
                                {!selected && (
                                    <option value="">选择执行</option>
                                )}
                                {runs.data.map((run) => (
                                    <option key={run.id} value={run.id}>
                                        第 {run.sequence} 轮 ·{' '}
                                        {runLabels[run.status]}
                                    </option>
                                ))}
                            </select>
                        </label>
                    )}
                    {selectedId && !selected && runs.isSuccess && (
                        <Notice message="找不到该 Run。" />
                    )}
                    {recentRetry &&
                        recentRetry.sourceRunId === selected?.id &&
                        (queuedRetry ? (
                            <Link
                                className="underline"
                                to={taskUrl(id, queuedRetry.id)}
                            >
                                打开重试执行
                            </Link>
                        ) : (
                            !data.reconciliation &&
                            !data.closedReason && (
                                <p role="status">正在恢复工作区和会话。</p>
                            )
                        ))}
                    {selected && (
                        <>
                            {selected.summary && (
                                <p className="whitespace-pre-wrap break-words">
                                    {selected.summary}
                                </p>
                            )}
                            {selected.status === 'needs_review' && (
                                <p>上一次操作结果未确认。</p>
                            )}
                            {selected.canCancel && (
                                <Button
                                    type="button"
                                    disabled={!mutable || pending}
                                    onClick={() => cancel.mutate(selected.id)}
                                >
                                    {selected.status === 'queued'
                                        ? '取消排队'
                                        : '请求停止'}
                                </Button>
                            )}
                            {(selected.status === 'failed' ||
                                selected.status === 'cancelled' ||
                                selected.status === 'needs_review') &&
                                (selected.retryReason ? (
                                    <p className="text-sm text-zinc-600">
                                        {retryReasonLabels[
                                            selected.retryReason
                                        ] ?? '当前无法安全重试。'}
                                    </p>
                                ) : (
                                    <Button
                                        type="button"
                                        disabled={
                                            !mutable ||
                                            pending ||
                                            !!data.reconciliation ||
                                            recentRetry?.sourceRunId ===
                                                selected.id
                                        }
                                        onClick={() =>
                                            setConfirmRetry(selected.id)
                                        }
                                    >
                                        安全重试
                                    </Button>
                                ))}
                            {confirmRetry === selected.id && (
                                <div className="space-y-2">
                                    <p>
                                        重试将丢弃本轮未完成的工作区变更，并保留原执行记录。
                                    </p>
                                    <Button
                                        type="button"
                                        disabled={
                                            !mutable ||
                                            pending ||
                                            selected.retryReason !== null
                                        }
                                        onClick={() =>
                                            retry.mutate(selected.id)
                                        }
                                    >
                                        确认重试
                                    </Button>
                                    <Button
                                        type="button"
                                        onClick={() => setConfirmRetry(null)}
                                    >
                                        返回
                                    </Button>
                                </div>
                            )}
                            {selected.resultVersion !== null ? (
                                <TaskRunResult
                                    key={
                                        selected.id +
                                        ':' +
                                        selected.resultVersion
                                    }
                                    account={account}
                                    run={selected}
                                />
                            ) : (
                                <p role="status">结果尚不可用。</p>
                            )}
                        </>
                    )}
                </section>
            </div>
        </main>
    );
}

function TaskRunResult({ account, run }: { account: string; run: TaskRun }) {
    const [view, setView] = useState<DiffView>('cumulative');
    const metadata = useQuery(
        taskResultQuery(account, run.taskId, run.id, run.resultVersion),
    );
    const version = run.resultVersion!;
    const url = taskDiffUrl(run.taskId, run.id, version, view);
    const diff = useQuery({
        queryKey: [
            'account',
            account,
            'task-diff',
            run.taskId,
            run.id,
            version,
            view,
        ],
        queryFn: async ({ signal }) => (await request(url, { signal })).text(),
        enabled: metadata.isSuccess && metadata.data.version === version,
    });
    if (metadata.error)
        return (
            <ReadFailure
                message={errorMessage(metadata.error)}
                label="重新读取结果"
                pending={metadata.isFetching}
                onRetry={() => void metadata.refetch()}
            />
        );
    if (!metadata.data) return <p role="status">正在读取结果…</p>;
    return (
        <div className="space-y-3">
            <h3 className="font-medium">检查结果</h3>
            {metadata.data.checks.length === 0 ? (
                <p>无检查记录。</p>
            ) : (
                <ul>
                    {metadata.data.checks.map((check, index) => (
                        <li key={index}>
                            {check.name} · {checkLabels[check.status]}
                            {check.output && (
                                <pre className="whitespace-pre-wrap">
                                    {check.output}
                                </pre>
                            )}
                        </li>
                    ))}
                </ul>
            )}
            <label>
                补丁范围
                <select
                    className={fieldClass}
                    value={view}
                    onChange={(event) =>
                        setView(event.target.value as DiffView)
                    }
                >
                    <option value="cumulative">累计变更</option>
                    <option value="incremental">本轮增量</option>
                </select>
            </label>
            {diff.isSuccess && (
                <>
                    <Button asChild>
                        <a
                            href={taskDiffUrl(
                                run.taskId,
                                run.id,
                                version,
                                view,
                                true,
                            )}
                        >
                            下载 diff
                        </a>
                    </Button>
                    <DiffPreview text={diff.data} />
                </>
            )}
            {diff.isError && (
                <ReadFailure
                    message={errorMessage(diff.error)}
                    label="重新读取补丁"
                    pending={diff.isFetching}
                    onRetry={() => void diff.refetch()}
                />
            )}
        </div>
    );
}
