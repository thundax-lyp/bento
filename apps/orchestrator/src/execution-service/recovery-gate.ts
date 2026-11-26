import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';

const query = promisify(execFile);
const digest = /^[0-9a-f]{64}$/;

type RecoveryGate = {
    deployment: string;
    host: string;
    epoch: number;
    checkpoint: string;
    isolation: string;
    authorityCommand: string;
};

export async function requireRecoveryOwner(
    configPath: string,
    expectedCheckpoint?: string,
) {
    const config = JSON.parse(
        await readFile(configPath, 'utf8'),
    ) as RecoveryGate;
    if (
        !config ||
        typeof config.deployment !== 'string' ||
        !config.deployment.trim() ||
        typeof config.host !== 'string' ||
        !config.host.trim() ||
        !Number.isSafeInteger(config.epoch) ||
        config.epoch < 1 ||
        typeof config.checkpoint !== 'string' ||
        typeof config.isolation !== 'string' ||
        (config.epoch === 1
            ? config.checkpoint !== '' || config.isolation !== ''
            : !digest.test(config.checkpoint) ||
              !digest.test(config.isolation)) ||
        typeof config.authorityCommand !== 'string' ||
        !isAbsolute(config.authorityCommand)
    )
        throw new Error('Invalid recovery owner gate configuration');

    if (
        expectedCheckpoint !== undefined &&
        (config.epoch === 1 || config.checkpoint !== expectedCheckpoint)
    )
        throw new Error('Recovery checkpoint does not match the owner gate');

    try {
        const { stdout } = await query(
            config.authorityCommand,
            [config.deployment],
            {
                timeout: 5000,
                killSignal: 'SIGKILL',
                maxBuffer: 4096,
                encoding: 'utf8',
            },
        );
        const owner = JSON.parse(stdout) as Omit<
            RecoveryGate,
            'deployment' | 'authorityCommand'
        >;
        if (
            owner?.host === config.host &&
            owner.epoch === config.epoch &&
            owner.checkpoint === config.checkpoint &&
            owner.isolation === config.isolation
        )
            return;
    } catch {
        throw new Error('Recovery owner authority unavailable');
    }
    throw new Error('Execution host does not own the recovery epoch');
}
