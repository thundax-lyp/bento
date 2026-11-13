// @vitest-environment node
import { afterEach, expect, test, vi } from 'vitest';
import {
    transferFile,
    getProjectDeletionImpact,
    deleteSpaceProject,
} from './space-api';

afterEach(() => vi.unstubAllGlobals());

test('续传只签名和写入服务器尚未收到的分块', async () => {
    const remote = 'https://storage.example.test/signed-part';
    const fetch = vi
        .fn()
        .mockResolvedValueOnce(Response.json({ state: 'uploading' }))
        .mockResolvedValueOnce(
            Response.json({ state: 'uploading', parts: [1] }),
        )
        .mockResolvedValueOnce(
            Response.json({ url: remote, checksum: 'checksum' }),
        )
        .mockResolvedValueOnce(new Response())
        .mockResolvedValueOnce(Response.json({ state: 'saved' }));
    vi.stubGlobal('fetch', fetch);

    await transferFile(
        'project',
        'upload',
        new File(['abcd'], 'readme.txt'),
        'folder/readme.txt',
        2,
        () => {},
    );

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
