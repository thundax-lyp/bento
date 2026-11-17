// @vitest-environment node
import { afterEach, expect, test, vi } from 'vitest';
import {
    transferFile,
    type TransferProgress,
    getProjectDeletionImpact,
    deleteSpaceProject,
} from './space-api.ts';

afterEach(() => vi.unstubAllGlobals());

test('续传只签名和写入服务器尚未收到的分块', async () => {
    const events: TransferProgress[] = [];
    const remote = 'https://storage.example.test/signed-part';
    const fetch = vi
        .fn()
        .mockResolvedValueOnce(Response.json({ state: 'uploading' }))
        .mockResolvedValueOnce(
            Response.json({ state: 'uploading', parts: [1] }),
        )
        .mockImplementationOnce(async () => {
            expect(events.at(-1)).toEqual({
                phase: 'transferring',
                confirmedParts: 1,
                totalParts: 2,
            });
            return Response.json({ url: remote, checksum: 'checksum' });
        })
        .mockResolvedValueOnce(new Response())
        .mockResolvedValueOnce(Response.json({ state: 'saved' }));
    vi.stubGlobal('fetch', fetch);

    await transferFile(
        'project',
        'upload',
        new File(['abcd'], 'readme.txt'),
        'folder/readme.txt',
        2,
        (event) => events.push(event),
    );

    expect(events).toEqual([
        { phase: 'checking' },
        { phase: 'transferring', confirmedParts: 1, totalParts: 2 },
        { phase: 'transferring', confirmedParts: 2, totalParts: 2 },
        { phase: 'completing' },
    ]);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
        '/api/space/projects/project/uploads',
        '/api/space/uploads/upload',
        '/api/space/uploads/upload/part',
        remote,
        '/api/space/uploads/upload/complete',
    ]);
    expect(JSON.parse(fetch.mock.calls[2]![1].body)).toEqual({ number: 2 });
    expect(await fetch.mock.calls[3]![1].body.text()).toBe('cd');
    expect(fetch.mock.calls[3]![1].credentials).toBe('omit');
});

const register = '/api/space/projects/project/uploads';
const statusPath = '/api/space/uploads/upload';
const completePath = statusPath + '/complete';
const partPath = statusPath + '/part';
const signedUrl = 'https://storage.example.test/part';
const checking = { phase: 'checking' };
const completing = { phase: 'completing' };
const uploading = () => Response.json({ state: 'uploading', parts: [] });
const saved = () => Response.json({ state: 'saved' });

test.each([
    {
        name: '注册已保存',
        responses: [saved()],
        paths: [register],
        events: [checking],
    },
    {
        name: '查询已保存',
        responses: [uploading(), saved()],
        paths: [register, statusPath],
        events: [checking],
    },
    {
        name: '查询正在确认',
        responses: [
            uploading(),
            Response.json({ state: 'completing', parts: [] }),
            saved(),
        ],
        paths: [register, statusPath, completePath],
        events: [checking, completing],
    },
    {
        name: '空文件',
        content: '',
        responses: [uploading(), uploading(), saved()],
        paths: [register, statusPath, completePath],
        events: [checking, completing],
    },
    {
        name: '完成回执未保存',
        responses: [
            uploading(),
            Response.json({ state: 'completing', parts: [] }),
            uploading(),
        ],
        paths: [register, statusPath, completePath],
        events: [checking, completing],
        error: '暂未确认上传结果',
    },
    {
        name: '分块 PUT 失败',
        responses: [
            uploading(),
            uploading(),
            Response.json({ url: signedUrl, checksum: 'checksum' }),
            new Response(null, { status: 500 }),
        ],
        paths: [register, statusPath, partPath, signedUrl],
        events: [
            checking,
            { phase: 'transferring', confirmedParts: 0, totalParts: 1 },
        ],
        error: '分块上传失败',
    },
])(
    '传输进度 · $name',
    async ({ content = 'ab', responses, paths, events, error }) => {
        const fetch = vi.fn();
        for (const response of responses) fetch.mockResolvedValueOnce(response);
        vi.stubGlobal('fetch', fetch);
        const notify = vi.fn();
        const result = transferFile(
            'project',
            'upload',
            new File([content], 'file'),
            'file',
            2,
            notify,
        );
        if (error) await expect(result).rejects.toThrow(error);
        else await expect(result).resolves.toBeUndefined();
        expect(notify.mock.calls.map(([event]) => event)).toEqual(events);
        expect(fetch.mock.calls.map(([url]) => url)).toEqual(paths);
    },
);

