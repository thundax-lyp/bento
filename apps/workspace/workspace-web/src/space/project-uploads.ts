import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError } from '../api.ts';
import { cancelUpload, getUpload, transferFile, type Space } from './api.ts';
import { message } from './error-message.ts';
import {
    hasReleasedPath,
    type UploadChoice,
    type UploadItem,
    type UploadRow,
} from './upload-plan.ts';

export function useProjectUploads(
    account: string,
    id: string,
    refresh: () => Promise<void>,
) {
    const [uploadRows, setUploadRows] = useState<UploadRow[]>([]);
    const [fileChoices, setFileChoices] = useState<UploadChoice[]>([]);
    const [folderChoices, setFolderChoices] = useState<UploadChoice[]>([]);
    function updateUploadRow(
        path: string,
        status: string,
        parts?: UploadRow['parts'],
    ): void {
        setUploadRows((rows) =>
            rows.map((row) =>
                row.path === path
                    ? { ...row, status, ...(parts ? { parts } : {}) }
                    : row,
            ),
        );
    }
    const upload = useMutation({
        async mutationFn({
            selected,
            config,
        }: {
            selected: UploadItem[];
            config: Space;
        }) {
            let signedOut = false;
            for (const { path, file, uploadId } of selected) {
                if (signedOut) {
                    updateUploadRow(path, '未开始，请重新登录后重选文件。');
                    continue;
                }
                updateUploadRow(path, '正在准备上传…');
                const key = JSON.stringify([
                    'bento:upload',
                    account,
                    id,
                    path,
                    file.size,
                ]);
                try {
                    let cached = uploadId ? null : sessionStorage.getItem(key);
                    if (
                        cached &&
                        !config.uploads.some((item) => item.id === cached)
                    ) {
                        const status = await getUpload(cached).catch(
                            (error: unknown) => {
                                if (
                                    error instanceof ApiError &&
                                    error.status === 401
                                )
                                    throw error;
                                return undefined;
                            },
                        );
                        if (status?.state === 'deleted') cached = null;
                    }
                    const ended =
                        cached &&
                        config.uploads.some(
                            (item) =>
                                item.id === cached &&
                                hasReleasedPath(item.state),
                        );
                    const currentId =
                        uploadId ??
                        (ended ? null : cached) ??
                        crypto.randomUUID();
                    sessionStorage.setItem(key, currentId);
                    await transferFile(
                        id,
                        currentId,
                        file,
                        path,
                        config.partSize,
                        (status) => {
                            switch (status.phase) {
                                case 'checking':
                                    updateUploadRow(path, '正在校验文件…');
                                    break;
                                case 'transferring':
                                    updateUploadRow(path, '上传中', {
                                        confirmedParts: status.confirmedParts,
                                        totalParts: status.totalParts,
                                    });
                                    break;
                                case 'completing':
                                    updateUploadRow(path, '正在确认上传结果…');
                                    break;
                            }
                        },
                    );
                    updateUploadRow(path, '已保存');
                    try {
                        if (sessionStorage.getItem(key) === currentId)
                            sessionStorage.removeItem(key);
                    } catch {
                        // A cache failure cannot change the server's saved result.
                    }
                } catch (error) {
                    signedOut =
                        error instanceof ApiError && error.status === 401;
                    updateUploadRow(
                        path,
                        signedOut
                            ? '登录已过期，请重新登录。'
                            : '本次上传未确认：' + message(error),
                    );
                }
            }
        },
        onSuccess() {
            setFileChoices([]);
            setFolderChoices([]);
        },
        onSettled: refresh,
    });
    const cancel = useMutation({
        mutationFn: cancelUpload,
        onSettled: refresh,
    });

    return {
        uploadRows,
        setUploadRows,
        fileChoices,
        setFileChoices,
        folderChoices,
        setFolderChoices,
        upload,
        cancel,
    };
}
