import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Binding } from '@/apps/worker/protocol.ts';
import {
    assertSameInventory,
    backupWorkspace,
    inventoryVolume,
    restoreWorkspace,
    type A7Config,
    type Command,
    type VolumeEntry,
} from './resources.ts';
const owner = 'bento-a7-b-0123456789abcdef';
const image = 'sha256:' + 'a'.repeat(64);
const binding: Binding = {
    tenant: 'a7-tenant',
    project: '00000000-0000-4000-8000-000000000001',
    session: 'a7-session',
    sandbox: 'b-0123456789abcdef',
    volume: 'bento-workspace-00000000-0000-4000-8000-000000000001',
};
const directory: VolumeEntry = {
    path: '.',
    type: 'directory',
    mode: 0o750,
    uid: 1000,
    gid: 1000,
    bytes: 0,
    sha256: null,
};
const entries: VolumeEntry[] = [
    directory,
    {
        path: 'a7-proof.txt',
        type: 'file',
        mode: 0o640,
        uid: 1000,
        gid: 1000,
        bytes: 9,
        sha256: 'b'.repeat(64),
    },
];
async function fixture(mode = 'pass') {
    const root = await mkdtemp(join(tmpdir(), 'bento-a7-resources-'));
    await mkdir(join(root, 'backup'));
    const config: A7Config = {
        schema: 1,
        caseId: owner,
        root,
        dockerDaemonId: 'owned-daemon',
        runtimeImageId: image,
        workerImageId: image,
        hostConfig: join(root, 'host.json'),
        sdkModule: join(root, 'sdk.js'),
        gatewayWorkspace: 'default',
        gatewayOwner: 'owned-gateway',
        gatewayEndpoint: 'https://127.0.0.1:12345',
        adapterManifest: join(root, 'manifest.json'),
        cli: join(root, 'cli'),
        cliConfigHome: root,
        policy: join(root, 'policy.yaml'),
    };
    const volumes = new Map<
        string,
        { labels: Record<string, string>; entries: VolumeEntry[] }
    >();
    volumes.set(binding.volume, {
        labels: {
            'bento.web08': mode === 'owner' ? 'other-owner' : owner,
            'bento.web08.project': binding.project,
        },
        entries: structuredClone(entries),
    });
    let attached = true;
    const calls: { command: string; args: string[] }[] = [];
    const run: Command = async (command, args, options) => {
        calls.push({ command, args: [...args] });
        if (command === process.execPath) {
            attached = false;
            return '';
        }
        if (command === config.cli) {
            assert.equal(options?.env.XDG_CONFIG_HOME, config.cliConfigHome);
            return '';
        }
        assert.equal(command, 'docker');
        if (args[0] === 'info')
            return mode === 'daemon' ? 'other-daemon' : 'owned-daemon';
        if (args[0] === 'ps')
            return attached && args.includes('volume=' + binding.volume)
                ? mode === 'extra'
                    ? 'container-1\ncontainer-2'
                    : 'container-1'
                : '';
        if (args[0] === 'container')
            return JSON.stringify([
                {
                    Config: { Labels: { 'bento.web08': owner } },
                    State: { Running: mode === 'running' },
                    Image: image,
                    Mounts: [
                        {
                            Type: 'volume',
                            Name: binding.volume,
                            Destination: '/sandbox/project/bento-workspace',
                        },
                    ],
                },
            ]);
        if (args[0] === 'volume') {
            const name = args.at(-1)!;
            if (args[1] === 'inspect') {
                const volume = volumes.get(name);
                assert(volume);
                return JSON.stringify([{ Name: name, Labels: volume.labels }]);
            }
            if (args[1] === 'ls') {
                const name = args[3]!.slice('name=^'.length, -1);
                return volumes.has(name) ? name : '';
            }
            if (args[1] === 'create') {
                assert(!volumes.has(name));
                const labels: Record<string, string> = {};
                for (let i = 0; i < args.length; i++)
                    if (args[i] === '--label') {
                        const value = args[++i]!,
                            at = value.indexOf('=');
                        labels[value.slice(0, at)] = value.slice(at + 1);
                    }
                volumes.set(name, {
                    labels,
                    entries: [structuredClone(directory)],
                });
                return name;
            }
            if (args[1] === 'rm') {
                assert(!attached);
                volumes.delete(name);
                return name;
            }
        }
        if (args[0] === 'run') {
            const mount = args.find((arg) => arg.startsWith('type=volume,'))!;
            const name = /src=([^,]+)/.exec(mount)![1]!;
            const volume = volumes.get(name);
            assert(volume);
            if (args.includes('node')) return JSON.stringify(volume.entries);
            assert(args.includes('/bin/tar'));
            if (args.includes('-cpf')) {
                assert(mount.endsWith(',readonly'));
                await writeFile(
                    join(root, 'backup', 'workspace.tar'),
                    'owned-archive',
                );
            } else {
                assert(args.includes('-xpf'));
                volume.entries = structuredClone(entries);
            }
            return '';
        }
        throw Error('Unexpected test command');
    };
    return { root, config, run, calls, volumes };
}
for (const mode of ['owner', 'daemon', 'extra', 'running'])
    test(
        'resource preflight refuses ' + mode + ' before any mutation',
        async () => {
            const f = await fixture(mode);
            try {
                await assert.rejects(inventoryVolume(f.config, binding, f.run));
                assert(
                    !f.calls.some(
                        (c) =>
                            c.args[0] === 'run' ||
                            c.args.includes('create') ||
                            c.args.includes('rm'),
                    ),
                );
            } finally {
                await rm(f.root, { recursive: true, force: true });
            }
        },
    );
