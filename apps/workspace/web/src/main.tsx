import { createRoot } from 'react-dom/client';
import {
    QueryCache,
    QueryClient,
    QueryClientProvider,
} from '@tanstack/react-query';
import {
    createBrowserRouter,
    isRouteErrorResponse,
    Link,
    redirect,
    redirectDocument,
    RouterProvider,
    useRouteError,
} from 'react-router';
import { ApiError, projectsQuery, runQuery, sessionQuery } from './api';
import {
    AccountSettings,
    Dashboard,
    Login,
    Register,
    RunDetails,
    TaskList,
    Workspace,
    Workbench,
} from './pages';
import { CloudProjectRoute } from './space';
import './style.css';

const externalAuth = import.meta.env.VITE_BENTO_KEYCLOAK_AUTH === '1';

const client = new QueryClient({
    defaultOptions: {
        queries: {
            staleTime: 10_000,
            retry: (count, error) =>
                count < 1 && !(error instanceof ApiError && error.status < 500),
        },
    },
    queryCache: new QueryCache({
        onError(error, query) {
            if (
                query.queryKey[0] !== 'session' &&
                error instanceof ApiError &&
                error.status === 401
            ) {
                void client.invalidateQueries({
                    queryKey: sessionQuery.queryKey,
                });
            }
        },
    }),
});

async function requireSession(request: Request) {
    try {
        return await client.fetchQuery(sessionQuery);
    } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
            if (externalAuth) throw redirectDocument('/auth');
            const url = new URL(request.url);
            throw redirect(
                '/login?' +
                    new URLSearchParams({ next: url.pathname + url.search }),
            );
        }
        throw error;
    }
}

function RouteError() {
    const error = useRouteError();
    const message =
        (isRouteErrorResponse(error) && error.status === 404) ||
        (error instanceof ApiError && error.status === 404)
            ? '找不到这个页面或任务。'
            : '暂时无法加载页面，请稍后重试。';
    return (
        <main className="mx-auto max-w-xl space-y-4 px-6 py-20">
            <h1 className="text-2xl font-semibold">{message}</h1>
            <Link className="underline" to="/">
                返回工作台
            </Link>
        </main>
    );
}

const router = createBrowserRouter([
    {
        path: '/login',
        Component: Login,
        ...(externalAuth ? { loader: () => redirectDocument('/auth') } : {}),
    },
    {
        path: '/register',
        Component: Register,
        ...(externalAuth ? { loader: () => redirectDocument('/auth') } : {}),
    },
    {
        loader: ({ request }) => requireSession(request),
        Component: Workbench,
        ErrorBoundary: RouteError,
        HydrateFallback: () => <p className="p-6">正在打开 Bento…</p>,
        children: [
            {
                index: true,
                async loader({ request }) {
                    const session = await requireSession(request);
                    await client.ensureQueryData(
                        projectsQuery(session.account),
                    );
                    return null;
                },
                Component: Dashboard,
            },
            { path: '/workspaces', Component: Workspace },
            { path: '/workspaces/:workspaceId', Component: Workspace },
            { path: '/space/:spaceId', Component: CloudProjectRoute },
            { path: '/runs', Component: TaskList },
            { path: '/account', Component: AccountSettings },
            {
                path: '/runs/:runId',
                async loader({ params, request }) {
                    const session = await requireSession(request);
                    const project = new URL(request.url).searchParams.get(
                        'project',
                    );
                    if (!project || !params.runId)
                        throw new Response(null, { status: 404 });
                    await client.ensureQueryData(
                        runQuery(session.account, project, params.runId),
                    );
                    return { project, run: params.runId };
                },
                Component: RunDetails,
                ErrorBoundary: RouteError,
            },
        ],
    },
]);

const root = document.getElementById('root');
if (!root) throw new Error('Bento application root is missing');
createRoot(root).render(
    <QueryClientProvider client={client}>
        <RouterProvider router={router} />
    </QueryClientProvider>,
);
