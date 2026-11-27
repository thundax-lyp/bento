import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SdkIngressOptions } from '../openshell/sdk-ingress.ts';
import { object, textSnapshot } from './input.ts';
import {
    executionEnvironmentVersion,
    type Binding,
    type ExecutionHost,
    type FileText,
} from './types.ts';
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
    imageDigest: string;
    policyDigest: string;
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
    sharedVolumes?: boolean;
    generationScopedStop?: boolean;
    generationScopedStart?: boolean;
    generationScopedFreeze?: boolean;
    controlTimeoutMs?: number;
    taskObservationModule?: string;
};

async function loadSchemas(raw: string) {
    const require = createRequire(raw);
    const protobuf = (await import(
        pathToFileURL(require.resolve('@bufbuild/protobuf')).href
    )) as {
        fromBinary<T>(
            schema: unknown,
            bytes: Uint8Array,
            options?: { readUnknownFields: boolean },
        ): T;
        toBinary(schema: unknown, message: object): Uint8Array;
    };
    const schemas = (await import(pathToFileURL(raw).href)) as Record<
        string,
        unknown
    >;
    return { protobuf, schemas };
}

export async function schemaDecoder(raw: string): Promise<Decode> {
    const {
        protobuf: { fromBinary },
        schemas,
    } = await loadSchemas(raw);
    const workspace = (request: Request) => {
        const selection = request.workspaceScope?.selection;
        return selection?.case === 'workspace' ? selection.value : '';
    };
    return (method, bytes) => {
        if (method === 'ExecSandboxInteractive') {
            const { payload } = fromBinary<Decoded>(
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
        const request = fromBinary<Decoded>(
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

export async function schemaExecEventDecoder(
    raw: string,
): Promise<NonNullable<SdkIngressOptions['decodeExecEvent']>> {
    const { protobuf, schemas } = await loadSchemas(raw);
    const schema = schemas.ExecSandboxEventSchema;
    if (!schema) throw new Error('SDK Exec event schema unavailable');
    return (bytes) => {
        const message = protobuf.fromBinary<{
            payload: { case?: string; value?: { exitCode?: number } };
        }>(schema, bytes, { readUnknownFields: false });
        if (!Buffer.from(bytes).equals(protobuf.toBinary(schema, message)))
            throw new Error('Invalid SDK Exec event encoding');
        const { case: kind, value } = message.payload;
        if (kind === 'stdout' || kind === 'stderr') return { kind: 'output' };
        const code = value?.exitCode;
        if (
            kind !== 'exit' ||
            typeof code !== 'number' ||
            !Number.isInteger(code) ||
            code < -0x80000000 ||
            code > 0x7fffffff
        )
            throw new Error('Invalid SDK Exec exit event');
        return { kind: 'exit', code };
    };
}

type TaskObservations = Required<
    Pick<
        ExecutionHost,
        'observeWorkerExit' | 'observeTaskVolumeStopped' | 'taskRecovery'
    >
>;

async function loadTaskObservations(path: string): Promise<TaskObservations> {
    const loaded = (await import(pathToFileURL(path).href)) as {
        default?: Partial<TaskObservations>;
    };
    const observations = loaded.default;
    if (
        typeof observations?.observeWorkerExit !== 'function' ||
        typeof observations.observeTaskVolumeStopped !== 'function' ||
        typeof observations.taskRecovery?.retryObservation !== 'function' ||
        typeof observations.taskRecovery.queryRestore !== 'function' ||
        typeof observations.taskRecovery.restoreTask !== 'function' ||
        typeof observations.taskRecovery.observeSdkRetrySafety !== 'function'
    )
        throw new Error('Invalid trusted Task observation module');
    return {
        observeWorkerExit: observations.observeWorkerExit.bind(observations),
        observeTaskVolumeStopped:
            observations.observeTaskVolumeStopped.bind(observations),
        taskRecovery: observations.taskRecovery,
    };
}

/** One trusted command owns deployment-specific operations; the service owns all worker grants. */
export async function commandHost(configPath: string): Promise<ExecutionHost> {
    const settings = object(
        JSON.parse(await readFile(configPath, 'utf8')),
    ) as Settings;
    const environmentVersion = executionEnvironmentVersion(
        settings.imageDigest,
        settings.policyDigest,
    );
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
    if (
        settings.sharedVolumes !== undefined &&
        typeof settings.sharedVolumes !== 'boolean'
    )
        throw new Error('Invalid shared volume setting');
    if (
        settings.generationScopedStop !== undefined &&
        typeof settings.generationScopedStop !== 'boolean'
    )
        throw new Error('Invalid generation-scoped stop setting');
    if (
        settings.generationScopedStart !== undefined &&
        typeof settings.generationScopedStart !== 'boolean'
    )
        throw new Error('Invalid generation-scoped start setting');
    if (
        settings.generationScopedFreeze !== undefined &&
        (typeof settings.generationScopedFreeze !== 'boolean' ||
            (settings.generationScopedFreeze && !settings.generationScopedStop))
    )
        throw new Error('Generation freeze requires generation-scoped stop');
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
    const observationModule = settings.taskObservationModule;
    if (
        observationModule !== undefined &&
        (typeof observationModule !== 'string' ||
            !observationModule.trim() ||
            settings.prewarmWorker !== true)
    )
        throw new Error(
            'Trusted Task observations require a module and warm workers',
        );
    const upstream = new URL(settings.gateway);
    const sdkRaw = configFile(settings.sdkRaw);
    const [ca, cert, key, decode, raw, taskObservations] = await Promise.all([
        readFile(configFile(settings.ca)),
        readFile(configFile(settings.cert)),
        readFile(configFile(settings.key)),
        schemaDecoder(sdkRaw),
        import(pathToFileURL(sdkRaw).href) as Promise<Record<string, unknown>>,
        observationModule === undefined
            ? undefined
            : loadTaskObservations(configFile(observationModule)),
    ]);
    const decodeExecEvent = raw.ExecSandboxEventSchema
        ? await schemaExecEventDecoder(sdkRaw)
        : undefined;
    async function call(
        action: string,
        binding: Binding,
        files?: readonly FileText[],
        version?: string,
    ) {
        const output = await invokeProcess(
            settings.control,
            {
                action,
                binding,
                ...(files === undefined ? {} : { files }),
                ...(version === undefined
                    ? {}
                    : { environmentVersion: version }),
            },
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
        environmentVersion,
        taskCancellationRequiresTrustedObservation: true,
        ...(taskObservations && {
            ...taskObservations,
            supportsTaskRunningCancellation: true as const,
        }),
        async provisionTask(binding, files, version) {
            const result = object(
                await call('provisionTask', binding, files, version),
            );
            if (result.environmentVersion !== version)
                throw new Error('Task environment observation mismatch');
            return { ...observation(result), environmentVersion: version };
        },
        sdk: {
            upstream,
            workspace: settings.workspace,
            credentials: { ca, cert, key },
            decode,
            ...(decodeExecEvent && { decodeExecEvent }),
        },
        provision: async (binding, files) =>
            observation(await call('provision', binding, files)),
        ...(settings.sharedVolumes === true && {
            sharedVolume: {
                attach: async (binding) =>
                    observation(await call('attach', binding)),
                async detach(binding) {
                    const receipt = object(await call('detach', binding));
                    if (
                        receipt.sandbox !== binding.sandbox ||
                        receipt.volume !== binding.volume ||
                        receipt.detached !== true
                    )
                        throw new Error('Session detachment unconfirmed');
                },
                async reclaim(binding) {
                    const receipt = object(await call('reclaim', binding));
                    if (
                        receipt.volume !== binding.volume ||
                        receipt.absent !== true
                    )
                        throw new Error('Volume reclaim unconfirmed');
                },
            },
        }),
        snapshot: async (binding) =>
            textSnapshot(await call('snapshot', binding)),
        async purge(binding) {
            const receipt = object(await call('purge', binding));
            if (
                receipt.absent !== true ||
                receipt.sandbox !== binding.sandbox ||
                receipt.volume !== binding.volume
            )
                throw new Error('Workspace deletion was not confirmed');
        },
        async stop(binding) {
            await call('stop', binding);
        },
        ...(settings.generationScopedStop === true && {
            async stopGeneration(binding) {
                await call('stopGeneration', binding);
            },
        }),
        ...(settings.generationScopedFreeze === true && {
            async freezeGeneration(binding) {
                await call('freezeGeneration', binding);
            },
        }),
        async start(binding) {
            await call('start', binding);
        },
        ...(settings.generationScopedStart === true && {
            async startGeneration(binding) {
                await call('startGeneration', binding);
            },
        }),
        stopped: async (binding) => (await call('stopped', binding)) === true,
        running: async (binding) => observation(await call('running', binding)),
        ...(settings.prewarmWorker
            ? prewarmedWorker(settings.worker, slots)
            : { worker: processWorker(settings.worker) }),
    };
}