test.each([
    { name: '四块并行完成后才开始下一批', failed: false },
    { name: '等待首批全部结算并优先返回 401', failed: true },
])('分块并行 · $name', async ({ failed }) => {
    const signed: number[] = [];
    const puts: number[] = [];
    const steps: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const fetch = vi.fn(async (url: string, options?: RequestInit) => {
        if (url === register) return uploading();
        if (url === statusPath)
            return Response.json({ state: 'uploading', parts: [1] });
        if (url === partPath) {
            const { number } = JSON.parse(String(options?.body));
            signed.push(number);
            if (failed && number === 3)
                return Response.json({}, { status: 401 });
            return Response.json({
                url: signedUrl + '/' + number,
                checksum: 'checksum',
            });
        }
        if (url === completePath) {
            steps.push('complete');
            return saved();
        }
        expect(url).toMatch(signedUrl + '/');
        expect(options?.method).toBe('PUT');
        const number = Number(url.split('/').at(-1));
        puts.push(number);
        steps.push('put ' + number);
        if (number <= 5) await gate;
        return new Response(null, {
            status: failed && number === 2 ? 500 : 200,
        });
    });
    vi.stubGlobal('fetch', fetch);
    const settled = vi.fn();
    const transfer = transferFile(
        'project',
        'upload',
        new File(['abcdef'], 'file'),
        'file',
        1,
        () => {},
    ).then(
        () => settled('saved'),
        (error: unknown) => settled(error),
    );
    try {
        await vi.waitFor(() => expect(puts).toHaveLength(failed ? 3 : 4));
        expect(signed).toEqual([2, 3, 4, 5]);
        expect(puts).toEqual(failed ? [2, 4, 5] : [2, 3, 4, 5]);
        expect(steps).not.toContain('complete');
        expect(settled).not.toHaveBeenCalled();
    } finally {
        release();
        await transfer;
    }
    if (failed) {
        expect(settled).toHaveBeenCalledWith(
            expect.objectContaining({ status: 401 }),
        );
        expect(signed).toEqual([2, 3, 4, 5]);
        expect(steps).not.toContain('complete');
    } else {
        expect(settled).toHaveBeenCalledWith('saved');
        expect(signed).toEqual([2, 3, 4, 5, 6]);
        expect(puts).toEqual([2, 3, 4, 5, 6]);
        expect(steps.filter((step) => step === 'complete')).toEqual([
            'complete',
        ]);
        expect(steps.at(-1)).toBe('complete');
    }
});

test('项目删除使用编码后的原项目地址及 202/204 回执', async () => {
    const id = 'a/b';
    const path = '/api/space/projects/a%2Fb';
    const impact = {
        fileCount: 1,
        uploadCount: 0,
        runCount: 2,
        diffCount: 1,
        blockers: [],
    };
    const fetch = vi
        .fn()
        .mockResolvedValueOnce(Response.json(impact))
        .mockResolvedValueOnce(
            Response.json({ state: 'deleting' }, { status: 202 }),
        )
        .mockResolvedValueOnce(new Response(null, { status: 204 }))
        .mockResolvedValueOnce(
            Response.json({ state: 'deleted' }, { status: 202 }),
        );
    vi.stubGlobal('fetch', fetch);
    expect(await getProjectDeletionImpact(id)).toEqual(impact);
    expect(await deleteSpaceProject(id)).toBe('deleting');
    expect(await deleteSpaceProject(id)).toBe('deleted');
    await expect(deleteSpaceProject(id)).rejects.toThrow(
        'Unexpected project deletion response',
    );
    expect(
        fetch.mock.calls.map(([url, options]) => [
            url,
            options.method ?? 'GET',
        ]),
    ).toEqual([
        [path + '/deletion', 'GET'],
        [path, 'DELETE'],
        [path, 'DELETE'],
        [path, 'DELETE'],
    ]);
});
