/* global AbortSignal, TextDecoder, TextEncoder, confirm, crypto, document, fetch, localStorage, setInterval */
const element = (id) => document.getElementById(id);
const loginForm = element('login-form');
const importForm = element('import-form');
const taskForm = element('task-form');
const promptInput = taskForm.elements.prompt;
const state = {
    account: null,
    version: 0,
    refresh: 0,
    refreshing: false,
    projects: [],
    projectId: null,
    runs: [],
    submitting: false,
};
let diffRequest = 0;
const labels = {
    importing: '导入中',
    ready: '可提交',
    queued: '排队中',
    running: '执行中',
    recovering: '恢复中',
    needs_review: '等待核对',
    succeeded: '成功',
    failed: '失败',
};
const isActive = (run) => !['succeeded', 'failed'].includes(run.status);
const projectPath = (id) => '/api/projects/' + encodeURIComponent(id);
const date = (value) => new Date(value).toLocaleString('zh-CN');

class ApiError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

async function api(path, { method = 'GET', body, key, plain = false } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (key) headers['Idempotency-Key'] = key;
    const response = await fetch(path, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
        const problem = await response.json().catch(() => null);
        throw new ApiError(
            response.status,
            problem?.error?.message ?? '请求失败，请稍后重试。',
        );
    }
    return plain ? response.text() : response.json();
}

function notice(message, error = false) {
    const box = element('notice');
    box.textContent = message;
    box.classList.toggle('error', error);
    box.hidden = !message;
}

function failure(error, login = false) {
    if (!login && error instanceof ApiError && error.status === 401)
        setAccount(null);
    notice(
        error instanceof Error && !(error instanceof TypeError)
            ? error.message
            : '连接中断，请稍后重试。',
        true,
    );
}

function setAccount(account) {
    state.version++;
    state.refreshing = false;
    state.account = account;
    state.projects = [];
    state.projectId = null;
    state.runs = [];
    state.submitting = false;
    importForm.reset();
    taskForm.reset();
    clearDiff();
    notice('');
    element('account').textContent = account ?? '';
    element('login-screen').hidden = !!account;
    element('workspace').hidden = !account;
    element('logout').hidden = !account;
    render();
}

function pendingKey(account, projectId) {
    return 'bento-one:pending:' + JSON.stringify([account, projectId]);
}

function pending(account = state.account, projectId = state.projectId) {
    if (!account || !projectId) return null;
    try {
        return JSON.parse(localStorage.getItem(pendingKey(account, projectId)));
    } catch {
        return null;
    }
}

async function fingerprint(prompt) {
    const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(prompt),
    );
    return Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, '0'),
    ).join('');
}

function clearPending(account, projectId, key) {
    if (pending(account, projectId)?.key === key)
        localStorage.removeItem(pendingKey(account, projectId));
}

function statusBadge(badge, status) {
    badge.textContent = labels[status];
    badge.classList.toggle(
        'warning',
        ['failed', 'needs_review'].includes(status),
    );
    badge.dataset.status = status;
}

function renderTaskForm(project) {
    const retry = pending();
    const busy = state.runs.some(isActive);
    const ready = project.status === 'ready';
    element('submit-task').disabled =
        state.submitting || !ready || (busy && !retry);
    element('submit-task').textContent = state.submitting
        ? '正在提交…'
        : retry
          ? '重试原提交'
          : '提交任务';
    element('forget-pending').hidden = !retry || state.submitting;
    promptInput.readOnly = state.submitting;
    element('task-hint').textContent = retry
        ? '上次提交的结果尚未确认。使用相同的任务描述重试，系统会沿用原提交键。'
        : !ready
          ? '项目就绪后才能提交任务。'
          : busy
            ? '该项目已有未结束的任务。'
            : '任务描述最多 8000 字符。';
}

