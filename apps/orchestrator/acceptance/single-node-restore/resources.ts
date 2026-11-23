import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, basename } from 'node:path';
import { promisify } from 'node:util';
import type { Binding } from '@/apps/worker/protocol.ts';

export type A7Config = {
    schema: 1;
    caseId: string;
    root: string;
    dockerDaemonId: string;
    runtimeImageId: string;
    workerImageId: string;
    hostConfig: string;
    sdkModule: string;
    gatewayWorkspace: string;
    gatewayOwner: string;
    gatewayEndpoint: string;
    adapterManifest: string;
    cli: string;
    cliConfigHome: string;
    policy: string;
};
export type VolumeEntry = {
    path: string;
    type: 'directory' | 'file';
    mode: number;
    uid: number;
    gid: number;
    bytes: number;
    sha256: string | null;
};
export type Command = (
    command: string,
    args: readonly string[],
    options?: { env: { XDG_CONFIG_HOME: string } },
) => Promise<string>;
const exec = promisify(execFile);
export const execute: Command = async (command, args, options) => {
    try {
        return (
            await exec(command, [...args], {
                timeout: 60000,
                maxBuffer: 16 * 1024 * 1024,
                env: { ...process.env, ...options?.env },
            })
        ).stdout.trim();
    } catch {
        throw new Error('resource_command_failed');
    }
};
const sha = (value: Uint8Array) =>
    createHash('sha256').update(value).digest('hex');
