import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    runDshWorkerLoop,
    runDshWorkerStdio,
    type DshWorkerBootstrap,
} from './dsh-worker.ts';

async function main() {
    const path = process.env.BENTO_DSH_BOOTSTRAP;
    if (!path) throw new Error('A private DSH bootstrap is required');
    const module = (await import(pathToFileURL(resolve(path)).href)) as {
        default: DshWorkerBootstrap;
    };
    if (process.argv[2] === '--warm') await runDshWorkerLoop(module.default);
    else await runDshWorkerStdio(module.default);
}

main().catch(() => {
    process.exit(1);
});
