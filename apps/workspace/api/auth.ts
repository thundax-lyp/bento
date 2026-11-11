import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { AccountStore, StoredAccount } from './account-store.ts';
import { object, RequestError } from './protocol.ts';

export type Account = {
    account: string;
    ownerId: string;
    inviteSha256: string;
};
type Identity = Pick<Account, 'account' | 'ownerId'>;
type Session = {
    account: Identity;
    expires: number;
    oidc?: { idToken: string; subject: string };
};

const lifetime = 24 * 60 * 60;
const digest = (value: string) =>
    createHash('sha256').update(value).digest('hex');

export function demoAccounts(): Account[] {
    return ['demo', 'guest', 'registration-demo'].map((account) => ({
        account,
        ownerId: randomBytes(24).toString('hex'),
        inviteSha256: digest('demo-invite'),
    }));
}

export function sessionAuth(
    store: AccountStore,
    secure: boolean,
    external = false,
) {
    const sessions = new Map<string, Session>();
    const closingOwners = new Set<string>();
    const attempts = new Map<string, { count: number; until: number }>();
    let hashing = 0;
    const cookieName = secure ? '__Host-bento_one' : 'bento_one';
    const cookieOptions =
        '; Path=/; HttpOnly; SameSite=' +
        (external ? 'Lax' : 'Strict') +
        (secure ? '; Secure' : '');
    const cookie = (token: string, maxAge: number) =>
        cookieName + '=' + token + cookieOptions + '; Max-Age=' + maxAge;

    async function invitedAccount(name: unknown) {
        if (typeof name !== 'string') return undefined;
        const trimmed = name.trim();
        if (!/^[A-Za-z0-9_.@-]{1,128}$/.test(trimmed)) return undefined;
        return store.byName(trimmed);
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

    async function session(request: IncomingMessage) {
        const key = sessionKey(request);
        const session = key ? sessions.get(key) : undefined;
        const current =
            session && session.expires > Date.now()
                ? await store.byOwner(session.account.ownerId)
                : undefined;
        if (
            !session ||
            !current ||
            current.closed ||
            closingOwners.has(session.account.ownerId) ||
            session.expires <= Date.now() ||
            (key && sessions.get(key) !== session)
        ) {
            if (key) sessions.delete(key);
            throw new RequestError(
                401,
                'login_required',
                '请使用受邀账号登录。',
            );
        }
        return session;
    }

    async function account(request: IncomingMessage) {
        return (await session(request)).account;
    }

    function startSession(
        request: IncomingMessage,
        identity: Identity,
        oidc?: { idToken: string; subject: string },
    ) {
        const now = Date.now();
        for (const [key, saved] of sessions) {
            if (saved.expires <= now) sessions.delete(key);
        }
        const prior = sessionKey(request);
        if (prior) sessions.delete(prior);
        const token = randomBytes(32).toString('base64url');
        sessions.set(digest(token), {
            account: identity,
            expires: now + lifetime * 1000,
            ...(oidc ? { oidc } : {}),
        });
        return { account: identity.account, cookie: cookie(token, lifetime) };
    }

    const invalidCredentials = () =>
        new RequestError(401, 'invalid_credentials', '账号或登录凭据不正确。');

    async function verifyCredential(invited: StoredAccount, password: unknown) {
        const saved = invited.credential;
        if (
            invited.closed ||
            !saved ||
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
    }

    async function closeVerified(
        request: IncomingMessage,
        ownerId: string,
        spaceRequired: boolean,
    ) {
        if ((await account(request)).ownerId !== ownerId)
            throw invalidCredentials();
        if (closingOwners.has(ownerId)) throw invalidCredentials();
        closingOwners.add(ownerId);
        try {
            if (!(await store.closeAccount(ownerId, spaceRequired)))
                throw invalidCredentials();
            for (const [key, session] of sessions) {
                if (session.account.ownerId === ownerId) sessions.delete(key);
            }
            attempts.delete(ownerId);
            return cookie('', 0);
        } finally {
            closingOwners.delete(ownerId);
        }
    }

    return {
        account,
        async register(input: unknown) {
            const { account: name, invite, password } = object(input);
            const invited = await invitedAccount(name);
            if (!invited || invited.closed || !matchesInvite(invited, invite))
                throw new RequestError(
                    401,
                    'invalid_invite',
                    '账号或邀请码不正确。',
                );
            if (invited.credential)
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
            if (!(await store.activate(invited.ownerId, salt, hash)))
                throw new RequestError(
                    409,
                    'already_registered',
                    '账号已注册，请登录。',
                );
            return { account: invited.account };
        },
        async login(request: IncomingMessage, input: unknown) {
            const { account: name, password } = object(input);
            const invited = await invitedAccount(name);
            if (!invited) throw invalidCredentials();
            await verifyCredential(invited, password);
            const current = await store.byOwner(invited.ownerId);
            if (
                !current ||
                current.closed ||
                closingOwners.has(invited.ownerId)
            )
                throw invalidCredentials();
            return startSession(request, {
                account: invited.account,
                ownerId: invited.ownerId,
            });
        },
        async closeAccount(
            request: IncomingMessage,
            input: unknown,
            spaceRequired: boolean,
        ) {
            const session = await account(request);
            const invited = await store.byOwner(session.ownerId);
            if (!invited) throw invalidCredentials();
            const { password, confirmed } = object(input);
            if (confirmed !== true)
                throw new RequestError(
                    400,
                    'confirmation_required',
                    '请先确认注销账号的影响。',
                );
            await verifyCredential(invited, password);
            return closeVerified(request, invited.ownerId, spaceRequired);
        },
        startSession,
        session,
        closeVerified,
        logout(request: IncomingMessage) {
            const key = sessionKey(request);
            if (key) sessions.delete(key);
            return cookie('', 0);
        },
        pendingPurges: store.pendingPurges,
        finishPurge: store.finishPurge,
    };
}