export function validateConfig(config: A7Config) {
    assert(
        config.schema === 1 && /^bento-a7-b-[a-f0-9]{16}$/.test(config.caseId),
        'resource_config_invalid',
    );
    assert(
        config.dockerDaemonId &&
            config.gatewayWorkspace === 'default' &&
            config.gatewayOwner,
        'resource_config_invalid',
    );
    for (const path of [
        config.root,
        config.hostConfig,
        config.sdkModule,
        config.adapterManifest,
        config.cli,
        config.cliConfigHome,
        config.policy,
    ])
        assert(
            isAbsolute(path) && !/[,\0\r\n]/.test(path),
            'resource_config_invalid',
        );
    for (const image of [config.runtimeImageId, config.workerImageId])
        assert(/^sha256:[a-f0-9]{64}$/.test(image), 'resource_config_invalid');
}
function validBinding(binding: Binding) {
    assert(
        /^[a-f0-9-]{36}$/.test(binding.project) &&
            binding.volume === 'bento-workspace-' + binding.project &&
            /^b-[a-f0-9]{16}$/.test(binding.sandbox),
        'resource_binding_invalid',
    );
}
async function identity(config: A7Config, run: Command) {
    validateConfig(config);
    assert.equal(
        await run('docker', ['info', '--format', '{{.ID}}']),
        config.dockerDaemonId,
        'resource_daemon_mismatch',
    );
}
async function volume(
    config: A7Config,
    binding: Binding,
    name: string,
    run: Command,
) {
    await identity(config, run);
    validBinding(binding);
    const [info] = JSON.parse(await run('docker', ['volume', 'inspect', name]));
    assert(
        info.Name === name &&
            info.Labels?.['bento.web08'] === config.caseId &&
            info.Labels?.['bento.web08.project'] === binding.project,
        'resource_owner_mismatch',
    );
    return info;
}
async function attachments(name: string, run: Command): Promise<string[]> {
    return (await run('docker', ['ps', '-aq', '--filter', 'volume=' + name]))
        .split(/\r?\n/)
        .filter(Boolean);
}
async function stopped(
    config: A7Config,
    binding: Binding,
    name: string,
    run: Command,
) {
    await volume(config, binding, name, run);
    const ids = await attachments(name, run);
    assert(ids.length <= 1, 'resource_extra_attachment');
    for (const id of ids) {
        const [info] = JSON.parse(
            await run('docker', ['container', 'inspect', id]),
        );
        assert(
            info.Config?.Labels?.['bento.web08'] === config.caseId,
            'resource_owner_mismatch',
        );
        assert(info.State?.Running === false, 'resource_writer_active');
        assert(info.Image === config.runtimeImageId, 'resource_image_mismatch');
        const mounts = info.Mounts.filter(
            (m: { Type: string; Name: string }) =>
                m.Type === 'volume' && m.Name === name,
        );
        assert(
            mounts.length === 1 &&
                mounts[0].Destination === '/sandbox/project/bento-workspace',
            'resource_mount_mismatch',
        );
    }
}
const inventoryScript = String.raw`
const fs=require('node:fs'),crypto=require('node:crypto'),path=require('node:path');
const rows=[];let total=0;
function walk(relative){
 const full=path.join('/volume',relative),s=fs.lstatSync(full);
 if(!(s.isDirectory()||s.isFile())||s.isSymbolicLink()||(s.isFile()&&s.nlink!==1))throw Error('inventory_type');
 if(rows.length>=10000)throw Error('inventory_limit');
 const row={path:relative,type:s.isDirectory()?'directory':'file',mode:s.mode&4095,uid:s.uid,gid:s.gid,bytes:s.isFile()?s.size:0,sha256:null};
 if(s.isFile()){total+=s.size;if(total>67108864)throw Error('inventory_limit');row.sha256=crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');}
 rows.push(row);
 if(s.isDirectory())for(const name of fs.readdirSync(full).sort()){if(name.includes('\\')||name.includes('\0'))throw Error('inventory_path');walk(relative==='.'?name:relative+'/'+name);}
}
walk('.');rows.sort((a,b)=>Buffer.compare(Buffer.from(a.path),Buffer.from(b.path)));console.log(JSON.stringify(rows));`;
async function inventory(
    config: A7Config,
    binding: Binding,
    name: string,
    run: Command,
): Promise<VolumeEntry[]> {
    await stopped(config, binding, name, run);
    const rows: VolumeEntry[] = JSON.parse(
        await run('docker', [
            'run',
            '--rm',
            '--network',
            'none',
            '--read-only',
            '--label',
            'io.bento.a7=' + config.caseId,
            '--mount',
            'type=volume,src=' + name + ',dst=/volume,readonly',
            '--entrypoint',
            'node',
            config.runtimeImageId,
            '-e',
            inventoryScript,
        ]),
    );
    assert(
        Array.isArray(rows) && rows.length > 0 && rows[0]?.path === '.',
        'inventory_invalid',
    );
    return rows;
}
export async function inventoryVolume(
    config: A7Config,
    binding: Binding,
    run: Command = execute,
): Promise<VolumeEntry[]> {
    return inventory(config, binding, binding.volume, run);
}
export function assertSameInventory(
    before: readonly VolumeEntry[],
    after: readonly VolumeEntry[],
) {
    if (JSON.stringify(after) !== JSON.stringify(before))
        throw new Error('volume_inventory_mismatch');
}
async function absent(name: string, run: Command) {
    const found = await run('docker', [
        'volume',
        'ls',
        '--filter',
        'name=^' + name + '$',
        '--format',
        '{{.Name}}',
    ]);
    assert.equal(found, '', 'resource_target_exists');
}
async function createVolume(
    config: A7Config,
    binding: Binding,
    name: string,
    run: Command,
) {
    await identity(config, run);
    await absent(name, run);
    const incarnation = randomUUID();
    assert.equal(
        await run('docker', [
            'volume',
            'create',
            '--label',
            'bento.web08=' + config.caseId,
            '--label',
            'bento.web08.project=' + binding.project,
            '--label',
            'io.bento.a7.incarnation=' + incarnation,
            '--label',
            'openshell.ai/sandbox-attachable=true',
            '--label',
            'openshell.ai/sandbox-attachable-workspace=' +
                config.gatewayWorkspace,
            name,
        ]),
        name,
    );
    const info = await volume(config, binding, name, run);
    assert.equal(
        info.Labels['io.bento.a7.incarnation'],
        incarnation,
        'resource_create_conflict',
    );
}
async function tar(
    config: A7Config,
    binding: Binding,
    name: string,
    archive: string,
    extract: boolean,
    run: Command,
) {
    await stopped(config, binding, name, run);
    await run('docker', [
        'run',
        '--rm',
        '--network',
        'none',
        '--read-only',
        '--label',
        'io.bento.a7=' + config.caseId,
        '--mount',
        'type=volume,src=' +
            name +
            ',dst=/volume' +
            (extract ? '' : ',readonly'),
        '--mount',
        'type=bind,src=' +
            join(config.root, 'backup') +
            ',dst=/backup' +
            (extract ? ',readonly' : ''),
        '--entrypoint',
        '/bin/tar',
        config.runtimeImageId,
        '--numeric-owner',
        extract ? '-xpf' : '-cpf',
        '/backup/' + basename(archive),
        '-C',
        '/volume',
        ...(extract ? [] : ['.']),
    ]);
}
type Proof = {
    schema: 1;
    caseId: string;
    binding: Binding;
    archiveSha256: string;
    entries: VolumeEntry[];
};
async function syncFile(path: string) {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        await file.sync();
    } finally {
        await file.close();
    }
}
async function archiveBytes(archive: string) {
    const stat = await lstat(archive);
    assert(
        stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1,
        'archive_invalid',
    );
    return readFile(archive);
}
export async function backupWorkspace(
    config: A7Config,
    binding: Binding,
    run: Command = execute,
): Promise<void> {
    const archive = join(config.root, 'backup', 'workspace.tar');
    const before = await inventoryVolume(config, binding, run);
    await assert.rejects(lstat(archive), { code: 'ENOENT' });
    await tar(config, binding, binding.volume, archive, false, run);
    assertSameInventory(before, await inventoryVolume(config, binding, run));
    await syncFile(archive);
    const archiveSha256 = sha(await archiveBytes(archive));
    const preserved = config.caseId + '-source-preserved';
    await createVolume(config, binding, preserved, run);
    const empty = await inventory(config, binding, preserved, run);
    assert(
        empty.length === 1 && empty[0]?.type === 'directory',
        'resource_target_not_empty',
    );
    await tar(config, binding, preserved, archive, true, run);
    assertSameInventory(
        before,
        await inventory(config, binding, preserved, run),
    );
    const proof: Proof = {
        schema: 1,
        caseId: config.caseId,
        binding,
        archiveSha256,
        entries: before,
    };
    await writeFile(archive + '.proof.json', JSON.stringify(proof) + '\n', {
        flag: 'wx',
        mode: 0o600,
    });
    await syncFile(archive + '.proof.json');
}
const deleteSandboxScript = String.raw`
import {readFile} from 'node:fs/promises';import {resolve,dirname} from 'node:path';import {pathToFileURL} from 'node:url';
try{const [file,module,name]=process.argv.slice(1);const c=JSON.parse(await readFile(file,'utf8'));const {SandboxClient}=await import(pathToFileURL(module).href);const root=dirname(file);const sdk=await SandboxClient.connect({gateway:c.gateway,caCert:await readFile(resolve(root,c.ca)),clientCert:await readFile(resolve(root,c.cert)),clientKey:await readFile(resolve(root,c.key))});await sdk.delete(name,{workspace:c.workspace});await sdk.waitDeleted(name,60,{workspace:c.workspace});process.exit(0);}catch{process.exit(1);}`;
export async function restoreWorkspace(
    config: A7Config,
    binding: Binding,
    archive: string,
    run: Command = execute,
): Promise<void> {
    validateConfig(config);
    validBinding(binding);
    assert.equal(
        archive,
        join(config.root, 'backup', 'workspace.tar'),
        'archive_path_invalid',
    );
    const proof: Proof = JSON.parse(
        await readFile(archive + '.proof.json', 'utf8'),
    );
    assert(
        proof.schema === 1 &&
            proof.caseId === config.caseId &&
            JSON.stringify(proof.binding) === JSON.stringify(binding),
        'archive_proof_invalid',
    );
    assert.equal(
        sha(await archiveBytes(archive)),
        proof.archiveSha256,
        'archive_digest_mismatch',
    );
    assertSameInventory(
        proof.entries,
        await inventoryVolume(config, binding, run),
    );
    assertSameInventory(
        proof.entries,
        await inventory(
            config,
            binding,
            config.caseId + '-source-preserved',
            run,
        ),
    );
    await run(process.execPath, [
        '--input-type=module',
        '-e',
        deleteSandboxScript,
        config.hostConfig,
        config.sdkModule,
        binding.sandbox,
    ]);
    assert.equal(
        (await attachments(binding.volume, run)).length,
        0,
        'resource_attachment_remains',
    );
    await volume(config, binding, binding.volume, run);
    await run('docker', ['volume', 'rm', binding.volume]);
    await absent(binding.volume, run);
    await createVolume(config, binding, binding.volume, run);
    assert(
        (await inventoryVolume(config, binding, run)).length === 1,
        'resource_target_not_empty',
    );
    await tar(config, binding, binding.volume, archive, true, run);
    assertSameInventory(
        proof.entries,
        await inventoryVolume(config, binding, run),
    );
    await run(
        config.cli,
        [
            '--gateway',
            config.gatewayOwner,
            '--gateway-endpoint',
            config.gatewayEndpoint,
            '--workspace',
            config.gatewayWorkspace,
            'sandbox',
            'create',
            '--name',
            binding.sandbox,
            '--from',
            config.caseId + '-runtime',
            '--policy',
            config.policy,
            '--detach',
            '--no-auto-providers',
            '--label',
            'bento.web08=' + config.caseId,
            '--driver-config-json',
            JSON.stringify({
                docker: {
                    mounts: [
                        {
                            type: 'volume',
                            source: binding.volume,
                            target: '/sandbox/project/bento-workspace',
                            read_only: false,
                        },
                    ],
                },
            }),
        ],
        { env: { XDG_CONFIG_HOME: config.cliConfigHome } },
    );
    // Publication of deployment IDs and waitReady remain the trusted runner's next mandatory stage.
}
