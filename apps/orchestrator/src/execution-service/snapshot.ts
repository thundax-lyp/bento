import { createHash } from 'node:crypto';
import { textSnapshot } from './input.ts';
import type { FileText } from './types.ts';
export function snapshotSha256(files: readonly FileText[]) {
    return createHash('sha256')
        .update(JSON.stringify(textSnapshot(files)))
        .digest('hex');
}
