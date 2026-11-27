import type { SingleHostExecution } from '../openshell/single-host.ts';
import { textSnapshot } from './input.ts';
import { projectBinding, type Store } from './store/index.ts';
import type { Binding, ExecutionHost } from './types.ts';

export async function importProject(
    db: Store,
    host: ExecutionHost,
    execution: SingleHostExecution,
    project: NonNullable<ReturnType<Store['importing']>>,
) {
    const binding = projectBinding(project);
    try {
        const files = textSnapshot(JSON.parse(project.source ?? 'null'));
        const task = db.taskConfig(binding.project);
        const observation = task
            ? await host.provisionTask(binding, files, task.environmentVersion)
            : await host.provision(binding, files);
        if (
            task &&
            (!('environmentVersion' in observation) ||
                observation.environmentVersion !== task.environmentVersion)
        )
            throw new Error('Task environment observation mismatch');
        const imported = textSnapshot(await host.snapshot(binding));
        if (JSON.stringify(imported) !== JSON.stringify(files))
            throw new Error('Imported snapshot differs');
        try {
            execution.bind(binding, observation);
        } catch (error) {
            // An earlier process may have bound the project before committing its business state.
            const existing = execution.inspect(binding.session);
            if (
                existing.state !== 'READY' ||
                existing.generation !== 1 ||
                !observation.installed ||
                !observation.running ||
                observation.sandbox !== binding.sandbox ||
                observation.volume !== binding.volume ||
                Object.entries(binding).some(
                    ([key, value]) => existing[key as keyof Binding] !== value,
                )
            )
                throw error;
        }
        db.importResult(project.id, 'ready');
    } catch {
        db.importResult(project.id, 'failed', 'preparation_failed');
    }
}
