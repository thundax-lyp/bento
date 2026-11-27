import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { openSpaceIntegrityFixture } from '@/apps/workspace/workspace-web/acceptance/fixtures/workspace-api/tests/fixtures/space-integrity-fixture.ts';

export async function startSpaceIntegrityFixture() {
    const space = await openSpaceIntegrityFixture({
        port: 4353,
        origin: 'http://127.0.0.1:4354',
    });
    const originals: { id: string; path: string; bytes: Buffer }[] = [];
    try {
        for (const path of ['saved.txt', 'prefix', 'dir/nested.txt']) {
            const id = randomUUID();
            const bytes = Buffer.from('abc');
            const response = await space.request(
                `/api/space/projects/${space.projectId}/uploads`,
                'POST',
                {
                    id,
                    path,
                    size: bytes.length,
                    checksums: [
                        createHash('sha256').update(bytes).digest('base64'),
                    ],
                },
            );
            assert.equal(response.status, 200);
            await space.putPart(id, 1, bytes);
            assert.equal(
                (
                    await space.request(
                        `/api/space/uploads/${id}/complete`,
                        'POST',
                        {},
                    )
                ).status,
                200,
            );
            originals.push({ id, path, bytes });
        }
        return { space, originals, close: () => space.close() };
    } catch (error) {
        await space.close();
        throw error;
    }
}
