import { setTimeout as delay } from 'node:timers/promises';
import type { Binding } from './types.ts';

type Result = { code: number | null; stdout: string; stderr: string };
type Command = (args: string[]) => Promise<Result>;

/** The caller scopes the Gateway command to its own deployment and workspace. */
export function dockerOpenShellPurge({
    gateway,
    docker,
    volumeLabel,
}: {
    gateway: Command;
    docker: Command;
    volumeLabel: { key: string; value: string };
}) {
    async function checked(command: Command, args: string[]) {
        const result = await command(args);
        if (result.code !== 0)
            throw new Error('Workspace inspection or removal failed');
        return result.stdout;
    }

    async function sandboxPresent(name: string) {
        const result = await gateway(['sandbox', 'get', name, '-o', 'json']);
        if (result.code === 0) return true;
        if (result.code === 1 && /sandbox[^\n]*not found/i.test(result.stderr))
            return false;
        throw new Error('Sandbox absence could not be confirmed');
    }

    async function volumePresent(name: string) {
        const volumes = await checked(docker, [
            'volume',
            'ls',
            '--format',
            '{{.Name}}',
        ]);
        return volumes.split(/\r?\n/).includes(name);
    }

    return async (binding: Binding) => {
        const { sandbox, volume, project } = binding;
        if (
            !/^b-[a-f0-9]{16}$/.test(sandbox) ||
            !/^[a-f0-9-]{36}$/.test(project) ||
            volume !== 'bento-workspace-' + project
        )
            throw new Error('Invalid workspace binding');

        const hasSandbox = await sandboxPresent(sandbox);
        const hasVolume = await volumePresent(volume);
        if (hasVolume) {
            const labels = JSON.parse(
                await checked(docker, [
                    'volume',
                    'inspect',
                    '--format',
                    '{{json .Labels}}',
                    volume,
                ]),
            ) as Record<string, string> | null;
            if (labels?.[volumeLabel.key] !== volumeLabel.value)
                throw new Error(
                    'Workspace volume ownership could not be confirmed',
                );
        } else if (hasSandbox) {
            throw new Error('Sandbox volume ownership could not be confirmed');
        }

        if (hasSandbox) await checked(gateway, ['sandbox', 'delete', sandbox]);
        const deadline = Date.now() + 60_000;
        for (;;) {
            const containers = await checked(docker, [
                'ps',
                '-aq',
                '--filter',
                'volume=' + volume,
            ]);
            if (!(await sandboxPresent(sandbox)) && !containers.trim()) break;
            if (Date.now() >= deadline)
                throw new Error('Sandbox or volume attachment still exists');
            await delay(500);
        }
        if (hasVolume) await checked(docker, ['volume', 'rm', volume]);
        if (await volumePresent(volume))
            throw new Error('Workspace volume still exists');
    };
}
