import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, isAbsolute, join } from 'node:path';
import { test } from 'node:test';

type Source = { role: string; path: string; sha256: string };
type Manifest = {
    schema: number;
    caseId: string;
    sources: Source[];
    patches: { role: string; before: string; after: string; count: number }[];
    outputs: { path: string; sha256: string }[];
    sdkLifecycle: string;
    sharedSources: Record<string, string>;
};
const pinned: Record<string, string> = {
    daemon: '886a876d35418e4c35d2d40540f818a0b9d5b372e8a5e0cc2beeecd3466dc2db',
    loopback:
        '0ec9745b5052a6a2a4c0ca7507abd2ef075d9fbfbd405e4a01598b258c67f350',
    base: '40fd7129d536fe920045f736d6b2e5d6871b96c97f799771b1ea8fb4b189d15b',
};
const hash = (bytes: Uint8Array) =>
    createHash('sha256').update(bytes).digest('hex');
async function manifest() {
    const path = process.env.BENTO_A7_ADAPTER_MANIFEST;
    const expected = process.env.BENTO_A7_ADAPTER_MANIFEST_SHA256;
    assert(
        path && isAbsolute(path) && expected && /^[a-f0-9]{64}$/.test(expected),
        'Explicit private adapter proof required',
    );
    const stat = await lstat(path);
    assert(
        stat.isFile() &&
            !stat.isSymbolicLink() &&
            (stat.mode & 0o777) === 0o600,
    );
    const bytes = await readFile(path);
    assert.equal(hash(bytes), expected, 'Adapter manifest identity mismatch');
    const data = JSON.parse(bytes.toString()) as Manifest;
    assert.equal(data.schema, 1);
    assert.match(data.caseId, /^bento-a7-b-[a-f0-9]{16}$/);
    assert.equal(dirname(path).split('/').pop(), data.caseId);
    return { data, root: dirname(path) };
}
test('private adapter source and output identities are pinned before use', async () => {
    const { data, root } = await manifest();
    assert.deepEqual(
        data.sources.map((source) => source.role).sort(),
        Object.keys(pinned).sort(),
    );
    for (const source of data.sources) {
        assert.equal(source.sha256, pinned[source.role]);
        assert.equal(hash(await readFile(source.path)), source.sha256);
    }
    assert.deepEqual(data.outputs.map((item) => item.path).sort(), [
        'a7-bootstrap.ts',
        'host-daemon.mjs',
        'worker-loopback.mjs',
    ]);
    for (const item of data.outputs) {
        const path = join(root, item.path),
            stat = await lstat(path);
        assert(
            stat.isFile() &&
                !stat.isSymbolicLink() &&
                (stat.mode & 0o777) === 0o600,
        );
        assert.equal(hash(await readFile(path)), item.sha256);
    }
    assert.equal(
        data.sharedSources['model-relay.mjs'],
        'd2e4a70a8987c134151dde41cad3e126fb4513cb83cc08faf1dfdf727d17e854',
    );
    assert.equal(
        data.sharedSources['volume-io.mjs'],
        'e1188ad9b0878f7960d2761490d9e699cc93b7db8f1ac5516e6673fc9553509c',
    );
});
test('derived launcher preserves Docker isolation and only recorded changes', async () => {
    const { data, root } = await manifest();
    for (const role of ['daemon', 'loopback']) {
        const source = data.sources.find((item) => item.role === role)!;
        let body = await readFile(source.path, 'utf8');
        for (const patch of data.patches.filter((item) => item.role === role)) {
            assert(patch.count > 0);
            assert.equal(body.split(patch.before).length - 1, patch.count);
            body = body.replaceAll(patch.before, patch.after);
        }
        const path = join(
            root,
            role === 'daemon' ? 'host-daemon.mjs' : 'worker-loopback.mjs',
        );
        assert.equal(await readFile(path, 'utf8'), body);
        execFileSync(process.execPath, ['--check', path], { stdio: 'pipe' });
    }
    const daemon = await readFile(join(root, 'host-daemon.mjs'), 'utf8');
    for (const fragment of [
        "'--network','none'",
        "'--user','1000:1000'",
        "'--cap-drop','ALL'",
        "'--security-opt','no-new-privileges'",
        "'--read-only'",
        'assert(inspect.Mounts.every(x=>!x.RW))',
        "await stop();await docker('rm',id)",
    ])
        assert(
            daemon.includes(fragment),
            'Original launcher isolation changed',
        );
    assert(daemon.includes('BENTO_DSH_BOOTSTRAP=/app/a7-bootstrap.ts'));
});
test('bootstrap uses existing SDK transport ownership and real runtime interfaces', async () => {
    const { data, root } = await manifest();
    const body = await readFile(join(root, 'a7-bootstrap.ts'), 'utf8');
    stripTypeScriptTypes(body, { mode: 'strip' });
    assert.equal(data.sdkLifecycle, 'createRunSdkTransport.close');
    assert(body.includes('new SandboxClient(sdk.transport)'));
    assert(body.includes('finally{await sdk.close();}'));
    assert(!/client\.(?:close|dispose)\(/.test(body));
    assert(
        body.includes(
            "defaultMode:'workspace-write', requireFullEnforcement:true",
        ),
    );
    assert(
        body.includes(
            'return client.execInteractive(name,argv,{...options,workspace:',
        ),
    );
    assert(body.includes('assert(name===request.binding.sandbox)'));
    assert(
        !/sk-[A-Za-z0-9_-]{12,}/.test(body),
        'Literal model credential forbidden',
    );
    assert(!/INSERT\s+INTO|batch_receipts|fixtureReadBytes/.test(body));
});
