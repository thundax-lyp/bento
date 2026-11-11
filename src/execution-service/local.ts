import { appendFileSync } from 'node:fs';
import {
    lstat,
    mkdir,
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
import { reserveOperation } from '../../apps/worker/protocol.ts';
import type {
    Binding,
    ExecutionHost,
    FileText,
    WorkerRequest,
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
    return {
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
        snapshot: (binding) => readTextVolume(volume(binding)),
        async purge(binding) {
            await rm(project(binding), { recursive: true, force: true });
        },
        start,
        async stop(binding) {
            try {
                await unlink(marker(binding));
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                    throw error;
            }
        },
        stopped: async (binding) => !(await exists(marker(binding))),
        running,
        async worker(request, signal) {
            const prior = await persistence(request, 'stat');
            if (request.mode === 'recover') {
                if (prior) {
                    const writer = await persistence(request, 'open', {
                        access: 'write',
                    });
                    await persistence(request, 'reconcile', {
                        key: writer?.key,
                    });
                    await persistence(request, 'close', { key: writer?.key });
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
                const readme = join(volume(request.binding), 'README.md');
                const target = (await exists(readme))
                    ? readme
                    : join(volume(request.binding), 'bento-demo.txt');
                signal.throwIfAborted();
                appendFileSync(target, prompt + '\n', { mode: 0o600 });
            }
            await persistence(request, 'close', { key: writer?.key });
            return 'completed';
        },
    };
}
