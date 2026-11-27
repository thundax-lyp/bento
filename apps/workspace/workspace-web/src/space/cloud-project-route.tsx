import {
    droppedChoices,
    planUpload,
    type UploadChoice,
} from './upload-plan.ts';
import { FilePreview, savedFileTree, SavedFiles } from './files.tsx';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { ChangeEvent, DragEvent, FormEvent } from 'react';
import { Link, useNavigate, useOutletContext, useParams } from 'react-router';
import {
    deleteSpaceFile,
    prepareWorkspace,
    spaceProjectQuery,
    spaceQuery,
} from './api.ts';
import type { Upload } from './api.ts';
import { ApiError, createTask, taskListQuery, taskUrl } from '../api.ts';
import { Button, Notice } from '../ui.tsx';
import { message } from './error-message.ts';
import { useProjectDeletion } from './project-deletion.ts';
import { useProjectUploads } from './project-uploads.ts';

const fileIssueMessages = new Map([
    ['invalid_utf8', '不是有效的 UTF-8 文本'],
    ['invalid_path', '文件路径不适用于执行'],
    ['too_large', '单个文件已超过快照的 1 MiB 总量限制'],
]);

function FileIssues({ issues }: { issues?: ApiError['issues'] }) {
    return issues?.map(({ path, code }) => {
        const reason = fileIssueMessages.get(code);
        return (
            reason && (
                <Notice
                    key={JSON.stringify([path, code])}
                    message={path + ' · ' + reason}
                />
            )
        );
    });
}

const executionLabels = {
    uninitialized: '尚未选择执行文件',
    validating: '正在校验',
    importing: '正在准备工作区',
    ready: '工作区已就绪',
    failed: '工作区准备失败',
};

export function CloudProjectRoute() {
    const { spaceId } = useParams();
    const account = useOutletContext<string>();
    if (!spaceId) return <Notice message="找不到这个项目。" />;
    return (
        <CloudProject
            key={account + ':' + spaceId}
            account={account}
            id={spaceId}
        />
    );
}

const deletionBlockerText = {
    upload_pending: '请先取消并清理未完成的上传。',
    project_importing: '请等待工作区初始化结束。',
    project_busy: '项目仍有未结束的任务或文件清理。',
};

