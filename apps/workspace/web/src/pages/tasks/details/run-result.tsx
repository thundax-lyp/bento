import type { DiffView, TaskRun } from '@/apps/workspace/web/src/api.ts';
import {
    ApiError,
    request,
    taskDiffUrl,
    taskResultQuery,
} from '@/apps/workspace/web/src/api.ts';
import {
    Button,
    DiffPreview,
    ReadFailure,
} from '@/apps/workspace/web/src/ui.tsx';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { checkLabels } from '../labels.ts';

const errorMessage = (error: unknown) =>
    error instanceof ApiError ? error.message : '暂时无法连接，请稍后重试。';
const fieldClass = 'mt-1 block w-full';

export function TaskRunResult({
    account,
    run,
}: {
    account: string;
    run: TaskRun;
}) {
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
