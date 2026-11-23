import { createHash } from 'node:crypto';
import {
    chmod,
    copyFile,
    mkdir,
    mkdtemp,
    open,
    readFile,
    realpath,
    rename,
    rm,
    stat,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { root, runCommand } from './process.ts';

export type TemporalTool = {
    binary: string;
    archiveSha256: string;
    binarySha256: string;
    platform: 'darwin-arm64' | 'linux-x64';
};
const releases = {
    'darwin-arm64': {
        id: 312122449,
        size: 50272315,
        sha: 'cca01b7ea35ad56e2a328d9ae596bf716bd22313ef63c7a761c88354457c2415',
    },
    'linux-x64': {
        id: 312122450,
        size: 50408448,
        sha: 'ddc95e08b0b076efd4ea9733a3f488eb7d2be875f8834e616cd2a37358b4852d',
    },
} as const;
const digest = (bytes: Uint8Array) =>
    createHash('sha256').update(bytes).digest('hex');

export async function acquireTemporal(
    directory: string,
    signal: AbortSignal,
): Promise<TemporalTool> {
    const platform = process.platform + '-' + process.arch;
    if (platform !== 'darwin-arm64' && platform !== 'linux-x64')
        throw new Error('Unsupported Temporal acceptance platform');
    const release = releases[platform];
    const cachedArchive = join(
        root,
        '..',
        'bento-sdk-cache',
        'temporal',
        '1.5.1',
        platform,
        'release.tar.gz',
    );
    let supplied = process.env.BENTO_A6_TEMPORAL_ARCHIVE;
    if (supplied === undefined) {
        try {
            await stat(cachedArchive);
            supplied = cachedArchive;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const archive = join(directory, 'release.tar.gz');
    const part = join(directory, 'part');
    const env = { ...process.env };
    for (const prefix of ['http', 'https', 'all', 'no']) {
        const lower = prefix + '_proxy',
            upper = prefix.toUpperCase() + '_PROXY';
        if (env[upper] && !env[lower]) env[lower] = env[upper];
        if (env[lower] && !env[upper]) env[upper] = env[lower];
    }
    const command = (
        args: string[],
        timeoutMs = 20000,
        input: string | null = null,
    ) =>
        runCommand(args[0]!, args.slice(1), {
            cwd: root,
            env,
            timeoutMs,
            signal,
            input,
        });
    try {
        if (supplied !== undefined) {
            if (!isAbsolute(supplied))
                throw new Error(
                    'Temporal archive must be absolute and outside the repository',
                );
            const source = await realpath(supplied),
                repo = await realpath(root);
            const rel = relative(repo, source);
            if (
                !rel.startsWith(
                    '..' + (process.platform === 'win32' ? '\\' : '/'),
                ) &&
                !isAbsolute(rel)
            )
                throw new Error(
                    'Temporal archive must be outside the repository',
                );
            await copyFile(source, archive);
            await chmod(archive, 0o600);
        } else {
            const deadline = Date.now() + 480000;
            let requests = 0;
            async function request(url: string, range: string | null) {
                if (++requests > 12 || Date.now() >= deadline)
                    throw new Error('Temporal download budget exhausted');
                await rm(part, { force: true });
                const handle = await open(part, 'w', 0o600);
                await handle.close();
                const seconds = Math.max(
                    1,
                    Math.min(45, Math.floor((deadline - Date.now()) / 1000)),
                );
                const config = 'url = ' + JSON.stringify(url) + '\n';
                const result = await command(
                    [
                        'curl',
                        '--http1.1',
                        '--silent',
                        '--show-error',
                        '--connect-timeout',
                        '10',
                        '--max-time',
                        String(seconds),
                        '--max-redirs',
                        '0',
                        '--dump-header',
                        '-',
                        '--output',
                        part,
                        '--header',
                        'Accept: application/octet-stream',
                        ...(range === null ? [] : ['--range', range]),
                        '--config',
                        '-',
                    ],
                    seconds * 1000,
                    config,
                );
                const block =
                    result.stdout
                        .trim()
                        .split(/\r?\n\r?\n/)
                        .at(-1) ?? '';
                const status = Number(/^HTTP\/\S+\s+(\d+)/.exec(block)?.[1]);
                const headers = new Map(
                    block
                        .split(/\r?\n/)
                        .slice(1)
                        .map((line) => {
                            const at = line.indexOf(':');
                            return [
                                line.slice(0, at).toLowerCase(),
                                line.slice(at + 1).trim(),
                            ];
                        }),
                );
                return { status, headers };
            }
            const redirect = await request(
                'https://api.github.com/repos/temporalio/cli/releases/assets/' +
                    release.id,
                null,
            );
            if (redirect.status !== 302 || !redirect.headers.has('location')) {
                const rawType = redirect.headers.get('content-type') ?? '';
                const contentType =
                    rawType.length <= 128 &&
                    /^(?:application\/(?:json|octet-stream)|text\/(?:html|plain))(?:;\s*charset=(?:utf-8|us-ascii))?$/i.test(
                        rawType,
                    )
                        ? rawType.toLowerCase()
                        : 'unknown';
                const remaining =
                    redirect.headers.get('x-ratelimit-remaining') ?? '';
                let apiError = 'non_json';
                const body = await open(part, 'r');
                try {
                    if ((await body.stat()).size <= 4096) {
                        const bytes = Buffer.alloc(4096);
                        const { bytesRead } = await body.read(
                            bytes,
                            0,
                            4096,
                            0,
                        );
                        try {
                            const parsed: unknown = JSON.parse(
                                bytes.subarray(0, bytesRead).toString('utf8'),
                            );
                            apiError = 'other_json';
                            const message =
                                parsed !== null &&
                                typeof parsed === 'object' &&
                                'message' in parsed &&
                                typeof parsed.message === 'string'
                                    ? parsed.message.toLowerCase()
                                    : '';
                            if (message.includes('rate limit'))
                                apiError = 'rate_limit';
                            else if (message === 'not found')
                                apiError = 'not_found';
                            else if (message === 'bad credentials')
                                apiError = 'unauthorized';
                            else if (message.includes('forbidden'))
                                apiError = 'forbidden';
                        } catch {
                            apiError = 'non_json';
                        }
                    }
                } finally {
                    await body.close();
                }
                throw new Error(
                    'Official Temporal asset redirect unavailable ' +
                        JSON.stringify({
                            status: Number.isFinite(redirect.status)
                                ? redirect.status
                                : null,
                            contentType,
                            hasLocation: redirect.headers.has('location'),
                            rateLimit:
                                remaining === '0'
                                    ? 'exhausted'
                                    : /^[1-9]\d*$/.test(remaining)
                                      ? 'available'
                                      : 'unknown',
                            apiError,
                        }),
                );
            }
            const url = new URL(redirect.headers.get('location')!);
            if (
                url.protocol !== 'https:' ||
                url.hostname !== 'release-assets.githubusercontent.com'
            )
                throw new Error('Unexpected Temporal asset origin');
            const output = await open(archive, 'w', 0o600);
            try {
                let offset = 0,
                    withoutProgress = 0;
                while (offset < release.size) {
                    const end = Math.min(
                        release.size - 1,
                        offset + 5 * 1024 * 1024 - 1,
                    );
                    let result: Awaited<ReturnType<typeof request>>;
                    try {
                        result = await request(url.href, offset + '-' + end);
                    } catch {
                        if (
                            ++withoutProgress >= 2 ||
                            requests >= 12 ||
                            Date.now() >= deadline
                        )
                            throw new Error(
                                'Temporal download made no verified progress',
                            );
                        continue;
                    }
                    if ([200, 401, 403, 416].includes(result.status))
                        throw new Error(
                            'Temporal asset refused required Range transfer',
                        );
                    const bytes = await readFile(part);
                    if (
                        result.status !== 206 ||
                        result.headers.get('content-range') !==
                            `bytes ${offset}-${end}/${release.size}` ||
                        bytes.length !== end - offset + 1
                    ) {
                        if (++withoutProgress >= 2)
                            throw new Error(
                                'Temporal Range validation failed twice',
                            );
                        continue;
                    }
                    let written = 0;
                    while (written < bytes.length)
                        written += (
                            await output.write(
                                bytes,
                                written,
                                bytes.length - written,
                                offset + written,
                            )
                        ).bytesWritten;
                    offset = end + 1;
                    withoutProgress = 0;
                    console.log(
                        JSON.stringify({
                            phase: 'temporal-download',
                            requests,
                            received: offset,
                            total: release.size,
                        }),
                    );
                }
                await output.sync();
            } finally {
                await output.close();
            }
        }
        if (
            (await stat(archive)).size !== release.size ||
            digest(await readFile(archive)) !== release.sha
        )
            throw new Error('Temporal archive size or SHA mismatch');
        const listing = (await command(['tar', '-tzf', archive])).stdout
            .trim()
            .split('\n')
            .map((name) => name.replace(/^\.\//, ''));
        if (
            listing.length !== 2 ||
            new Set(listing).size !== 2 ||
            !listing.includes('LICENSE') ||
            !listing.includes('temporal')
        )
            throw new Error('Unexpected Temporal archive members');
        await command(['tar', '-xzf', archive, '-C', directory, 'temporal']);
        const binary = join(directory, 'temporal');
        await chmod(binary, 0o700);
        const binarySha256 = digest(await readFile(binary));
        if (
            platform === 'darwin-arm64' &&
            binarySha256 !==
                '1bde16fafe3ac67706ec90b4b16ce5c42097cf4d0203447a4a59bb44e5c65be7'
        )
            throw new Error('Temporal extracted binary SHA mismatch');
        const version = (await command([binary, '--version'])).stdout.trim();
        if (version !== 'temporal version 1.5.1 (Server 1.29.1, UI 2.42.1)')
            throw new Error('Temporal version mismatch');
        if (supplied === undefined) {
            const cacheDirectory = dirname(cachedArchive);
            await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
            const staging = await mkdtemp(join(cacheDirectory, '.download-'));
            try {
                const candidate = join(staging, 'release.tar.gz');
                await copyFile(archive, candidate);
                await chmod(candidate, 0o600);
                await rename(candidate, cachedArchive);
            } finally {
                await rm(staging, { recursive: true, force: true });
            }
        }
        return { binary, archiveSha256: release.sha, binarySha256, platform };
    } catch (error) {
        await rm(archive, { force: true });
        await rm(join(directory, 'temporal'), { force: true });
        throw error;
    } finally {
        await rm(part, { force: true });
    }
}
