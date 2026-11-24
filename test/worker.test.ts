import { describe, expect, it } from 'vitest';
import { handleRequest, type Env } from '../src/worker';

function environment(): Env {
  const objects = new Map<string, string>([
    ['manifests/stable.json', '{"schemaVersion":1,"payload":"x","signature":"y"}'],
    ['releases/v0.3.2/linux-amd64/SamuelClient-v0.3.2-linux-amd64', 'binary'],
  ]);
  const bucket = {
    async get(key: string) {
      const value = objects.get(key);
      if (value === undefined) return null;
      const bytes = new TextEncoder().encode(value);
      return {
        body: new Response(bytes).body,
        size: bytes.length,
        httpEtag: '"test-etag"',
        writeHttpMetadata(headers: Headers) {
          headers.set('Content-Type', key.endsWith('.json') ? 'application/json' : 'application/octet-stream');
        },
      };
    },
  };
  return { OTA_BUCKET: bucket as unknown as R2Bucket };
}

describe('OTA worker', () => {
  it('serves health without a bucket read', async () => {
    const response = await handleRequest(new Request('https://mlup.mcnb.dev/healthz'), environment());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('serves the stable manifest without caching', async () => {
    const response = await handleRequest(new Request('https://mlup.mcnb.dev/v1/channels/stable.json'), environment());
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('serves immutable release assets', async () => {
    const response = await handleRequest(new Request('https://mlup.mcnb.dev/v1/releases/v0.3.2/linux-amd64/SamuelClient-v0.3.2-linux-amd64'), environment());
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toContain('immutable');
    expect(await response.text()).toBe('binary');
  });

  it('rejects mismatched asset names and traversal', async () => {
    for (const path of [
      '/v1/releases/v0.3.2/linux-amd64/other',
      '/v1/releases/v0.3.2/windows-amd64/SamuelClient-v0.3.2-linux-amd64',
      '/v1/releases/../manifests/stable.json',
    ]) {
      const response = await handleRequest(new Request(`https://mlup.mcnb.dev${path}`), environment());
      expect(response.status).toBe(404);
    }
  });

  it('allows only GET and HEAD', async () => {
    const response = await handleRequest(new Request('https://mlup.mcnb.dev/healthz', { method: 'POST' }), environment());
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('GET, HEAD');
  });
});
