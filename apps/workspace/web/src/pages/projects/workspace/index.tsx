import {
    ApiError,
    createProject,
    projectsQuery,
} from '@/apps/workspace/web/src/api.ts';
import { SpaceList } from '@/apps/workspace/web/src/space/index.tsx';
import { Button, Notice } from '@/apps/workspace/web/src/ui.tsx';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FormEvent } from 'react';
import { Link, useOutletContext, useParams } from 'react-router';

const errorMessage = (error: unknown) =>
    error instanceof ApiError ? error.message : '暂时无法连接，请稍后重试。';
const fieldClass = 'mt-1 block w-full';

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
