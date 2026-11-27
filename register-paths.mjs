import { registerHooks } from 'node:module';
import { URL } from 'node:url';

const sourceAliases = {
    '@/': './',
    '@worker/': './apps/worker/src/',
    '@orchestrator/': './apps/orchestrator/orchestrator-execution-host/src/',
    '@workspace-web/': './apps/workspace/workspace-web/src/',
    '@workspace-api-fixture/':
        './apps/workspace/workspace-web/tests/acceptance/fixtures/workspace-api/src/',
};

registerHooks({
    resolve(specifier, context, nextResolve) {
        for (const [prefix, directory] of Object.entries(sourceAliases)) {
            if (specifier.startsWith(prefix)) {
                return nextResolve(
                    new URL(
                        directory + specifier.slice(prefix.length),
                        import.meta.url,
                    ).href,
                    context,
                );
            }
        }
        return nextResolve(specifier, context);
    },
});
