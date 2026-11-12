import { queryOptions } from '@tanstack/react-query';
import { ApiError, json, post } from './api';

export type Upload = {
    id: string;
    project: string;
    path: string;
    size: number;
    state:
        | 'preparing'
        | 'uploading'
        | 'completing'
        | 'cleaning'
        | 'saved'
        | 'deleting'
        | 'cancelled'
        | 'expired'
        | 'failed';
};
export type Space = {
    projects: { id: string; name: string }[];
    uploads: Upload[];
    quota: number;
    fileLimit: number;
    partSize: number;
    saved: number;
    reserved: number;
};
type Execution = {
    state: 'uninitialized' | 'validating' | 'importing' | 'ready' | 'failed';
    projectId?: string;
    issues?: { path: string; code: 'invalid_path' | 'invalid_utf8' }[];
};
export type SpaceProject = {
    name: string;
    files: { id: string; path: string; size: number }[];
    execution: Execution;
};

const root = '/api/space';
const projectPath = (id: string) =>
    root + '/projects/' + encodeURIComponent(id);
const uploadPath = (id: string) => root + '/uploads/' + encodeURIComponent(id);

export const spaceQuery = (account: string) =>
    queryOptions({
        queryKey: ['account', account, 'space'],
        async queryFn({ signal }) {
            try {
                return await json<Space>(root, { signal });
            } catch (error) {
                if (error instanceof ApiError && error.status === 404)
                    return null;
                throw error;
            }
        },
    });
export const spaceProjectQuery = (account: string, id: string) =>
    queryOptions({
        queryKey: ['account', account, 'space-project', id],
        queryFn: ({ signal }) =>
            json<SpaceProject>(projectPath(id), { signal }),
        refetchInterval: ({ state }) =>
            ['validating', 'importing'].includes(
                state.data?.execution.state ?? '',
            )
                ? 1500
                : false,
    });

export const createSpaceProject = (id: string, name: string) =>
    post<{ id: string }>(root + '/projects', { id, name });
export const prepareWorkspace = (id: string, fileIds: string[], key: string) =>
    post<Execution>(projectPath(id) + '/execution', { fileIds }, key);
export const cancelUpload = (id: string) =>
    post<Upload>(uploadPath(id) + '/cancel', {});
export const getUpload = (id: string) =>
    json<Omit<Upload, 'state'> & { state: Upload['state'] | 'deleted' }>(
        uploadPath(id),
    );
export const downloadFileUrl = (id: string) =>
    root + '/files/' + encodeURIComponent(id) + '/download';

export type PreviewResult =
    | { kind: 'text'; text: string }
    | { kind: 'too_large' | 'not_utf8' | 'unavailable' };

export async function previewFile(
    id: string,
    signal: AbortSignal,
): Promise<PreviewResult> {
    const limit = 256 * 1024;
    try {
        const response = await fetch(
            root + '/files/' + encodeURIComponent(id) + '/preview',
            {
                credentials: 'same-origin',
                cache: 'no-store',
                referrerPolicy: 'no-referrer',
                signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
            },
        );
        if (response.status !== 200) {
            await response.body?.cancel().catch(() => {});
            return {
                kind: response.status === 413 ? 'too_large' : 'unavailable',
            };
        }
        const reader = response.body?.getReader();
        if (!reader) return { kind: 'text', text: '' };
        const bytes = new Uint8Array(limit);
        let length = 0;
        try {
            while (true) {
                const chunk = await reader.read();
                if (chunk.done) break;
                if (chunk.value.length > limit - length)
                    return { kind: 'too_large' };
                bytes.set(chunk.value, length);
                length += chunk.value.length;
            }
            try {
                const text = new TextDecoder('utf-8', {
                    fatal: true,
                    ignoreBOM: true,
                }).decode(bytes.subarray(0, length));
                return { kind: 'text', text };
            } catch {
                return { kind: 'not_utf8' };
            }
        } finally {
            await reader.cancel().catch(() => {});
            reader.releaseLock();
        }
    } catch {
        return { kind: 'unavailable' };
    }
}

export async function transferFile(
    project: string,
    id: string,
    file: File,
    filename: string,
    partSize: number,
    notify: (message: string) => void,
) {
    const checksums: string[] = [];
    notify('正在校验文件…');
    for (let offset = 0; offset < file.size; offset += partSize) {
        const bytes = await file.slice(offset, offset + partSize).arrayBuffer();
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        checksums.push(btoa(String.fromCharCode(...new Uint8Array(digest))));
    }
    const registered = await post<Upload>(projectPath(project) + '/uploads', {
        id,
        path: filename,
        size: file.size,
        checksums,
    });
    if (registered.state === 'saved') return;
    const path = uploadPath(id);
    const status = await json<Upload & { parts: number[] }>(path);
    if (status.state === 'saved') return;
    if (status.state === 'completing') {
        await post<Upload>(path + '/complete', {});
        return;
    }
    const uploaded = new Set(status.parts);
    for (let number = 1; number <= checksums.length; number++) {
        if (uploaded.has(number)) continue;
        const signed = await post<{ url: string; checksum: string }>(
            path + '/part',
            { number },
        );
        const response = await fetch(signed.url, {
            method: 'PUT',
            credentials: 'omit',
            headers: { 'x-amz-checksum-sha256': signed.checksum },
            body: file.slice((number - 1) * partSize, number * partSize),
            signal: AbortSignal.timeout(120_000),
        });
        if (!response.ok)
            throw new Error('分块上传失败。重新选择同一个文件可继续。');
        uploaded.add(number);
        notify('已上传 ' + uploaded.size + ' / ' + checksums.length + ' 块');
    }
    notify('正在确认上传结果…');
    await post<Upload>(path + '/complete', {});
}
