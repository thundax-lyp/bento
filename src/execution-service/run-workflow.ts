import { proxyActivities } from '@temporalio/workflow';

const { advanceRun } = proxyActivities<{
    advanceRun(runId: string): Promise<void>;
}>({
    startToCloseTimeout: '3 hours',
    heartbeatTimeout: '10 seconds',
    retry: { maximumInterval: '10 seconds' },
});

export async function bentoRun(runId: string) {
    await advanceRun(runId);
}
