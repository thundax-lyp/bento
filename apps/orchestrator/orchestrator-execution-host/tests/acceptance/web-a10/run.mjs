import assert from 'node:assert/strict';
import { log } from 'node:console';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    mkdir,
    mkdtemp,
    lstat,
    readFile,
    readdir,
    realpath,
    rename,
    rm,
    writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';

const root = fileURLToPath(
    new URL('../../../../../../../bento-debug/web-a10', import.meta.url),
);
const leasePath = join(root, 'lease.json');
const project = 'bento-worker-a-web-a10';
const candidates = [
    'apps/workspace/workspace-web/src/pages/tasks/details/index.tsx',
    'apps/workspace/workspace-web/playwright.web-a10.config.ts',
    'apps/workspace/workspace-web/tests/acceptance/web-a10.spec.ts',
    'apps/workspace/workspace-web/tests/acceptance/web-a10-hook.ts',
    'apps/orchestrator/orchestrator-execution-host/tests/acceptance/web-a10/run.mjs',
    'apps/orchestrator/orchestrator-execution-host/tests/acceptance/web-a10/run.test.mjs',
];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function assertCandidatePaths(changedPaths) {
    for (const path of changedPaths)
        assert(candidates.includes(path), 'Unapproved candidate path: ' + path);
}

async function privatePath(path, isDirectory) {
    const info = await lstat(path);
    assert.equal(await realpath(path), path);
    assert.equal(info.uid, process.getuid());
    assert(isDirectory ? info.isDirectory() : info.isFile());
    assert.equal(info.mode & 0o777, isDirectory ? 0o700 : 0o600);
}

async function collectFiles(source, directory = source) {
    const paths = (await readdir(directory)).sort();
    const rows = [];
    for (const name of paths) {
        const path = join(directory, name);
        const info = await lstat(path);
        if (info.isDirectory())
            rows.push(...(await collectFiles(source, path)));
        else {
            assert(
                info.isFile(),
                'Frozen source must contain only regular files',
            );
            rows.push({
                path: relative(source, path).split(sep).join('/'),
                sha256: sha256(await readFile(path)),
            });
        }
    }
    return rows;
}

const privateInputs = [
    'GoControl.Dockerfile',
    'bootstrap.ts',
    'compose.database.yml',
    'compose.env',
    'compose.identity.yml',
    'compose.overlay.yml',
    'compose.storage.yml',
    'compose.temporal.yml',
    'compose.web.yml',
    'execution.env',
    'fault-control.mjs',
    'formal-source.mjs',
    'host.json',
    'identities.json',
    'launcher.mjs',
    'launcher.test.mjs',
    'matrix-bootstrap.ts',
    'matrix-browser-probe.mjs',
    'matrix-context.mjs',
    'matrix-identity.mjs',
    'matrix-notifier.mjs',
    'matrix-rehearsal-report.json',
    'matrix-tools.mjs',
    'matrix-witness.mjs',
    'ops.mjs',
    'probe-model.mjs',
    'provision-web.mjs',
    'queue-barrier.mjs',
    'realm.json',
    'relay/ca.crt',
    'relay/client.crt',
    'relay/client.key',
    'relay/tls.crt',
    'relay/tls.key',
    'restore-volume.mjs',
    'review.mjs',
    'runtime-image-post-hwe-report.json',
    'runtime.json',
    'sandbox-control.mjs',
    'sandbox-policy.yaml',
    'sdk-relay.mjs',
    'sdk-runtime/identity.json',
    'sdk-runtime/package-lock.json',
    'sdk-runtime/package.json',
    'slot-proxy.mjs',
    'source-root.mjs',
    'storage-pki/ca.crt',
    'storage-pki/private.key',
    'storage-pki/public.crt',
    'storage.pki.tar',
    'subpath-probe-report.json',
    'task-observation.mjs',
    'trusted-entry.mjs',
    'trusted-entry.test.mjs',
    'volume-io.mjs',
    'web.env',
];

async function acceptanceInputs(lease) {
    assert.equal(lease.webOidc.origin, 'http://127.0.0.1:8080');
    assert.equal(
        lease.webOidc.issuer,
        lease.webOidc.origin + '/identity/realms/' + project,
    );
    await privatePath(join(root, 'relay'), true);
    const hashes = {};
    for (const name of privateInputs) {
        const path = join(root, name);
        await privatePath(path, false);
        hashes[name] = sha256(await readFile(path));
    }
    for (const name of [
        'inputs/exchange-linux-amd64',
        'inputs/exchange-linux-arm64',
        'tools/openshell',
    ]) {
        const executable = join(root, name);
        const info = await lstat(executable);
        assert(info.isFile() && info.uid === process.getuid());
        assert.equal(await realpath(executable), executable);
        assert.equal(info.mode & 0o777, 0o500);
        hashes[name] = sha256(await readFile(executable));
    }
    const sdk = join(root, 'sdk-runtime', 'dist');
    assert.equal(await realpath(sdk), sdk);
    hashes['sdk-runtime/dist'] = sha256(
        JSON.stringify(await collectFiles(sdk)),
    );
    return hashes;
}

export async function readFrozenCandidate(lease, state) {
    const candidate = join(state, 'candidate');
    const manifestPath = join(candidate, 'manifest.json');
    await privatePath(candidate, true);
    await privatePath(manifestPath, false);
    const bytes = await readFile(manifestPath);
    const manifest = JSON.parse(bytes);
    assert.equal(manifest.project, project);
    assert.equal(manifest.leaseId, lease.leaseId);
    assert.match(manifest.sourceCommit, /^[a-f0-9]{40}$/);
    assert.match(manifest.sourceTree, /^[a-f0-9]{40}$/);
    const archive = join(candidate, 'source.tar');
    await privatePath(archive, false);
    assert.equal(sha256(await readFile(archive)), manifest.archiveSha256);
    assert.deepEqual(manifest.configSha256, await acceptanceInputs(lease));
    const source = join(candidate, 'source');
    await privatePath(source, true);
    assert.deepEqual(await collectFiles(source), manifest.files);
    return { manifest, manifestSha256: sha256(bytes), source };
}

