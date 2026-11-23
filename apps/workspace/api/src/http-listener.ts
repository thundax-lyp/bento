import {
    createServer,
    type RequestListener,
    type ServerResponse,
} from 'node:http';
import type { Socket } from 'node:net';

// Own the listener so receive limits are configured before listen(). Deadlines
// also survive server.close(), which stops Node's connection timeout scanner.
export function httpListener(
    handler: RequestListener,
    receiveTimeoutMs = 30_000,
) {
    const responses = new Set<ServerResponse>();
    const receiving = new Map<
        Socket,
        { timer: NodeJS.Timeout; response?: ServerResponse }
    >();
    function begin(socket: Socket, response?: ServerResponse) {
        const prior = receiving.get(socket);
        if (prior) {
            if (response) prior.response = response;
            return;
        }
        const entry = {
            timer: setTimeout(() => {
                receiving.delete(socket);
                // Parser completion does not depend on the handler consuming
                // IncomingMessage or receiving its readable 'end' event.
                if (entry.response?.req.complete) return;
                if (!entry.response?.headersSent && socket.writable)
                    socket.end(
                        'HTTP/1.1 408 Request Timeout\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
                        () => socket.destroy(),
                    );
                else socket.destroy();
            }, receiveTimeoutMs).unref(),
            ...(response ? { response } : {}),
        };
        receiving.set(socket, entry);
    }
    function complete(socket: Socket) {
        clearTimeout(receiving.get(socket)?.timer);
        receiving.delete(socket);
    }
    const server = createServer(
        {
            requestTimeout: receiveTimeoutMs,
            headersTimeout: receiveTimeoutMs,
            connectionsCheckingInterval: 500,
        },
        (request, response) => {
            responses.add(response);
            response.once('close', () => responses.delete(response));
            if (receiving.get(request.socket)?.response)
                complete(request.socket);
            begin(request.socket, response);
            request.once('end', () => {
                if (receiving.get(request.socket)?.response === response)
                    complete(request.socket);
            });
            handler(request, response);
        },
    );
    server.on('connection', (socket) => {
        begin(socket);
        socket.on('data', () => begin(socket));
        socket.once('close', () => {
            complete(socket);
        });
    });
    return {
        server,
        close() {
            for (const response of responses) {
                response.shouldKeepAlive = false;
                if (!response.headersSent)
                    response.setHeader('Connection', 'close');
            }
            return new Promise<void>((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
                server.closeIdleConnections();
            });
        },
    };
}
