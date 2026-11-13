import { registerHooks } from 'node:module';
import { URL } from 'node:url';

registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier.startsWith('@/')) {
            return nextResolve(
                new URL('./' + specifier.slice(2), import.meta.url).href,
                context,
            );
        }
        return nextResolve(specifier, context);
    },
});
