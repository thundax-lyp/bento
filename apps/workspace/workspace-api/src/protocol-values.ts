export const runStatuses = [
    'pending_approval',
    'queued',
    'running',
    'recovering',
    'needs_review',
    'cancelling',
    'cancelled',
    'succeeded',
    'failed',
] as const;

export class RequestError extends Error {
    readonly status: number;
    readonly code: string;
    readonly reason?: string;
    readonly issues?: { fileId: string; path: string; code: string }[];

    constructor(
        status: number,
        code: string,
        message: string,
        issues?: RequestError['issues'],
        reason?: string,
    ) {
        super(message);
        this.status = status;
        this.code = code;
        if (issues) this.issues = issues;
        if (reason) this.reason = reason;
    }
}

export const notFound = () =>
    new RequestError(404, 'not_found', '找不到该资源。');
export const conflict = (message: string) =>
    new RequestError(409, 'conflict', message);

export function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new RequestError(400, 'invalid_input', '请求必须是 JSON 对象。');
    }
    return value as Record<string, unknown>;
}

export function runPrompt(value: unknown): string {
    const { prompt } = object(value);
    if (
        typeof prompt !== 'string' ||
        !prompt.trim() ||
        [...prompt.trim()].length > 8000
    ) {
        throw new RequestError(
            400,
            'invalid_prompt',
            '任务描述须为 1 至 8000 个字符。',
        );
    }
    return prompt.trim();
}

export function resourceId(value: unknown): string {
    if (
        typeof value !== 'string' ||
        !value ||
        value === '.' ||
        value === '..' ||
        /[/\\\p{Cc}\p{Surrogate}]/u.test(value)
    ) {
        throw notFound();
    }
    return value;
}

export function field(value: unknown): string {
    if (typeof value !== 'string') throw new Error('Invalid field');
    return value;
}

export function timestamp(value: unknown): string {
    const date = field(value);
    if (
        !/^\d{4}-\d{2}-\d{2}T/.test(date) ||
        !Number.isFinite(Date.parse(date))
    ) {
        throw new Error('Invalid timestamp');
    }
    return date;
}

export function status<T extends string>(
    value: unknown,
    allowed: readonly T[],
): T {
    const match = allowed.find((candidate) => candidate === value);
    if (!match) throw new Error('Invalid status');
    return match;
}