test('backup preserves and verifies an independent volume before source retirement', async () => {
    const f = await fixture();
    try {
        await backupWorkspace(f.config, binding, f.run);
        assert(f.volumes.has(binding.volume));
        assertSameInventory(
            entries,
            f.volumes.get(owner + '-source-preserved')!.entries,
        );
        assert(
            !f.calls.some(
                (c) => c.args[1] === 'rm' || c.command === process.execPath,
            ),
        );
        await restoreWorkspace(
            f.config,
            binding,
            join(f.root, 'backup', 'workspace.tar'),
            f.run,
        );
        assertSameInventory(entries, f.volumes.get(binding.volume)!.entries);
        assert(f.volumes.has(owner + '-source-preserved'));
        const deletion = f.calls.findIndex(
            (c) => c.command === process.execPath,
        );
        const proof = JSON.parse(
            await readFile(
                join(f.root, 'backup', 'workspace.tar.proof.json'),
                'utf8',
            ),
        );
        assert.equal(proof.caseId, owner);
        assert(deletion > 0);
        for (const call of f.calls.filter((c) => c.args[0] === 'run')) {
            assert(call.args.includes('--read-only'));
            assert(call.args.includes('none'));
        }
    } finally {
        await rm(f.root, { recursive: true, force: true });
    }
});
test('damaged archive or preserved inventory never retires the source', async () => {
    for (const corruption of ['archive', 'preserved']) {
        const f = await fixture();
        try {
            await backupWorkspace(f.config, binding, f.run);
            f.calls.length = 0;
            if (corruption === 'archive')
                await writeFile(
                    join(f.root, 'backup', 'workspace.tar'),
                    'changed',
                );
            else
                f.volumes.get(owner + '-source-preserved')!.entries[1]!.sha256 =
                    'c'.repeat(64);
            await assert.rejects(
                restoreWorkspace(
                    f.config,
                    binding,
                    join(f.root, 'backup', 'workspace.tar'),
                    f.run,
                ),
            );
            assert(f.volumes.has(binding.volume));
            assert(
                !f.calls.some(
                    (c) => c.command === process.execPath || c.args[1] === 'rm',
                ),
            );
        } finally {
            await rm(f.root, { recursive: true, force: true });
        }
    }
});
test('inventory differences include permissions and file bytes', () => {
    for (const change of [
        { mode: 0o777 },
        { sha256: 'c'.repeat(64) },
        { bytes: 10 },
    ]) {
        const changed = structuredClone(entries);
        Object.assign(changed[1]!, change);
        assert.throws(() => assertSameInventory(entries, changed));
    }
});

test('actual inventory helper reads bytes and rejects noncanonical filenames', async () => {
    const f = await fixture();
    try {
        await inventoryVolume(f.config, binding, f.run);
        const helper = f.calls
            .find(
                (call) =>
                    call.args.includes('node') && call.args.includes('-e'),
            )!
            .args.at(-1)!;
        const local = join(f.root, 'helper-volume');
        await mkdir(local);
        await writeFile(join(local, 'proof.txt'), 'actual bytes');
        const script = helper.replace("'/volume'", JSON.stringify(local));
        const rows: VolumeEntry[] = JSON.parse(
            execFileSync(process.execPath, ['-e', script], {
                encoding: 'utf8',
            }),
        );
        assert.equal(rows.find((row) => row.path === 'proof.txt')?.bytes, 12);
        await writeFile(join(local, 'bad\\name'), 'reject');
        assert.throws(() =>
            execFileSync(process.execPath, ['-e', script], { stdio: 'pipe' }),
        );
    } finally {
        await rm(f.root, { recursive: true, force: true });
    }
});
