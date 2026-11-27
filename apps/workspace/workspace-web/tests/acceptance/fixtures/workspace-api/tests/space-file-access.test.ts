import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { mockBackend } from '@workspace-api-fixture/mock.ts';
import { projectInput, RequestError } from '@workspace-api-fixture/protocol.ts';
import { mySpace } from '@workspace-api-fixture/space/index.ts';
import {
    spaceObjectKey,
    spaceStorage,
} from '@workspace-api-fixture/space/storage.ts';
import { noBody, errorIs, notFound } from './fixtures/space-assertions.ts';

test('direct text import enforces the snapshot limits', () => {
    const files = Array.from({ length: 100 }, (_, i) => ({
        path: `file-${i}.txt`,
        text: '',
    }));
    files[0]!.text = 'é'.repeat(512 * 1024);
    assert.equal(projectInput({ name: 'fixture', files }).files.length, 100);
    assert.throws(
        () =>
            projectInput({
                name: 'fixture',
                files: [...files, { path: 'extra.txt', text: '' }],
            }),
        (error: unknown) =>
            error instanceof RequestError && error.code === 'too_many_files',
    );
    files[0]!.text += 'a';
    assert.throws(
        () => projectInput({ name: 'fixture', files }),
        (error: unknown) =>
            error instanceof RequestError && error.code === 'project_too_large',
    );
});

test('preview signs only readable saved files within the byte limit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bento-space-files-'));
    const dbPath = join(dir, 'space.sqlite');
    const storage = spaceStorage('http://127.0.0.1:1', 'fixture', 'us-east-1');
    const calls: string[] = [];
    storage.preview = async (key) => {
        calls.push('preview ' + key);
        return 'https://fixture.invalid/read';
    };
    storage.download = async (key, name) => {
        calls.push('download ' + key + ' ' + name);
        return 'https://fixture.invalid/download';
    };
    const space = mySpace(dbPath, storage, mockBackend());
    try {
        const owner = 'owner-a';
        const project = randomUUID();
        const empty = randomUUID();
        const exact = randomUUID();
        const large = randomUUID();
        const pending = randomUUID();
        const db = new DatabaseSync(dbPath);
        try {
            db.prepare('INSERT INTO space_projects VALUES (?, ?, ?)').run(
                project,
                owner,
                'Fixture',
            );
            const insert = db.prepare(`
                INSERT INTO space_uploads (id, project, owner, path, size, manifest, state, expires)
                VALUES (?, ?, ?, ?, ?, '[]', ?, 0)
            `);
            insert.run(empty, project, owner, 'empty.txt', 0, 'saved');
            insert.run(
                exact,
                project,
                owner,
                'folder/exact.txt',
                262144,
                'saved',
            );
            insert.run(large, project, owner, 'large.txt', 262145, 'saved');
            insert.run(pending, project, owner, 'pending.txt', 1, 'uploading');
        } finally {
            db.close();
        }
        const preview = (caller: string, id: string) =>
            space.route(
                caller,
                'GET',
                '/api/space/files/' + id + '/preview',
                noBody,
            );
        for (const id of [empty, exact]) {
            assert.deepEqual(await preview(owner, id), {
                redirect: 'https://fixture.invalid/read',
            });
        }
        await assert.rejects(
            preview(owner, large),
            errorIs(413, 'preview_too_large', '文件超过 256 KiB，无法预览。'),
        );
        await assert.rejects(preview('owner-b', exact), notFound);
        await assert.rejects(preview('owner-b', large), notFound);
        await assert.rejects(preview(owner, randomUUID()), notFound);
        await assert.rejects(preview(owner, pending), notFound);
        assert.deepEqual(
            await space.route(
                owner,
                'GET',
                '/api/space/files/' + exact + '/download',
                noBody,
            ),
            { redirect: 'https://fixture.invalid/download' },
        );
        assert.deepEqual(calls, [
            'preview ' + spaceObjectKey(empty),
            'preview ' + spaceObjectKey(exact),
            'download ' + spaceObjectKey(exact) + ' exact.txt',
        ]);
    } finally {
        await space.close();
        await rm(dir, { recursive: true, force: true });
    }
});
