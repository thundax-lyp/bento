import { randomUUID } from 'node:crypto';
import { conflict, notFound } from './protocol.ts';
import type { Backend, Project, Run } from './protocol.ts';

type MockProject = {
    ownerId: string;
    project: Project;
    sessionId: string;
    files: Map<string, string>;
    runs: Map<string, MockRun>;
    submissions: Map<string, MockRun>;
};

type MockRun = { run: Run; prompt: string; diff: string };
type Job = { project: MockProject; item: MockRun };

const now = () => new Date().toISOString();

function patch(files: Map<string, string>): string {
    const entry = files.entries().next().value;
    const path = entry?.[0] ?? 'bento-result.txt';
    const original = entry?.[1] ?? '';
    const addition = 'Bento 模拟任务已完成。';
    const newline = original && !original.endsWith('\n') ? '\n' : '';
    files.set(path, original + newline + addition + '\n');

    const lines = original ? original.replace(/\n$/, '').split('\n') : [];
    const context = lines.slice(-3);
    const start = lines.length - context.length + 1;
    const oldPath = entry ? JSON.stringify('a/' + path) : '/dev/null';
    const newPath = JSON.stringify('b/' + path);
    const header = '--- ' + oldPath + '\n+++ ' + newPath + '\n';
    const range =
        '@@ -' +
        (lines.length ? start : 0) +
        ',' +
        context.length +
        ' +' +
        start +
        ',' +
        (context.length + 1) +
        ' @@\n';

    if (newline) {
        const last = context.pop();
        return (
            header +
            range +
            context.map((line) => ' ' + line + '\n').join('') +
            '-' +
            last +
            '\n\\ No newline at end of file\n+' +
            last +
            '\n+' +
            addition +
            '\n'
        );
    }
    return (
        header +
        range +
        context.map((line) => ' ' + line + '\n').join('') +
        '+' +
        addition +
        '\n'
    );
}

export function mockBackend(): Backend {
    const projects = new Map<string, MockProject>();
    const queue: Job[] = [];
    let busy = false;

    function advance() {
        if (busy) return;
        const job = queue.shift();
        if (!job) return;
        busy = true;
        const { project, item } = job;
        const { run, prompt } = item;

        setTimeout(() => {
            run.status = 'running';
            run.updatedAt = now();
        }, 400).unref();
        if (prompt === 'mock:review') {
            setTimeout(() => {
                run.status = 'recovering';
                run.updatedAt = now();
            }, 1100).unref();
        }
        setTimeout(() => {
            if (prompt === 'mock:review') {
                run.status = 'needs_review';
                run.summary = '模拟执行已暂停，等待可信侧核对。';
            } else if (prompt === 'mock:failed') {
                run.status = 'failed';
                run.summary = '模拟任务失败。';
            } else {
                item.diff = prompt === 'mock:empty' ? '' : patch(project.files);
                run.status = 'succeeded';
                run.summary = item.diff
                    ? '模拟 diff 已生成。'
                    : '模拟任务完成，文件没有变化。';
            }
            run.updatedAt = now();
            busy = false;
            advance();
        }, 2100).unref();
    }

    return async (ownerId, operation) => {
        if (operation.kind === 'listProjects') {
            const visible = [...projects.values()]
                .filter((item) => item.ownerId === ownerId)
                .map((item) => item.project);
            return { status: 200, json: { projects: visible } };
        }
        if (operation.kind === 'createProject') {
            const { name, files } = operation.input;
            const project: Project = {
                id: randomUUID(),
                name,
                status: 'importing',
                createdAt: now(),
            };
            projects.set(project.id, {
                ownerId,
                project,
                sessionId: randomUUID(),
                files: new Map(files.map(({ path, text }) => [path, text])),
                runs: new Map(),
                submissions: new Map(),
            });
            setTimeout(() => {
                project.status = 'ready';
            }, 400).unref();
            return { status: 201, json: project };
        }

        const project = projects.get(operation.projectId);
        if (!project || project.ownerId !== ownerId) throw notFound();
        if (operation.kind === 'project')
            return { status: 200, json: project.project };
        if (operation.kind === 'listRuns') {
            return {
                status: 200,
                json: {
                    runs: [...project.runs.values()].map((item) => item.run),
                },
            };
        }
        if (operation.kind === 'createRun') {
            const { key, prompt } = operation;
            const prior = project.submissions.get(key);
            if (prior) {
                if (prior.prompt !== prompt)
                    throw conflict('此提交键已用于其他任务内容。');
                return { status: 200, json: prior.run };
            }
            if (project.project.status !== 'ready')
                throw conflict('请等项目导入完成。');
            if (
                [...project.runs.values()].some(
                    ({ run }) => !['succeeded', 'failed'].includes(run.status),
                )
            ) {
                throw conflict('该项目已有尚未结束的任务。');
            }
            const createdAt = now();
            const run: Run = {
                id: randomUUID(),
                projectId: project.project.id,
                sessionId: project.sessionId,
                status: 'queued',
                createdAt,
                updatedAt: createdAt,
            };
            const item = { run, prompt, diff: '' };
            project.runs.set(run.id, item);
            project.submissions.set(key, item);
            queue.push({ project, item });
            advance();
            return { status: 202, json: run };
        }

        if (!('runId' in operation)) throw notFound();
        const item = project.runs.get(operation.runId);
        if (!item) throw notFound();
        if (operation.kind === 'run') return { status: 200, json: item.run };
        if (item.run.status !== 'succeeded') throw conflict('成果尚未可用。');
        return { status: 200, diff: item.diff };
    };
}
