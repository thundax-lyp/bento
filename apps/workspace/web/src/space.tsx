import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { ChangeEvent, DragEvent, FormEvent } from 'react';
import { Link, useNavigate, useOutletContext, useParams } from 'react-router';
import {
    cancelUpload,
    createSpaceProject,
    deleteSpaceFile,
    downloadFileUrl,
    getUpload,
    prepareWorkspace,
    previewFile,
    spaceProjectQuery,
    spaceQuery,
    transferFile,
} from './space-api.ts';
import type { PreviewResult, Space } from './space-api.ts';
import { Button, Notice } from './ui';

function message(error: unknown) {
    return error instanceof Error ? error.message : '操作失败，请稍后重试。';
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
                已用 {((saved + reserved) / 1e9).toFixed(2)} / {quota / 1e9}{' '}
                GB，包含上传预占。
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

type UploadChoice =
    { path: string; file: File } | { path: string; file: null; reason: string };
type UploadItem = { path: string; file: File; uploadId?: string };

function droppedChoices(items: DataTransferItemList): UploadChoice[] {
    return Array.from(items)
        .filter((item) => item.kind === 'file')
        .map((item) => {
            const entry = item.webkitGetAsEntry?.();
            if (entry?.isDirectory)
                return {
                    path: entry.name,
                    file: null,
                    reason: '请用文件夹选择入口。',
                };
            const file = entry?.isFile ? item.getAsFile() : null;
            return file
                ? { path: file.name, file }
                : {
                      path: entry?.name ?? '拖入项',
                      file: null,
                      reason: '无法读取拖入项，请使用选择入口。',
                  };
        });
}

function hasReleasedPath(state: Space['uploads'][number]['state']) {
    return state === 'cancelled' || state === 'expired' || state === 'failed';
}

function pathPrefixes(path: string) {
    const prefixes: string[] = [];
    for (
        let end = path.indexOf('/');
        end !== -1;
        end = path.indexOf('/', end + 1)
    )
        prefixes.push(path.slice(0, end));
    return prefixes;
}

function planUpload(choices: UploadChoice[], config: Space, project: string) {
    const rows = choices.map((choice) => {
        const { path, file } = choice;
        let reason = '';
        if (!file) reason = choice.reason;
        else if (
            path.length > 1024 ||
            /[\\\p{Cc}\p{Surrogate}]/u.test(path) ||
            path.split('/').some((segment) => ['', '.', '..'].includes(segment))
        )
            reason = '文件路径无效。';
        else if (file.size > config.fileLimit) reason = '单文件最多 4 GB。';
        return { ...choice, reason };
    });
    const paths = new Map<string, number>();
    const directories = new Set<string>();
    for (const { path, reason } of rows) {
        if (reason) continue;
        paths.set(path, (paths.get(path) ?? 0) + 1);
        for (const prefix of pathPrefixes(path)) directories.add(prefix);
    }
    const existing = config.uploads.filter(
        (item) => item.project === project && !hasReleasedPath(item.state),
    );
    const available = config.quota - config.saved - config.reserved;
    let remaining = available;
    const selected: UploadItem[] = [];
    const checklist = rows.map(({ path, file, reason }) => {
        let label = reason;
        if (file && !label) {
            const prior = existing.find(
                (item) =>
                    item.path === path ||
                    item.path.startsWith(path + '/') ||
                    path.startsWith(item.path + '/'),
            );
            if ((paths.get(path) ?? 0) > 1) label = '清单内目标路径重复。';
            else if (
                directories.has(path) ||
                pathPrefixes(path).some((prefix) => paths.has(prefix))
            )
                label = '清单内文件与目录路径冲突。';
            else if (prior) {
                if (
                    prior.path !== path ||
                    prior.state === 'saved' ||
                    prior.state === 'cleaning' ||
                    prior.state === 'deleting'
                )
                    label = '目标路径已被占用。';
                else if (prior.size !== file.size)
                    label = '请选择同一上传的原文件。';
                else {
                    selected.push({ path, file, uploadId: prior.id });
                    label = '待校验续传';
                }
            } else if (file.size > remaining) label = '账号可用额度不足。';
            else {
                remaining -= file.size;
                selected.push({ path, file });
                label = '待上传';
            }
        }
        return { path, size: file?.size, label };
    });
    return { available, checklist, selected };
}

function FilePreview({
    id,
    path,
    onClose,
}: {
    id: string;
    path: string;
    onClose: () => void;
}) {
    const [result, setResult] = useState<PreviewResult>();
    useEffect(() => {
        const controller = new AbortController();
        void previewFile(id, controller.signal).then((preview) => {
            if (!controller.signal.aborted) setResult(preview);
        });
        return () => controller.abort();
    }, [id]);
    return (
        <section
            aria-label="文本预览"
            className="space-y-2 rounded border border-zinc-200 p-3"
        >
            <div className="flex items-center justify-between gap-3">
                <h3 className="break-all font-medium">{path}</h3>
                <Button type="button" onClick={onClose}>
                    关闭预览
                </Button>
            </div>
            {result?.kind === 'text' ? (
                result.text === '' ? (
                    <p>空文件</p>
                ) : (
                    <pre className="max-h-96 overflow-auto">{result.text}</pre>
                )
            ) : (
                <p role="status">
                    {result
                        ? {
                              too_large: '文件超过 256 KiB，无法预览',
                              not_utf8: '文件不是有效的 UTF-8 文本',
                              unavailable: '预览暂不可用',
                          }[result.kind]
                        : '正在读取预览…'}
                </p>
            )}
        </section>
    );
}

function CloudProject({ account, id }: { account: string; id: string }) {
    const client = useQueryClient();
    const space = useQuery(spaceQuery(account));
    const project = useQuery(spaceProjectQuery(account, id));
    const [progress, setProgress] = useState('');
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
    const upload = useMutation({
        async mutationFn({
            selected,
            config,
        }: {
            selected: UploadItem[];
            config: Space;
        }) {
            const results: { path: string; status: string }[] = [];
            let signedOut = false;
            for (const { path, file, uploadId } of selected) {
                if (signedOut) {
                    results.push({ path, status: '请重新登录后重选文件。' });
                    continue;
                }
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
                            () => undefined,
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
                            setProgress(path + ' · ' + status);
                        },
                    );
                    results.push({ path, status: '已保存' });
                    try {
                        if (sessionStorage.getItem(key) === currentId)
                            sessionStorage.removeItem(key);
                    } catch {
                        // A cache failure cannot change the server's saved result.
                    }
                } catch (error) {
                    signedOut =
                        error instanceof Error &&
                        'status' in error &&
                        error.status === 401;
                    results.push({
                        path,
                        status: signedOut
                            ? '登录已过期，请重新登录。'
                            : message(error),
                    });
                }
            }
            return results;
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
        execution.state === 'uninitialized' ||
        (execution.state === 'failed' && !execution.projectId);
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
        setProgress('');
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
                    将文件拖到这里，或使用选择入口。单文件最大 4
                    GB，中断后可重选原文件续传。
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
                <p role="status" className="text-sm text-zinc-600">
                    {upload.isPending ? progress : ''}
                </p>
                {upload.data && (
                    <ul aria-label="上传结果" className="text-sm">
                        {upload.data.map(({ path, status }) => (
                            <li key={path} className="break-all">
                                {path} · {status}
                            </li>
                        ))}
                    </ul>
                )}
                {upload.error && <Notice message={message(upload.error)} />}
            </form>
            <section className="space-y-3 rounded-xl border border-zinc-200 p-5">
                <h2 className="font-semibold">文件与执行范围</h2>
                <p role="status" className="text-sm text-zinc-600">
                    {executionLabels[execution.state]}
                </p>
                <ul className="divide-y divide-zinc-200">
                    {uploads.map((file) => (
                        <li
                            key={file.id}
                            className="flex justify-between gap-3 py-2"
                        >
                            {file.state === 'saved' && selectable ? (
                                <label className="flex items-center gap-2">
                                    <input
                                        type="checkbox"
                                        checked={files.includes(file.id)}
                                        onChange={(event) =>
                                            setFiles(
                                                event.target.checked
                                                    ? [...files, file.id]
                                                    : files.filter(
                                                          (value) =>
                                                              value !== file.id,
                                                      ),
                                            )
                                        }
                                    />
                                    {file.path}
                                </label>
                            ) : (
                                <span>{file.path}</span>
                            )}
                            {file.state === 'saved' ? (
                                <div className="flex items-center gap-2">
                                    <Button
                                        type="button"
                                        onClick={() => setPreviewId(file.id)}
                                    >
                                        预览文本
                                    </Button>
                                    <a
                                        className="text-sm underline"
                                        href={downloadFileUrl(file.id)}
                                    >
                                        下载文件
                                    </a>
                                    <Button
                                        type="button"
                                        disabled={remove.isPending}
                                        onClick={() => {
                                            remove.reset();
                                            setDeleteTarget({
                                                id: file.id,
                                                path: file.path,
                                            });
                                        }}
                                    >
                                        删除文件
                                    </Button>
                                </div>
                            ) : (
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
                            )}
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
                            remove.isPending
                        }
                        onClick={() => init.mutate(executionFiles)}
                    >
                        准备执行文件
                    </Button>
                )}
                {cancel.error && <Notice message={message(cancel.error)} />}
                {init.error && <Notice message={message(init.error)} />}
                {execution.issues?.map((issue, index) => (
                    <Notice
                        key={index}
                        message={
                            issue.path +
                            ' · ' +
                            (issue.code === 'invalid_utf8'
                                ? '不是有效的 UTF-8 文本'
                                : '文件路径不适用于执行')
                        }
                    />
                ))}
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
