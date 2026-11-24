import { execFile } from 'node:child_process';
import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyManifest } from '../src/manifest';
import { handleRequest } from '../src/worker';

const projectRoot = resolve(import.meta.dirname, '..');
const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const servers: Server[] = [];

interface StoredObject {
  body: Buffer;
  metadata: Record<string, string>;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolveClose, reject) => {
      server.close(error => error ? reject(error) : resolveClose());
    });
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('publish and rollback CLI', () => {
  it('publishes signed assets and activates a signed mandatory rollback', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'samuelclient-ota-'));
    temporaryDirectories.push(directory);
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const privatePath = join(directory, 'private.pem');
    const publicPath = join(directory, 'public.pem');
    writeFileSync(privatePath, privateKey.export({ format: 'pem', type: 'pkcs8' }));
    writeFileSync(publicPath, publicKey.export({ format: 'pem', type: 'spki' }));

    createArtifacts(directory, 'v0.3.1');
    createArtifacts(directory, 'v0.3.2');

    const objects = new Map<string, StoredObject>();
    const server = await startServer(objects);
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port');
    const baseURL = `http://127.0.0.1:${address.port}`;
    const env = {
      ...process.env,
      AWS_REQUEST_CHECKSUM_CALCULATION: 'when_required',
      AWS_RESPONSE_CHECKSUM_VALIDATION: 'when_required',
      R2_ACCOUNT_ID: 'local',
      R2_ACCESS_KEY_ID: 'local-access-key',
      R2_SECRET_ACCESS_KEY: 'local-secret-key',
      R2_BUCKET: 'samuelclient-ota',
      R2_UPLOAD_MODE: 's3',
      R2_ENDPOINT: baseURL,
      OTA_PRIVATE_KEY_PATH: privatePath,
      OTA_PUBLIC_KEY_PATH: publicPath,
    };

    await runCli('publish.ts', ['--version', 'v0.3.1', '--linux-file', artifact(directory, 'v0.3.1', 'linux'),
      '--windows-file', artifact(directory, 'v0.3.1', 'windows'), '--notes', 'First OTA release'], env);
    const first = await fetchManifest(baseURL, publicKey);
    expect(first.version).toBe('v0.3.1');
    expect(first.assets).toHaveLength(2);
    await expectAssets(baseURL, 'v0.3.1');

    await runCli('publish.ts', ['--version', 'v0.3.2', '--linux-file', artifact(directory, 'v0.3.2', 'linux'),
      '--windows-file', artifact(directory, 'v0.3.2', 'windows'), '--notes', 'Second OTA release', '--mandatory'], env);
    const second = await fetchManifest(baseURL, publicKey);
    expect(second.version).toBe('v0.3.2');
    expect(second.mandatory).toBe(true);

    await runCli('rollback.ts', ['--version', 'v0.3.1', '--notes', 'Roll back the problematic release'], env);
    const rollback = await fetchManifest(baseURL, publicKey);
    expect(rollback.version).toBe('v0.3.1');
    expect(rollback.mandatory).toBe(true);
    expect(rollback.allowDowngrade).toBe(true);
    expect(rollback.notes).toBe('Roll back the problematic release');
    await expectAssets(baseURL, 'v0.3.1');
  }, 30_000);
});

function createArtifacts(directory: string, version: string): void {
  writeFileSync(artifact(directory, version, 'linux'), `linux executable ${version}`);
  writeFileSync(artifact(directory, version, 'windows'), `windows executable ${version}`);
}

function artifact(directory: string, version: string, os: 'linux' | 'windows'): string {
  return join(directory, `SamuelClient-${version}-${os}-amd64${os === 'windows' ? '.exe' : ''}`);
}

async function runCli(script: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  try {
    await execFileAsync(process.execPath, ['--import', 'tsx', join('scripts', script), ...args], {
      cwd: projectRoot,
      env,
      timeout: 20_000,
    });
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    throw new Error(`${script} failed: ${failure.message}\n${failure.stdout ?? ''}\n${failure.stderr ?? ''}`);
  }
}

async function fetchManifest(baseURL: string, publicKey: KeyObject) {
  const response = await fetch(`${baseURL}/v1/channels/stable.json`);
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  return verifyManifest(await response.text(), publicKey);
}

async function expectAssets(baseURL: string, version: string): Promise<void> {
  for (const os of ['linux', 'windows'] as const) {
    const name = `SamuelClient-${version}-${os}-amd64${os === 'windows' ? '.exe' : ''}`;
    const response = await fetch(`${baseURL}/v1/releases/${version}/${os}-amd64/${name}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toContain('immutable');
    const expected = Buffer.from(`${os} executable ${version}`);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(expected);
    expect(createHash('sha256').update(expected).digest('hex')).toMatch(/^[0-9a-f]{64}$/);
  }
}

async function startServer(objects: Map<string, StoredObject>): Promise<Server> {
  const bucket = {
    async get(key: string) {
      const object = objects.get(key);
      if (!object) return null;
      return {
        body: new Response(Uint8Array.from(object.body)).body,
        size: object.body.length,
        httpEtag: `"${createHash('md5').update(object.body).digest('hex')}"`,
        writeHttpMetadata() {},
      };
    },
  } as unknown as R2Bucket;

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/healthz' || url.pathname === '/v1/channels/stable.json'
        || url.pathname.startsWith('/v1/releases/')) {
        const workerResponse = await handleRequest(
          new Request(url, { method: request.method }),
          { OTA_BUCKET: bucket },
        );
        response.writeHead(workerResponse.status, Object.fromEntries(workerResponse.headers));
        response.end(Buffer.from(await workerResponse.arrayBuffer()));
        return;
      }

      const prefix = '/samuelclient-ota/';
      if (!url.pathname.startsWith(prefix)) {
        response.writeHead(404).end();
        return;
      }
      const key = decodeURIComponent(url.pathname.slice(prefix.length));
      const object = objects.get(key);
      if (request.method === 'PUT') {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const metadata = Object.fromEntries(Object.entries(request.headers)
          .filter(([name]) => name.startsWith('x-amz-meta-'))
          .map(([name, value]) => [name.slice('x-amz-meta-'.length), String(value)]));
        objects.set(key, { body: Buffer.concat(chunks), metadata });
        response.writeHead(200, { ETag: '"stored"' }).end();
        return;
      }
      if (!object) {
        response.writeHead(404, { 'Content-Type': 'application/xml' });
        response.end(request.method === 'HEAD' ? undefined : '<Error><Code>NoSuchKey</Code></Error>');
        return;
      }
      const headers: Record<string, string> = {
        'Content-Length': String(object.body.length),
        'Content-Type': 'application/octet-stream',
        ETag: '"stored"',
      };
      for (const [name, value] of Object.entries(object.metadata)) {
        headers[`x-amz-meta-${name}`] = value;
      }
      response.writeHead(200, headers);
      response.end(request.method === 'HEAD' ? undefined : object.body);
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'text/plain' });
      response.end(error instanceof Error ? error.message : String(error));
    }
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  return server;
}
