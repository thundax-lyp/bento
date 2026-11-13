import { mkdir, copyFile } from 'node:fs/promises';
import { URL } from 'node:url';

const output = new URL('./dist/', import.meta.url);
await mkdir(output, { recursive: true });
for (const file of ['login.html', 'account.html', 'style.css']) {
    await copyFile(new URL(file, import.meta.url), new URL(file, output));
}
