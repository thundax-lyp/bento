import { fileURLToPath } from 'node:url';
import { Context } from '@temporalio/activity';
import {
    Client,
    Connection,
    WorkflowExecutionAlreadyStartedError,
} from '@temporalio/client';
import { NativeConnection, Worker } from '@temporalio/worker';

export type TemporalRunOptions = {
    address: string;
    namespace?: string;
    taskQueue: string;
};

export async function temporalRuns(
    { address, namespace = 'default', taskQueue }: TemporalRunOptions,
    slots: 1 | 2,
    advance: (runId: string) => Promise<void>,
) {
    if (!address || !/^[a-zA-Z0-9_-]{1,128}$/.test(taskQueue))
        throw new Error('Invalid Temporal Run configuration');
    const connection = await Connection.connect({
        address,
        connectTimeout: 5000,
    });
    let native: NativeConnection | undefined;
    try {
        native = await NativeConnection.connect({ address });
        const client = new Client({ connection, namespace });
        const worker = await Worker.create({
            connection: native,
            namespace,
            taskQueue,
            workflowsPath: fileURLToPath(
                new URL('./run-workflow.ts', import.meta.url),
            ),
            maxConcurrentActivityTaskExecutions: slots,
            activities: {
                async advanceRun(runId: string) {
                    const context = Context.current();
                    context.heartbeat();
                    const timer = setInterval(() => context.heartbeat(), 2000);
                    try {
                        await advance(runId);
                    } finally {
                        clearInterval(timer);
                    }
                },
            },
        });
        const running = worker.run().catch(() => {
            process.stderr.write(
                'Bento Temporal worker stopped unexpectedly. Restart the execution service to resume polling.\n',
            );
        });
        return {
            async enqueue(runId: string) {
                try {
                    await connection.withDeadline(Date.now() + 5000, () =>
                        client.workflow.start('bentoRun', {
                            workflowId: 'bento-run-' + runId,
                            workflowIdReusePolicy: 'REJECT_DUPLICATE',
                            taskQueue,
                            args: [runId],
                        }),
                    );
                } catch (error) {
                    if (
                        !(error instanceof WorkflowExecutionAlreadyStartedError)
                    )
                        throw error;
                }
            },
            async close() {
                if (worker.getState() === 'RUNNING') worker.shutdown();
                await running;
                await native?.close();
                await connection.close();
            },
        };
    } catch (error) {
        await native?.close();
        await connection.close();
        throw error;
    }
}
