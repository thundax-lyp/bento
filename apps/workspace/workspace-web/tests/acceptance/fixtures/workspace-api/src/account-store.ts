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

export type OidcAccountStore = AccountStore & {
    bindOidc(
        issuer: string,
        subject: string,
        account: string,
    ): Promise<
        Pick<StoredAccount, 'account' | 'ownerId' | 'closed'> | undefined
    >;
};
