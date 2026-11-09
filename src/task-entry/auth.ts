import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { object, RequestError } from './protocol.ts';

type Account = { account: string; ownerId: string; inviteSha256: string };
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
        const { account, ownerId, inviteSha256 } = object(item);
        if (
            typeof account !== 'string' ||
            !/^[A-Za-z0-9_.@-]{1,128}$/.test(account) ||
            typeof ownerId !== 'string' ||
            !/^[A-Za-z0-9_.~-]{1,128}$/.test(ownerId) ||
            typeof inviteSha256 !== 'string' ||
            !/^[a-f0-9]{64}$/.test(inviteSha256) ||
            names.has(account) ||
            ids.has(ownerId)
        ) {
            throw new Error('Invalid or duplicate account');
        }
        names.add(account);
        ids.add(ownerId);
        return { account, ownerId, inviteSha256 };
    });
}

export function sessionAuth(accounts: Account[], secure: boolean) {
    const invites = new Map(
        accounts.map((account) => [account.account, account]),
    );
    const sessions = new Map<string, Session>();
    const cookieName = secure ? '__Host-bento_one' : 'bento_one';
    const cookieOptions =
        '; Path=/; HttpOnly; SameSite=Strict' + (secure ? '; Secure' : '');
    const cookie = (token: string, maxAge: number) =>
        cookieName + '=' + token + cookieOptions + '; Max-Age=' + maxAge;

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
        if (!session || session.expires <= Date.now()) {
            if (key) sessions.delete(key);
            throw new RequestError(
                401,
                'login_required',
                '请使用受邀账号登录。',
            );
        }
        return session.account;
    }

    return {
        account,
        login(request: IncomingMessage, input: unknown) {
            const { account: name, invite } = object(input);
            const invited =
                typeof name === 'string' ? invites.get(name.trim()) : undefined;
            const provided =
                typeof invite === 'string' && invite.length <= 256
                    ? digest(invite)
                    : '';
            if (
                !invited ||
                !provided ||
                !timingSafeEqual(
                    Buffer.from(invited.inviteSha256, 'hex'),
                    Buffer.from(provided, 'hex'),
                )
            ) {
                throw new RequestError(
                    401,
                    'invalid_invite',
                    '账号或邀请码不正确。',
                );
            }
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
        logout(request: IncomingMessage) {
            const key = sessionKey(request);
            if (key) sessions.delete(key);
            return cookie('', 0);
        },
    };
}
