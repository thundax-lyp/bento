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
import { homedir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import process from 'node:process';

const root = join(homedir(), 'bento-web-a10');
const leasePath = join(root, 'lease.json');
const project = 'bento-web-a10';
const candidates = [
    'apps/workspace/web/src/pages/tasks/details/index.tsx',
    'apps/workspace/web/playwright.web-a10.config.ts',
    'apps/workspace/web/acceptance/web-a10.spec.ts',
    'apps/workspace/web/acceptance/web-a10-hook.ts',
    'apps/orchestrator/acceptance/web-a10/run.mjs',
];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const digest = /^[a-f0-9]{64}$/;

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

async function checkedDigests(expected, paths) {
    assert.deepEqual(Object.keys(expected).sort(), [...paths].sort());
    for (const name of paths) {
        const path = join(root, name);
        await privatePath(path, false);
        assert.equal(sha256(await readFile(path)), expected[name], name);
    }
    return expected;
}

async function acceptanceInputs(lease, state) {
    const supervisor = 'adapter/launcher-supervisor.mjs';
    const oldGrantProbe = await checkedDigests(lease.oldGrantProbe.fileSha256, [
        supervisor,
        'adapter/old-grant-probe.mjs',
        'adapter/old-grant-probe.test.mjs',
    ]);
    const { 'trusted-entry.mjs': priorEntry, ...classificationFiles } =
        lease.retryClassification.fileSha256;
    assert.match(priorEntry, digest);
    const retryClassification = await checkedDigests(classificationFiles, [
        supervisor,
        'adapter/retry-classification.mjs',
    ]);
    const webOidc = lease.webOidc;
    assert.equal(webOidc.origin, 'http://127.0.0.1:28080');
    assert.equal(
        webOidc.issuer,
        webOidc.origin + '/identity/realms/' + project,
    );
    assert.equal(webOidc.nginxPath, join(state, 'web-nginx.conf'));
    for (const [path, expected] of [
        [webOidc.nginxPath, webOidc.nginxSha256],
        [join(state, 'oidc-loopback-fixture.mjs'), webOidc.fixtureSha256],
        [join(state, 'oidc-loopback-preflight.json'), webOidc.preflightSha256],
        [join(root, 'compose.overlay.yml'), webOidc.overlaySha256],
    ]) {
        await privatePath(path, false);
        assert.equal(sha256(await readFile(path)), expected, path);
    }
    assert.equal(
        lease.netns.fileSha256['compose.overlay.yml'],
        webOidc.overlaySha256,
    );
    return { oldGrantProbe, retryClassification, webOidc };
}

async function readFrozenCandidate(lease, state) {
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
    assert.deepEqual(manifest.inputs, await acceptanceInputs(lease, state));
    assert.deepEqual(manifest.bootstrap, lease.bootstrap);
    assert.deepEqual(manifest.netns, lease.netns);
    await checkedDigests(manifest.configSha256, [
        'review.mjs',
        'trusted-entry.mjs',
    ]);
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
        }).trim();

    try {
        const sourceCommit = git(['rev-parse', 'HEAD']);
        const index = join(staging, 'index');
        git(['read-tree', sourceCommit], index);
        git(['add', '--', ...candidates], index);
        const sourceTree = git(['write-tree'], index);
        const changed = git([
            'diff-tree',
            '--no-commit-id',
            '--name-only',
            '-r',
            sourceCommit,
            sourceTree,
        ]).split('\n');
        assert.deepEqual(
            changed.sort(),
            [...candidates].sort(),
            'Candidate changes must match the approved paths',
        );
        const bootstrap = lease.bootstrap;
        const netns = lease.netns;
        const inputs = await acceptanceInputs(lease, state);
        assert.match(bootstrap?.baseSha256, digest);
        assert.match(bootstrap?.lockSha256, digest);
        assert.match(netns?.preflightSha256, digest);
        assert.equal(netns?.bridgeSocket, join(state, 'br', 'bridge.sock'));
        assert.equal(netns?.upstreamSocket, join(state, 'br', 'upstream.sock'));
        const filesAtFreeze = {};
        for (const name of ['review.mjs', 'trusted-entry.mjs']) {
            const path = join(root, name);
            await privatePath(path, false);
            filesAtFreeze[name] = sha256(await readFile(path));
        }
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
            configSha256: filesAtFreeze,
            bootstrap,
            netns,
            inputs,
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
    assert.deepEqual(process.argv.slice(2), ['--freeze']);
    await freeze(lease, state);
}

await main();
