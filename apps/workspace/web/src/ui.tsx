import { Slot } from '@radix-ui/react-slot';
import type { ComponentProps } from 'react';

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

export function DiffPreview({ text }: { text: string }) {
    if (!text)
        return <p className="text-sm text-zinc-600">这次任务没有文件变更。</p>;
    return (
        <pre
            aria-label="逐行变更"
            className="overflow-x-auto rounded-lg border border-zinc-200 text-sm"
        >
            {text.split('\n').map((line, index) => (
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
                    {line || ' '}
                </span>
            ))}
        </pre>
    );
}
