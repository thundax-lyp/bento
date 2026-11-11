import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { object, RequestError } from './protocol.ts';

type Account = {
    account: string;
    ownerId: string;
    inviteSha256: string;
    registrationRequired?: boolean;
};
type Session = { account: Account; expires: number };

const lifetime = 24 * 60 * 60;
const digest = (value: string) =>
    createHash('sha256').update(value).digest('hex');

export function demoAccounts(): Account[] {
    return ['demo', 'guest'].map((account) => ({
        account,
        ownerId: randomBytes(24).toString('hex'),
        inviteSha256: digest('demo-invite'),
    }));
}

export function readAccounts(value: unknown): Account[] {
    if (!Array.isArray(value) || !value.length)
        throw new Error('Invalid account configuration');
    const names = new Set<string>();
    const ids = new Set<string>();
    return value.map((item: unknown) => {
        const {
            account,
            ownerId,
            inviteSha256,
            registrationRequired = false,
        } = object(item);
        if (
            typeof account !== 'string' ||
            !/^[A-Za-z0-9_.@-]{1,128}$/.test(account) ||
            typeof ownerId !== 'string' ||
            !/^[A-Za-z0-9_.~-]{1,128}$/.test(ownerId) ||
            typeof inviteSha256 !== 'string' ||
            !/^[a-f0-9]{64}$/.test(inviteSha256) ||
            typeof registrationRequired !== 'boolean' ||
            names.has(account) ||
            ids.has(ownerId)
        ) {
            throw new Error('Invalid or duplicate account');
        }
        names.add(account);
        ids.add(ownerId);
        return { account, ownerId, inviteSha256, registrationRequired };
    });
}

