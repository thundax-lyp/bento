import { spawn } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { dirname, join, isAbsolute } from 'node:path';
const args = process.argv.slice(2);
if (
    args.length !== 2 ||
    args[0] !== '--case' ||
    !['restart', 'restore'].includes(args[1]) ||
    !process.env.BENTO_A7_CONFIG ||
    !isAbsolute(process.env.BENTO_A7_CONFIG)
) {
    process.stderr.write(
        'Usage: set absolute BENTO_A7_CONFIG and run --case restart|restore\n',
    );
    process.exitCode = 2;
} else {
    const directory = dirname(fileURLToPath(import.meta.url));
    const registration = fileURLToPath(
        new URL('../../../../../../register-paths.mjs', import.meta.url),
    );
    const child = spawn(
        process.execPath,
        [
            '--import',
            registration,
            '--experimental-strip-types',
            '--test',
            '--test-concurrency=1',
            '--test-timeout=900000',
            join(directory, 'real-restore.test.ts'),
        ],
        { stdio: 'inherit', env: { ...process.env, BENTO_A7_CASE: args[1] } },
    );
    child.once('error', () => {
        process.exitCode = 1;
    });
    child.once('close', (code) => {
        process.exitCode = code ?? 1;
    });
}
