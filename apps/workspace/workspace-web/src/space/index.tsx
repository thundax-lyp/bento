import {
    droppedChoices,
    hasReleasedPath,
    planUpload,
    type UploadChoice,
    type UploadItem,
    type UploadRow,
} from './upload-plan.ts';
import { FilePreview, savedFileTree, SavedFiles } from './files.tsx';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent, FormEvent } from 'react';
import { Link, useNavigate, useOutletContext, useParams } from 'react-router';
import {
    cancelUpload,
    createSpaceProject,
    deleteSpaceFile,
    deleteSpaceProject,
    getProjectDeletionImpact,
    getUpload,
    prepareWorkspace,
    spaceProjectQuery,
    spaceQuery,
    transferFile,
} from './api.ts';
import type { Space, Upload } from './api.ts';
import { ApiError, createTask, taskListQuery, taskUrl } from '../api.ts';
import { Button, Notice } from '../ui.tsx';

function message(error: unknown) {
    return error instanceof Error ? error.message : '操作失败，请稍后重试。';
}

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

export function SpaceList() {
    const account = useOutletContext<string>();
    const query = useQuery(spaceQuery(account));
    const client = useQueryClient();
    const navigate = useNavigate();
    const [draft, setDraft] = useState({ name: '', id: '' });
    const create = useMutation({
        mutationFn: ({ id, name }: typeof draft) =>
            createSpaceProject(id, name),
        async onSuccess(result) {
            await client.invalidateQueries({
                queryKey: spaceQuery(account).queryKey,
            });
            await navigate('/space/' + encodeURIComponent(result.id));
        },
    });
    if (query.error) return <Notice message={message(query.error)} />;
    if (!query.data) return null;
    const { saved, reserved, quota, projects } = query.data;
    function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const payload = {
            name: draft.name.trim(),
            id: draft.id || crypto.randomUUID(),
        };
        setDraft(payload);
        create.mutate(payload);
    }
    return (
        <section className="space-y-3 rounded-xl border border-zinc-200 p-5">
            <h2 className="text-lg font-semibold">云端空间</h2>
            <p className="text-sm text-zinc-600">
                已用 {((saved + reserved) / 1e6).toFixed(2)} / {quota / 1e6}{' '}
                MB，包含上传预占。
            </p>
            <ul className="divide-y divide-zinc-200">
                {projects.map((project) => (
                    <li key={project.id} className="py-2">
                        <Link
                            className="underline"
                            to={'/space/' + encodeURIComponent(project.id)}
                        >
                            {project.name}
                        </Link>
                        {project.state === 'deleting' && (
                            <span className="ml-2">正在删除项目</span>
                        )}
                    </li>
                ))}
            </ul>
            <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
                <label>
                    空间项目名称
                    <input
                        className="mt-1 block"
                        required
                        maxLength={120}
                        value={draft.name}
                        onChange={(event) =>
                            setDraft({ name: event.target.value, id: '' })
                        }
                    />
                </label>
                <Button
                    primary
                    disabled={create.isPending || !draft.name.trim()}
                >
                    新建空间项目
                </Button>
            </form>
            {create.error && <Notice message={message(create.error)} />}
        </section>
    );
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
    const deletionKey = JSON.stringify(['bento:project-delete', account, id]);
    const [confirmProject, setConfirmProject] = useState(false);
    const [confirmedProject, setConfirmedProject] = useState(
        () => sessionStorage.getItem(deletionKey) === '1',
    );
    const [projectAccepted, setProjectAccepted] = useState(false);
    const checkedMissing = useRef(false);
    const impact = useQuery({
        queryKey: ['account', account, 'project-deletion-impact', id],
        queryFn: ({ signal }) => getProjectDeletionImpact(id, signal),
        enabled: confirmProject || confirmedProject,
        retry: false,
    });
    const rememberDeletion = () => {
        sessionStorage.setItem(deletionKey, '1');
        setConfirmedProject(true);
    };
    const forgetDeletion = () => {
        sessionStorage.removeItem(deletionKey);
        setConfirmedProject(false);
    };
    const deleteProject = useMutation({
        mutationFn: () => deleteSpaceProject(id),
        async onSuccess(state) {
            if (state === 'deleted') {
                forgetDeletion();
                setProjectAccepted(false);
                await client.invalidateQueries({
                    queryKey: spaceQuery(account).queryKey,
                });
                await navigate('/workspaces');
                return;
            }
            setProjectAccepted(true);
            setConfirmProject(false);
            await refresh();
        },
        async onError(error) {
            if (error instanceof ApiError && error.status === 409) {
                forgetDeletion();
                setProjectAccepted(false);
                setConfirmProject(true);
            }
            if (!(error instanceof ApiError) || error.status !== 404) {
                await Promise.all([refresh(), impact.refetch()]);
            }
        },
    });
    const serverDeleting = project.data?.state === 'deleting';
    const missing = [project.error, impact.error].some(
        (error) => error instanceof ApiError && error.status === 404,
    );
    useEffect(() => {
        if (serverDeleting) {
            sessionStorage.setItem(deletionKey, '1');
        }
    }, [serverDeleting, deletionKey]);
    const { mutate: checkDeletion, isPending: deletingRequest } = deleteProject;
    useEffect(() => {
        if (!missing) {
            checkedMissing.current = false;
            return;
        }
        if (
            deletingRequest ||
            checkedMissing.current ||
            (!confirmedProject && sessionStorage.getItem(deletionKey) !== '1')
        )
            return;
        checkedMissing.current = true;
        checkDeletion();
    }, [
        missing,
        deletingRequest,
        confirmedProject,
        deletionKey,
        checkDeletion,
    ]);
    const [uploadRows, setUploadRows] = useState<UploadRow[]>([]);
    const [fileChoices, setFileChoices] = useState<UploadChoice[]>([]);
    const [folderChoices, setFolderChoices] = useState<UploadChoice[]>([]);
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
    function updateUploadRow(
        path: string,
        status: string,
        parts?: UploadRow['parts'],
    ): void {
        setUploadRows((rows) =>
            rows.map((row) =>
                row.path === path
                    ? { ...row, status, ...(parts ? { parts } : {}) }
                    : row,
            ),
        );
    }
    const upload = useMutation({
        async mutationFn({
            selected,
            config,
        }: {
            selected: UploadItem[];
            config: Space;
        }) {
            let signedOut = false;
            for (const { path, file, uploadId } of selected) {
                if (signedOut) {
                    updateUploadRow(path, '未开始，请重新登录后重选文件。');
                    continue;
                }
                updateUploadRow(path, '正在准备上传…');
                const key = JSON.stringify([
                    'bento:upload',
                    account,
                    id,
                    path,
                    file.size,
                ]);
                try {
                    let cached = uploadId ? null : sessionStorage.getItem(key);
                    if (
                        cached &&
                        !config.uploads.some((item) => item.id === cached)
                    ) {
                        const status = await getUpload(cached).catch(
                            (error: unknown) => {
                                if (
                                    error instanceof ApiError &&
                                    error.status === 401
                                )
                                    throw error;
                                return undefined;
                            },
                        );
                        if (status?.state === 'deleted') cached = null;
                    }
                    const ended =
                        cached &&
                        config.uploads.some(
                            (item) =>
                                item.id === cached &&
                                hasReleasedPath(item.state),
                        );
                    const currentId =
                        uploadId ??
                        (ended ? null : cached) ??
                        crypto.randomUUID();
                    sessionStorage.setItem(key, currentId);
                    await transferFile(
                        id,
                        currentId,
                        file,
                        path,
                        config.partSize,
                        (status) => {
                            switch (status.phase) {
                                case 'checking':
                                    updateUploadRow(path, '正在校验文件…');
                                    break;
                                case 'transferring':
                                    updateUploadRow(path, '上传中', {
                                        confirmedParts: status.confirmedParts,
                                        totalParts: status.totalParts,
                                    });
                                    break;
                                case 'completing':
                                    updateUploadRow(path, '正在确认上传结果…');
                                    break;
                            }
                        },
                    );
                    updateUploadRow(path, '已保存');
                    try {
                        if (sessionStorage.getItem(key) === currentId)
                            sessionStorage.removeItem(key);
                    } catch {
                        // A cache failure cannot change the server's saved result.
                    }
                } catch (error) {
                    signedOut =
                        error instanceof ApiError && error.status === 401;
                    updateUploadRow(
                        path,
                        signedOut
                            ? '登录已过期，请重新登录。'
                            : '本次上传未确认：' + message(error),
                    );
                }
            }
        },
        onSuccess() {
            setFileChoices([]);
            setFolderChoices([]);
        },
        onSettled: refresh,
    });
    const cancel = useMutation({
        mutationFn: cancelUpload,
        onSettled: refresh,
    });
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
