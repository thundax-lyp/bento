import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileText } from './types.ts';

function git(cwd: string, args: string[], input = '') {
    return new Promise<string>((resolve, reject) => {
        const child = spawn('git', args, {
            cwd,
            env: {
                ...(process.env.PATH === undefined
                    ? {}
                    : { PATH: process.env.PATH }),
                GIT_CONFIG_NOSYSTEM: '1',
                GIT_CONFIG_GLOBAL: '/dev/null',
                LC_ALL: 'C',
            },
            stdio: ['pipe', 'pipe', 'ignore'],
            signal: AbortSignal.timeout(15_000),
        });
        const output: Buffer[] = [];
        let bytes = 0;
        child.stdout.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 8 * 1024 * 1024) child.kill('SIGKILL');
            else output.push(chunk);
        });
        child.stdin.on('error', reject);
        child.once('error', reject);
        child.once('close', (code) => {
            if (code === 0) resolve(Buffer.concat(output).toString('utf8'));
            else reject(new Error('Git diff generation failed'));
        });
        child.stdin.end(input);
    });
}

async function tree(cwd: string, files: readonly FileText[]) {
    await git(cwd, ['read-tree', '--empty']);
    let index = '';
    for (const { path, text } of files) {
        const blob = (
            await git(
                cwd,
                ['hash-object', '-w', '--stdin', '--no-filters'],
                text,
            )
        ).trim();
        index += `100644 ${blob}\t${path}\0`;
    }
    await git(cwd, ['update-index', '-z', '--index-info'], index);
    return (await git(cwd, ['write-tree'])).trim();
}

export async function unifiedDiff(
    before: readonly FileText[],
    after: readonly FileText[],
) {
    if (JSON.stringify(before) === JSON.stringify(after)) return '';
    const cwd = await mkdtemp(join(tmpdir(), 'bento-diff-'));
    try {
        // Use raw Git objects so project attributes and filters never interpret file contents.
        await git(cwd, ['init', '--quiet', '--template=']);
        const oldTree = await tree(cwd, before);
        const newTree = await tree(cwd, after);
        return await git(cwd, [
            '-c',
            'core.quotePath=false',
            'diff',
            '--no-ext-diff',
            '--no-textconv',
            '--no-renames',
            '--text',
            '--src-prefix=a/',
            '--dst-prefix=b/',
            oldTree,
            newTree,
            '--',
        ]);
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
}
