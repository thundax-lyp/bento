import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SingleHostExecution } from '@/apps/orchestrator/src/openshell/single-host.ts';
import type { Binding, Grant } from '@/apps/worker/protocol.ts';
import { snapshot } from './state.ts';

export type Actor = 'A' | 'B';
export type BindingFixture = Awaited<ReturnType<typeof createBindingFixture>>;
export async function createBindingFixture() {
    const folder = await mkdtemp(join(tmpdir(), 'bento-a102-'));
    const paths = {
        authority: join(folder, 'authority.sqlite'),
        history: join(folder, 'history.sqlite'),
    };
    const bindings = Object.fromEntries(
        ['A', 'B', 'C'].map((actor) => [
            actor,
            {
                tenant: 'a102-' + actor + '-' + randomUUID(),
                project: randomUUID(),
                session: randomUUID(),
                sandbox: 'a102-' + actor + '-' + randomUUID(),
                volume: randomUUID(),
            },
        ]),
    ) as Record<Actor | 'C', Binding>;
    const volumes = Object.fromEntries(
        Object.entries(bindings).map(([actor, binding]) => [
            actor,
            join(folder, binding.volume),
        ]),
    ) as Record<Actor | 'C', string>;
    const grants = new Map<Actor, Grant>();
    const removeCalls: Binding[] = [];
    let controller: SingleHostExecution | undefined;
    let ingress: Server | undefined;
    let url = '';
    let disposed = false;
    const sandbox = {
        async stop() {
            throw new Error('A1-02 does not stop sandboxes');
        },
        async stopped() {
            throw new Error('A1-02 does not observe stops');
        },
        async start() {
            throw new Error('A1-02 does not start sandboxes');
        },
        async running() {
            throw new Error('A1-02 does not observe starts');
        },
    };
    async function closeNetwork() {
        if (!ingress) return;
        const current = ingress;
        ingress = undefined;
        await new Promise<void>((resolve, reject) => {
            current.close((error) => (error ? reject(error) : resolve()));
            current.closeAllConnections();
        });
    }
    async function open() {
        controller = new SingleHostExecution(paths, sandbox);
        ingress = controller.persistenceIngress();
        ingress.listen(0, '127.0.0.1');
        await once(ingress, 'listening');
        const address = ingress.address();
        assert(address && typeof address === 'object');
        url = `http://127.0.0.1:${address.port}`;
    }
    async function dispose() {
        if (disposed) return;
        const failures: unknown[] = [];
        try {
            await closeNetwork();
        } catch (error) {
            failures.push(error);
        }
        try {
            controller?.close();
            controller = undefined;
        } catch (error) {
            failures.push(error);
        }
        if (failures.length)
            throw new AggregateError(
                failures,
                'A1-02 cleanup failed; retained private fixture',
            );
        await rm(folder, { recursive: true, force: true });
        disposed = true;
    }
    try {
        for (const actor of ['A', 'B', 'C'] as const) {
            await mkdir(volumes[actor], { mode: 0o700 });
            await writeFile(
                join(volumes[actor], 'canary.txt'),
                'a102-private-' + actor + '-' + randomUUID(),
                { mode: 0o600 },
            );
        }
        await open();
        for (const binding of Object.values(bindings))
            controller!.bind(binding, {
                ...binding,
                running: true,
                installed: true,
            });
        return {
            folder,
            paths,
            bindings,
            volumes,
            removeCalls,
            get controller() {
                assert(controller);
                return controller;
            },
            snapshot: () => snapshot(paths, Object.values(volumes)),
            admit() {
                assert.equal(grants.size, 0);
                for (const actor of ['A', 'B'] as const)
                    grants.set(
                        actor,
                        controller!.admit(
                            bindings[actor].session,
                            1,
                            randomUUID(),
                            300_000,
                        ),
                    );
            },
            grant(actor: Actor) {
                const grant = grants.get(actor);
                assert(grant);
                return grant;
            },
            async rpc(actor: Actor, body: unknown) {
                const grant = grants.get(actor);
                assert(grant);
                const response = await fetch(new URL('/rpc', url), {
                    method: 'POST',
                    headers: {
                        authorization: 'Bearer ' + grant.token,
                        'content-type': 'application/json',
                    },
                    body: JSON.stringify(body),
                    signal: AbortSignal.timeout(5000),
                });
                return {
                    status: response.status,
                    body: (await response.json()) as unknown,
                };
            },
            async remove(binding: Binding) {
                const actor = (['A', 'B', 'C'] as const).find(
                    (actor) =>
                        JSON.stringify(bindings[actor]) ===
                        JSON.stringify(binding),
                );
                assert(
                    actor,
                    'Only registered complete fixture bindings can remove resources',
                );
                removeCalls.push({ ...binding });
                await rm(volumes[actor], { recursive: true });
            },
            async reopen() {
                await closeNetwork();
                controller!.close();
                controller = undefined;
                await open();
            },
            dispose,
        };
    } catch (error) {
        try {
            await dispose();
        } catch (cleanup) {
            throw new AggregateError(
                [error, cleanup],
                'A1-02 setup and cleanup failed',
            );
        }
        throw error;
    }
}
