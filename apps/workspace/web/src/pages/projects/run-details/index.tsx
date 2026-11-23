import type { Run } from '@/apps/workspace/web/src/api.ts';
import {
    ApiError,
    cancelRun,
    isUnavailableRun,
    projectsQuery,
    runLabels,
    runQuery,
    runsQuery,
} from '@/apps/workspace/web/src/api.ts';
import {
    isOnline,
    subscribeOnline,
} from '@/apps/workspace/web/src/pages/shared/online.ts';
import {
    Button,
    Notice,
    ReadFailure,
    RunResult,
} from '@/apps/workspace/web/src/ui.tsx';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { Link, useLoaderData, useOutletContext } from 'react-router';

const errorMessage = (error: unknown) =>
    error instanceof ApiError ? error.message : '暂时无法连接，请稍后重试。';

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
