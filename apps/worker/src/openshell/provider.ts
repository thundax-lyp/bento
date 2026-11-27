import {
    apply,
    OpenShellFileSystem,
    OpenShellSandboxProvider,
    OpenShellSubprocessRuntime,
    OpenShellWorkingDirectory,
    OpenShellWorkspace,
} from 'dsh-sandbox-openshell';

export type OpenShellProviderConfig = Parameters<typeof apply>[1];

// rc.1 inherits WorkingDirectoryService.inject but also reads openShellWorkspace.
class BoundWorkingDirectory extends OpenShellWorkingDirectory {
    static inject = [...OpenShellWorkingDirectory.inject, 'openShellWorkspace'];
}

export async function installOpenShellProvider(
    ctx: Parameters<typeof apply>[0],
    config: OpenShellProviderConfig,
) {
    await ctx.plugin(OpenShellSubprocessRuntime, config);
    await ctx.plugin(OpenShellWorkspace);
    await ctx.plugin(OpenShellFileSystem);
    await ctx.plugin(OpenShellSandboxProvider);
    ctx.inject(['sessionProjections', 'systemPrompt'], async (scope) => {
        if (scope.get('workingDirectory'))
            throw new Error(
                'install OpenShell before the working-directory provider',
            );
        await scope.plugin(BoundWorkingDirectory, {
            defaultDirectory: ctx.openShellWorkspace.root,
        });
    });
}