function render() {
    const project = state.projects.find((item) => item.id === state.projectId);
    const list = element('projects');
    list.replaceChildren(
        ...state.projects.map((item) => {
            const row = document.createElement('li');
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'secondary';
            button.textContent = item.name + ' · ' + labels[item.status];
            button.setAttribute(
                'aria-current',
                String(item.id === state.projectId),
            );
            button.addEventListener('click', () => {
                if (state.projectId === item.id) return;
                selectProject(item.id);
                render();
                void refresh();
            });
            row.append(button);
            return row;
        }),
    );
    element('empty-project').hidden = !!project;
    element('project-detail').hidden = !project;
    if (!project) return;
    element('project-name').textContent = project.name;
    statusBadge(element('project-status'), project.status);
    renderTaskForm(project);

    element('runs').replaceChildren(
        ...state.runs.map((run) => {
            const card = document.createElement('li');
            card.className = 'run-card';
            const row = document.createElement('div');
            row.className = 'row';
            const label = document.createElement('span');
            label.className = 'badge';
            statusBadge(label, run.status);
            row.append(label);
            if (run.status === 'succeeded') {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'secondary';
                button.textContent = '查看 diff';
                button.addEventListener('click', () => void showDiff(run));
                row.append(button);
            }
            const time = document.createElement('p');
            time.className = 'run-meta';
            time.textContent = date(run.createdAt) + ' · ' + run.id;
            card.append(row, time);
            if (run.summary || run.status === 'needs_review') {
                const summary = document.createElement('p');
                summary.className = 'run-meta';
                summary.textContent =
                    run.status === 'needs_review'
                        ? '任务已暂停，等待可信侧核对。'
                        : run.summary;
                card.append(summary);
            }
            return card;
        }),
    );
    if (!state.runs.length) {
        const empty = document.createElement('li');
        empty.className = 'empty';
        empty.textContent = '还没有任务。';
        element('runs').append(empty);
    }
}

function selectProject(id) {
    state.projectId = id;
    state.runs = [];
    taskForm.reset();
    clearDiff();
}

async function refresh(manual = false) {
    if (!state.account) return;
    const version = state.version;
    const ticket = ++state.refresh;
    state.refreshing = true;
    const current = () => version === state.version && ticket === state.refresh;
    try {
        const { projects } = await api('/api/projects');
        if (!current()) return;
        projects.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        const id = projects.some((project) => project.id === state.projectId)
            ? state.projectId
            : (projects[0]?.id ?? null);
        const { runs } = id
            ? await api(projectPath(id) + '/runs')
            : { runs: [] };
        if (!current()) return;
        runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        const changed =
            id !== state.projectId ||
            JSON.stringify(projects) !== JSON.stringify(state.projects) ||
            JSON.stringify(runs) !== JSON.stringify(state.runs);
        if (id !== state.projectId) selectProject(id);
        state.projects = projects;
        state.runs = runs;
        if (changed) render();
        if (manual) notice('已刷新。');
    } catch (error) {
        if (current()) failure(error);
    } finally {
        if (current()) state.refreshing = false;
    }
}

function clearDiff() {
    diffRequest++;
    element('diff-panel').hidden = true;
    element('diff-status').textContent = '';
    element('diff-text').textContent = '';
    element('diff-text').hidden = true;
    element('download').removeAttribute('href');
    element('download').hidden = true;
}

async function showDiff(run) {
    clearDiff();
    const ticket = diffRequest;
    const path =
        projectPath(run.projectId) +
        '/runs/' +
        encodeURIComponent(run.id) +
        '/diff';
    element('diff-panel').hidden = false;
    element('diff-status').textContent = '正在读取成果…';
    try {
        const diff = await api(path, { plain: true });
        if (ticket !== diffRequest) return;
        element('diff-status').textContent = diff.length
            ? ''
            : '任务已完成，文件没有变化（空 diff）。';
        element('diff-text').textContent = diff;
        element('diff-text').hidden = !diff.length;
        element('download').href = path + '?download=1';
        element('download').hidden = false;
    } catch (error) {
        if (ticket !== diffRequest) return;
        if (error instanceof ApiError && error.status === 401) failure(error);
        else
            element('diff-status').textContent =
                '暂时无法读取成果。请刷新后重试。';
    }
}

loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.submitter;
    button.disabled = true;
    try {
        const { account } = await api('/api/login', {
            method: 'POST',
            body: {
                account: loginForm.elements.account.value,
                invite: loginForm.elements.invite.value,
            },
        });
        loginForm.reset();
        setAccount(account);
        await refresh();
    } catch (error) {
        failure(error, true);
    } finally {
        button.disabled = false;
    }
});

element('logout').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
        await api('/api/logout', { method: 'POST' });
        setAccount(null);
    } catch (error) {
        failure(error);
    } finally {
        button.disabled = false;
    }
});

importForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const version = state.version;
    const button = event.submitter;
    button.disabled = true;
    try {
        const direct = Array.from(importForm.elements.files.files);
        const folder = Array.from(importForm.elements.folder.files);
        if (direct.length && folder.length)
            throw new Error('请选择多个文件或一个文件夹。');
        const selected = folder.length ? folder : direct;
        if (!selected.length) throw new Error('请选择要导入的文本文件。');
        if (
            selected.length > 100 ||
            selected.reduce((sum, file) => sum + file.size, 0) > 1024 * 1024
        ) {
            throw new Error('项目最多包含 100 个文件及 1 MiB 文本。');
        }
        const files = await Promise.all(
            selected.map(async (file) => {
                const path =
                    file.webkitRelativePath.split('/').slice(1).join('/') ||
                    file.name;
                const buffer = await file.arrayBuffer();
                try {
                    return {
                        path,
                        text: new TextDecoder('utf-8', {
                            fatal: true,
                            ignoreBOM: true,
                        }).decode(buffer),
                    };
                } catch {
                    throw new Error('文件不是有效的 UTF-8 文本：' + path);
                }
            }),
        );
        if (version !== state.version) return;
        const project = await api('/api/projects', {
            method: 'POST',
            body: { name: importForm.elements.name.value, files },
        });
        if (version !== state.version) return;
        state.projects.unshift(project);
        selectProject(project.id);
        render();
        importForm.reset();
        element('import-panel').open = false;
        notice('已提交项目导入。');
        await refresh();
    } catch (error) {
        if (version === state.version) failure(error);
    } finally {
        button.disabled = false;
    }
});

taskForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const { account, projectId, version } = state;
    const project = state.projects.find((item) => item.id === projectId);
    if (!account || !project || state.submitting || project.status !== 'ready')
        return;
    const prompt = promptInput.value.trim();
    if (!prompt || Array.from(prompt).length > 8000)
        return notice('任务描述须为 1 至 8000 个字符。', true);
    state.submitting = true;
    renderTaskForm(project);
    let key;
    try {
        const hash = await fingerprint(prompt);
        if (version !== state.version) return;
        const prior = pending(account, projectId);
        if (prior && prior.hash !== hash)
            throw new Error('请填写原任务描述，再重试这次提交。');
        const nextKey = prior?.key ?? crypto.randomUUID();
        try {
            localStorage.setItem(
                pendingKey(account, projectId),
                JSON.stringify({ key: nextKey, hash }),
            );
        } catch {
            throw new Error('请允许本站保存提交键后再提交。');
        }
        key = nextKey;
        await api(projectPath(projectId) + '/runs', {
            method: 'POST',
            body: { prompt },
            key,
        });
        clearPending(account, projectId, key);
        if (version !== state.version) return;
        if (state.projectId === projectId) taskForm.reset();
        notice('任务已提交，可稍后回来查看。');
        await refresh();
    } catch (error) {
        if (
            key &&
            error instanceof ApiError &&
            [400, 404, 409, 413, 429].includes(error.status)
        ) {
            clearPending(account, projectId, key);
        }
        if (version === state.version) {
            if (key && !(error instanceof ApiError && error.status < 500)) {
                notice('暂未确认任务是否提交成功。请使用原描述重试。', true);
            } else {
                failure(error);
            }
        }
    } finally {
        if (version === state.version) {
            state.submitting = false;
            const selected = state.projects.find(
                (item) => item.id === state.projectId,
            );
            if (selected) renderTaskForm(selected);
        }
    }
});

element('forget-pending').addEventListener('click', () => {
    const { account, projectId } = state;
    const prior = pending();
    if (
        !prior ||
        !confirm('请先核对运行记录。清除后，再提交会创建新的提交键。是否继续？')
    )
        return;
    clearPending(account, projectId, prior.key);
    render();
    notice('已清除待重试记录。');
});
element('refresh').addEventListener('click', () => void refresh(true));
document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !state.refreshing) void refresh();
});
setInterval(() => {
    if (!document.hidden && !state.refreshing) void refresh();
}, 2500);

async function start() {
    const mock = document.documentElement.dataset.mode === 'mock';
    element('mode').textContent = mock ? '本地模拟' : '连接任务服务';
    element('demo-hint').hidden = !mock;
    try {
        const { account } = await api('/api/session');
        setAccount(account);
        await refresh();
    } catch (error) {
        setAccount(null);
        if (!(error instanceof ApiError && error.status === 401))
            failure(error);
    }
}
void start();
