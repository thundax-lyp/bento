import type { FileText } from './types.ts';

export class RequestError extends Error {
    constructor(status: number, code: string, message: string) {
        super(message);
        this.status = status;
        this.code = code;
    }

    readonly status: number;
    readonly code: string;
}

export const invalid = (message: string) =>
    new RequestError(400, 'invalid_input', message);
export const conflict = (code: string, message: string) =>
    new RequestError(409, code, message);
export const missing = () =>
    new RequestError(404, 'not_found', 'Resource not found.');
export const oversized = () =>
    new RequestError(
        413,
        'payload_too_large',
        'Snapshot or request exceeds the size limit.',
    );

export function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw invalid('Expected a JSON object.');
    return value as Record<string, unknown>;
}

export function wellFormed(text: string) {
    return Buffer.from(text).toString('utf8') === text;
}

export function filePath(path: string) {
    const parts = path.split('/');
    if (
        !wellFormed(path) ||
        Buffer.byteLength(path) > 4096 ||
        /[\\\p{Cc}]/u.test(path) ||
        parts.some(
            (part) =>
                !part ||
                part === '.' ||
                part === '..' ||
                part.toLowerCase() === '.git' ||
                Buffer.byteLength(part) > 255,
        )
    )
        throw invalid('Invalid relative file path.');
    return parts;
}

export const maxSnapshotFiles = 100;
export const maxSnapshotBytes = 1024 * 1024;

export function textSnapshot(value: unknown): FileText[] {
    if (!Array.isArray(value)) throw invalid('Expected a files array.');
    if (value.length > maxSnapshotFiles) throw oversized();
    const files: FileText[] = [];
    const paths = new Set<string>();
    const directories = new Set<string>();
    let bytes = 0;
    for (const item of value) {
        const { path, text } = object(item);
        if (
            typeof path !== 'string' ||
            typeof text !== 'string' ||
            !wellFormed(text)
        )
            throw invalid('Each file needs a path and UTF-8 text.');
        const parts = filePath(path);
        if (paths.has(path)) throw invalid('Duplicate file path.');
        paths.add(path);
        for (let i = 1; i < parts.length; i++)
            directories.add(parts.slice(0, i).join('/'));
        bytes += Buffer.byteLength(text);
        if (bytes > maxSnapshotBytes) throw oversized();
        files.push({ path, text });
    }
    if ([...paths].some((path) => directories.has(path)))
        throw invalid('File and directory paths conflict.');
    return files.sort((a, b) =>
        a.path < b.path ? -1 : a.path === b.path ? 0 : 1,
    );
}

export function projectInput(value: unknown) {
    const { name, files } = object(value);
    if (typeof name !== 'string' || !name.trim() || !wellFormed(name))
        throw invalid('Project name must contain UTF-8 text.');
    return { name: name.trim(), files: textSnapshot(files) };
}

export function runInput(value: unknown, key: string | undefined) {
    if (!key) throw invalid('Idempotency-Key is required.');
    const { prompt } = object(value);
    if (typeof prompt !== 'string' || !wellFormed(prompt))
        throw invalid('Expected a UTF-8 prompt.');
    const input = prompt.trim();
    if (!input || [...input].length > 8000)
        throw invalid('Prompt must contain 1 to 8000 characters.');
    return { key, prompt: input };
}
