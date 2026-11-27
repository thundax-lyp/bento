import { registerHooks } from 'node:module';
import { URL } from 'node:url';
import { sourceAliases } from './source-aliases.mjs';

registerHooks({
    resolve(specifier, context, nextResolve) {
        for (const [prefix, directory] of sourceAliases) {
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
