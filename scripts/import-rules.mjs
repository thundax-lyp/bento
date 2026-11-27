import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { URL, fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const tsconfig = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8'));
const aliases = Object.entries(tsconfig.compilerOptions.paths)
    .filter(
        ([alias, targets]) =>
            alias.endsWith('*') &&
            targets.length === 1 &&
            targets[0].endsWith('*'),
    )
    .map(([alias, [target]]) => [alias.slice(0, -1), target.slice(0, -1)])
    .sort(([a], [b]) => b.length - a.length);

function discoverPackages(directory) {
    const manifest = join(directory, 'package.json');
    if (existsSync(manifest)) {
        return [{ directory, ...JSON.parse(readFileSync(manifest, 'utf8')) }];
    }
    if (existsSync(join(directory, 'go.mod'))) return [{ directory }];
    return readdirSync(directory, { withFileTypes: true })
        .filter(
            (entry) =>
                entry.isDirectory() &&
                !entry.name.startsWith('.') &&
                !['node_modules', 'src', 'tests', 'dist'].includes(entry.name),
        )
        .flatMap((entry) => discoverPackages(join(directory, entry.name)));
}

const packages = discoverPackages(join(root, 'apps'));
const localExtension = /\.(?:[cm]?[jt]sx?|json|css|svg|png|webp|woff2?)$/;
const relativeImport = /^\.\.?\//;

function inside(directory, file) {
    const subpath = relative(directory, file);
    return (
        subpath !== '..' &&
        !subpath.startsWith('..' + sep) &&
        !isAbsolute(subpath)
    );
}

function identify(filename, specifier) {
    const alias = aliases.find(([prefix]) => specifier.startsWith(prefix));
    if (alias) {
        return {
            file: resolve(root, alias[1] + specifier.slice(alias[0].length)),
            sourcePath: true,
        };
    }
    if (relativeImport.test(specifier) || isAbsolute(specifier)) {
        const file = resolve(dirname(filename), specifier);
        return { file, sourcePath: inside(root, file) };
    }
    const workspace = packages.find(
        (pkg) =>
            pkg.name &&
            (specifier === pkg.name || specifier.startsWith(pkg.name + '/')),
    );
    if (!workspace) return {};
    const subpath = specifier.slice(workspace.name.length + 1);
    const key = subpath ? './' + subpath : '.';
    return {
        workspace,
        subpath,
        publicEntry: Boolean(workspace.exports?.[key]),
    };
}

function visitImports(check) {
    function inspect(node) {
        if (typeof node?.value === 'string') check(node, node.value);
    }
    return {
        ImportDeclaration: (node) => inspect(node.source),
        ExportNamedDeclaration: (node) => inspect(node.source),
        ExportAllDeclaration: (node) => inspect(node.source),
        ImportExpression: (node) => inspect(node.source),
        TSImportType: (node) => inspect(node.source),
    };
}

const publicWorkspaceImports = {
    meta: {
        schema: [],
        messages: {
            usePublicEntry:
                'Cross-package source imports must use an exported entry of {{packageName}}.',
        },
    },
    create(context) {
        const file = context.physicalFilename;
        const owner = packages.find((pkg) =>
            file.startsWith(join(pkg.directory, 'src') + sep),
        );
        if (
            !owner ||
            /(?:^|[/\\])(?:tests|__tests__)[/\\]|\.(?:test|spec)\.[^.]+$/.test(
                relative(owner.directory, file),
            )
        ) {
            return {};
        }
        return visitImports((node, specifier) => {
            const target = identify(file, specifier);
            const destination =
                target.workspace ??
                (target.file &&
                    packages.find((pkg) => inside(pkg.directory, target.file)));
            if (!destination || destination === owner || target.publicEntry)
                return;
            context.report({
                node,
                messageId: 'usePublicEntry',
                data: {
                    packageName:
                        destination.name ??
                        relative(root, destination.directory),
                },
            });
        });
    },
};

const repositoryImportPaths = {
    meta: {
        schema: [],
        messages: {
            extension: 'Use an explicit file extension for repository imports.',
            sourceAlias:
                'Use a configured @ alias or a package export instead of spelling a src/ path.',
            parentAlias:
                'Use a configured @ alias for imports that cross two or more parent directories.',
        },
    },
    create(context) {
        return visitImports((node, specifier) => {
            const target = identify(context.physicalFilename, specifier);
            if (!target.sourcePath && !target.subpath) return;
            if (!localExtension.test(specifier)) {
                context.report({ node, messageId: 'extension' });
            }
            if (target.sourcePath && /(?:^|\/)src\//.test(specifier)) {
                context.report({ node, messageId: 'sourceAlias' });
            } else if (
                target.sourcePath &&
                /\.(?:[cm]?ts|tsx)$/.test(context.physicalFilename) &&
                /^\.\.\/\.\.(?:\/|$)/.test(specifier)
            ) {
                context.report({ node, messageId: 'parentAlias' });
            }
        });
    },
};

export default {
    rules: {
        'public-workspace-imports': publicWorkspaceImports,
        'repository-import-paths': repositoryImportPaths,
    },
};
