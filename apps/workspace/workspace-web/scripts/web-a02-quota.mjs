import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';

import { size, partSize, partCount, poll } from './web-a02-fixtures.mjs';

export async function verifyQuota(
    original,
    changed,
    {
        page,
        directory,
        stage,
        select,
        progressAt,
        expectPuts,
        currentPhase,
        checkObject,
        record,
        usage,
        projectPath,
        persist,
        post,
        read,
    },
) {
    const downloadLinks = page.getByRole('link', {
        name: '下载文件',
        exact: true,
    });
    const second = join(directory, 'second.bin');
    await fs.rename(changed, second);
    for (const [index, file] of [original, second].entries()) {
        await stage('quota save ' + (index + 1));
        await select(file);
        await poll(
            async () => {
                assert(Date.now() - progressAt() < 120_000);
                return await downloadLinks.count();
            },
            (count) => count === index + 1,
            600_000,
        );
        await expectPuts(
            currentPhase(),
            size,
            Array.from({ length: partCount }, (_, i) => i + 1),
        );
        checkObject('saved', record.uploadIds[index]);
        await usage((index + 1) * size, 0);
    }
    const checksum = createHash('sha256')
        .update(Buffer.from([0]))
        .digest('base64');
    const input = (path, bytes) => ({
        id: randomUUID(),
        path,
        size: bytes,
        checksums: Array(Math.ceil(bytes / partSize)).fill(checksum),
    });
    const start = (payload) => post(projectPath() + '/uploads', payload);
    const excess = input('excess.bin', 1);
    record.uploadIds.push(excess.id);
    await persist();
    const denied = await start(excess);
    assert.equal(denied.status, 409);
    assert.equal(denied.body.error.code, 'space_quota');
    checkObject('absent', excess.id);
    await usage(2 * size, 0);
    console.log('WEB_A03_FULL_QUOTA_OK', 2 * size);

    await stage('quota delete');
    const [first] = record.uploadIds;
    const row = page.getByRole('listitem').filter({
        has: page
            .getByRole('link', { name: '下载文件' })
            .and(
                page.locator(
                    'a[href="/api/space/files/' + first + '/download"]',
                ),
            ),
    });
    await row.getByRole('button', { name: '删除文件', exact: true }).click();
    await page
        .locator('[aria-label="确认删除文件"]')
        .getByRole('button', { name: '确认删除', exact: true })
        .click();
    await poll(
        () => read('/api/space'),
        ({ body }) => body?.saved === size,
    );
    checkObject('absent', first);
    await usage(size, 0);

    await stage('quota race');
    const contenders = [input('race-a.bin', size), input('race-b.bin', size)];
    record.uploadIds.push(...contenders.map(({ id }) => id));
    await persist();
    const results = await Promise.all(contenders.map(start));
    assert.deepEqual(results.map(({ status }) => status).sort(), [200, 409]);
    const winner =
        contenders[results.findIndex(({ status }) => status === 200)];
    const loser = contenders[results.findIndex(({ status }) => status === 409)];
    assert.equal(
        results.find(({ status }) => status === 409).body.error.code,
        'space_quota',
    );
    checkObject('absent', loser.id);
    await usage(size, size);
    await stage('quota cancel');
    const cancel = await post(
        '/api/space/uploads/' + winner.id + '/cancel',
        {},
    );
    assert.equal(cancel.status, 200);
    await poll(
        () => read('/api/space/uploads/' + winner.id),
        ({ body }) => body?.state === 'cancelled',
    );
    checkObject('absent', winner.id);
    await usage(size, 0);
    const reusable = input('reusable.bin', size);
    record.uploadIds.push(reusable.id);
    await persist();
    assert.equal((await start(reusable)).status, 200);
    await usage(size, size);
    assert.equal(
        (await post('/api/space/uploads/' + reusable.id + '/cancel', {}))
            .status,
        200,
    );
    await poll(
        () => read('/api/space/uploads/' + reusable.id),
        ({ body }) => body?.state === 'cancelled',
    );
    checkObject('absent', reusable.id);
    await usage(size, 0);
    console.log('WEB_A03_CONCURRENT_CANCEL_DELETE_REUSE_OK');
}
