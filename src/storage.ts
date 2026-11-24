import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

if (existsSync('.env')) loadEnvFile('.env');

export interface StorageConfig {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  endpoint: string;
}

export interface StorageClient {
  getObject(key: string): Promise<Buffer | null>;
  headObject(key: string): Promise<{ metadata?: Record<string, string> } | null>;
  putObject(
    key: string,
    body: Buffer | string,
    contentType: string,
    cacheControl: string,
    metadata?: Record<string, string>,
  ): Promise<void>;
}

export function storageBucket(): string {
  return process.env.R2_BUCKET || 'samuelclient-ota';
}

export function storageConfig(): StorageConfig {
  const accountId = requiredEnv('R2_ACCOUNT_ID');
  const accessKeyId = requiredEnv('R2_ACCESS_KEY_ID');
  const secretAccessKey = requiredEnv('R2_SECRET_ACCESS_KEY');
  return {
    accountId,
    accessKeyId,
    secretAccessKey,
    bucket: storageBucket(),
    endpoint: process.env.R2_ENDPOINT || `https://${accountId}.r2.cloudflarestorage.com`,
  };
}

export function createS3Storage(config: StorageConfig): StorageClient {
  const client = createStorageClient(config);
  return {
    getObject: key => getObject(client, config, key),
    headObject: key => headObject(client, config, key),
    putObject: (key, body, contentType, cacheControl, metadata) =>
      putObject(client, config, key, body, contentType, cacheControl, metadata),
  };
}

export function createStorageClient(config: StorageConfig): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: config.endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

export async function putObject(
  client: S3Client,
  config: StorageConfig,
  key: string,
  body: Buffer | string,
  contentType: string,
  cacheControl: string,
  metadata?: Record<string, string>,
): Promise<void> {
  await client.send(new PutObjectCommand({
    Bucket: config.bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
    CacheControl: cacheControl,
    Metadata: metadata,
  }));
}

export async function getObject(
  client: S3Client,
  config: StorageConfig,
  key: string,
): Promise<Buffer | null> {
  try {
    const result = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
    if (!result.Body) return null;
    return Buffer.from(await result.Body.transformToByteArray());
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

export async function headObject(
  client: S3Client,
  config: StorageConfig,
  key: string,
): Promise<{ metadata?: Record<string, string> } | null> {
  try {
    const result = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
    return { metadata: result.Metadata };
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

export async function objectExists(
  client: S3Client,
  config: StorageConfig,
  key: string,
): Promise<boolean> {
  try {
    await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return candidate.name === 'NoSuchKey' || candidate.$metadata?.httpStatusCode === 404;
}
