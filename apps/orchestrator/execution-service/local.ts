import { appendFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import {
    lstat,
    mkdir,
    open,
    readlink,
    realpath,
    symlink,
    mkdtemp,
    readFile,
    readdir,
    rename,
    rm,
    unlink,
    writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { filePath, textSnapshot } from './input.ts';
import { operationId, reserveOperation } from '@/apps/worker/protocol.ts';
import {
    executionBindingDigest,
    executionEnvironmentVersion,
    sha256Digest,
    type Binding,
    type ExecutionHost,
    type FileText,
    type FixtureWriteReceipt,
    type RestoreObservation,
    type WorkerExitObservation,
    type WorkerRequest,
} from './types.ts';

export async function readTextVolume(root: string) {
    const files: FileText[] = [];
    let bytes = 0;
    let entries = 0;
    async function read(directory: string, prefix: string) {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            if (++entries > 4096)
                throw new Error('Workspace has too many entries');
            const path = prefix + entry.name;
            filePath(path);
            const full = join(directory, entry.name);
            if (entry.isDirectory()) {
                await read(full, path + '/');
                continue;
            }
            if (!entry.isFile() || files.length >= 100)
                throw new Error('Workspace is outside text snapshot limits');
            const size = (await lstat(full)).size;
            if (bytes + size > 1024 * 1024)
                throw new Error('Workspace exceeds size limit');
            const buffer = await readFile(full);
            bytes += buffer.length;
            if (bytes > 1024 * 1024)
                throw new Error('Workspace exceeds size limit');
            files.push({
                path,
                text: new TextDecoder('utf-8', {
                    fatal: true,
                    ignoreBOM: true,
                }).decode(buffer),
            });
        }
    }
    if (!(await lstat(root)).isDirectory())
        throw new Error('Workspace directory required');
    await read(root, '');
    return textSnapshot(files);
}

async function exists(path: string) {
    try {
        await lstat(path);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
    }
}

async function persistence(
    request: WorkerRequest,
    method: string,
    fields: object = {},
) {
    const response = await fetch(new URL('/rpc', request.persistenceUrl), {
        method: 'POST',
        headers: { authorization: 'Bearer ' + request.grant.token },
        body: JSON.stringify({ method, id: request.grant.session, ...fields }),
        signal: AbortSignal.timeout(5000),
    });
    const result = (await response.json()) as {
        ok: boolean;
        value?: { key: string };
    };
    if (!response.ok || !result.ok)
        throw new Error('Demo history request failed');
    return result.value;
}

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const hex = /^[0-9a-f]{64}$/;

async function syncPath(path: string) {
    const handle = await open(path, 'r');
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
}

async function durableJson(path: string, value: object) {
    const directory = dirname(path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await syncPath(dirname(directory));
    const temporary = join(directory, '.' + randomUUID());
    try {
        await writeFile(temporary, JSON.stringify(value), {
            mode: 0o600,
            flag: 'wx',
            flush: true,
        });
        await rename(temporary, path);
        await syncPath(directory);
    } finally {
        await rm(temporary, { force: true });
    }
}

async function readJson<T>(path: string): Promise<T | null> {
    try {
        return JSON.parse(await readFile(path, 'utf8')) as T;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    }
}

async function stageFiles(root: string, files: readonly FileText[]) {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const directories = new Set([root]);
    for (const file of textSnapshot(files)) {
        const target = join(root, ...filePath(file.path));
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, file.text, {
            mode: 0o600,
            flag: 'wx',
            flush: true,
        });
        for (let path = dirname(target); path !== root; path = dirname(path))
            directories.add(path);
    }
    for (const directory of [...directories].sort(
        (a, b) => b.length - a.length,
    ))
        await syncPath(directory);
    await syncPath(dirname(root));
}

type RestoreJournal = RestoreObservation & {
    bindingDigest: string;
    previousVolume: string;
    stagedVolume: string;
};

export const localEnvironmentVersion = executionEnvironmentVersion(
    'sha256:' + '0'.repeat(64),
    'sha256:' + '1'.repeat(64),
);

/** Explicit local fixture with a deterministic text edit. It does not run a model or user code. */
export function localHost(root: string): ExecutionHost {
    const project = (binding: Binding) => join(root, binding.project);
    const volume = (binding: Binding) => join(project(binding), 'volume');
    const marker = (binding: Binding) => join(project(binding), 'running');
    const start = async (binding: Binding) => {
        await writeFile(marker(binding), '', { mode: 0o600 });
    };
    const running = async (binding: Binding) => ({
        sandbox: binding.sandbox,
        volume: binding.volume,
        running: await exists(marker(binding)),
        installed: true,
    });
    const writers = new Set<string>();
    const exclusive = new Set<string>();
    const taskPointer = (binding: Binding) =>
        join(project(binding), 'task-volume');
    const snapshotDigest = (files: readonly FileText[]) =>
        sha256Digest(JSON.stringify(textSnapshot(files)));
    const getPointer = async (binding: Binding) => {
        const target = await readlink(taskPointer(binding));
        if (!target.startsWith('volume-') || !uuid.test(target.slice(7)))
            throw new Error('Invalid Task volume pointer');
        return target;
    };
    async function resolveTaskVolume(binding: Binding) {
        const hostRoot = await realpath(root);
        const projectRoot = await realpath(project(binding));
        if (
            projectRoot !== join(hostRoot, binding.project) ||
            dirname(projectRoot) !== hostRoot
        )
            throw new Error('Invalid Task project root');
        const target = join(projectRoot, await getPointer(binding));
        if (
            !(await lstat(target)).isDirectory() ||
            (await realpath(target)) !== target
        )
            throw new Error('Invalid Task volume root');
        return target;
    }
    const workspace = async (binding: Binding) =>
        (await exists(taskPointer(binding)))
            ? resolveTaskVolume(binding)
            : volume(binding);
    const stopped = async (binding: Binding) =>
        !(await exists(marker(binding)));
    async function stop(binding: Binding) {
        try {
            await unlink(marker(binding));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
    }
    function scopedPath(
        binding: Binding,
        directory: string,
        id: string,
        generation?: number,
    ) {
        if (
            !uuid.test(id) ||
            !uuid.test(binding.project) ||
            (generation !== undefined &&
                (!Number.isSafeInteger(generation) || generation < 1))
        )
            throw new Error('Invalid fixture receipt identity');
        return join(
            project(binding),
            directory,
            id + (generation === undefined ? '' : '.' + generation) + '.json',
        );
    }
    function executionIdentity(
        binding: Binding,
        runId: string,
        generation: number,
    ) {
        return {
            sessionId: binding.session,
            runId,
            generation,
            bindingDigest: executionBindingDigest(binding),
        };
    }
    function matchesExecution(
        record: ReturnType<typeof executionIdentity>,
        binding: Binding,
        runId: string,
        generation: number,
    ) {
        return (
            record.sessionId === binding.session &&
            record.runId === runId &&
            record.generation === generation &&
            record.bindingDigest === executionBindingDigest(binding)
        );
    }
    async function observeWorkerExit(
        binding: Binding,
        runId: string,
        generation: number,
    ) {
        const record = await readJson<WorkerExitObservation>(
            scopedPath(binding, 'exits', runId, generation),
        );
        if (
            record &&
            (!matchesExecution(record, binding, runId, generation) ||
                !Number.isFinite(Date.parse(record.exitedAt)))
        )
            throw new Error('Fixture exit observation mismatch');
        return record;
    }
    async function readFixtureWriteReceipt(
        binding: Binding,
        runId: string,
        generation: number,
    ) {
        const record = await readJson<FixtureWriteReceipt>(
            scopedPath(binding, 'writes', runId, generation),
        );
        if (
            record &&
            (!matchesExecution(record, binding, runId, generation) ||
                record.operationId !== operationId(runId, 'local-demo') ||
                !hex.test(record.inputDigest) ||
                !hex.test(record.fileSha256) ||
                (record.relativePath !== 'README.md' &&
                    record.relativePath !== 'bento-demo.txt'))
        )
            throw new Error('Fixture write observation mismatch');
        return record;
    }
    async function publishPointer(binding: Binding, target: string) {
        const temporary = join(project(binding), '.pointer-' + randomUUID());
        try {
            await symlink(target, temporary);
            await rename(temporary, taskPointer(binding));
            await syncPath(project(binding));
        } finally {
            await rm(temporary, { force: true });
        }
    }
    async function readRestore(binding: Binding, attemptId: string) {
        const journal = await readJson<RestoreJournal>(
            scopedPath(binding, 'restores', attemptId),
        );
        if (!journal) return null;
        if (
            journal.attemptId !== attemptId ||
            journal.bindingDigest !== executionBindingDigest(binding) ||
            journal.stagedVolume !== 'volume-' + attemptId ||
            !hex.test(journal.sha256)
        )
            throw new Error('Conflicting restore journal');
        const pointer = await getPointer(binding);
        if (journal.phase === 'prepared' && pointer === journal.previousVolume)
            return journal;
        if (
            pointer !== journal.stagedVolume ||
            snapshotDigest(
                await readTextVolume(await resolveTaskVolume(binding)),
            ) !== journal.sha256
        )
            throw new Error('Restore volume evidence mismatch');
        return {
            ...journal,
            phase:
                journal.phase === 'ready'
                    ? ('ready' as const)
                    : ('published' as const),
        };
    }
    async function withStoppedVolume<T>(
        binding: Binding,
        action: () => Promise<T>,
    ) {
        const id = binding.project;
        if (writers.has(id) || exclusive.has(id))
            throw new Error('Task volume has an active writer');
        exclusive.add(id);
        try {
            await stop(binding);
            if (!(await stopped(binding)))
                throw new Error('Task volume stop unconfirmed');
            return await action();
        } finally {
            exclusive.delete(id);
        }
    }
    return {
        environmentVersion: localEnvironmentVersion,
        supportsTaskRunningCancellation: true,
        async provisionTask(binding, files, environmentVersion) {
            if (environmentVersion !== localEnvironmentVersion)
                throw new Error('Fixture environment unavailable');
            const root = project(binding);
            await mkdir(root, { recursive: true, mode: 0o700 });
            if (!(await exists(taskPointer(binding)))) {
                const target = 'volume-' + randomUUID();
                await stageFiles(join(root, target), files);
                await publishPointer(binding, target);
            }
            await start(binding);
            return { ...(await running(binding)), environmentVersion };
        },
        observeWorkerExit,
        async observeRetryCleanup(binding, attemptId, generation) {
            return withStoppedVolume(binding, async () => ({
                attemptId,
                generation,
                bindingDigest: executionBindingDigest(binding),
                restoreIdle: true,
                volumeWriters: 0,
                sandboxStopped: true,
                observedAt: new Date().toISOString(),
            }));
        },
        taskRecovery: {
            async retryObservation(binding, runId, generation) {
                if (
                    !(await exists(taskPointer(binding))) ||
                    !(await observeWorkerExit(binding, runId, generation))
                )
                    throw new Error('Fixture worker exit unconfirmed');
                return { unknownOperations: 0, workspaceOnly: true };
            },
            async queryRestore(binding, attemptId) {
                const journal = await readRestore(binding, attemptId);
                return (
                    journal && {
                        attemptId,
                        phase: journal.phase,
                        sha256: journal.sha256,
                    }
                );
            },
            async restoreTask(binding, attemptId, files, expectedSha256) {
                if (snapshotDigest(files) !== expectedSha256)
                    throw new Error('Unexpected restore input digest');
                const path = scopedPath(binding, 'restores', attemptId);
                const receipt = { attemptId, sha256: expectedSha256 };
                const prior = await readRestore(binding, attemptId);
                if (prior && prior.sha256 !== expectedSha256)
                    throw new Error('Conflicting restore input');
                if (prior?.phase === 'ready') return receipt;
                return withStoppedVolume(binding, async () => {
                    let journal = await readRestore(binding, attemptId);
                    if (!journal) {
                        const stagedVolume = 'volume-' + attemptId;
                        const stage = join(project(binding), stagedVolume);
                        await rm(stage, { recursive: true, force: true });
                        await stageFiles(stage, files);
                        journal = {
                            ...receipt,
                            phase: 'prepared',
                            bindingDigest: executionBindingDigest(binding),
                            previousVolume: await getPointer(binding),
                            stagedVolume,
                        };
                        await durableJson(path, journal);
                    }
                    if (journal.sha256 !== expectedSha256)
                        throw new Error('Conflicting restore input');
                    if (journal.phase === 'prepared')
                        await publishPointer(binding, journal.stagedVolume);
                    if (
                        snapshotDigest(
                            await readTextVolume(
                                await resolveTaskVolume(binding),
                            ),
                        ) !== expectedSha256
                    )
                        throw new Error('Restore verification failed');
                    await durableJson(path, { ...journal, phase: 'published' });
                    await start(binding);
                    if (!(await running(binding)).running)
                        throw new Error('Restored fixture did not start');
                    await durableJson(path, { ...journal, phase: 'ready' });
                    return receipt;
                });
            },
            readFixtureWriteReceipt,
        },
        async provision(binding, files) {
            await mkdir(project(binding), { recursive: true, mode: 0o700 });
            const path = volume(binding);
            if (!(await exists(path))) {
                const staging = await mkdtemp(
                    join(project(binding), 'import-'),
                );
                try {
                    for (const file of files) {
                        const target = join(staging, ...filePath(file.path));
                        await mkdir(dirname(target), {
                            recursive: true,
                            mode: 0o700,
                        });
                        await writeFile(target, file.text, {
                            flag: 'wx',
                            mode: 0o600,
                        });
                    }
                    await rename(staging, path);
                } finally {
                    await rm(staging, { force: true, recursive: true });
                }
            }
            await start(binding);
            return running(binding);
        },
        snapshot: async (binding) => readTextVolume(await workspace(binding)),
        async purge(binding) {
            await rm(project(binding), { recursive: true, force: true });
        },
        start,
        stop,
        stopped,
        running,
        async worker(request, signal, _slot, onWorkerExit) {
            const { binding, grant } = request;
            const id = binding.project;
            if (exclusive.has(id) || writers.has(id))
                throw new Error('Task volume is exclusively in use');
            writers.add(id);
            let task = false;
            try {
                task = await exists(taskPointer(binding));
                if (task && !(await running(binding)).running)
                    throw new Error('Task volume is stopped');
                const prior = await persistence(request, 'stat');
                if (request.mode === 'recover') {
                    if (prior) {
                        const writer = await persistence(request, 'open', {
                            access: 'write',
                        });
                        await persistence(request, 'reconcile', {
                            key: writer?.key,
                        });
                        await persistence(request, 'close', {
                            key: writer?.key,
                        });
                    }
                    return 'recovered';
                }
                const writer = prior
                    ? await persistence(request, 'open', { access: 'write' })
                    : await persistence(request, 'create', {
                          header: {
                              id: request.grant.session,
                              version: 4,
                              createdAt: Date.now(),
                              isSeeded: false,
                          },
                      });
                const prompt = request.prompt ?? '';
                if (prompt !== 'noop') {
                    if (
                        !(await reserveOperation(
                            request,
                            'local-demo',
                            prompt,
                            signal,
                        ))
                    )
                        return 'review';
                    signal.throwIfAborted();
                    const workspaceRoot = await workspace(binding);
                    const relativePath = (await exists(
                        join(workspaceRoot, 'README.md'),
                    ))
                        ? 'README.md'
                        : 'bento-demo.txt';
                    const target = join(workspaceRoot, relativePath);
                    signal.throwIfAborted();
                    appendFileSync(target, prompt + '\n', { mode: 0o600 });
                    if (task) {
                        await syncPath(target);
                        await syncPath(workspaceRoot);
                        const receipt: FixtureWriteReceipt = {
                            ...executionIdentity(
                                binding,
                                grant.run,
                                grant.generation,
                            ),
                            operationId: operationId(grant.run, 'local-demo'),
                            inputDigest: sha256Digest(prompt),
                            relativePath,
                            fileSha256: createHash('sha256')
                                .update(await readFile(target))
                                .digest('hex'),
                        };
                        const path = scopedPath(
                            binding,
                            'writes',
                            grant.run,
                            grant.generation,
                        );
                        const prior = await readFixtureWriteReceipt(
                            binding,
                            grant.run,
                            grant.generation,
                        );
                        if (
                            prior &&
                            JSON.stringify(prior) !== JSON.stringify(receipt)
                        )
                            throw new Error(
                                'Conflicting fixture write receipt',
                            );
                        if (!prior) await durableJson(path, receipt);
                    }
                }
                await persistence(request, 'close', { key: writer?.key });
                return 'completed';
            } finally {
                writers.delete(id);
                if (task && request.mode === 'execute') {
                    const prior = await observeWorkerExit(
                        binding,
                        grant.run,
                        grant.generation,
                    );
                    if (!prior)
                        await durableJson(
                            scopedPath(
                                binding,
                                'exits',
                                grant.run,
                                grant.generation,
                            ),
                            {
                                ...executionIdentity(
                                    binding,
                                    grant.run,
                                    grant.generation,
                                ),
                                exitedAt: new Date().toISOString(),
                            },
                        );
                }
                onWorkerExit?.();
            }
        },
    };
}
