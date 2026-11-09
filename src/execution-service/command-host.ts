import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SdkIngressOptions } from '../openshell/sdk-ingress.ts';
import { object, textSnapshot } from './input.ts';
import type { Binding, ExecutionHost, FileText } from './types.ts';
import { prewarmedWorker } from './warm-worker.ts';
import { invokeProcess, processWorker, type Launch } from './worker.ts';

type Decode = SdkIngressOptions['decode'];
type Selection = { case: string; value: string };
type Request = {
    name?: string;
    sandbox?: string;
    workspaceScope?: { selection: Selection };
    tty?: boolean;
};
type Decoded = Request & { payload: { case: string; value: Request } };
type Settings = {
    gateway: string;
    workspace: string;
    ca: string;
    cert: string;
    key: string;
    sdkRaw: string;
    control: Launch;
    worker: Launch;
    prewarmWorker?: boolean;
    workerSlots?: 1 | 2;
    controlTimeoutMs?: number;
};

export async function schemaDecoder(raw: string): Promise<Decode> {
    const require = createRequire(raw);
    const { fromBinary } = (await import(
        pathToFileURL(require.resolve('@bufbuild/protobuf')).href
    )) as {
        fromBinary(schema: unknown, bytes: Uint8Array): Decoded;
    };
    const schemas = (await import(pathToFileURL(raw).href)) as Record<
        string,
        unknown
    >;
    const workspace = (request: Request) => {
        const selection = request.workspaceScope?.selection;
        return selection?.case === 'workspace' ? selection.value : '';
    };
    return (method, bytes) => {
        if (method === 'ExecSandboxInteractive') {
            const { payload } = fromBinary(
                schemas.ExecSandboxInputSchema,
                bytes,
            );
            if (payload.case === 'stdin') return 'stdin';
            if (payload.case !== 'start')
                throw new Error('Unsupported interactive request');
            return {
                sandbox: payload.value.sandbox ?? '',
                workspace: workspace(payload.value),
                tty: payload.value.tty ?? false,
            };
        }
        const lookup = method === 'GetSandbox';
        const request = fromBinary(
            lookup
                ? schemas.GetSandboxRequestSchema
                : schemas.ExecSandboxRequestSchema,
            bytes,
        );
        return {
            sandbox: (lookup ? request.name : request.sandbox) ?? '',
            workspace: workspace(request),
        };
    };
}

/** One trusted command owns deployment-specific operations; the service owns all worker grants. */
export async function commandHost(configPath: string): Promise<ExecutionHost> {
    const settings = object(
        JSON.parse(await readFile(configPath, 'utf8')),
    ) as Settings;
    if (
        !isAbsolute(settings.control?.command ?? '') ||
        !isAbsolute(settings.worker?.command ?? '')
    )
        throw new Error(
            'Host and worker commands must be absolute executable paths',
        );
    if (
        settings.prewarmWorker !== undefined &&
        typeof settings.prewarmWorker !== 'boolean'
    )
        throw new Error('Invalid worker prewarm setting');
    const slots = settings.workerSlots ?? 1;
    if (
        (slots !== 1 && slots !== 2) ||
        (slots === 2 && !settings.prewarmWorker)
    )
        throw new Error('Invalid host worker slots');
    const timeout = settings.controlTimeoutMs ?? 60_000;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 300_000)
        throw new Error('Invalid host command timeout');
    if (!settings.workspace)
        throw new Error('Gateway workspace scope required');
    const configFile = (path: string) => resolve(dirname(configPath), path);
    const upstream = new URL(settings.gateway);
    const [ca, cert, key, decode] = await Promise.all([
        readFile(configFile(settings.ca)),
        readFile(configFile(settings.cert)),
        readFile(configFile(settings.key)),
        schemaDecoder(configFile(settings.sdkRaw)),
    ]);
    async function call(
        action: string,
        binding: Binding,
        files?: readonly FileText[],
    ) {
        const output = await invokeProcess(
            settings.control,
            { action, binding, ...(files === undefined ? {} : { files }) },
            AbortSignal.timeout(timeout),
            9 * 1024 * 1024,
        );
        return output.trim() ? (JSON.parse(output) as unknown) : undefined;
    }
    function observation(value: unknown) {
        const { sandbox, volume, running, installed } = object(value);
        if (
            typeof sandbox !== 'string' ||
            typeof volume !== 'string' ||
            typeof running !== 'boolean' ||
            typeof installed !== 'boolean'
        )
            throw new Error('Invalid host observation');
        return { sandbox, volume, running, installed };
    }
    return {
        sdk: {
            upstream,
            workspace: settings.workspace,
            credentials: { ca, cert, key },
            decode,
        },
        provision: async (binding, files) =>
            observation(await call('provision', binding, files)),
        snapshot: async (binding) =>
            textSnapshot(await call('snapshot', binding)),
        async stop(binding) {
            await call('stop', binding);
        },
        async start(binding) {
            await call('start', binding);
        },
        stopped: async (binding) => (await call('stopped', binding)) === true,
        running: async (binding) => observation(await call('running', binding)),
        ...(settings.prewarmWorker
            ? prewarmedWorker(settings.worker, slots)
            : { worker: processWorker(settings.worker) }),
    };
}
