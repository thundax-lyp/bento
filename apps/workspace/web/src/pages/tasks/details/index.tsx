import {
    ApiError,
    cancelTaskRun,
    createTaskRun,
    isUnavailableRun,
    prepareTask,
    retryTaskRun,
    runLabels,
    taskDetailsQuery,
    taskEventsQuery,
    taskRunsQuery,
    taskUrl,
} from '@/apps/workspace/web/src/api.ts';
import {
    isOnline,
    subscribeOnline,
} from '@/apps/workspace/web/src/pages/shared/online.ts';
import { Button, Notice, ReadFailure } from '@/apps/workspace/web/src/ui.tsx';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, useSyncExternalStore } from 'react';
import {
    Link,
    useNavigate,
    useOutletContext,
    useParams,
    useSearchParams,
} from 'react-router';
import {
    checkLabels,
    retryReasonLabels,
    taskEventLabels,
    taskStatusLabel,
} from '../labels.ts';
import { TaskRunResult } from './run-result.tsx';

const errorMessage = (error: unknown) =>
    error instanceof ApiError ? error.message : '暂时无法连接，请稍后重试。';
const fieldClass = 'mt-1 block w-full';

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
                                <p>上一次操作结果未确认。请等待可信侧核对。</p>
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
