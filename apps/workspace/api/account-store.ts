import type { Account } from './auth.ts';

type Credential = { salt: Uint8Array; scryptHash: Uint8Array };
type PendingPurge = { ownerId: string; spaceRequired: boolean };
export type StoredAccount = Account & {
    closed: boolean;
    credential?: Credential;
};

export type AccountStore = {
    byName(name: string): Promise<StoredAccount | undefined>;
    byOwner(owner: string): Promise<StoredAccount | undefined>;
    activate(
        owner: string,
        salt: Uint8Array,
        hash: Uint8Array,
    ): Promise<boolean>;
    closeAccount(owner: string, spaceRequired: boolean): Promise<boolean>;
    pendingPurges(): Promise<PendingPurge[]>;
    finishPurge(owner: string): Promise<void>;
};

export function mockAccounts(accounts: Account[]): AccountStore {
    const records: StoredAccount[] = accounts.map((account) => ({
        ...account,
        closed: false,
    }));
    const names = new Map(records.map((account) => [account.account, account]));
    const owners = new Map(
        records.map((account) => [account.ownerId, account]),
    );
    const purges = new Map<string, PendingPurge>();
    const snapshot = (account?: StoredAccount) => account && { ...account };
    return {
        byName: (name) => Promise.resolve(snapshot(names.get(name))),
        byOwner: (owner) => Promise.resolve(snapshot(owners.get(owner))),
        activate(owner, salt, scryptHash) {
            const account = owners.get(owner);
            if (!account || account.closed || account.credential)
                return Promise.resolve(false);
            account.credential = { salt, scryptHash };
            return Promise.resolve(true);
        },
        closeAccount(owner, spaceRequired) {
            const account = owners.get(owner);
            if (!account || account.closed) return Promise.resolve(false);
            account.closed = true;
            delete account.credential;
            purges.set(owner, { ownerId: owner, spaceRequired });
            return Promise.resolve(true);
        },
        pendingPurges: () => Promise.resolve([...purges.values()]),
        finishPurge(owner) {
            purges.delete(owner);
            return Promise.resolve();
        },
    };
}

export function mysqlAccounts(): AccountStore & {
    bindOidc(
        issuer: string,
        subject: string,
        account: string,
    ): Promise<
        Pick<StoredAccount, 'account' | 'ownerId' | 'closed'> | undefined
    >;
} {
    async function request<T>(path: string, method = 'GET', body?: object) {
        const response = await fetch('http://127.0.0.1:4103/internal/' + path, {
            method,
            ...(body ? { body: JSON.stringify(body) } : {}),
            signal: AbortSignal.timeout(10_000),
        });
        if (
            response.status === 404 &&
            method === 'GET' &&
            path.startsWith('accounts/')
        )
            return undefined;
        if (!response.ok) throw new Error('MySQL account store unavailable');
        return (await response.json()) as T;
    }
    async function lookup(kind: 'name' | 'owner', value: string) {
        const row = await request<
            Account & { closed: boolean; salt?: string; scryptHash?: string }
        >('accounts/by-' + kind + '/' + encodeURIComponent(value));
        if (!row) return undefined;
        const { salt, scryptHash, ...account } = row;
        return {
            ...account,
            ...(salt && scryptHash
                ? {
                      credential: {
                          salt: Buffer.from(salt, 'base64'),
                          scryptHash: Buffer.from(scryptHash, 'base64'),
                      },
                  }
                : {}),
        };
    }
    return {
        async bindOidc(issuer: string, subject: string, account: string) {
            return request<
                Pick<StoredAccount, 'account' | 'ownerId' | 'closed'>
            >('accounts/oidc', 'POST', { issuer, subject, account });
        },
        byName: (name) => lookup('name', name),
        byOwner: (owner) => lookup('owner', owner),
        async activate(owner, salt, hash) {
            return (
                (await request<boolean>(
                    'accounts/' + encodeURIComponent(owner) + '/register',
                    'POST',
                    {
                        Salt: Buffer.from(salt).toString('base64'),
                        Hash: Buffer.from(hash).toString('base64'),
                    },
                )) === true
            );
        },
        async closeAccount(owner, spaceRequired) {
            return (
                (await request<boolean>(
                    'accounts/' + encodeURIComponent(owner) + '/close',
                    'POST',
                    { spaceRequired },
                )) === true
            );
        },
        async pendingPurges() {
            return (await request<PendingPurge[]>('account-purges')) ?? [];
        },
        async finishPurge(owner) {
            await request(
                'account-purges/' + encodeURIComponent(owner),
                'DELETE',
            );
        },
    };
}
