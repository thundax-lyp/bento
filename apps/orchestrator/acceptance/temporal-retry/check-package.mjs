import assert from 'node:assert/strict';
import console from 'node:console';
import process from 'node:process';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
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
const sources = [
    'tool.ts',
    'process.ts',
    'control-proxy.mjs',
    'probe/main.go',
    'host.ts',
    'evidence.ts',
    'real-retry.test.ts',
    'check-package.mjs',
].map((name) => 'apps/orchestrator/acceptance/temporal-retry/' + name);
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
assert.deepEqual(
    manifest.files,
    expectedFiles,
    'Root package files must preserve the approved scope',
);
const publication = JSON.parse(
    readFileSync(join(root, 'public-files.json'), 'utf8'),
);
assert.deepEqual(publication.patterns, [
    'apps/orchestrator/index.ts',
    'apps/orchestrator/execution-service/*.ts',
    'apps/orchestrator/openshell/*.ts',
]);
assert(Array.isArray(publication.files));
assert.equal(new Set(publication.files).size, publication.files.length);
for (const path of sources)
    assert.equal(
        publication.files.filter((file) => file === path).length,
        1,
        'New source must be explicitly public: ' + path,
    );
const packed = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
    timeout: 120000,
    killSignal: 'SIGKILL',
    maxBuffer: 8 * 1024 * 1024,
});
if (packed.error || packed.status !== 0)
    throw new Error('npm pack dry run failed');
const result = JSON.parse(packed.stdout);
assert(
    Array.isArray(result) &&
        result.length === 1 &&
        Array.isArray(result[0].files),
);
const files = result[0].files.map((file) => {
    assert.equal(typeof file.path, 'string');
    return file.path;
});
assert.equal(new Set(files).size, files.length);
for (const path of [
    'package.json',
    'register-paths.mjs',
    'apps/orchestrator/temporal.go',
    'apps/orchestrator/go.mod',
    'apps/orchestrator/execution-service/service.ts',
    ...sources,
])
    assert.equal(
        files.filter((file) => file === path).length,
        1,
        'Expected package source missing: ' + path,
    );
for (const path of files) {
    assert(
        !/(^|\/)node_modules(\/|$)/.test(path),
        'Dependencies must not enter the package',
    );
    assert(
        !/\.(?:sqlite(?:-(?:wal|shm))?|db|log|tgz|tar\.gz|exe)$/.test(path),
        'Runtime artifact entered the package',
    );
    assert(
        !/(^|\/)(?:control|temporal|bento-orchestrator|temporal-probe)$/.test(
            path,
        ),
        'Private binary entered the package',
    );
    assert(
        !/(^|\/)(?:debug-workspace|business-evidence|t[456]-evidence|bento-a6-[^/]*)(\/|$)/.test(
            path,
        ),
        'Private evidence entered the package',
    );
}
console.log(
    JSON.stringify({
        schema: 1,
        publicSources: 8,
        packageFiles: files.length,
        positive: true,
        negative: true,
    }),
);
