import type { Readable } from 'node:stream';

export async function* workerFrames(stream: Readable, limit: number) {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let tail = Buffer.alloc(0);
    for await (const chunk of stream as AsyncIterable<Buffer>) {
        let start = 0;
        while (start < chunk.length) {
            const newline = chunk.indexOf(10, start);
            const end = newline === -1 ? chunk.length : newline;
            const part = chunk.subarray(start, end);
            if (tail.length + part.length > limit)
                throw new Error('Worker frame exceeds size limit');
            if (newline === -1) {
                tail = Buffer.concat([tail, part]);
                break;
            }
            const frame = decoder.decode(Buffer.concat([tail, part]));
            tail = Buffer.alloc(0);
            start = newline + 1;
            yield frame;
        }
    }
    if (tail.length) throw new Error('Incomplete worker frame');
}
