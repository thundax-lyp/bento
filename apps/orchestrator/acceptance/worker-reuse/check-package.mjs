import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { log } from 'node:console';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const read = (path) =>
    JSON.parse(
        readFileSync(
            new URL(path, new URL('../../../../', import.meta.url)),
            'utf8',
        ),
    );
const expectedFiles = [
    'register-paths.mjs',
    'shared/text-snapshot.ts',
    'apps/orchestrator',
    'apps/workspace/api',
    'apps/workspace/auth',
    '!apps/workspace/auth/dist',
    'apps/worker',
    'docs/00-governance/ARCHITECTURE.md',
    'assets/architecture.svg',
    'docs/10-requirements/APPLICATION-BOUNDARIES-REQUIREMENTS.md',
    'docs/10-requirements/WEB-REQUIREMENTS.md',
    'docs/20-interfaces/WEB-INTERFACE.md',
    'docs/30-designs/APPLICATION-BOUNDARIES-DESIGN.md',
    'docs/30-designs/WEB-DESIGN.md',
    'docs/40-readiness/CURRENT-READINESS.md',
    'deploy/README.md',
    'public-files.json',
    '!apps/**/node_modules/**',
];
assert.deepEqual(
    read('package.json').files,
    expectedFiles,
    'Root package scope changed',
);
for (const dependency of [
    '@connectrpc/connect',
    '@connectrpc/connect-node',
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-agent',
    '@deepseek-ai/dsh-agent-loop',
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/dsh-session',
    '@deepseek-ai/dsh-session-projection',
    '@deepseek-ai/dsh-session-checkpoint-policy',
    '@deepseek-ai/dsh-system-prompt',
    '@deepseek-ai/dsh-tools',
    '@deepseek-ai/dsh-session-persistence',
    'dsh-sandbox-openshell',
]) {
    const installed = read(
        'apps/worker/node_modules/' + dependency + '/package.json',
    );
    assert.equal(
        installed.name,
        dependency,
        'Worker runtime dependency missing',
    );
    const expected = dependency.startsWith('@connectrpc/')
        ? '2.1.2'
        : dependency === '@deepseek-ai/cordis'
          ? '4.0.5'
          : dependency === 'dsh-sandbox-openshell'
            ? '0.1.0-rc.1'
            : '0.2.1-rc.4';
    assert.equal(
        installed.version,
        expected,
        'Worker runtime dependency version drift',
    );
}
const packages = JSON.parse(
    execFileSync('npm', ['pack', '--dry-run', '--json'], {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
    }),
);
assert.equal(packages.length, 1);
const packed = new Set(packages[0].files.map((row) => row.path));
const publicFiles = new Set(read('public-files.json').files);
const sources = [
    'apps/worker/base-bootstrap.ts',
    'apps/worker/sdk-transport.ts',
    'apps/worker/base-bootstrap.test.ts',
    'apps/worker/sdk-transport.test.ts',
    ...[
        'sdk.ts',
        'sdk.test.ts',
        'fixture.ts',
        'observer.ts',
        'trace.ts',
        'fixture.test.ts',
        'model-adapter.ts',
        'observed-bootstrap.ts',
        'real-reuse.test.ts',
        'check-package.mjs',
    ].map((name) => 'apps/orchestrator/acceptance/worker-reuse/' + name),
];
for (const path of sources) {
    assert(packed.has(path), 'Missing Worker reuse package source: ' + path);
    assert(
        publicFiles.has(path),
        'Missing Worker reuse public source: ' + path,
    );
}
for (const path of packed) {
    assert(
        !/(?:^|\/)node_modules\//.test(path),
        'Installed dependency entered package',
    );
    assert(
        !/(?:^|\/)(?:private|debug-workspace|retained-sdk|tree)\//.test(path),
        'Private runtime data entered package',
    );
    assert(
        !/\.(?:key|pem|crt|sqlite|sqlite-wal|sqlite-shm|db|log|ndjson|ack|tgz)$/.test(
            path,
        ),
        'Runtime artifact entered package',
    );
    assert(
        !/(?:sdk-source-manifest|sdk-built-manifest|runtime)\.json$/.test(path),
        'Private SDK/config entered package',
    );
    assert(
        !path.endsWith('source.tar.gz'),
        'Private SDK archive entered package',
    );
}
log('Worker reuse installed-tree package contract passed');
