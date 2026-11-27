import { createHash, timingSafeEqual } from 'node:crypto';
import { RequestError } from './input.ts';

export type AdminDiagnostics = {
    token: string;
    grants: readonly { subject: string; owner: string; workspace: string }[];
};

export const diagnosticKeyPrefix = 'admin-diagnostic:';
export const diagnosticPrompt =
    'Report whether the current workspace can be listed. Do not modify files.';

export function diagnosticAuthorization(
    workspaceToken: string,
    config?: AdminDiagnostics,
) {
    if (
        config &&
        (!/^[!-~]{16,1024}$/.test(config.token) ||
            config.token === workspaceToken ||
            !Array.isArray(config.grants) ||
            !config.grants.every(
                (grant) =>
                    grant &&
                    [grant.subject, grant.owner, grant.workspace].every(
                        (value) =>
                            typeof value === 'string' &&
                            /^[!-~]{1,256}$/.test(value) &&
                            !value.includes(','),
                    ),
            ))
    )
        throw new Error('Invalid admin diagnostic authorization configuration');

    const auth = config
        ? createHash('sha256')
              .update('Bearer ' + config.token)
              .digest()
        : undefined;
    return {
        matches(supplied: string | undefined) {
            return !!(
                supplied &&
                auth &&
                timingSafeEqual(
                    auth,
                    createHash('sha256').update(supplied).digest(),
                )
            );
        },
        authorize(subject: string | string[] | undefined, workspace: string) {
            const grants = config?.grants.filter(
                (grant) =>
                    grant.subject === subject && grant.workspace === workspace,
            );
            if (grants?.length !== 1)
                throw new RequestError(
                    403,
                    'workspace_scope_denied',
                    'Workspace access denied.',
                );
            return grants[0]!.owner;
        },
    };
}
