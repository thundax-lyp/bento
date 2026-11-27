import assert from 'node:assert/strict';
import console from 'node:console';
import process from 'node:process';
import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';
import { join, posix } from 'node:path';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const expectedFiles = [
    'register-paths.mjs',
    'shared/text-snapshot.ts',
    'apps/orchestrator',
    'apps/admin',
    'apps/workspace/workspace-api',
    'apps/workspace/workspace-auth',
    '!apps/workspace/workspace-auth/dist',
    'apps/worker',
    'docs/00-governance/ARCHITECTURE.md',
    'assets/architecture.svg',
    'docs/10-requirements/APPLICATION-BOUNDARIES-REQUIREMENTS.md',
    'docs/10-requirements/WEB-REQUIREMENTS.md',
    'docs/20-interfaces/WEB-INTERFACE.md',
    'docs/20-interfaces/APP-ORCHESTRATOR-INTERFACE.md',
    'docs/30-designs/APPLICATION-BOUNDARIES-DESIGN.md',
    'docs/30-designs/WEB-DESIGN.md',
    'docs/40-readiness/CURRENT-READINESS.md',
    'docs/40-readiness/evidence/*.md',
    'deploy/README.md',
    'deploy/admin.Dockerfile',
    'public-files.json',
    '!apps/**/node_modules/**',
];
const sources = [
    'backup.ts',
    'backup.test.ts',
    'audit.ts',
    'audit.test.ts',
    'adapter.test.ts',
    'resources.ts',
    'resources.test.ts',
    'host.ts',
    'driver.ts',
    'driver.test.ts',
    'run.mjs',
    'real-restore.test.ts',
    'check-package.mjs',
].map((name) => 'apps/orchestrator/acceptance/single-node-restore/' + name);
const storeDirectory = 'apps/orchestrator/src/execution-service/store';
const storeSources = readdirSync(join(root, storeDirectory), {
    withFileTypes: true,
})
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map(({ name }) => storeDirectory + '/' + name);
assert(
    storeSources.includes(storeDirectory + '/index.ts'),
    'Store entry is missing',
);
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
    'apps/orchestrator/src/execution-service/*.ts',
    'apps/orchestrator/src/openshell/*.ts',
]);
assert(Array.isArray(publication.files));
assert.equal(new Set(publication.files).size, publication.files.length);
for (const path of [...sources, ...storeSources])
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
    'apps/orchestrator/src/control/temporal.go',
    'apps/orchestrator/go.mod',
    'apps/orchestrator/src/execution-service/service.ts',
    ...sources,
    ...storeSources,
])
    assert.equal(
        files.filter((file) => file === path).length,
        1,
        'Expected package source missing: ' + path,
    );
// Verify package-local source imports, including the backup implementation consumed by tests/driver.
for (const path of [...sources, ...storeSources]) {
    const body = readFileSync(join(root, path), 'utf8');
    for (const match of body.matchAll(
        /(?:from\s+|import\s*\()(['"])([^'"\n]+)\1/g,
    )) {
        const specifier = match[2];
        const target = specifier.startsWith('@/')
            ? specifier.slice(2)
            : specifier.startsWith('.')
              ? posix.normalize(posix.join(posix.dirname(path), specifier))
              : null;
        if (target)
            assert(
                files.includes(target),
                'Package source import missing: ' + target,
            );
    }
}
const orchestrator = JSON.parse(
    readFileSync(join(root, 'apps/orchestrator/package.json'), 'utf8'),
);
const localTests = [
    'backup.test.ts',
    'audit.test.ts',
    'resources.test.ts',
    'driver.test.ts',
];
const localCommand =
    'node --import ../../register-paths.mjs --experimental-strip-types --test ' +
    localTests
        .map((name) => 'acceptance/single-node-restore/' + name)
        .join(' ');
assert.equal(
    orchestrator.scripts['test:single-node-restore:local'],
    localCommand,
);
assert(
    orchestrator.scripts['check:core:fast'].includes(
        'pnpm test:single-node-restore:local',
    ),
);
assert(!/real-restore|adapter\.test/.test(localCommand));
assert.equal(
    orchestrator.scripts['test:single-node-restore'],
    'node acceptance/single-node-restore/run.mjs',
);
for (const path of files) {
    assert(
        !/(^|\/)node_modules(\/|$)/.test(path),
        'Dependencies must not enter the package',
    );
    assert(
        !/\.(?:sqlite(?:-(?:wal|shm))?|db(?:-(?:wal|shm))?|log|tgz|tar(?:\.gz)?|exe|key|crt|pem|env)$/.test(
            path,
        ),
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
for (const path of files) {
    assert(
        !/(^|\/)(?:adapter-manifest|case|host|gate|manifest)\.json$/.test(path),
        'Private deployment JSON entered package',
    );
    assert(
        !/(^|\/)(?:bento-a7-[^/]*|historical-source|gateway-state)(\/|$)/.test(
            path,
        ),
        'A7 private artifact entered package',
    );
}
console.log(
    JSON.stringify({
        schema: 1,
        publicSources: sources.length,
        localSuites: localTests.length,
        packageImportClosure: true,
        packageFiles: files.length,
        positive: true,
        negative: true,
    }),
);
