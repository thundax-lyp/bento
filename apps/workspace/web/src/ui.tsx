import { Slot } from '@radix-ui/react-slot';
import { useMemo, useState } from 'react';
import type { ComponentProps } from 'react';
import { splitFileDiff } from './file-diff.ts';

// Button follows the shadcn/ui Radix pattern so links and buttons share a style.
export function Button({
    asChild,
    primary,
    className = '',
    ...props
}: ComponentProps<'button'> & { asChild?: boolean; primary?: boolean }) {
    const Component = asChild ? Slot : 'button';
    return (
        <Component
            className={
                'inline-flex min-h-10 items-center justify-center rounded-lg border px-3.5 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50 ' +
                (primary
                    ? 'border-zinc-900 bg-zinc-900 text-white hover:bg-zinc-700 '
                    : 'border-zinc-200 bg-white text-zinc-900 hover:bg-zinc-100 ') +
                className
            }
            {...props}
        />
    );
}

export function Notice({ message }: { message: string }) {
    return (
        <p
            role="alert"
            className="rounded-lg bg-red-50 p-3 text-sm text-red-800"
        >
            {message}
        </p>
    );
}

function DiffText({ text }: { text: string }) {
    return (
        <pre
            aria-label="逐行变更"
            className="overflow-x-auto rounded-lg border border-zinc-200 text-sm"
        >
            {text.match(/[^\n]*\n|[^\n]+$/g)?.map((line, index) => (
                <span
                    key={index}
                    className={
                        'block min-w-max px-3 py-0.5 ' +
                        (line.startsWith('+') && !line.startsWith('+++')
                            ? 'bg-green-50 text-green-900'
                            : line.startsWith('-') && !line.startsWith('---')
                              ? 'bg-red-50 text-red-900'
                              : line.startsWith('@@')
                                ? 'bg-zinc-100'
                                : '')
                    }
                >
                    {line}
                </span>
            ))}
        </pre>
    );
}

const changeLabels = { added: '新增', modified: '修改', deleted: '删除' };

export function DiffPreview({ text }: { text: string }) {
    const files = useMemo(() => splitFileDiff(text), [text]);
    const [path, setPath] = useState<string | null>(null);
    if (!text)
        return <p className="text-sm text-zinc-600">这次任务没有文件变更。</p>;

    const selected = files?.find((file) => file.path === path);
    return (
        <>
            {files ? (
                <>
                    <ul aria-label="变更文件" className="flex flex-wrap gap-2">
                        {files.map((file) => (
                            <li key={file.path} className="min-w-0 max-w-full">
                                <Button
                                    type="button"
                                    primary={selected === file}
                                    aria-pressed={selected === file}
                                    className="max-w-full break-all text-left"
                                    onClick={() => setPath(file.path)}
                                >
                                    {changeLabels[file.status] +
                                        ' ' +
                                        file.path}
                                </Button>
                            </li>
                        ))}
                    </ul>
                    <Button
                        type="button"
                        primary={!selected}
                        aria-pressed={!selected}
                        onClick={() => setPath(null)}
                    >
                        完整补丁
                    </Button>
                </>
            ) : (
                <p className="text-sm text-zinc-600">无法按文件显示此补丁。</p>
            )}
            <DiffText text={selected?.text ?? text} />
        </>
    );
}
