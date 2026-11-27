import {
    ApiError,
    createRun,
    projectsQuery,
    runLabels,
    runQuery,
    runsQuery,
    runUrl,
    taskListQuery,
    tasksUnavailable,
} from '@/apps/workspace/workspace-web/src/api.ts';
import type { Draft } from '@/apps/workspace/workspace-web/src/draft.ts';
import {
    loadDraft,
    prepareSubmission,
    saveDraft,
} from '@/apps/workspace/workspace-web/src/draft.ts';
import { TaskComposer } from '@/apps/workspace/workspace-web/src/pages/tasks/composer/index.tsx';
import { Button, Notice } from '@/apps/workspace/workspace-web/src/ui.tsx';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FormEvent } from 'react';
import { useState } from 'react';
import {
    Link,
    useNavigate,
    useOutletContext,
    useSearchParams,
} from 'react-router';

const errorMessage = (error: unknown) =>
    error instanceof ApiError ? error.message : '暂时无法连接，请稍后重试。';
const fieldClass = 'mt-1 block w-full';

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
