// @vitest-environment node
import { afterEach, expect, test, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import {
    chmod,
    link,
    mkdir,
    mkdtemp,
    readFile,
    realpath,
    rm,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { nativeConnection } from '../acceptance/web-a12-hook.ts';

const roots: string[] = [];
const sha = (bytes: string | Buffer) =>
    createHash('sha256').update(bytes).digest('hex');
async function put(path: string, value: unknown) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify(value) + '\n', { mode: 0o600 });
}
async function change(
    path: string,
    mutate: (value: Record<string, unknown>) => void,
) {
    const value = JSON.parse(await readFile(path, 'utf8')) as Record<
        string,
        unknown
    >;
    mutate(value);
    await put(path, value);
}
async function fixture() {
    const root = await realpath(
        await mkdtemp(join(tmpdir(), 'bento-a12-connection-')),
    );
    roots.push(root);
    const leaseId = randomUUID(),
        attemptId = randomUUID();
    const base = join(root, '.bento-web-a12-r6'),
        state = join(base, 'state', leaseId);
    const lease = join(base, 'registry/lease.json');
    const entry = join(state, 'archive/debug-workspace/web-a12/hook.mjs');
    const host = join(state, 'configuration/a12-host-binding.json');
    const manifest = join(
        state,
        'archive/debug-workspace/web-a12/private/materialized/manifest.json',
    );
    const candidate = join(state, 'bundle/candidate.json');
    const revision = 'a'.repeat(40);
    const registration = join(state, 'archive/register-paths.mjs'),
        resolver = join(state, 'private/resolve-a12.mjs'),
        runtime = join(state, 'bundle/runtime/runtime-manifest.json');
    await put(registration, 'fixture registration');
    await put(resolver, 'fixture resolver');
    await put(runtime, {
        revision,
        files: [
            {
                path: 'register-paths.mjs',
                renderedSha256: sha(await readFile(registration)),
            },
        ],
    });
    const currentRuntimeManifestSha256 = sha(await readFile(runtime));
    await put(entry, 'fixture hook');
    await put(lease, {
        leaseId,
        lockedCommit: revision,
        stateDir: state,
        composeProject: 'bento-a-web-a12',
        workspace: 'bento-a-web-a12',
        owner: 'bento-a-web-a12',
        realm: 'bento-a-web-a12',
        publicOrigin: 'https://bento-a12.test:19443',
        gateway: 'https://127.0.0.1:19445',
        windowStart: new Date(Date.now() - 1000).toISOString(),
        windowEnd: new Date(Date.now() + 3_600_000).toISOString(),
    });
    await put(manifest, {
        phase: 'materialized',
        currentRuntimeManifestSha256,
        bindings: { leaseId, revision },
    });
    await put(candidate, {
        revision,
        attemptId,
        runtimeManifestSha256: currentRuntimeManifestSha256,
        privateSources: { 'hook.mjs': sha(await readFile(entry)) },
    });
    await put(host, {
        leaseId,
        registryPath: lease,
        leaseSha256: sha(await readFile(lease)),
        materializedManifest: manifest,
        manifestSha256: sha(await readFile(manifest)),
        candidateSha256: sha(await readFile(candidate)),
        resolverSha256: sha(await readFile(resolver)),
        attemptId,
    });
    vi.stubEnv('BENTO_WEB_A12_BROWSER_HOOK', entry);
    vi.stubEnv('BENTO_WEB_A12_LEASE_FILE', lease);
    return {
        root,
        runtime,
        registration,
        resolver,
        state,
        leaseId,
        attemptId,
        revision,
        lease,
        entry,
        host,
        manifest,
        candidate,
    };
}
afterEach(async () => {
    vi.unstubAllEnvs();
    for (const root of roots.splice(0))
        await rm(root, { recursive: true, force: true });
});

test('fresh leases and attempts use their protected current source and hook binding', async () => {
    const first = await fixture();
    expect((await nativeConnection()).lease).toBe(first.lease);
    const second = await fixture();
    expect(second.leaseId).not.toBe(first.leaseId);
    expect(second.attemptId).not.toBe(first.attemptId);
    expect((await nativeConnection()).entry).toBe(second.entry);
});

