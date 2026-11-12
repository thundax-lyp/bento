import {
    AbortMultipartUploadCommand,
    CompleteMultipartUploadCommand,
    CreateMultipartUploadCommand,
    DeleteObjectCommand,
    GetObjectCommand,
    HeadObjectCommand,
    ListMultipartUploadsCommand,
    ListPartsCommand,
    PutObjectCommand,
    S3Client,
    UploadPartCommand,
} from '@aws-sdk/client-s3';
import type { CompletedPart } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'node:stream';

export const partUrlSeconds = 600;
export const spaceObjectKey = (id: string) => 'space/' + id;

function missing(error: unknown) {
    return (
        error instanceof Error &&
        ['NotFound', 'NoSuchKey', 'NoSuchUpload'].includes(error.name)
    );
}

export function spaceStorage(endpoint: string, bucket: string, region: string) {
    const origin = new URL(endpoint).origin;
    const client = new S3Client({
        endpoint,
        region,
        forcePathStyle: true,
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
        maxAttempts: 1,
    });

    return {
        origin,
        async read(key: string, size: number) {
            const result = await client.send(
                new GetObjectCommand({ Bucket: bucket, Key: key }),
                { abortSignal: AbortSignal.timeout(15_000) },
            );
            const body = result.Body;
            if (!(body instanceof Readable))
                throw new Error('Missing file stream');
            if (result.ContentLength !== size) {
                body.destroy();
                throw new Error('Stored file size mismatch');
            }
            let length = 0;
            const chunks: Buffer[] = [];
            for await (const chunk of body) {
                const bytes = Buffer.from(chunk);
                length += bytes.length;
                if (length > size)
                    throw new Error('Stored file exceeds input limit');
                chunks.push(bytes);
            }
            if (length !== size) throw new Error('Incomplete stored file');
            return Buffer.concat(chunks, length);
        },
        async create(key: string) {
            const result = await client.send(
                new CreateMultipartUploadCommand({
                    Bucket: bucket,
                    Key: key,
                    ChecksumAlgorithm: 'SHA256',
                    ContentType: 'application/octet-stream',
                }),
                { abortSignal: AbortSignal.timeout(15_000) },
            );
            if (!result.UploadId) throw new Error('Missing upload ID');
            return result.UploadId;
        },
        signPart(
            key: string,
            upload: string,
            part: number,
            size: number,
            checksum: string,
        ) {
            return getSignedUrl(
                client,
                new UploadPartCommand({
                    Bucket: bucket,
                    Key: key,
                    UploadId: upload,
                    PartNumber: part,
                    ContentLength: size,
                    ChecksumSHA256: checksum,
                }),
                {
                    expiresIn: partUrlSeconds,
                    signableHeaders: new Set(['content-length']),
                    unhoistableHeaders: new Set(['x-amz-checksum-sha256']),
                },
            );
        },
        async parts(key: string, upload: string) {
            try {
                const result = await client.send(
                    new ListPartsCommand({
                        Bucket: bucket,
                        Key: key,
                        UploadId: upload,
                    }),
                    { abortSignal: AbortSignal.timeout(15_000) },
                );
                if (result.IsTruncated)
                    throw new Error('Unexpected part count');
                return result.Parts ?? [];
            } catch (error) {
                if (missing(error)) return null;
                throw error;
            }
        },
        async complete(key: string, upload: string, parts: CompletedPart[]) {
            await client.send(
                new CompleteMultipartUploadCommand({
                    Bucket: bucket,
                    Key: key,
                    UploadId: upload,
                    MultipartUpload: { Parts: parts },
                    IfNoneMatch: '*',
                }),
                { abortSignal: AbortSignal.timeout(30_000) },
            );
        },
        async empty(key: string) {
            await client.send(
                new PutObjectCommand({
                    Bucket: bucket,
                    Key: key,
                    Body: new Uint8Array(),
                    ContentLength: 0,
                    ContentType: 'application/octet-stream',
                    IfNoneMatch: '*',
                }),
                { abortSignal: AbortSignal.timeout(15_000) },
            );
        },
        async size(key: string) {
            try {
                const result = await client.send(
                    new HeadObjectCommand({
                        Bucket: bucket,
                        Key: key,
                    }),
                    { abortSignal: AbortSignal.timeout(15_000) },
                );
                if (result.ContentLength === undefined)
                    throw new Error('Missing object size');
                return result.ContentLength;
            } catch (error) {
                if (missing(error)) return null;
                throw error;
            }
        },
        async remove(key: string) {
            await client.send(
                new DeleteObjectCommand({ Bucket: bucket, Key: key }),
                { abortSignal: AbortSignal.timeout(15_000) },
            );
            if ((await this.size(key)) !== null)
                throw new Error('Object cleanup pending');
        },
        async abort(key: string, upload?: string) {
            const ids = new Set<string>();
            if (upload) ids.add(upload);
            // Find any initiation whose response was lost before the ID was recorded.
            const result = await client.send(
                new ListMultipartUploadsCommand({
                    Bucket: bucket,
                    Prefix: key,
                }),
                { abortSignal: AbortSignal.timeout(15_000) },
            );
            if (result.IsTruncated) throw new Error('Unexpected upload count');
            for (const item of result.Uploads ?? []) {
                if (item.Key === key && item.UploadId) ids.add(item.UploadId);
            }
            for (const id of ids) {
                try {
                    await client.send(
                        new AbortMultipartUploadCommand({
                            Bucket: bucket,
                            Key: key,
                            UploadId: id,
                        }),
                        { abortSignal: AbortSignal.timeout(15_000) },
                    );
                } catch (error) {
                    if (!missing(error)) throw error;
                }
                if ((await this.parts(key, id)) !== null)
                    throw new Error('Multipart cleanup pending');
            }
        },
        preview(key: string) {
            return getSignedUrl(
                client,
                new GetObjectCommand({
                    Bucket: bucket,
                    Key: key,
                    ResponseContentType: 'application/octet-stream',
                    ResponseCacheControl: 'no-store',
                }),
                { expiresIn: 300 },
            );
        },
        download(key: string, name: string) {
            const encoded = encodeURIComponent(name).replace(
                /['()*]/g,
                (char) => '%' + char.charCodeAt(0).toString(16).toUpperCase(),
            );
            return getSignedUrl(
                client,
                new GetObjectCommand({
                    Bucket: bucket,
                    Key: key,
                    ResponseContentDisposition:
                        "attachment; filename*=UTF-8''" + encoded,
                    ResponseContentType: 'application/octet-stream',
                }),
                { expiresIn: 300 },
            );
        },
    };
}
