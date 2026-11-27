import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { downloadFileUrl, previewFile } from './api.ts';
import type { PreviewResult, Upload } from './api.ts';
import { Button } from '../ui.tsx';

export function FilePreview({
    id,
    path,
    onClose,
}: {
    id: string;
    path: string;
    onClose: () => void;
}) {
    const [result, setResult] = useState<PreviewResult>();
    useEffect(() => {
        const controller = new AbortController();
        void previewFile(id, controller.signal).then((preview) => {
            if (!controller.signal.aborted) setResult(preview);
        });
        return () => controller.abort();
    }, [id]);
    return (
        <section
            aria-label="文本预览"
            className="space-y-2 rounded border border-zinc-200 p-3"
        >
            <div className="flex items-center justify-between gap-3">
                <h3 className="break-all font-medium">{path}</h3>
                <Button type="button" onClick={onClose}>
                    关闭预览
                </Button>
            </div>
            {result?.kind === 'text' ? (
                result.text === '' ? (
                    <p>空文件</p>
                ) : (
                    <pre className="max-h-96 overflow-auto">{result.text}</pre>
                )
            ) : (
                <p role="status">
                    {result
                        ? {
                              too_large: '文件超过 256 KiB，无法预览',
                              not_utf8: '文件不是有效的 UTF-8 文本',
                              unavailable: '预览暂不可用',
                          }[result.kind]
                        : '正在读取预览…'}
                </p>
            )}
        </section>
    );
}

type SavedFileDirectory = {
    directories: Map<string, SavedFileDirectory>;
    files: Upload[];
};

export function savedFileTree(uploads: Upload[]): SavedFileDirectory {
    const root: SavedFileDirectory = { directories: new Map(), files: [] };
    for (const file of uploads) {
        if (file.state !== 'saved') continue;
        const segments = file.path.split('/');
        segments.pop();
        let directory = root;
        for (const segment of segments) {
            let child = directory.directories.get(segment);
            if (!child) {
                child = { directories: new Map(), files: [] };
                directory.directories.set(segment, child);
            }
            directory = child;
        }
        directory.files.push(file);
    }
    return root;
}

export function SavedFiles({
    directory,
    label,
    selectable,
    files,
    setFiles,
    setPreviewId,
    deleting,
    onDelete,
}: {
    directory: SavedFileDirectory;
    label: string;
    selectable: boolean;
    files: string[];
    setFiles: (files: string[]) => void;
    setPreviewId: (id: string) => void;
    deleting: boolean;
    onDelete: (file: Upload) => void;
}): ReactNode {
    return (
        <ul aria-label={label} className="divide-y divide-zinc-200">
            {[...directory.directories].map(([segment, child]) => (
                <li key={segment} className="space-y-1 py-2 pl-4">
                    <span className="font-medium">{segment}</span>
                    <SavedFiles
                        directory={child}
                        label={segment}
                        selectable={selectable}
                        files={files}
                        setFiles={setFiles}
                        setPreviewId={setPreviewId}
                        deleting={deleting}
                        onDelete={onDelete}
                    />
                </li>
            ))}
            {directory.files.map((file) => (
                <li key={file.id} className="flex justify-between gap-3 py-2">
                    {selectable ? (
                        <label className="flex items-center gap-2">
                            <input
                                type="checkbox"
                                checked={files.includes(file.id)}
                                onChange={(event) =>
                                    setFiles(
                                        event.target.checked
                                            ? [...files, file.id]
                                            : files.filter(
                                                  (value) => value !== file.id,
                                              ),
                                    )
                                }
                            />
                            {file.path}
                        </label>
                    ) : (
                        <span>{file.path}</span>
                    )}
                    <span className="text-sm text-zinc-600">
                        {file.size} 字节
                    </span>
                    <div className="flex items-center gap-2">
                        <Button
                            type="button"
                            onClick={() => setPreviewId(file.id)}
                        >
                            预览文本
                        </Button>
                        <a
                            className="text-sm underline"
                            href={downloadFileUrl(file.id)}
                        >
                            下载文件
                        </a>
                        <Button
                            type="button"
                            disabled={deleting}
                            onClick={() => onDelete(file)}
                        >
                            删除文件
                        </Button>
                    </div>
                </li>
            ))}
        </ul>
    );
}