test.each([
    [
        'foreign host lease',
        async (f: Awaited<ReturnType<typeof fixture>>) =>
            change(f.host, (v) => {
                v.leaseId = randomUUID();
            }),
    ],
    [
        'changed lease bytes',
        async (f: Awaited<ReturnType<typeof fixture>>) =>
            change(f.lease, (v) => {
                v.lockedCommit = 'b'.repeat(40);
            }),
    ],
    [
        'expired lease',
        async (f: Awaited<ReturnType<typeof fixture>>) =>
            change(f.lease, (v) => {
                v.windowEnd = new Date(Date.now() - 1).toISOString();
            }),
    ],
    [
        'foreign namespace',
        async (f: Awaited<ReturnType<typeof fixture>>) =>
            change(f.lease, (v) => {
                v.workspace = 'foreign';
            }),
    ],
    [
        'foreign state path',
        async (f: Awaited<ReturnType<typeof fixture>>) =>
            change(f.lease, (v) => {
                v.stateDir = f.root;
            }),
    ],
    [
        'wrong manifest hash',
        async (f: Awaited<ReturnType<typeof fixture>>) =>
            change(f.host, (v) => {
                v.manifestSha256 = 'f'.repeat(64);
            }),
    ],
    [
        'unmaterialized manifest with matching hash',
        async (f: Awaited<ReturnType<typeof fixture>>) => {
            await change(f.manifest, (v) => {
                v.phase = 'planned';
            });
            const h = sha(await readFile(f.manifest));
            await change(f.host, (v) => {
                v.manifestSha256 = h;
            });
        },
    ],
    [
        'foreign manifest identity with matching hash',
        async (f: Awaited<ReturnType<typeof fixture>>) => {
            await change(f.manifest, (v) => {
                v.bindings = { leaseId: randomUUID(), revision: f.revision };
            });
            const h = sha(await readFile(f.manifest));
            await change(f.host, (v) => {
                v.manifestSha256 = h;
            });
        },
    ],
    [
        'wrong candidate hash',
        async (f: Awaited<ReturnType<typeof fixture>>) =>
            change(f.host, (v) => {
                v.candidateSha256 = 'f'.repeat(64);
            }),
    ],
    [
        'foreign candidate source with matching hash',
        async (f: Awaited<ReturnType<typeof fixture>>) => {
            await change(f.candidate, (v) => {
                v.revision = 'b'.repeat(40);
            });
            const h = sha(await readFile(f.candidate));
            await change(f.host, (v) => {
                v.candidateSha256 = h;
            });
        },
    ],
    [
        'foreign candidate attempt with matching hash',
        async (f: Awaited<ReturnType<typeof fixture>>) => {
            await change(f.candidate, (v) => {
                v.attemptId = randomUUID();
            });
            const h = sha(await readFile(f.candidate));
            await change(f.host, (v) => {
                v.candidateSha256 = h;
            });
        },
    ],
    [
        'foreign hook with matching candidate hash',
        async (f: Awaited<ReturnType<typeof fixture>>) => {
            await change(f.candidate, (v) => {
                v.privateSources = { 'hook.mjs': 'f'.repeat(64) };
            });
            const h = sha(await readFile(f.candidate));
            await change(f.host, (v) => {
                v.candidateSha256 = h;
            });
        },
    ],
    [
        'changed hook bytes',
        async (f: Awaited<ReturnType<typeof fixture>>) =>
            put(f.entry, 'changed hook'),
    ],
    [
        'permissive lease mode',
        async (f: Awaited<ReturnType<typeof fixture>>) => chmod(f.lease, 0o644),
    ],
    [
        'permissive candidate mode',
        async (f: Awaited<ReturnType<typeof fixture>>) =>
            chmod(f.candidate, 0o644),
    ],
    [
        'symlink hook',
        async (f: Awaited<ReturnType<typeof fixture>>) => {
            const other = join(f.root, 'other');
            await put(other, 'fixture hook');
            await rm(f.entry);
            await symlink(other, f.entry);
        },
    ],
    [
        'multiply linked host binding',
        async (f: Awaited<ReturnType<typeof fixture>>) =>
            link(f.host, join(f.root, 'host-alias')),
    ],
    [
        'foreign candidate and hook pair with the same revision',
        async (f: Awaited<ReturnType<typeof fixture>>) => {
            await put(f.entry, 'foreign hook');
            const h = sha(await readFile(f.entry));
            await change(f.candidate, (v) => {
                v.attemptId = randomUUID();
                v.privateSources = { 'hook.mjs': h };
            });
        },
    ],
    [
        'changed runtime manifest',
        async (f: Awaited<ReturnType<typeof fixture>>) =>
            change(f.runtime, (v) => {
                v.revision = 'b'.repeat(40);
            }),
    ],
    [
        'changed registration bytes',
        async (f: Awaited<ReturnType<typeof fixture>>) =>
            put(f.registration, 'foreign registration'),
    ],
    [
        'changed resolver bytes',
        async (f: Awaited<ReturnType<typeof fixture>>) =>
            put(f.resolver, 'foreign resolver'),
    ],
    [
        'symlink resolver',
        async (f: Awaited<ReturnType<typeof fixture>>) => {
            const other = join(f.root, 'other-resolver');
            await put(other, 'fixture resolver');
            await rm(f.resolver);
            await symlink(other, f.resolver);
        },
    ],
    [
        'foreign current runtime anchor',
        async (f: Awaited<ReturnType<typeof fixture>>) => {
            await change(f.manifest, (v) => {
                v.currentRuntimeManifestSha256 = 'f'.repeat(64);
            });
            const h = sha(await readFile(f.manifest));
            await change(f.host, (v) => {
                v.manifestSha256 = h;
            });
        },
    ],
] as const)('rejects %s', async (_name, mutate) => {
    const f = await fixture();
    await mutate(f);
    await expect(nativeConnection()).rejects.toThrow();
});
