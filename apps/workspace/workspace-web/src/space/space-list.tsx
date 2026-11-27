import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useOutletContext } from 'react-router';
import { Button, Notice } from '../ui.tsx';
import { createSpaceProject, spaceQuery } from './api.ts';
import { message } from './error-message.ts';

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