function CloudProject({ account, id }: { account: string; id: string }) {
    const client = useQueryClient();
    const space = useQuery(spaceQuery(account));
    const project = useQuery(spaceProjectQuery(account, id));
    const tasks = useQuery(taskListQuery(account));
    const taskEnabled = tasks.isSuccess;
    const legacyEnabled = !taskEnabled;

    const navigate = useNavigate();
    const {
        confirmProject,
        setConfirmProject,
        confirmedProject,
        projectAccepted,
        deleteProject,
        impact,
        serverDeleting,
        missing,
        deletingRequest,
        checkDeletion,
        rememberDeletion,
    } = useProjectDeletion(
        account,
        id,
        project.data?.state,
        project.error,
        refresh,
    );
    const [files, setFiles] = useState<string[]>([]);
    const [previewId, setPreviewId] = useState<string>();
    const [deleteTarget, setDeleteTarget] = useState<{
        id: string;
        path: string;
    }>();
    async function refresh() {
        await Promise.all([
            client.invalidateQueries({
                queryKey: spaceQuery(account).queryKey,
            }),
            client.invalidateQueries({
                queryKey: spaceProjectQuery(account, id).queryKey,
            }),
        ]);
    }
    const {
        uploadRows,
        fileChoices,
        setFileChoices,
        folderChoices,
        setFolderChoices,
        setUploadRows,
        upload,
        cancel,
    } = useProjectUploads(account, id, refresh);
    const remove = useMutation({
        mutationFn: deleteSpaceFile,
        onSuccess(_result, fileId) {
            setPreviewId((current) =>
                current === fileId ? undefined : current,
            );
        },
        onSettled() {
            setDeleteTarget(undefined);
            return refresh();
        },
    });
    const init = useMutation({
        mutationFn(fileIds: string[]) {
            const key = JSON.stringify([
                'bento:prepare',
                account,
                id,
                [...fileIds].sort(),
            ]);
            const requestId =
                sessionStorage.getItem(key) ?? crypto.randomUUID();
            sessionStorage.setItem(key, requestId);
            return prepareWorkspace(id, fileIds, requestId);
        },
        onSettled: refresh,
    });
    const snapshotTask = useMutation({
        mutationFn: ({ name, fileIds }: { name: string; fileIds: string[] }) =>
            createTask(account, name, {
                kind: 'space_snapshot',
                spaceId: id,
                fileIds,
            }),
        async onSuccess(task) {
            await client.invalidateQueries({
                queryKey: taskListQuery(account).queryKey,
            });
            await navigate(taskUrl(task.id));
        },
    });
    if (serverDeleting || projectAccepted || (missing && confirmedProject)) {
        return (
            <main className="mx-auto max-w-4xl space-y-5 px-5 py-10">
                <Link className="text-sm underline" to="/workspaces">
                    返回 Workspace
                </Link>
                <h1 className="text-2xl font-semibold">
                    {project.data?.name ?? '项目删除'}
                </h1>
                <p>
                    {serverDeleting || projectAccepted
                        ? '正在删除项目'
                        : '正在确认项目删除结果'}
                </p>
                <Button
                    disabled={deletingRequest}
                    onClick={() => checkDeletion()}
                >
                    查询删除进度
                </Button>
                {deleteProject.error && (
                    <Notice message={message(deleteProject.error)} />
                )}
            </main>
        );
    }
    if (project.error) return <Notice message={message(project.error)} />;
    if (space.error) return <Notice message={message(space.error)} />;
    if (!project.data || !space.data)
        return <p className="p-6">正在读取空间…</p>;
    const { execution, name } = project.data;
    const config = space.data;
    const uploads = config.uploads.filter((item) => item.project === id);
    const executionFiles = uploads
        .filter((file) => file.state === 'saved' && files.includes(file.id))
        .map((file) => file.id);
    const preview = uploads.find(
        (file) => file.id === previewId && file.state === 'saved',
    );
    const removalError =
        remove.error &&
        ('status' in remove.error && remove.error.status !== 503
            ? message(remove.error)
            : '暂未确认删除结果，请刷新后重试。');
    const selectable =
        taskEnabled ||
        (legacyEnabled &&
            (execution.state === 'uninitialized' ||
                (execution.state === 'failed' && !execution.projectId)));
    const tree = savedFileTree(uploads);
    const pendingUploads = uploads.filter(
        (file): file is Upload & { state: Exclude<Upload['state'], 'saved'> } =>
            file.state !== 'saved',
    );

    const choices = [...fileChoices, ...folderChoices];
    const { available, checklist, selected } = planUpload(choices, config, id);
    function pick(
        event: ChangeEvent<HTMLInputElement>,
        set: (choices: UploadChoice[]) => void,
    ) {
        const next = Array.from(event.currentTarget.files ?? [], (file) => ({
            path: file.webkitRelativePath || file.name,
            file,
        }));
        event.currentTarget.value = '';
        if (next.length) set(next);
    }
    function send(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (upload.isPending || !selected.length) return;
        setUploadRows(
            selected.map(({ path }) => ({ path, status: '等待上传' })),
        );
        upload.mutate({ selected, config });
    }
    function drop(event: DragEvent<HTMLFormElement>) {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        if (!upload.isPending)
            setFileChoices(droppedChoices(event.dataTransfer.items));
    }
    return (
        <main className="mx-auto max-w-4xl space-y-5 px-5 py-10">
            <Link className="text-sm underline" to="/workspaces">
                返回 Workspace
            </Link>
            <h1 className="text-2xl font-semibold">{name}</h1>
            <Button
                onClick={() => {
                    setConfirmProject(true);
                    void impact.refetch();
                }}
            >
                删除项目
            </Button>
            {confirmProject && (
                <section
                    aria-label="确认删除项目"
                    className="space-y-3 rounded-xl border border-zinc-200 p-5"
                >
                    <h2 className="font-semibold">确认删除项目</h2>
                    <p>
                        项目文件、执行工作区、任务历史和补丁将一并删除，无法恢复。
                    </p>
                    {impact.data && (
                        <ul>
                            <li>文件 {impact.data.fileCount}</li>
                            <li>未清理上传 {impact.data.uploadCount}</li>
                            <li>任务 {impact.data.runCount}</li>
                            <li>已发布补丁 {impact.data.diffCount}</li>
                            {impact.data.blockers.map((code) => (
                                <li key={code}>{deletionBlockerText[code]}</li>
                            ))}
                        </ul>
                    )}
                    {impact.error && <Notice message={message(impact.error)} />}
                    {impact.isFetching && <p>正在读取删除影响…</p>}
                    <div className="flex gap-2">
                        <Button
                            primary
                            disabled={
                                deletingRequest ||
                                confirmedProject ||
                                impact.isFetching ||
                                !!impact.error ||
                                !impact.data ||
                                !!impact.data.blockers.length
                            }
                            onClick={() => {
                                rememberDeletion();
                                checkDeletion();
                            }}
                        >
                            确认删除
                        </Button>
                        <Button onClick={() => setConfirmProject(false)}>
                            取消
                        </Button>
                    </div>
                </section>
            )}
            {confirmedProject && (
                <Button
                    disabled={deletingRequest}
                    onClick={() => checkDeletion()}
                >
                    查询删除进度
                </Button>
            )}
            {deleteProject.error && (
                <Notice message={message(deleteProject.error)} />
            )}
            <form
                onSubmit={send}
                onDragOver={(event) => {
                    if (event.dataTransfer.types.includes('Files'))
                        event.preventDefault();
                }}
                onDrop={drop}
                aria-label="文件拖放上传"
                className="space-y-3 rounded-xl border border-zinc-200 p-5"
            >
                <h2 className="font-semibold">上传文件</h2>
                <p className="text-sm text-zinc-600">
                    将文件拖到这里，或使用选择入口。单文件最大{' '}
                    {config.fileLimit / 1e6} MB，中断后可重选原文件续传。
                </p>
                <label>
                    文件{' '}
                    <input
                        name="file"
                        onChange={(event) => pick(event, setFileChoices)}
                        type="file"
                        multiple
                        disabled={upload.isPending}
                    />
                </label>
                <label>
                    文件夹{' '}
                    <input
                        name="folder"
                        onChange={(event) => pick(event, setFolderChoices)}
                        type="file"
                        ref={(input) => {
                            input?.setAttribute('webkitdirectory', '');
                        }}
                        multiple
                        disabled={upload.isPending}
                    />
                </label>
                {checklist.length > 0 && (
                    <section
                        aria-label="上传前清单"
                        className="space-y-2 text-sm"
                    >
                        <p>目标项目：{name}</p>
                        <p>
                            总大小{' '}
                            {checklist.reduce(
                                (sum, row) => sum + (row.size ?? 0),
                                0,
                            )}{' '}
                            字节， 可用额度 {available}{' '}
                            字节（以服务端受理时为准）。
                        </p>
                        <ul>
                            {checklist.map(({ path, size, label }, index) => (
                                <li key={index} className="break-all">
                                    {path} ·{' '}
                                    {size === undefined
                                        ? '大小未知'
                                        : size + ' 字节'}{' '}
                                    · {label}
                                </li>
                            ))}
                        </ul>
                    </section>
                )}
                <Button primary disabled={upload.isPending || !selected.length}>
                    确认上传
                </Button>
                {checklist.length > 0 && (
                    <Button
                        type="button"
                        disabled={upload.isPending}
                        onClick={() => {
                            setFileChoices([]);
                            setFolderChoices([]);
                        }}
                    >
                        放弃本次选择
                    </Button>
                )}
                {uploadRows.length > 0 && (
                    <ul
                        aria-label="上传结果"
                        aria-live="polite"
                        className="text-sm"
                    >
                        {uploadRows.map(({ path, status, parts }) => (
                            <li key={path} className="break-all">
                                {path} · {status}
                                {parts &&
                                    ` · 已确认 ${parts.confirmedParts} / ${parts.totalParts} 块`}
                            </li>
                        ))}
                    </ul>
                )}
                {upload.error && <Notice message={message(upload.error)} />}
            </form>
            <section className="space-y-3 rounded-xl border border-zinc-200 p-5">
                <h2 className="font-semibold">文件与执行范围</h2>
                {legacyEnabled && (
                    <p role="status" className="text-sm text-zinc-600">
                        {executionLabels[execution.state]}
                    </p>
                )}
                {(tree.directories.size > 0 || tree.files.length > 0) && (
                    <SavedFiles
                        directory={tree}
                        label="已保存文件"
                        selectable={selectable}
                        files={files}
                        setFiles={setFiles}
                        setPreviewId={setPreviewId}
                        deleting={remove.isPending}
                        onDelete={(file) => {
                            remove.reset();
                            setDeleteTarget({ id: file.id, path: file.path });
                        }}
                    />
                )}
                <ul className="divide-y divide-zinc-200">
                    {pendingUploads.map((file) => (
                        <li
                            key={file.id}
                            className="flex justify-between gap-3 py-2"
                        >
                            <span>{file.path}</span>
                            <span className="text-sm text-zinc-600">
                                {
                                    {
                                        preparing: '准备中',
                                        uploading: '可续传',
                                        completing: '正在确认',
                                        cleaning: '清理中',
                                        deleting: '正在删除',
                                        cancelled: '已取消',
                                        expired: '已过期',
                                        failed: '失败',
                                    }[file.state]
                                }
                            </span>
                            {['preparing', 'uploading'].includes(
                                file.state,
                            ) && (
                                <Button
                                    type="button"
                                    disabled={
                                        cancel.isPending || upload.isPending
                                    }
                                    onClick={() => cancel.mutate(file.id)}
                                >
                                    取消上传
                                </Button>
                            )}
                        </li>
                    ))}
                </ul>
                {deleteTarget && (
                    <div
                        role="group"
                        aria-label="确认删除文件"
                        className="space-y-2 rounded border border-zinc-200 p-3"
                    >
                        <p className="break-all">{deleteTarget.path}</p>
                        <p>
                            将删除这个原文件，清理完成后释放额度。已有任务与补丁仍可查看。
                        </p>
                        <div className="flex flex-wrap gap-2">
                            <Button
                                type="button"
                                disabled={remove.isPending}
                                onClick={() => setDeleteTarget(undefined)}
                            >
                                保留文件
                            </Button>
                            <Button
                                type="button"
                                primary
                                disabled={remove.isPending}
                                onClick={() => remove.mutate(deleteTarget.id)}
                            >
                                确认删除
                            </Button>
                        </div>
                    </div>
                )}
                {removalError && <Notice message={removalError} />}
                {preview && (
                    <FilePreview
                        key={preview.id}
                        id={preview.id}
                        path={preview.path}
                        onClose={() => setPreviewId(undefined)}
                    />
                )}
                {selectable && (
                    <Button
                        type="button"
                        disabled={
                            !executionFiles.length ||
                            init.isPending ||
                            snapshotTask.isPending ||
                            remove.isPending
                        }
                        onClick={() =>
                            taskEnabled
                                ? snapshotTask.mutate({
                                      name,
                                      fileIds: executionFiles,
                                  })
                                : init.mutate(executionFiles)
                        }
                    >
                        {taskEnabled ? '从所选文件新建任务' : '准备执行文件'}
                    </Button>
                )}
                {cancel.error && <Notice message={message(cancel.error)} />}
                {init.error && <Notice message={message(init.error)} />}
                {snapshotTask.error && (
                    <Notice message={message(snapshotTask.error)} />
                )}
                {snapshotTask.error instanceof ApiError && (
                    <FileIssues issues={snapshotTask.error.issues} />
                )}
                <FileIssues issues={execution.issues} />
                {execution.state === 'ready' && execution.projectId && (
                    <Button asChild primary>
                        <Link
                            to={
                                '/?' +
                                new URLSearchParams({
                                    project: execution.projectId,
                                })
                            }
                        >
                            在对话中使用
                        </Link>
                    </Button>
                )}
            </section>
        </main>
    );
}