export function sessionAuth(
    accounts: Account[],
    secure: boolean,
    credentialPath = ':memory:',
) {
    if (credentialPath !== ':memory:')
        closeSync(openSync(credentialPath, 'a', 0o600));
    const db = new DatabaseSync(credentialPath);
    db.exec(`
        CREATE TABLE IF NOT EXISTS credentials (
            ownerId TEXT PRIMARY KEY, salt BLOB NOT NULL, scryptHash BLOB NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS closed_accounts (ownerId TEXT PRIMARY KEY) STRICT;
        CREATE TABLE IF NOT EXISTS account_purges (ownerId TEXT PRIMARY KEY, spaceRequired INTEGER NOT NULL) STRICT;
    `);
    const closedAccount = db.prepare(
        'SELECT 1 FROM closed_accounts WHERE ownerId = ?',
    );
    const credential = db.prepare(
        'SELECT salt, scryptHash FROM credentials WHERE ownerId = ?',
    );
    const activate = db.prepare(
        'INSERT OR IGNORE INTO credentials VALUES (?, ?, ?)',
    );
    const invites = new Map(
        accounts.map((account) => [account.account, account]),
    );
    const sessions = new Map<string, Session>();
    const attempts = new Map<string, { count: number; until: number }>();
    let hashing = 0;
    const cookieName = secure ? '__Host-bento_one' : 'bento_one';
    const cookieOptions =
        '; Path=/; HttpOnly; SameSite=Strict' + (secure ? '; Secure' : '');
    const cookie = (token: string, maxAge: number) =>
        cookieName + '=' + token + cookieOptions + '; Max-Age=' + maxAge;

    function invitedAccount(name: unknown) {
        return typeof name === 'string' ? invites.get(name.trim()) : undefined;
    }

    function matchesInvite(invited: Account, value: unknown) {
        return (
            typeof value === 'string' &&
            value.length <= 256 &&
            timingSafeEqual(
                Buffer.from(invited.inviteSha256, 'hex'),
                Buffer.from(digest(value), 'hex'),
            )
        );
    }

    async function passwordHash(password: string, salt: Uint8Array) {
        if (hashing >= 2)
            throw new RequestError(
                429,
                'auth_busy',
                '认证请求较多，请稍后重试。',
            );
        hashing++;
        try {
            return await new Promise<Buffer>((resolve, reject) => {
                scrypt(
                    password,
                    salt,
                    32,
                    { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 },
                    (error, key) => {
                        if (error) reject(error);
                        else resolve(key);
                    },
                );
            });
        } finally {
            hashing--;
        }
    }

    function sessionKey(request: IncomingMessage): string | undefined {
        const prefix = cookieName + '=';
        const candidates = request.headers.cookie
            ?.split(';')
            .map((part) => part.trim())
            .filter((part) => part.startsWith(prefix));
        const token = candidates?.[0]?.slice(prefix.length);
        return candidates?.length === 1 &&
            token &&
            /^[A-Za-z0-9_-]{43}$/.test(token)
            ? digest(token)
            : undefined;
    }

    function account(request: IncomingMessage) {
        const key = sessionKey(request);
        const session = key ? sessions.get(key) : undefined;
        if (
            !session ||
            session.expires <= Date.now() ||
            closedAccount.get(session.account.ownerId)
        ) {
            if (key) sessions.delete(key);
            throw new RequestError(
                401,
                'login_required',
                '请使用受邀账号登录。',
            );
        }
        return session.account;
    }

    const invalidCredentials = () =>
        new RequestError(401, 'invalid_credentials', '账号或登录凭据不正确。');

    async function verifyCredential(
        invited: Account,
        password: unknown,
        legacyInvite?: unknown,
    ) {
        if (closedAccount.get(invited.ownerId)) throw invalidCredentials();
        const saved = credential.get(invited.ownerId) as
            { salt: Uint8Array; scryptHash: Uint8Array } | undefined;
        if (saved) {
            if (
                typeof password !== 'string' ||
                !password ||
                [...password].length > 128 ||
                /\p{Surrogate}/u.test(password)
            )
                throw invalidCredentials();
            const time = Date.now();
            const previous = attempts.get(invited.ownerId);
            const attempt =
                previous && previous.until > time
                    ? previous
                    : { count: 0, until: time + 60_000 };
            if (attempt.count >= 10)
                throw new RequestError(
                    429,
                    'login_limited',
                    '登录尝试过多，请稍后重试。',
                );
            attempt.count++;
            attempts.set(invited.ownerId, attempt);
            if (
                !timingSafeEqual(
                    saved.scryptHash,
                    await passwordHash(password, saved.salt),
                )
            )
                throw invalidCredentials();
            attempts.delete(invited.ownerId);
        } else if (
            invited.registrationRequired ||
            !matchesInvite(invited, legacyInvite ?? password)
        ) {
            throw invalidCredentials();
        }
    }

    return {
        account,
        async register(input: unknown) {
            const { account: name, invite, password } = object(input);
            const invited = invitedAccount(name);
            if (
                !invited ||
                closedAccount.get(invited.ownerId) ||
                !matchesInvite(invited, invite)
            )
                throw new RequestError(
                    401,
                    'invalid_invite',
                    '账号或邀请码不正确。',
                );
            if (credential.get(invited.ownerId))
                throw new RequestError(
                    409,
                    'already_registered',
                    '账号已注册，请登录。',
                );
            if (
                typeof password !== 'string' ||
                [...password].length < 15 ||
                [...password].length > 128 ||
                /\p{Surrogate}/u.test(password) ||
                matchesInvite(invited, password)
            )
                throw new RequestError(
                    400,
                    'invalid_password',
                    '请设置 15 至 128 个字符的密码，与邀请码不同。',
                );
            const salt = randomBytes(16);
            const hash = await passwordHash(password, salt);
            if (closedAccount.get(invited.ownerId)) throw invalidCredentials();
            if (!activate.run(invited.ownerId, salt, hash).changes)
                throw new RequestError(
                    409,
                    'already_registered',
                    '账号已注册，请登录。',
                );
            for (const [key, session] of sessions) {
                if (session.account.ownerId === invited.ownerId)
                    sessions.delete(key);
            }
            return { account: invited.account };
        },
        async login(request: IncomingMessage, input: unknown) {
            const { account: name, invite, password } = object(input);
            const invited = invitedAccount(name);
            if (!invited) throw invalidCredentials();
            await verifyCredential(invited, password, invite);
            if (closedAccount.get(invited.ownerId)) throw invalidCredentials();
            const now = Date.now();
            for (const [key, session] of sessions) {
                if (session.expires <= now) sessions.delete(key);
            }
            const prior = sessionKey(request);
            if (prior) sessions.delete(prior);
            const token = randomBytes(32).toString('base64url');
            sessions.set(digest(token), {
                account: invited,
                expires: now + lifetime * 1000,
            });
            return {
                account: invited.account,
                cookie: cookie(token, lifetime),
            };
        },
        async closeAccount(
            request: IncomingMessage,
            input: unknown,
            spaceRequired: boolean,
        ) {
            const invited = account(request);
            const { password, confirmed } = object(input);
            if (confirmed !== true)
                throw new RequestError(
                    400,
                    'confirmation_required',
                    '请先确认注销账号的影响。',
                );
            await verifyCredential(invited, password);
            account(request);
            db.exec('BEGIN IMMEDIATE');
            try {
                db.prepare('INSERT INTO closed_accounts VALUES (?)').run(
                    invited.ownerId,
                );
                db.prepare('DELETE FROM credentials WHERE ownerId = ?').run(
                    invited.ownerId,
                );
                db.prepare('INSERT INTO account_purges VALUES (?, ?)').run(
                    invited.ownerId,
                    Number(spaceRequired),
                );
                db.exec('COMMIT');
            } catch (error) {
                db.exec('ROLLBACK');
                throw error;
            }
            for (const [key, session] of sessions) {
                if (session.account.ownerId === invited.ownerId)
                    sessions.delete(key);
            }
            attempts.delete(invited.ownerId);
            return cookie('', 0);
        },
        logout(request: IncomingMessage) {
            const key = sessionKey(request);
            if (key) sessions.delete(key);
            return cookie('', 0);
        },
        pendingPurges() {
            return db
                .prepare('SELECT ownerId, spaceRequired FROM account_purges')
                .all() as { ownerId: string; spaceRequired: number }[];
        },
        finishPurge(owner: string) {
            db.prepare('DELETE FROM account_purges WHERE ownerId = ?').run(
                owner,
            );
        },
        close() {
            db.close();
        },
    };
}
