import assert from 'node:assert/strict';
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

const root = join(homedir(), 'bento-web-a10');
const leasePath = join(root, 'lease.json');
const project = 'bento-web-a10';
const imagesByService = {
    'bento-web': 'BENTO_A10_WEB_IMAGE',
    orchestrator: 'BENTO_A10_ORCHESTRATOR_IMAGE',
    'bento-worker': 'BENTO_A10_WORKER_IMAGE',
};
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

function checkComposeConfig(config, lease, version, state) {
    assert.match(version, /^sha256:[a-f0-9]{64}$/);
    assert.equal(config.name, project);
    assert(config.services && typeof config.services === 'object');
    const published = [];
    for (const [name, service] of Object.entries(config.services)) {
        assert.notEqual(service.network_mode, 'host');
        for (const port of service.ports ?? []) {
            assert.equal(port.protocol, 'tcp');
            assert.equal(port.host_ip, '127.0.0.1');
            published.push(`${name}:${port.published}:${port.target}`);
        }
    }
    assert.deepEqual(published.sort(), [
        'bento-web:28080:8080',
        'mailpit:28494:8025',
    ]);
    const orchestrator = config.services.orchestrator;
    assert.equal(
        orchestrator.environment.BENTO_EXECUTION_ENVIRONMENT_VERSION,
        version,
    );
    const bridges = Object.values(config.services).filter(
        (service) => service.network_mode === 'service:orchestrator',
    );
    assert.equal(bridges.length, 1);
    const [bridge] = bridges;
    assert.equal(bridge.user, '1000:1000');
    assert.equal(bridge.volumes.length, 2);
    for (const [target, source, readOnly] of [
        [
            '/bridge/loopback-bridge.mjs',
            join(root, 'loopback-bridge.mjs'),
            true,
        ],
        ['/bridge/sockets', join(state, 'br'), false],
    ]) {
        const volume = bridge.volumes.find((entry) => entry.target === target);
        assert.equal(volume?.type, 'bind');
        assert.equal(volume.source, source);
        assert.equal(volume.read_only ?? false, readOnly);
    }
    const web = config.services['bento-web'];
    const binds = web.volumes.filter(
        (volume) => volume.target === '/etc/nginx/bento.conf',
    );
    assert.equal(binds.length, 1);
    assert.equal(binds[0].type, 'bind');
    assert.equal(binds[0].source, lease.webOidc.nginxPath);
    assert.equal(binds[0].read_only, true);
    assert.equal(binds[0].bind?.create_host_path ?? false, false);
}

async function renderCompose(lease, state, source, version, images) {
    assert.equal(lease.composeEnvPath, join(root, 'compose.env'));
    assert.equal(lease.composeOverlayPath, join(root, 'compose.overlay.yml'));
    await privatePath(lease.composeEnvPath, false);
    await privatePath(lease.composeOverlayPath, false);
    const args = [
        'compose',
        '--profile',
        'dev',
        '--project-name',
        project,
        '--env-file',
        lease.composeEnvPath,
        '-f',
        join(source, 'deploy/compose.yaml'),
        '-f',
        lease.composeOverlayPath,
    ];
    const env = { ...process.env };
    for (const key of [
        'BENTO_EXECUTION_ENVIRONMENT_VERSION',
        'COMPOSE_PROFILES',
        ...Object.values(imagesByService),
    ])
        delete env[key];
    const configSha256 = {};
    for (const [view, flags] of [
        ['start', []],
        ['images', ['--profile', 'worker-image']],
    ]) {
        const bytes = execFileSync(
            'docker',
            [...args, ...flags, 'config', '--format', 'json'],
            { cwd: source, env, stdio: ['ignore', 'pipe', 'ignore'] },
        );
        const config = JSON.parse(bytes);
        checkComposeConfig(config, lease, version, state);
        for (const name of Object.keys(imagesByService)) {
            const image = images[name];
            assert.match(image, /^sha256:[a-f0-9]{64}$/);
            if (name === 'bento-worker' && view === 'start')
                assert.equal(Object.hasOwn(config.services, name), false);
            else assert.equal(config.services[name]?.image, image, name);
        }
        configSha256[view] = sha256(bytes);
    }
    return { args, env, configSha256 };
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
            console.log(
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
        console.log(
            'A10_CANDIDATE_FROZEN',
            sourceTree,
            archiveSha256,
            sha256(bytes),
        );
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
