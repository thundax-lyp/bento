export type Draft = { project: string; prompt: string; pending?: string };

const storageKey = (account: string) => 'bento:web:draft:' + account;

export function loadDraft(account: string): Draft {
    try {
        return (
            JSON.parse(
                sessionStorage.getItem(storageKey(account)) ?? 'null',
            ) ?? { project: '', prompt: '' }
        );
    } catch {
        return { project: '', prompt: '' };
    }
}

export function saveDraft(account: string, draft: Draft) {
    sessionStorage.setItem(storageKey(account), JSON.stringify(draft));
}

export function prepareSubmission(draft: Draft) {
    return {
        ...draft,
        prompt: draft.prompt.trim(),
        pending: draft.pending ?? crypto.randomUUID(),
    };
}
