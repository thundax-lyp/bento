import type { Space } from './api.ts';

export type UploadChoice =
    { path: string; file: File } | { path: string; file: null; reason: string };
export type UploadItem = { path: string; file: File; uploadId?: string };
export type UploadRow = {
    path: string;
    status: string;
    parts?: { confirmedParts: number; totalParts: number };
};

export function droppedChoices(items: DataTransferItemList): UploadChoice[] {
    return Array.from(items)
        .filter((item) => item.kind === 'file')
        .map((item) => {
            const entry = item.webkitGetAsEntry?.();
            if (entry?.isDirectory)
                return {
                    path: entry.name,
                    file: null,
                    reason: '请用文件夹选择入口。',
                };
            const file = entry?.isFile ? item.getAsFile() : null;
            return file
                ? { path: file.name, file }
                : {
                      path: entry?.name ?? '拖入项',
                      file: null,
                      reason: '无法读取拖入项，请使用选择入口。',
                  };
        });
}

export function hasReleasedPath(state: Space['uploads'][number]['state']) {
    return state === 'cancelled' || state === 'expired' || state === 'failed';
}

function pathPrefixes(path: string) {
    const prefixes: string[] = [];
    for (
        let end = path.indexOf('/');
        end !== -1;
        end = path.indexOf('/', end + 1)
    )
        prefixes.push(path.slice(0, end));
    return prefixes;
}

export function planUpload(
    choices: UploadChoice[],
    config: Space,
    project: string,
) {
    const rows = choices.map((choice) => {
        const { path, file } = choice;
        let reason = '';
        if (!file) reason = choice.reason;
        else if (
            path.length > 1024 ||
            /[\\\p{Cc}\p{Surrogate}]/u.test(path) ||
            path.split('/').some((segment) => ['', '.', '..'].includes(segment))
        )
            reason = '文件路径无效。';
        else if (file.size > config.fileLimit)
            reason = `单文件最多 ${config.fileLimit / 1e6} MB。`;
        return { ...choice, reason };
    });
    const paths = new Map<string, number>();
    const directories = new Set<string>();
    for (const { path, reason } of rows) {
        if (reason) continue;
        paths.set(path, (paths.get(path) ?? 0) + 1);
        for (const prefix of pathPrefixes(path)) directories.add(prefix);
    }
    const existing = config.uploads.filter(
        (item) => item.project === project && !hasReleasedPath(item.state),
    );
    const available = config.quota - config.saved - config.reserved;
    let remaining = available;
    const selected: UploadItem[] = [];
    const checklist = rows.map(({ path, file, reason }) => {
        let label = reason;
        if (file && !label) {
            const prior = existing.find(
                (item) =>
                    item.path === path ||
                    item.path.startsWith(path + '/') ||
                    path.startsWith(item.path + '/'),
            );
            if ((paths.get(path) ?? 0) > 1) label = '清单内目标路径重复。';
            else if (
                directories.has(path) ||
                pathPrefixes(path).some((prefix) => paths.has(prefix))
            )
                label = '清单内文件与目录路径冲突。';
            else if (prior) {
                if (
                    prior.path !== path ||
                    prior.state === 'saved' ||
                    prior.state === 'cleaning' ||
                    prior.state === 'deleting'
                )
                    label = '目标路径已被占用。';
                else if (prior.size !== file.size)
                    label = '请选择同一上传的原文件。';
                else {
                    selected.push({ path, file, uploadId: prior.id });
                    label = '待校验续传';
                }
            } else if (file.size > remaining) label = '账号可用额度不足。';
            else {
                remaining -= file.size;
                selected.push({ path, file });
                label = '待上传';
            }
        }
        return { path, size: file?.size, label };
    });
    return { available, checklist, selected };
}
