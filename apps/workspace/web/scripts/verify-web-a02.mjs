import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import dns from 'node:dns/promises';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { URL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';

const size = 100_000_000;
const partSize = 16_777_216;
const partCount = Math.ceil(size / partSize);
const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;

function origin(value) {
    const url = new URL(value);
    assert.equal(url.origin, value);
    assert(
        url.protocol === 'https:' ||
            (url.protocol === 'http:' &&
                ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)),
    );
    return url.origin;
}

async function digest(file) {
    const hash = createHash('sha256');
    for await (const bytes of createReadStream(file)) hash.update(bytes);
    return hash.digest('hex');
}

async function fixtures(directory, size) {
    const partCount = Math.ceil(size / partSize);
    const files = [];
    for (const variant of ['original', 'changed', 'oversize']) {
        const folder = join(directory, variant);
        await fs.mkdir(folder, { mode: 0o700 });
        const file = join(
            folder,
            variant === 'oversize' ? 'oversize.bin' : 'web-a02.bin',
        );
        const handle = await fs.open(file, 'wx', 0o600);
        try {
            await handle.truncate(size + Number(variant === 'oversize'));
            if (variant !== 'oversize') {
                for (let i = 0; i < partCount; i++) {
                    const end = Math.min((i + 1) * partSize, size) - 1;
                    await handle.write(
                        Buffer.from([i + 1]),
                        0,
                        1,
                        i * partSize,
                    );
                    await handle.write(Buffer.from([255 - i]), 0, 1, end);
                }
                if (variant === 'changed') {
                    await handle.write(Buffer.from([0]), 0, 1, size - 1);
                }
            }
        } finally {
            await handle.close();
        }
        files.push(file);
    }
    return files;
}

async function verifyExpiredPut(url, original, checksum) {
    const bytes = Buffer.alloc(partSize);
    const file = await fs.open(original, 'r');
    try {
        const { bytesRead } = await file.read(bytes, 0, partSize, partSize);
        assert.equal(bytesRead, partSize);
    } finally {
        await file.close();
    }
    assert.equal(createHash('sha256').update(bytes).digest('base64'), checksum);
    const address = await dns.lookup(new URL(url).hostname, { family: 4 });
    const { status, body, sent } = await new Promise((resolve, reject) => {
        let sent = false;
        const request = httpsRequest(
            url,
            {
                method: 'PUT',
                signal: globalThis.AbortSignal.timeout(30_000),
                lookup: (_hostname, options, callback) =>
                    options.all
                        ? callback(null, [address])
                        : callback(null, address.address, address.family),
                headers: {
                    Expect: '100-continue',
                    'content-length': String(bytes.length),
                    'x-amz-checksum-sha256': checksum,
                },
            },
            (response) => {
                let body = '';
                response.setEncoding('utf8');
                response.on('data', (chunk) => {
                    if (body.length < 4096) body += chunk;
                });
                response.on('error', reject);
                response.on('end', () =>
                    resolve({ status: response.statusCode, body, sent }),
                );
            },
        );
        request.once('continue', () => {
            sent = true;
            request.end(bytes);
        });
        request.on('error', reject);
        request.flushHeaders();
    });
    console.log('WEB_A02_EXPIRED_NODE_PUT', status, bytes.length, Number(sent));
    assert(sent, 'expired PUT sent the original block');
    assert.equal(status, 403);
    assert.match(body, /<Code>AccessDenied<\/Code>/);
    assert.match(body, /<Message>[^<]*expired/i);
}

async function poll(read, accept, timeout = 30_000) {
    const end = Date.now() + timeout;
    do {
        const value = await read();
        if (accept(value)) return value;
        await delay(250);
    } while (Date.now() < end);
    throw Error('poll timeout');
}

