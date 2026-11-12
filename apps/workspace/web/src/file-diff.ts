type FileChange = {
    path: string;
    status: 'added' | 'modified' | 'deleted';
    text: string;
};

function readPath(token: string, prefix: 'a/' | 'b/'): string | null {
    if (token === '/dev/null') return '';
    try {
        const path: unknown = token.startsWith('"') ? JSON.parse(token) : token;
        return typeof path === 'string' &&
            path.startsWith(prefix) &&
            path.length > prefix.length &&
            !/[\\\p{Cc}]/u.test(path)
            ? path.slice(prefix.length)
            : null;
    } catch {
        return null;
    }
}

function gitPath(header: string): string | null {
    const paths = header.slice('diff --git '.length);
    const middle = (paths.length - 1) / 2;
    const quoted = /^("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")$/.exec(paths);
    const [oldToken, newToken] = paths.startsWith('"')
        ? [quoted?.[1], quoted?.[2]]
        : Number.isInteger(middle) && paths[middle] === ' '
          ? [paths.slice(0, middle), paths.slice(middle + 1)]
          : [];
    if (!oldToken || !newToken) return null;
    const path = readPath(oldToken, 'a/');
    return path && path === readPath(newToken, 'b/') ? path : null;
}

function consumeHunks(lines: string[], cursor: number): number | null {
    const start = cursor;
    while (lines[cursor]?.startsWith('@@ ')) {
        const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@(?: .*)?$/.exec(
            lines[cursor++] ?? '',
        );
        if (!hunk) return null;
        let oldLines = Number(hunk[1] ?? 1);
        let newLines = Number(hunk[2] ?? 1);
        if (
            !Number.isSafeInteger(oldLines) ||
            !Number.isSafeInteger(newLines) ||
            (!oldLines && !newLines)
        )
            return null;
        while (oldLines || newLines) {
            switch (lines[cursor++]?.[0]) {
                case ' ':
                    oldLines--;
                    newLines--;
                    break;
                case '-':
                    oldLines--;
                    break;
                case '+':
                    newLines--;
                    break;
                default:
                    return null;
            }
            if (oldLines < 0 || newLines < 0) return null;
            if (lines[cursor] === '\\ No newline at end of file') cursor++;
        }
    }
    return cursor === start ? null : cursor;
}

export function splitFileDiff(text: string): FileChange[] | null {
    if (!text.endsWith('\n')) return null;
    const lines = text.slice(0, -1).split('\n');
    const git = text.startsWith('diff --git ');
    const files: FileChange[] = [];
    const seen = new Set<string>();
    let cursor = 0;

    while (cursor < lines.length) {
        const start = cursor;
        let headerPath: string | null = null;
        let mode: FileChange['status'] = 'modified';
        let emptyFile = false;
        if (git) {
            const header = lines[cursor++];
            if (!header?.startsWith('diff --git ')) return null;
            headerPath = gitPath(header);
            if (!headerPath) return null;
            if (lines[cursor] === 'new file mode 100644') mode = 'added';
            if (lines[cursor] === 'deleted file mode 100644') mode = 'deleted';
            if (mode !== 'modified') cursor++;

            const index =
                /^index ([0-9a-f]{4,40})\.\.([0-9a-f]{4,40})( 100644)?$/.exec(
                    lines[cursor++] ?? '',
                );
            if (!index) return null;
            const [, before = '', after = '', fileMode] = index;
            if (
                Boolean(fileMode) !== (mode === 'modified') ||
                /^0+$/.test(before) !== (mode === 'added') ||
                /^0+$/.test(after) !== (mode === 'deleted')
            )
                return null;
            const blob = mode === 'added' ? after : before;
            emptyFile =
                mode !== 'modified' &&
                blob.startsWith('e69de29') &&
                'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391'.startsWith(blob) &&
                (cursor === lines.length ||
                    lines[cursor]?.startsWith('diff --git ') === true);
        }

        let path: string;
        let status: FileChange['status'];
        if (emptyFile && headerPath) {
            path = headerPath;
            status = mode;
        } else {
            const oldHeader = lines[cursor++];
            const newHeader = lines[cursor++];
            if (
                !oldHeader?.startsWith('--- ') ||
                !newHeader?.startsWith('+++ ')
            )
                return null;
            const before = readPath(
                oldHeader.slice(4).replace(/\t$/, ''),
                'a/',
            );
            const after = readPath(newHeader.slice(4).replace(/\t$/, ''), 'b/');
            if (
                before === null ||
                after === null ||
                (!before && !after) ||
                (before && after && before !== after)
            )
                return null;
            path = after || before;
            status = before ? (after ? 'modified' : 'deleted') : 'added';
            if (git && (path !== headerPath || status !== mode)) return null;
            const end = consumeHunks(lines, cursor);
            if (end === null) return null;
            cursor = end;
        }

        if (seen.has(path)) return null;
        seen.add(path);
        files.push({
            path,
            status,
            text: lines.slice(start, cursor).join('\n') + '\n',
        });
    }
    return files;
}
