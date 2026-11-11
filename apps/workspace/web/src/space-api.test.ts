// @vitest-environment node
import { afterEach, expect, test, vi } from 'vitest';
import { transferFile } from './space-api';

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
