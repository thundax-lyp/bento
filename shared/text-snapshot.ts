export function wellFormed(text: string) {
    return Buffer.from(text).toString('utf8') === text;
}

export function snapshotPathParts(path: string) {
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
        return undefined;
    return parts;
}

export const maxSnapshotFiles = 100;
export const maxSnapshotBytes = 1024 * 1024;
