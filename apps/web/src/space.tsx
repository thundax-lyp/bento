import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate, useOutletContext, useParams } from 'react-router';
import {
    cancelUpload,
    createSpaceProject,
    downloadFileUrl,
    prepareWorkspace,
    spaceProjectQuery,
    spaceQuery,
    transferFile,
} from './space-api';
import type { Space } from './space-api';
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

function CloudProject({ account, id }: { account: string; id: string }) {
    const client = useQueryClient();
    const space = useQuery(spaceQuery(account));
    const project = useQuery(spaceProjectQuery(account, id));
    const [progress, setProgress] = useState('');
    const [files, setFiles] = useState<string[]>([]);
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
            selected: File[];
            config: Space;
        }) {
            const paths = selected.map(
                (file) => file.webkitRelativePath || file.name,
            );
            if (new Set(paths).size !== paths.length)
                throw new Error('所选文件存在重复路径。');
            for (const file of selected) {
                const filename = file.webkitRelativePath || file.name;
                if (file.size > config.fileLimit)
                    throw new Error('单个文件最大 4 GB。');
                const prior = config.uploads.find(
                    (item) => item.project === id && item.path === filename,
                );
                const row =
                    prior &&
                    !['cancelled', 'expired', 'failed'].includes(prior.state)
                        ? prior
                        : undefined;
                if (row && row.size !== file.size)
                    throw new Error('此路径已有不同大小的文件，请选择原文件。');
                const key = JSON.stringify([
                    'bento:upload',
                    account,
                    id,
                    filename,
                    file.size,
                ]);
                const uploadId =
                    row?.id ??
                    (prior ? null : sessionStorage.getItem(key)) ??
                    crypto.randomUUID();
                sessionStorage.setItem(key, uploadId);
                await transferFile(
                    id,
                    uploadId,
                    file,
                    filename,
                    config.partSize,
                    setProgress,
                );
                sessionStorage.removeItem(key);
            }
        },
        onSettled: refresh,
    });
    const cancel = useMutation({
        mutationFn: cancelUpload,
        onSettled: refresh,
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
    const selectable =
        execution.state === 'uninitialized' ||
        (execution.state === 'failed' && !execution.projectId);
    function send(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const selected = [
            ...event.currentTarget.querySelectorAll<HTMLInputElement>(
                'input[type="file"]',
            ),
        ].flatMap((input) => Array.from(input.files ?? []));
        if (selected.length) upload.mutate({ selected, config });
    }
    return (
        <main className="mx-auto max-w-4xl space-y-5 px-5 py-10">
            <Link className="text-sm underline" to="/workspaces">
                返回 Workspace
            </Link>
            <h1 className="text-2xl font-semibold">{name}</h1>
            <form
                onSubmit={send}
                className="space-y-3 rounded-xl border border-zinc-200 p-5"
            >
                <h2 className="font-semibold">上传文件</h2>
                <p className="text-sm text-zinc-600">
                    单文件最大 4 GB。中断后重新选择原文件可续传。
                </p>
                <label>
                    文件{' '}
                    <input
                        name="file"
                        type="file"
                        multiple
                        disabled={upload.isPending}
                    />
                </label>
                <label>
                    文件夹{' '}
                    <input
                        name="folder"
                        type="file"
                        ref={(input) => {
                            input?.setAttribute('webkitdirectory', '');
                        }}
                        multiple
                        disabled={upload.isPending}
                    />
                </label>
                <Button primary disabled={upload.isPending}>
                    上传或续传
                </Button>
                <p role="status" className="text-sm text-zinc-600">
                    {upload.isSuccess
                        ? '文件已保存。'
                        : upload.isPending
                          ? progress
                          : ''}
                </p>
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
                                <a
                                    className="text-sm underline"
                                    href={downloadFileUrl(file.id)}
                                >
                                    下载文件
                                </a>
                            ) : (
                                <span className="text-sm text-zinc-600">
                                    {
                                        {
                                            preparing: '准备中',
                                            uploading: '可续传',
                                            completing: '正在确认',
                                            cleaning: '清理中',
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
                {selectable && (
                    <Button
                        type="button"
                        disabled={!files.length || init.isPending}
                        onClick={() => init.mutate(files)}
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
