import {
    LlmAdapter,
    type GenerateOptions,
    type StreamChunk,
} from '@deepseek-ai/dsh-llm';
import { appendFileSync, existsSync, unlinkSync } from 'node:fs';
import { request as httpRequest, type ClientRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { ModelAdapterFactory } from '@/apps/worker/base-bootstrap.ts';

function trace(value: object) {
    const path = process.env.BENTO_REUSE_TRACE;
    if (!path) throw new Error('Private acceptance trace required');
    appendFileSync(
        path,
        JSON.stringify({ pid: process.pid, ...value }) + '\n',
        { mode: 0o600 },
    );
}

const factory: ModelAdapterFactory = async (metadata) => {
    if (Object.keys(metadata).sort().join(',') !== 'model,provider')
        throw new Error('Model factory received extra identity');
    const url = new URL(process.env.BENTO_REUSE_MODEL_URL ?? '');
    if (
        url.protocol !== 'http:' ||
        url.hostname !== '127.0.0.1' ||
        !url.port ||
        url.pathname !== '/' ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
    )
        throw new Error('Model fixture requires a private loopback endpoint');
    const id = randomUUID();
    const cancellation = new AbortController();
    const active = new Map<ClientRequest, Promise<void>>();
    let disposed = false;
    trace({ kind: 'model-created', id });
    class Adapter extends LlmAdapter {
        async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
            if (disposed) throw new Error('Disposed model adapter');
            const signal = options.signal
                ? AbortSignal.any([options.signal, cancellation.signal])
                : cancellation.signal;
            signal.throwIfAborted();
            const text = await new Promise<string>((resolve, reject) => {
                const req = httpRequest(
                    url,
                    {
                        method: 'POST',
                        agent: false,
                        signal,
                        headers: { 'content-type': 'application/json' },
                    },
                    (response) => {
                        const chunks: Buffer[] = [];
                        let size = 0;
                        response.on('data', (chunk: Buffer) => {
                            size += chunk.length;
                            if (size > 65536)
                                req.destroy(
                                    new Error(
                                        'Model fixture response too large',
                                    ),
                                );
                            else chunks.push(chunk);
                        });
                        response.on('error', reject);
                        response.on('end', () => {
                            if (response.statusCode !== 200)
                                return reject(
                                    new Error('Model fixture rejected request'),
                                );
                            try {
                                const result = JSON.parse(
                                    Buffer.concat(chunks).toString(),
                                ) as { text?: unknown };
                                if (typeof result.text !== 'string')
                                    throw new Error('Invalid model response');
                                resolve(result.text);
                            } catch {
                                reject(
                                    new Error('Invalid model fixture response'),
                                );
                            }
                        });
                    },
                );
                const closed = new Promise<void>((done) =>
                    req.once('close', done),
                );
                active.set(req, closed);
                void closed.then(() => active.delete(req));
                req.on('error', reject);
                req.setTimeout(30000, () =>
                    req.destroy(new Error('Model fixture request timed out')),
                );
                req.end(
                    JSON.stringify({
                        provider: options.provider,
                        model: options.model,
                        session: options.sessionId,
                        messages: options.messages,
                    }),
                );
            });
            await Promise.all(active.values());
            trace({
                kind: 'model-request',
                id,
                session: options.sessionId,
                active: active.size,
            });
            yield { type: 'block-start', index: 0, blockType: 'text' };
            yield { type: 'text-delta', index: 0, text };
            yield {
                type: 'block-end',
                index: 0,
                block: { type: 'text', text },
            };
            yield { type: 'finish', reason: { kind: 'stop' } };
        }
    }
    return {
        adapter: new Adapter(),
        async dispose() {
            disposed = true;
            cancellation.abort();
            await Promise.all(active.values());
            trace({ kind: 'model-disposed', id, active: active.size });
            const failure = process.env.BENTO_REUSE_DISPOSE_FAILURE;
            if (failure && existsSync(failure)) {
                unlinkSync(failure);
                throw new Error('Fixture model cleanup failed');
            }
        },
    };
};
export default factory;
