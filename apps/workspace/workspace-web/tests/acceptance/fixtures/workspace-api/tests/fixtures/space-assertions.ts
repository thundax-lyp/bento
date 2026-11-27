import { RequestError } from '@/apps/workspace/workspace-web/tests/acceptance/fixtures/workspace-api/src/protocol.ts';

export const noBody = () =>
    Promise.reject(new Error('Unexpected request body'));
export const errorIs =
    (status: number, code: string, message: string) => (error: unknown) =>
        error instanceof RequestError &&
        error.status === status &&
        error.code === code &&
        error.message === message;
export const notFound = errorIs(404, 'not_found', '找不到该资源。');
