import {
    ApiError,
    createTask,
    taskListQuery,
    taskUrl,
} from '@/apps/workspace/web/src/api.ts';
import { Button, Notice } from '@/apps/workspace/web/src/ui.tsx';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';

const errorMessage = (error: unknown) =>
    error instanceof ApiError ? error.message : '暂时无法连接，请稍后重试。';
const fieldClass = 'mt-1 block w-full';

export function TaskComposer({ account }: { account: string }) {
    const [name, setName] = useState('');
    const navigate = useNavigate();
    const client = useQueryClient();
    const mutation = useMutation({
        mutationFn: () => createTask(account, name, { kind: 'blank' }),
        async onSuccess(task) {
            await client.invalidateQueries({
                queryKey: taskListQuery(account).queryKey,
            });
            await navigate(taskUrl(task.id));
        },
    });
    return (
        <main className="mx-auto max-w-3xl space-y-5 px-5 py-10">
            <h1 className="text-2xl font-semibold">新建任务</h1>
            <form
                className="space-y-4 rounded-xl border border-zinc-200 p-5"
                onSubmit={(event) => {
                    event.preventDefault();
                    if (name.trim() && !mutation.isPending) mutation.mutate();
                }}
            >
                <label>
                    任务名称
                    <input
                        className={fieldClass}
                        required
                        maxLength={120}
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                    />
                </label>
                <Button primary disabled={!name.trim() || mutation.isPending}>
                    创建空白任务
                </Button>
                {mutation.error && (
                    <Notice message={errorMessage(mutation.error)} />
                )}
            </form>
        </main>
    );
}
