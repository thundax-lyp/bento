import assert from 'node:assert/strict';
import { once } from 'node:events';
import { connect } from 'node:net';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { httpListener } from '../src/http-listener.ts';

for (const shutdown of [false, true]) {
    for (const partial of [
        'POST / HTTP/1.1\r\nHost:',
        'POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 10\r\n\r\na',
    ]) {
        test(
            `bounds incomplete ${partial.endsWith('a') ? 'body' : 'headers'}${shutdown ? ' during shutdown' : ''}`,
            { timeout: 3000 },
            async (t) => {
                const listener = httpListener((request, response) => {
                    request.resume();
                    request.once('end', () => response.end('ok'));
                }, 150);
                listener.server.listen(0, '127.0.0.1');
                await once(listener.server, 'listening');
                const address = listener.server.address();
                assert(address && typeof address !== 'string');
                const socket = connect({
                    port: address.port,
                    host: '127.0.0.1',
                    allowHalfOpen: true,
                });
                t.after(() => socket.destroy());
                await once(socket, 'connect');
                let result = '';
                socket.setEncoding('utf8').on('data', (data) => {
                    result += data;
                });
                const ended = once(socket, 'end');
                socket.write(partial);
                await delay(30);
                const closed = shutdown ? listener.close() : undefined;
                await ended;
                assert.match(result, /^HTTP\/1.1 408 /);
                await (closed ?? listener.close());
            },
        );
    }
}

test(
    'shutdown drains a complete request whose handler exceeds the receive deadline',
    { timeout: 3000 },
    async () => {
        let received!: () => void;
        const input = new Promise<void>((resolve) => {
            received = resolve;
        });
        const listener = httpListener((request, response) => {
            request.resume();
            request.once('end', () => {
                received();
                void delay(250).then(() => response.end('finished'));
            });
        }, 100);
        listener.server.listen(0, '127.0.0.1');
        await once(listener.server, 'listening');
        const address = listener.server.address();
        assert(address && typeof address !== 'string');
        const response = fetch(`http://127.0.0.1:${address.port}/`, {
            method: 'POST',
            body: 'complete',
        });
        await input;
        const closed = listener.close();
        assert.equal(await (await response).text(), 'finished');
        await closed;
    },
);