async function freeze(lease, state) {
    const checkout = execFileSync('git', ['rev-parse', '--show-toplevel'], {
        encoding: 'utf8',
    }).trim();
    const staging = await mkdtemp(join(state, 'freeze.'));
    const target = join(state, 'candidate');
    const source = join(staging, 'source');
    const git = (args, index) =>
        execFileSync('git', args, {
            cwd: checkout,
            env: index
                ? { ...process.env, GIT_INDEX_FILE: index }
                : process.env,
            encoding: 'utf8',
        });
    const gitPaths = (args, index) =>
        git(args, index).split('\0').filter(Boolean);

    try {
        assertCandidatePaths([
            ...gitPaths([
                'diff',
                '--no-renames',
                '--name-only',
                '-z',
                'HEAD',
                '--',
            ]),
            ...gitPaths([
                'ls-files',
                '--others',
                '--exclude-standard',
                '-z',
                '--',
            ]),
        ]);
        const sourceCommit = git(['rev-parse', 'HEAD']).trim();
        const index = join(staging, 'index');
        git(['read-tree', sourceCommit], index);
        git(['add', '--', ...candidates], index);
        const sourceTree = git(['write-tree'], index).trim();
        assertCandidatePaths(
            gitPaths(
                [
                    'diff-tree',
                    '--no-commit-id',
                    '--no-renames',
                    '--name-only',
                    '-z',
                    '-r',
                    sourceCommit,
                    sourceTree,
                    '--',
                ],
                index,
            ),
        );
        const configSha256 = await acceptanceInputs(lease);
        const previous = await readFile(
            join(target, 'manifest.json'),
            'utf8',
        ).catch((error) => {
            if (error.code !== 'ENOENT') throw error;
            return null;
        });
        if (previous) {
            const { manifest } = await readFrozenCandidate(lease, state);
            assert.deepEqual(
                {
                    project: manifest.project,
                    leaseId: manifest.leaseId,
                    sourceCommit: manifest.sourceCommit,
                    sourceTree: manifest.sourceTree,
                },
                { project, leaseId: lease.leaseId, sourceCommit, sourceTree },
            );
            log(
                'A10_CANDIDATE_FROZEN',
                sourceTree,
                manifest.archiveSha256,
                sha256(previous),
            );
            return;
        }
        const archive = join(staging, 'source.tar');
        git(
            ['archive', '--format=tar', '--output=' + archive, sourceTree],
            index,
        );
        const archiveSha256 = sha256(await readFile(archive));
        await mkdir(source, { mode: 0o700 });
        execFileSync('tar', ['-xpf', archive, '-C', source]);
        const files = await collectFiles(source);
        for (const path of candidates) {
            const row = files.find((file) => file.path === path);
            assert.equal(
                row?.sha256,
                sha256(await readFile(join(checkout, path))),
            );
        }
        const manifest = {
            project,
            leaseId: lease.leaseId,
            sourceCommit,
            sourceTree,
            archiveSha256,
            configSha256,
            files,
        };
        const bytes = JSON.stringify(manifest) + '\n';
        await writeFile(join(staging, 'manifest.json'), bytes, {
            mode: 0o600,
            flag: 'wx',
        });
        await rm(index);
        try {
            await rename(staging, target);
        } catch (error) {
            if (error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST')
                throw error;
            await privatePath(target, true);
            assert.equal(
                await readFile(join(target, 'manifest.json'), 'utf8'),
                bytes,
                'Existing candidate has different bytes',
            );
            assert.equal(
                sha256(await readFile(join(target, 'source.tar'))),
                archiveSha256,
            );
            assert.deepEqual(await collectFiles(join(target, 'source')), files);
        }
        log('A10_CANDIDATE_FROZEN', sourceTree, archiveSha256, sha256(bytes));
    } finally {
        await rm(staging, { recursive: true, force: true });
    }
}

async function main() {
    process.umask(0o077);
    assert.equal(process.env.BENTO_WEB_A10_CONFIG, leasePath);
    await privatePath(dirname(leasePath), true);
    await privatePath(leasePath, false);
    const lease = JSON.parse(await readFile(leasePath, 'utf8'));
    assert.equal(lease.project, project);
    assert.match(
        lease.leaseId,
        /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/,
    );
    const state = join(root, 'state', lease.leaseId);
    await privatePath(state, true);
    const [command, extra] = process.argv.slice(2);
    assert.equal(extra, undefined);
    if (command === '--freeze') {
        await freeze(lease, state);
        return;
    }
    assert(['--prepare', '--verify', '--cleanup'].includes(command));
    const { manifest, manifestSha256, source } = await readFrozenCandidate(
        lease,
        state,
    );
    const approvalPath = join(root, 'approval.json');
    await privatePath(approvalPath, false);
    const approval = JSON.parse(await readFile(approvalPath, 'utf8'));
    assert.equal(approval.leaseId, lease.leaseId);
    assert.equal(approval.sourceCommit, manifest.sourceCommit);
    assert.equal(approval.sourceTree, manifest.sourceTree);
    assert.equal(approval.archiveSha256, manifest.archiveSha256);
    execFileSync(process.execPath, [join(root, 'ops.mjs'), command.slice(2)], {
        cwd: source,
        env: { ...process.env, BENTO_WEB_A10_MANIFEST_SHA256: manifestSha256 },
        stdio: 'inherit',
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
    await main();
