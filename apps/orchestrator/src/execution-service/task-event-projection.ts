import { publicTaskEventBatch } from '@/apps/worker/protocol.ts';
import type { Store } from './store/index.ts';
import type { WorkerRequest } from './types.ts';

export function taskEventProjection(
    db: Store,
    canExecute: (grant: WorkerRequest['grant']) => boolean,
) {
    const taskProjectionEnds = new Set<string>();
    const projectionKey = (grant: WorkerRequest['grant']) =>
        grant.run + ':' + grant.generation;
    function acceptTaskEvents(grant: WorkerRequest['grant'], body: unknown) {
        const run = db.findRun(grant.run);
        if (
            !canExecute(grant) ||
            run.sessionId !== grant.session ||
            run.admittedGeneration !== grant.generation ||
            run.taskSequence === null
        )
            throw new Error('Task event grant mismatch');
        const events = publicTaskEventBatch(body).map((event) =>
            event.kind === 'check'
                ? {
                      offset: event.offset,
                      kind: event.kind,
                      text: event.name,
                      check: {
                          name: event.name,
                          status: event.status,
                          output: event.output,
                      },
                  }
                : { ...event, check: null },
        );
        db.appendTaskEvents(run.projectId, run.id, grant.generation, events);
        if (events.length === 0) taskProjectionEnds.add(projectionKey(grant));
    }
    return {
        acceptTaskEvents,
        ended: (grant: WorkerRequest['grant']) =>
            taskProjectionEnds.has(projectionKey(grant)),
        forget: (grant: WorkerRequest['grant']) =>
            taskProjectionEnds.delete(projectionKey(grant)),
    };
}
