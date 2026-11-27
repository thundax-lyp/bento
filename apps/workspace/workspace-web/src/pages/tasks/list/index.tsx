import type { Run } from '@workspace-web/api.ts';
import {
    ApiError,
    projectsQuery,
    runLabels,
    runsQuery,
    runUrl,
    taskListQuery,
    taskUrl,
} from '@workspace-web/api.ts';
import { Button, Notice } from '@workspace-web/ui.tsx';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useOutletContext } from 'react-router';
import { taskStatusLabel } from '../labels.ts';

const errorMessage = (error: unknown) =>
    error instanceof ApiError ? error.message : '暂时无法连接，请稍后重试。';
const fieldClass = 'mt-1 block w-full';

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