async function verify(browser) {
    const web = origin(process.env.BENTO_A02_ORIGIN);
    const storage = origin(process.env.BENTO_A02_STORAGE_ORIGIN);
    const {
        BENTO_A02_LOGIN: login,
        BENTO_A02_PASSWORD: password,
        BENTO_A02_STORAGE_CHECK: checker,
    } = process.env;
    assert(login && password && checker);
    await fs.access(checker, fs.constants.X_OK);
    const preflight = process.argv[2] === '--small';
    const quotaRun = process.argv[2] === '--quota';
    const downloadOnly = process.argv[2] === '--download-boundary';
    const fixtureSize = preflight ? partSize + 1 : size;
    const directory = await fs.mkdtemp(join(tmpdir(), 'bento-web-a02-'));
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    const projectName = 'web-a02-' + randomUUID();
    const record = {
        directory,
        projectName,
        projectId: null,
        uploadIds: [],
        stage: 'login',
    };
    const recovery = join(directory, 'recovery.json');
    const timeout = setTimeout(
        () => {
            console.error('WEB_A02_TIMEOUT', record.stage);
            process.exit(1);
        },
        3 * 60 * 60 * 1000,
    );
    const observed = { writes: [], puts: [], parts: [] };
    let lastProgress = Date.now();
    let phase = 'setup';
    let releaseDisconnect;
    const disconnectGate = new Promise((resolve) => {
        releaseDisconnect = resolve;
    });
    const putPhases = new WeakMap();
    const storageRequests = new Map();
    const wireLengths = new Map();
    const wireStatuses = new Map();
    const corsErrors = new Map();
    const expiredPuts = [];
    let cached;
    let fresh;
    let routingFailure = false;
    let initial;
    let result;
    let failed = false;

    async function persist() {
        const pending = recovery + '.next';
        const file = await fs.open(pending, 'w', 0o600);
        try {
            await file.writeFile(JSON.stringify(record) + '\n');
            await file.sync();
        } finally {
            await file.close();
        }
        await fs.rename(pending, recovery);
        const folder = await fs.open(directory, 'r');
        try {
            await folder.sync();
        } finally {
            await folder.close();
        }
    }

    async function stage(name) {
        record.stage = name;
        phase = name;
        lastProgress = Date.now();
        console.log('WEB_A02_STAGE', name);
        await persist();
    }

    const button = (name) => page.getByRole('button', { name, exact: true });
    const input = page.locator('input[name=file]');
    const resultArea = page.getByRole('list', { name: '上传结果' });
    const projectPath = () => '/api/space/projects/' + record.projectId;
    const uploadPath = () => '/api/space/uploads/' + record.uploadIds[0];
    const puts = (name) => observed.puts.filter((item) => item.phase === name);
    const writes = (name) =>
        observed.writes.filter((item) => item.phase === name);
    const checkObject = (mode, id, expectedBytes) =>
        execFileSync(
            checker,
            [
                mode,
                'space/' + id,
                ...(expectedBytes === undefined ? [] : [String(expectedBytes)]),
            ],
            { stdio: 'ignore', timeout: 30_000 },
        );

    async function putLength(request, number, status) {
        const contentLength = await poll(
            () => wireLengths.get(storageRequests.get(request.url())),
            (value) => value !== undefined,
            5_000,
        );
        const length = /^\d+$/.test(contentLength) ? Number(contentLength) : -1;
        const lengthSigned = new URL(request.url()).searchParams
            .get('X-Amz-SignedHeaders')
            ?.split(';')
            .includes('content-length');
        console.log(
            'WEB_A02_PUT_LENGTH',
            number,
            status,
            length,
            Number(Boolean(lengthSigned)),
        );
        assert(lengthSigned, 'content-length is signed');
        assert(length >= 0, 'PUT content-length exists');
        return length;
    }

    async function expectPuts(name, bytes, numbers) {
        const actual = await Promise.all(
            puts(name).map(async ({ number, status, request }) => [
                number,
                status,
                await putLength(request, number, status),
            ]),
        );
        actual.sort(([a], [b]) => a - b);
        assert.deepEqual(
            actual,
            numbers.map((number) => [
                number,
                200,
                Math.min(partSize, bytes - (number - 1) * partSize),
            ]),
        );
    }

    function read(path) {
        return page.evaluate(async (url) => {
            const response = await globalThis.fetch(url, {
                redirect: 'manual',
            });
            return {
                status: response.status,
                body: response.status === 200 ? await response.json() : null,
            };
        }, path);
    }

    async function select(file) {
        await input.setInputFiles(file);
        await button('确认上传').click();
    }

    async function post(path, payload) {
        return page.evaluate(
            async ({ path, payload }) => {
                const response = await globalThis.fetch(path, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(payload),
                    signal: globalThis.AbortSignal.timeout(15_000),
                });
                return { status: response.status, body: await response.json() };
            },
            { path, payload },
        );
    }

    async function usage(saved, reserved) {
        const { body } = await read('/api/space');
        assert.equal(body.saved, saved);
        assert.equal(body.reserved, reserved);
        console.log('WEB_A03_USAGE', saved, reserved);
    }

    async function verifyQuota(original, changed) {
        const downloadLinks = page.getByRole('link', {
            name: '下载文件',
            exact: true,
        });
        const second = join(directory, 'second.bin');
        await fs.rename(changed, second);
        for (const [index, file] of [original, second].entries()) {
            await stage('quota save ' + (index + 1));
            await select(file);
            await poll(
                async () => {
                    assert(Date.now() - lastProgress < 120_000);
                    return await downloadLinks.count();
                },
                (count) => count === index + 1,
                600_000,
            );
            await expectPuts(
                phase,
                size,
                Array.from({ length: partCount }, (_, i) => i + 1),
            );
            checkObject('saved', record.uploadIds[index]);
            await usage((index + 1) * size, 0);
        }
        const checksum = createHash('sha256')
            .update(Buffer.from([0]))
            .digest('base64');
        const input = (path, bytes) => ({
            id: randomUUID(),
            path,
            size: bytes,
            checksums: Array(Math.ceil(bytes / partSize)).fill(checksum),
        });
        const start = (payload) => post(projectPath() + '/uploads', payload);
        const excess = input('excess.bin', 1);
        record.uploadIds.push(excess.id);
        await persist();
        const denied = await start(excess);
        assert.equal(denied.status, 409);
        assert.equal(denied.body.error.code, 'space_quota');
        checkObject('absent', excess.id);
        await usage(2 * size, 0);
        console.log('WEB_A03_FULL_QUOTA_OK', 2 * size);

        await stage('quota delete');
        const [first] = record.uploadIds;
        const row = page.getByRole('listitem').filter({
            has: page
                .getByRole('link', { name: '下载文件' })
                .and(
                    page.locator(
                        'a[href="/api/space/files/' + first + '/download"]',
                    ),
                ),
        });
        await row
            .getByRole('button', { name: '删除文件', exact: true })
            .click();
        await page
            .locator('[aria-label="确认删除文件"]')
            .getByRole('button', { name: '确认删除', exact: true })
            .click();
        await poll(
            () => read('/api/space'),
            ({ body }) => body?.saved === size,
        );
        checkObject('absent', first);
        await usage(size, 0);

        await stage('quota race');
        const contenders = [
            input('race-a.bin', size),
            input('race-b.bin', size),
        ];
        record.uploadIds.push(...contenders.map(({ id }) => id));
        await persist();
        const results = await Promise.all(contenders.map(start));
        assert.deepEqual(
            results.map(({ status }) => status).sort(),
            [200, 409],
        );
        const winner =
            contenders[results.findIndex(({ status }) => status === 200)];
        const loser =
            contenders[results.findIndex(({ status }) => status === 409)];
        assert.equal(
            results.find(({ status }) => status === 409).body.error.code,
            'space_quota',
        );
        checkObject('absent', loser.id);
        await usage(size, size);
        await stage('quota cancel');
        const cancel = await post(
            '/api/space/uploads/' + winner.id + '/cancel',
            {},
        );
        assert.equal(cancel.status, 200);
        await poll(
            () => read('/api/space/uploads/' + winner.id),
            ({ body }) => body?.state === 'cancelled',
        );
        checkObject('absent', winner.id);
        await usage(size, 0);
        const reusable = input('reusable.bin', size);
        record.uploadIds.push(reusable.id);
        await persist();
        assert.equal((await start(reusable)).status, 200);
        await usage(size, size);
        assert.equal(
            (await post('/api/space/uploads/' + reusable.id + '/cancel', {}))
                .status,
            200,
        );
        await poll(
            () => read('/api/space/uploads/' + reusable.id),
            ({ body }) => body?.state === 'cancelled',
        );
        checkObject('absent', reusable.id);
        await usage(size, 0);
        console.log('WEB_A03_CONCURRENT_CANCEL_DELETE_REUSE_OK');
    }

    async function sameParts() {
        const status = await read(uploadPath());
        assert.equal(status.status, 200);
        assert.equal(status.body.id, record.uploadIds[0]);
        assert.deepEqual(status.body.parts, [1]);
    }

    page.on('request', (request) => {
        if (
            request.method() === 'PUT' &&
            new URL(request.url()).origin === storage
        ) {
            putPhases.set(request, phase);
            if (phase === 'expired') expiredPuts.push(request);
        }
    });

    page.on('response', (response) => {
        const url = new URL(response.url());
        if (url.origin === storage && response.request().method() === 'PUT') {
            if (response.ok()) {
                lastProgress = Date.now();
            }
            const number = Number(url.searchParams.get('partNumber'));
            const request = response.request();
            const requestPhase = putPhases.get(request);
            console.log(
                'WEB_A02_PUT',
                requestPhase,
                number,
                response.status(),
                new Date(lastProgress).toISOString(),
            );
            if (!requestPhase) routingFailure = true;
            observed.puts.push({
                phase: requestPhase,
                number,
                status: response.status(),
                request,
            });
        }
        if (url.origin === web && url.pathname === projectPath() + '/uploads') {
            observed.writes.push({
                phase,
                kind: 'registration-response',
                status: response.status(),
            });
        }
    });

    try {
        // Chromium reports the headers written on the wire separately from Request.
        const network = await context.newCDPSession(page);
        network.on('Network.requestWillBeSent', ({ request, requestId }) => {
            if (
                request.method === 'PUT' &&
                new URL(request.url).origin === storage
            )
                storageRequests.set(request.url, requestId);
        });
        network.on(
            'Network.requestWillBeSentExtraInfo',
            ({ headers, requestId }) => {
                const contentLength = Object.entries(headers).find(
                    ([name]) => name.toLowerCase() === 'content-length',
                )?.[1];
                if (contentLength !== undefined)
                    wireLengths.set(requestId, contentLength);
            },
        );
        // CORS can hide the S3 response from the page while the request still reached storage.
        network.on(
            'Network.responseReceivedExtraInfo',
            ({ requestId, statusCode }) => {
                wireStatuses.set(requestId, statusCode);
            },
        );
        network.on(
            'Network.loadingFailed',
            ({ corsErrorStatus, requestId }) => {
                if (phase === 'expired' && corsErrorStatus)
                    corsErrors.set(requestId, corsErrorStatus.corsError);
            },
        );
        await network.send('Network.enable');
        await page.goto(web + '/auth');
        await page.getByRole('link', { name: '受邀用户登录' }).click();
        await page.locator('#username').fill(login);
        await page.locator('#kc-login').click();
        await page.locator('#password').fill(password);
        await page.locator('#kc-login').click();
        await page.waitForURL(
            (url) =>
                url.origin === web &&
                !url.pathname.startsWith('/identity') &&
                !url.pathname.startsWith('/api/'),
        );
        assert.equal((await read('/api/session')).status, 200);
        initial = (await read('/api/space')).body;
        assert.equal(initial.fileLimit, size);
        assert.equal(initial.quota, 200_000_000);
        assert.equal(initial.partSize, partSize);
        assert.equal(initial.saved, 0);
        assert.equal(initial.reserved, 0);
        record.saved = initial.saved;
        record.reserved = initial.reserved;
        await stage('fixtures');
        const [original, changed, oversize] = await fixtures(
            directory,
            fixtureSize,
        );

        await context.route(
            (url) =>
                url.origin === web && url.pathname.startsWith('/api/space/'),
            async (route) => {
                const request = route.request();
                const path = new URL(request.url()).pathname;
                try {
                    if (
                        request.method() === 'POST' &&
                        path === '/api/space/projects'
                    ) {
                        const { id, name } = request.postDataJSON();
                        assert.equal(name, projectName);
                        assert(uuid.test(id));
                        assert(!record.projectId || record.projectId === id);
                        record.projectId = id;
                        await persist();
                    }
                    if (
                        request.method() === 'POST' &&
                        path === projectPath() + '/uploads'
                    ) {
                        const {
                            id,
                            size: bytes,
                            checksums,
                        } = request.postDataJSON();
                        assert(uuid.test(id));
                        if (!record.uploadIds.includes(id)) {
                            record.uploadIds.push(id);
                            await persist();
                        }
                        observed.writes.push({
                            phase,
                            kind: 'registration',
                            id,
                            bytes,
                            count: checksums.length,
                        });
                    }
                    if (
                        request.method() === 'POST' &&
                        path.endsWith('/complete')
                    ) {
                        const match =
                            /^\/api\/space\/uploads\/([\da-f-]+)\/complete$/i.exec(
                                path,
                            );
                        assert(
                            match &&
                                uuid.test(match[1]) &&
                                record.uploadIds.includes(match[1]),
                        );
                        const { status, body } = await read(
                            '/api/space/uploads/' + match[1],
                        );
                        assert.equal(status, 200);
                        assert.equal(body.id, match[1]);
                        assert.equal(body.size, fixtureSize);
                        assert.deepEqual(
                            body.parts,
                            Array.from(
                                { length: Math.ceil(fixtureSize / partSize) },
                                (_, i) => i + 1,
                            ),
                        );
                    }
                    if (
                        request.method() === 'POST' &&
                        path === uploadPath() + '/part'
                    ) {
                        const { number } = request.postDataJSON();
                        observed.writes.push({ phase, kind: 'sign', number });
                        if (number > 1 && phase === 'disconnect') {
                            await disconnectGate;
                            return await route.abort().catch(() => {});
                        }
                        if (
                            (phase === 'capture' || phase === 'expired') &&
                            number !== 2
                        )
                            return await route.abort();
                        if (number === 2 && phase === 'capture') {
                            const response = await route.fetch({
                                timeout: 10_000,
                            });
                            assert.equal(response.status(), 200);
                            cached = await response.json();
                            return await route.abort();
                        }
                        if (number === 2 && phase === 'expired') {
                            assert(cached);
                            const expired = cached;
                            cached = undefined;
                            await route.fulfill({
                                status: 200,
                                json: expired,
                            });
                            console.log('WEB_A02_EXPIRED_SIGN_DELIVERED');
                            return;
                        }
                        if (number === 2 && phase === 'resume') {
                            const response = await route.fetch({
                                timeout: 10_000,
                            });
                            assert.equal(response.status(), 200);
                            fresh = await response.json();
                            return await route.fulfill({ response });
                        }
                    }
                    if (
                        request.method() === 'GET' &&
                        path === uploadPath() &&
                        ['different', 'capture', 'expired', 'resume'].includes(
                            phase,
                        )
                    ) {
                        const response = await route.fetch({ timeout: 10_000 });
                        assert.equal(response.status(), 200);
                        const body = await response.json();
                        observed.parts.push({ phase, parts: body.parts });
                        return await route.fulfill({ response });
                    }
                    await route.continue();
                } catch {
                    routingFailure = true;
                    await route.abort().catch(() => {});
                }
            },
        );

        await stage('project');
        await page.goto(web + '/workspaces');
        await page.getByLabel('空间项目名称').fill(projectName);
        await button('新建空间项目').click();
        await page.waitForURL((url) =>
            /^\/space\/[\da-f-]+$/i.test(url.pathname),
        );
        const projectUrl = web + '/space/' + record.projectId;
        await page.waitForURL(projectUrl);

        if (quotaRun) {
            await verifyQuota(original, changed);
            result = true;
        } else if (preflight || downloadOnly) {
            await stage(
                preflight ? 'small upload' : 'boundary download upload',
            );
            await select(original);
            await page
                .getByRole('link', { name: '下载文件', exact: true })
                .waitFor({ timeout: 120_000 });
            await expectPuts(
                phase,
                fixtureSize,
                Array.from(
                    { length: Math.ceil(fixtureSize / partSize) },
                    (_, i) => i + 1,
                ),
            );
        } else {
            await stage('oversize');
            await input.setInputFiles(oversize);
            await page
                .getByText('单文件最多 100 MB。', { exact: false })
                .waitFor();
            assert(await button('确认上传').isDisabled());
            assert.equal((await fs.stat(oversize)).size, size + 1);
            await button('放弃本次选择').click();
            assert.deepEqual(writes('oversize'), []);
            assert.deepEqual(puts('oversize'), []);
            const overId = randomUUID();
            record.uploadIds.push(overId);
            await persist();
            const rejected = await page.evaluate(
                async ({ path, id, bytes }) => {
                    const response = await globalThis.fetch(path, {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({
                            id,
                            path: 'oversize.bin',
                            size: bytes,
                            checksums: [],
                        }),
                    });
                    return [
                        response.status,
                        (await response.json()).error.code,
                    ];
                },
                {
                    path: projectPath() + '/uploads',
                    id: overId,
                    bytes: size + 1,
                },
            );
            assert.deepEqual(rejected, [413, 'file_limit']);
            assert.equal(
                (await read('/api/space')).body.reserved,
                initial.reserved,
            );
            assert.deepEqual(puts('oversize'), []);
            checkObject('absent', overId);
            record.uploadIds = record.uploadIds.filter((id) => id !== overId);
            await persist();
            console.log('WEB_A02_OVERSIZE_OK', size + 1);

            await stage('disconnect');
            await select(original);
            await poll(() => puts('disconnect').length, Boolean, 120_000);
            await expectPuts('disconnect', size, [1]);
            await sameParts();
            const first = writes('disconnect').find(
                (item) => item.kind === 'registration',
            );
            assert.equal(first.bytes, size);
            assert.equal(first.count, partCount);
            await context.setOffline(true);
            releaseDisconnect();
            await assert.rejects(
                page.reload({ timeout: 10_000 }),
                /ERR_INTERNET_DISCONNECTED/,
            );
            await context.setOffline(false);
            await page.goto(projectUrl);
            await sameParts();
            console.log('WEB_A02_DISCONNECT_OK', size, 'parts=1');

            await stage('different');
            await select(changed);
            await resultArea
                .getByText(/同一上传编号对应不同文件/)
                .waitFor({ timeout: 120_000 });
            assert.deepEqual(
                writes('different').map((item) => item.kind),
                ['registration', 'registration-response'],
            );
            assert.equal(writes('different')[0].id, first.id);
            assert.equal(writes('different')[1].status, 409);
            assert.deepEqual(puts('different'), []);
            await sameParts();
            console.log('WEB_A02_DIFFERENT_FILE_OK', '409 space_conflict');

            await stage('capture');
            await select(original);
            await resultArea
                .getByText(/本次上传未确认/)
                .waitFor({ timeout: 120_000 });
            assert(cached);
            assert.deepEqual(puts('capture'), []);
            const { url: stale, checksum: staleChecksum } = cached;
            const signed = new URL(stale);
            assert.equal(signed.origin, storage);
            const date = signed.searchParams.get('X-Amz-Date');
            assert.match(date, /^\d{8}T\d{6}Z$/);
            const issued = Date.parse(
                date.replace(
                    /^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/,
                    '$1-$2-$3T$4:$5:$6Z',
                ),
            );
            assert.equal(signed.searchParams.get('X-Amz-Expires'), '600');
            console.log(
                'WEB_A02_WAIT_SIGNATURE_EXPIRY',
                new Date(issued + 605_000).toISOString(),
            );
            await delay(Math.max(0, issued + 605_000 - Date.now()));

            await stage('expired');
            assert.equal((await read('/api/session')).status, 200);
            await select(original);
            await poll(() => expiredPuts.length, Boolean, 120_000);
            await resultArea
                .getByText(/本次上传未确认/)
                .waitFor({ timeout: 120_000 });
            assert.equal(expiredPuts.length, 1);
            const [expiredPut] = expiredPuts;
            assert.equal(expiredPut.url(), stale);
            assert.equal(signed.searchParams.get('partNumber'), '2');
            const expiredRequestId = await poll(
                () => storageRequests.get(expiredPut.url()),
                Boolean,
                5_000,
            );
            const expiredStatus = await poll(
                () => wireStatuses.get(expiredRequestId),
                (status) => status !== undefined,
                5_000,
            );
            console.log('WEB_A02_EXPIRED_CHROMIUM_PUT', expiredStatus);
            if (expiredStatus === 502) {
                const corsError = await poll(
                    () => corsErrors.get(expiredRequestId),
                    Boolean,
                    5_000,
                );
                assert.equal(corsError, 'MissingAllowOriginHeader');
                console.log('WEB_A02_EXPIRED_CORS', corsError);
                await verifyExpiredPut(stale, original, staleChecksum);
            } else {
                assert.equal(expiredStatus, 403);
                assert.equal(
                    await putLength(expiredPut, 2, expiredStatus),
                    partSize,
                );
            }
            await sameParts();

            await stage('resume');
            await select(original);
            const downloadLink = page.getByRole('link', {
                name: '下载文件',
                exact: true,
            });
            await poll(
                async () => {
                    assert(
                        Date.now() - lastProgress < 120_000,
                        'upload progress deadline',
                    );
                    return await downloadLink.isVisible();
                },
                Boolean,
                10 * 60_000,
            );
            record.stage = 'verify resumed parts';
            await persist();
            console.log(
                'WEB_A02_RESUME_OBSERVED',
                JSON.stringify({
                    fresh: Boolean(fresh && fresh.url !== stale),
                    putCount: puts('resume').length,
                    reads: observed.parts,
                }),
            );
            assert(fresh && fresh.url !== stale);
            await expectPuts(
                'resume',
                size,
                Array.from({ length: partCount - 1 }, (_, i) => i + 2),
            );
            for (const name of ['capture', 'expired', 'resume']) {
                const reads = observed.parts.filter(
                    (entry) => entry.phase === name,
                );
                assert(reads.length > 0);
                assert.deepEqual(reads[0].parts, [1]);
            }
            const saved = await read(uploadPath());
            assert.equal(saved.body.id, first.id);
            assert.equal(saved.body.state, 'saved');
            assert.equal(saved.body.size, size);
            assert.deepEqual(record.uploadIds, [first.id]);
            assert(!routingFailure);
            checkObject('saved', first.id);
            console.log('WEB_A02_EXPIRED_SIGNATURE_OK', '403 then 200');
            console.log('WEB_A02_MISSING_PARTS_ONLY_OK', '2..6');
        }
        if (!quotaRun) {
            await stage('download');
            const downloadEvent = page.waitForEvent('download');
            await page.getByRole('link', { name: '下载文件' }).click();
            const download = await downloadEvent;
            const destination = join(directory, 'download.bin');
            await download.saveAs(destination);
            assert.equal((await fs.stat(destination)).size, fixtureSize);
            if (preflight)
                checkObject('saved', record.uploadIds[0], fixtureSize);
            else checkObject('saved', record.uploadIds[0]);
            const sha256 = await digest(original);
            assert.equal(await digest(destination), sha256);
            result = { sha256 };
            console.log('WEB_A02_DOWNLOAD_OK', fixtureSize, sha256);
        }
    } catch {
        console.error('WEB_A02_FAILED', record.stage);
        failed = true;
    } finally {
        try {
            releaseDisconnect();
            await context.setOffline(false);
            await context.unrouteAll({ behavior: 'wait' });
            if (record.projectId) {
                await stage('cleanup read');
                await page.goto(web + '/space/' + record.projectId);
                for (const id of record.uploadIds) {
                    const path = '/api/space/uploads/' + id;
                    const upload = await read(path);
                    if (
                        ['preparing', 'uploading'].includes(upload.body?.state)
                    ) {
                        const cancelled = await post(path + '/cancel', {});
                        assert.equal(cancelled.status, 200);
                    }
                    await poll(
                        () => read(path),
                        ({ status, body }) =>
                            status === 404 ||
                            [
                                'cancelled',
                                'expired',
                                'failed',
                                'saved',
                                'deleted',
                            ].includes(body?.state),
                        720_000,
                    );
                }
                if ((await read(projectPath())).status !== 404) {
                    await stage('cleanup delete project');
                    await page.reload();
                    await button('删除项目').click();
                    await button('确认删除').click();
                    await poll(
                        () => read(projectPath()),
                        ({ status }) => status === 404,
                        720_000,
                    );
                }
                await stage('cleanup verify object and quota');
                for (const id of record.uploadIds) {
                    const path = '/api/space/files/' + id + '/download';
                    assert.equal((await read(path)).status, 404);
                    checkObject('absent', id);
                }
                const { body } = await read('/api/space');
                assert.equal(body.saved, initial.saved);
                assert.equal(body.reserved, initial.reserved);
            }
            await context.close();
            for (const entry of await fs.readdir(directory)) {
                if (entry !== 'recovery.json')
                    await fs.rm(join(directory, entry), {
                        recursive: true,
                        force: true,
                    });
            }
            await fs.rm(recovery, { force: true });
            await fs.rmdir(directory);
            console.log('WEB_A02_CLEANUP_OK');
        } catch {
            console.error('WEB_A02_CLEANUP_FAILED', record.stage, directory);
            failed = true;
        } finally {
            clearTimeout(timeout);
        }
    }
    assert(!failed && !routingFailure && result);
    console.log(quotaRun ? 'WEB_A03_PASS' : 'WEB_A02_PASS');
}

let browser;
try {
    assert(
        process.argv.length === 2 ||
            (process.argv.length === 3 &&
                [
                    '--check',
                    '--small',
                    '--quota',
                    '--download-boundary',
                ].includes(process.argv[2])),
    );
    assert.equal(origin('http://127.0.0.1:8080'), 'http://127.0.0.1:8080');
    browser = await chromium.launch();
    if (process.argv[2] === '--check') console.log('WEB_A02_PREFLIGHT_OK');
    else await verify(browser);
} catch {
    console.error('WEB_A02_EXIT_FAILED');
    process.exitCode = 1;
} finally {
    await browser?.close();
}
