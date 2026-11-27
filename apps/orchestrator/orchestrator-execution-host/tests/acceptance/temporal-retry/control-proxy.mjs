import { Buffer } from 'node:buffer';
import {
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
} from 'node:timers';
import process from 'node:process';
import {
    appendFileSync,
    readFileSync,
    renameSync,
    writeFileSync,
    unlinkSync,
} from 'node:fs';
import { connect } from 'node:net';
import { isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';

const config = JSON.parse(
    readFileSync(process.env.BENTO_A6_PROXY_CONFIG, 'utf8'),
);
if (
    config.schema !== 1 ||
    !isAbsolute(config.socketPath) ||
    !isAbsolute(config.directory) ||
    !['pass', 'drop'].includes(config.mode) ||
    !(
        process.argv.length === 2 ||
        (process.argv.length === 3 && process.argv[2] === 'temporal')
    )
)
    throw new Error('Invalid acceptance proxy configuration');
const socket = connect(config.socketPath);
let sequence = 0,
    held,
    closeId,
    closeAck,
    holdingTimer,
    ending = false,
    failed = false;
const advances = new Map();
const audit = (event, runId = null, frameId = null) =>
    appendFileSync(
        join(config.directory, 'events.ndjson'),
        JSON.stringify({ schema: 1, seq: ++sequence, event, runId, frameId }) +
            '\n',
        { mode: 0o600, flush: true },
    );
const marker = (name, value) => {
    const file = join(config.directory, name);
    writeFileSync(file + '.tmp', JSON.stringify(value), {
        mode: 0o600,
        flush: true,
    });
    renameSync(file + '.tmp', file);
};
function frame(line) {
    if (Buffer.byteLength(line) > 8 * 1024 * 1024)
        throw new Error('Proxy frame limit');
    const value = JSON.parse(line);
    if (
        !value ||
        typeof value.id !== 'string' ||
        (value.method !== undefined && typeof value.method !== 'string') ||
        (value.error !== undefined && typeof value.error !== 'string')
    )
        throw new Error('Invalid proxy frame');
    return value;
}
function fail() {
    failed = true;
    process.exitCode = 1;
    socket.end();
}
const host = createInterface({ input: process.stdin });
const control = createInterface({ input: socket });
socket.once('connect', () => audit('connected'));
socket.on('error', fail);
process.stdin.on('error', fail);
process.stdout.on('error', fail);
host.on('line', (line) => {
    try {
        const message = frame(line);
        if (message.method === 'close') closeId = message.id;
        if (advances.has(message.id)) {
            const runId = advances.get(message.id);
            advances.delete(message.id);
            if (message.error !== undefined) {
                socket.write(line + '\n');
                return;
            }
            if (message.value !== null)
                throw new Error('Unexpected advancement reply');
            if (config.mode === 'drop') {
                if (held) throw new Error('Duplicate held reply');
                held = { schema: 1, runId, frameId: message.id };
                audit('reply-held', runId, message.id);
                marker('held.json', held);
                holdingTimer = setTimeout(fail, 30000);
                return;
            }
            audit('reply-forwarded', runId, message.id);
        }
        socket.write(line + '\n');
    } catch {
        fail();
    }
});
control.on('line', (line) => {
    try {
        const message = frame(line);
        if (message.method === 'advance') {
            if (typeof message.value !== 'string')
                throw new Error('Invalid advance');
            advances.set(message.id, message.value);
            audit('advance', message.value, message.id);
        }
        if (closeId === message.id && message.method === undefined) {
            closeAck = line;
            return;
        }
        process.stdout.write(line + '\n');
    } catch {
        fail();
    }
});
const commands = setInterval(() => {
    try {
        const command = JSON.parse(
            readFileSync(join(config.directory, 'command.json'), 'utf8'),
        );
        if (
            command.schema !== 1 ||
            !['drop', 'shutdown'].includes(command.command)
        )
            throw new Error('Invalid proxy command');
        unlinkSync(join(config.directory, 'command.json'));
        clearInterval(commands);
        clearTimeout(holdingTimer);
        if (command.command === 'drop') {
            if (config.mode !== 'drop' || !held)
                throw new Error('No held response to drop');
            marker('drop-ready.json', { ...held, discarded: true });
            held = undefined;
        } else socket.end();
    } catch (error) {
        if (error.code !== 'ENOENT') fail();
    }
}, 20);
function shutdown() {
    if (!ending) socket.end();
}
host.on('close', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('disconnect', shutdown);
function finishControl() {
    if (ending) return;
    ending = true;
    clearInterval(commands);
    clearTimeout(holdingTimer);
    host.close();
    const deadline = Date.now() + 5000;
    const finish = () => {
        try {
            const record = JSON.parse(
                readFileSync(
                    join(config.directory, 'control-closed.json'),
                    'utf8',
                ),
            );
            if (record.schema !== 1 || record.closed !== true)
                throw new Error('Control close not proven');
            audit('control-closed');
            audit('proxy-closing');
            marker('proxy-closed.json', { schema: 1, controlClosed: true });
            if (closeAck && !failed) process.stdout.write(closeAck + '\n');
            socket.end();
            socket.destroy();
            process.stdin.destroy();
        } catch (error) {
            if (error.code === 'ENOENT' && Date.now() < deadline) {
                setTimeout(finish, 20);
                return;
            }
            process.exitCode = 1;
            socket.destroy();
            process.stdin.destroy();
        }
    };
    finish();
}
socket.once('end', finishControl);
socket.once('close', finishControl);
