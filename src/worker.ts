import { assetName, normalizeVersion, type TargetArch, type TargetOS } from './manifest';

export interface Env {
  OTA_BUCKET: R2Bucket;
}

const MANIFEST_KEY = 'manifests/stable.json';
const immutableCacheControl = 'public, max-age=31536000, immutable';

export default {
  fetch: handleRequest,
};

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return jsonResponse({ error: 'method not allowed' }, 405, { Allow: 'GET, HEAD' });
  }

  const path = new URL(request.url).pathname;
  if (path === '/healthz') {
    return jsonResponse({ status: 'ok' }, 200, { 'Cache-Control': 'no-store' });
  }
  if (path === '/v1/channels/stable.json') {
    return serveObject(request, env, MANIFEST_KEY, 'application/json', 'no-store');
  }

  const asset = parseAssetPath(path);
  if (!asset) return jsonResponse({ error: 'not found' }, 404);
  return serveObject(request, env, asset.key, 'application/octet-stream', immutableCacheControl);
}

function parseAssetPath(path: string): { key: string; name: string } | null {
  const parts = path.split('/');
  if (parts.length !== 6 || parts[0] !== '' || parts[1] !== 'v1' || parts[2] !== 'releases') return null;
  const [, , , rawVersion, rawTarget, name] = parts;
  let version: string;
  try {
    version = normalizeVersion(rawVersion);
  } catch {
    return null;
  }
  const match = /^(linux|windows)-(amd64|arm64)$/.exec(rawTarget);
  if (!match) return null;
  const os = match[1] as TargetOS;
  const arch = match[2] as TargetArch;
  if (name !== assetName(version, os, arch)) return null;
  return {
    key: `releases/${version}/${os}-${arch}/${name}`,
    name,
  };
}

async function serveObject(
  request: Request,
  env: Env,
  key: string,
  contentType: string,
  cacheControl: string,
): Promise<Response> {
  const object = await env.OTA_BUCKET.get(key);
  if (!object) return jsonResponse({ error: 'not found' }, 404);

  const headers = new Headers({
    'Content-Type': contentType,
    'Cache-Control': cacheControl,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  object.writeHttpMetadata(headers);
  if (object.httpEtag) headers.set('ETag', object.httpEtag);
  if (object.size >= 0) headers.set('Content-Length', String(object.size));
  return new Response(request.method === 'HEAD' ? null : object.body, { status: 200, headers });
}

function jsonResponse(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  });
}
