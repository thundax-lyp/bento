export type Upload = {
    id: string;
    project: string;
    owner: string;
    path: string;
    size: number;
    manifest: string;
    state:
        | 'preparing'
        | 'uploading'
        | 'completing'
        | 'cleaning'
        | 'saved'
        | 'deleting'
        | 'deleted'
        | 'cancelled'
        | 'expired'
        | 'failed';
    storageId: string | null;
    expires: number;
    signedUntil: number;
    cleanup: 'cancelled' | 'expired' | 'failed' | null;
};
