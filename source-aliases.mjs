import { readFileSync } from 'node:fs';
import { URL } from 'node:url';

const tsconfig = JSON.parse(
    readFileSync(new URL('./tsconfig.json', import.meta.url), 'utf8'),
);
export const sourceAliases = Object.entries(tsconfig.compilerOptions.paths)
    .filter(
        ([alias, targets]) =>
            alias.endsWith('*') &&
            targets.length === 1 &&
            targets[0].endsWith('*'),
    )
    .map(([alias, [target]]) => [alias.slice(0, -1), target.slice(0, -1)])
    .sort(([a], [b]) => b.length - a.length);
