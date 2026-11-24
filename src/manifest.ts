import { createHash, createPublicKey, KeyObject, sign, verify } from 'node:crypto';

type PublicKeyInput = Parameters<typeof createPublicKey>[0] | KeyObject;

export const MANIFEST_SCHEMA_VERSION = 1 as const;
export const MAX_ASSET_SIZE = 500 * 1024 * 1024;

export type TargetOS = 'linux' | 'windows';
export type TargetArch = 'amd64' | 'arm64';

export interface ReleaseAsset {
  os: TargetOS;
  arch: TargetArch;
  name: string;
  url: string;
  size: number;
  sha256: string;
}

export interface ManifestPayload {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  channel: 'stable';
  version: string;
  releasedAt: string;
  mandatory: boolean;
  allowDowngrade: boolean;
  notes: string;
  keyId: string;
  assets: ReleaseAsset[];
}

export interface SignedManifest {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  payload: string;
  signature: string;
}

export interface ReleaseMetadata {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  version: string;
  mandatory: boolean;
  allowDowngrade: boolean;
  notes: string;
  assets: ReleaseAsset[];
}

const stableVersionPattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const digestPattern = /^[0-9a-f]{64}$/;

export function normalizeVersion(input: string): string {
  const value = input.trim();
  if (!/^v?\d+\.\d+\.\d+$/.test(value)) {
    throw new Error('version must use vX.Y.Z or X.Y.Z format');
  }
  const normalized = value.startsWith('v') ? value : `v${value}`;
  const parts = normalized.slice(1).split('.').map(Number);
  if (parts.some(part => !Number.isSafeInteger(part) || part < 0)) {
    throw new Error('version contains an invalid number');
  }
  return `v${parts.join('.')}`;
}

export function compareVersions(left: string, right: string): number {
  const a = normalizeVersion(left).slice(1).split('.').map(Number);
  const b = normalizeVersion(right).slice(1).split('.').map(Number);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

export function assetName(version: string, os: TargetOS, arch: TargetArch): string {
  const normalized = normalizeVersion(version);
  return `SamuelClient-${normalized}-${os}-${arch}${os === 'windows' ? '.exe' : ''}`;
}

export function assetPath(version: string, os: TargetOS, arch: TargetArch): string {
  const normalized = normalizeVersion(version);
  return `/v1/releases/${normalized}/${os}-${arch}/${assetName(normalized, os, arch)}`;
}

export function releaseObjectKey(version: string): string {
  return `releases/${normalizeVersion(version)}/release.json`;
}

export function assetObjectKey(version: string, os: TargetOS, arch: TargetArch): string {
  const normalized = normalizeVersion(version);
  return `releases/${normalized}/${os}-${arch}/${assetName(normalized, os, arch)}`;
}

export function publicKeyId(publicKey: PublicKeyInput): string {
  const der = resolvePublicKey(publicKey).export({ format: 'der', type: 'spki' });
  const raw = der.subarray(der.length - 32);
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

function resolvePublicKey(publicKey: PublicKeyInput): KeyObject {
  if (publicKey instanceof KeyObject) return publicKey;
  return createPublicKey(publicKey);
}

function encodeBase64Url(value: Buffer): string {
  return value.toString('base64url');
}

function decodeBase64Url(value: string, label: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`${label} is not base64url`);
  const decoded = Buffer.from(value, 'base64url');
  if (encodeBase64Url(decoded) !== value) throw new Error(`${label} is not canonical base64url`);
  return decoded;
}

export function encodeManifestPayload(payload: ManifestPayload): string {
  validatePayload(payload);
  const assets = [...payload.assets].sort((a, b) =>
    a.os.localeCompare(b.os) || a.arch.localeCompare(b.arch));
  const canonical: ManifestPayload = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    channel: 'stable',
    version: payload.version,
    releasedAt: payload.releasedAt,
    mandatory: payload.mandatory,
    allowDowngrade: payload.allowDowngrade,
    notes: payload.notes,
    keyId: payload.keyId,
    assets: assets.map(asset => ({
      os: asset.os,
      arch: asset.arch,
      name: asset.name,
      url: asset.url,
      size: asset.size,
      sha256: asset.sha256,
    })),
  };
  return encodeBase64Url(Buffer.from(JSON.stringify(canonical), 'utf8'));
}

export function signManifest(payload: ManifestPayload, privateKey: Parameters<typeof sign>[2]): SignedManifest {
  const encodedPayload = encodeManifestPayload(payload);
  const signature = sign(null, decodeBase64Url(encodedPayload, 'payload'), privateKey);
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    payload: encodedPayload,
    signature: encodeBase64Url(signature),
  };
}

export function decodeManifestPayload(encoded: string): ManifestPayload {
  const bytes = decodeBase64Url(encoded, 'payload');
  if (bytes.length > 64 * 1024) throw new Error('manifest payload is too large');
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('manifest payload is not valid JSON');
  }
  validatePayload(value);
  return value;
}

export function verifyManifest(json: string, publicKey: PublicKeyInput): ManifestPayload {
  if (json.length > 128 * 1024) throw new Error('manifest is too large');
  let envelope: unknown;
  try {
    envelope = JSON.parse(json);
  } catch {
    throw new Error('manifest is not valid JSON');
  }
  if (!isRecord(envelope) || envelope.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new Error('unsupported manifest schema');
  }
  if (typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string') {
    throw new Error('manifest signature envelope is incomplete');
  }
  const payloadBytes = decodeBase64Url(envelope.payload, 'payload');
  const signature = decodeBase64Url(envelope.signature, 'signature');
  const trustedKey = resolvePublicKey(publicKey);
  if (!verify(null, payloadBytes, trustedKey, signature)) {
    throw new Error('manifest signature is invalid');
  }
  const payload = decodeManifestPayload(envelope.payload);
  if (payload.keyId !== publicKeyId(trustedKey)) throw new Error('manifest key ID does not match trusted key');
  return payload;
}

export function validatePayload(value: unknown): asserts value is ManifestPayload {
  if (!isRecord(value)) throw new Error('manifest payload must be an object');
  if (value.schemaVersion !== MANIFEST_SCHEMA_VERSION) throw new Error('unsupported manifest schema');
  if (value.channel !== 'stable') throw new Error('unsupported release channel');
  if (typeof value.version !== 'string' || !stableVersionPattern.test(value.version)) {
    throw new Error('manifest version must be a stable vX.Y.Z version');
  }
  if (typeof value.releasedAt !== 'string' || !Number.isFinite(Date.parse(value.releasedAt))) {
    throw new Error('manifest releasedAt is invalid');
  }
  if (typeof value.mandatory !== 'boolean' || typeof value.allowDowngrade !== 'boolean') {
    throw new Error('manifest update policy is invalid');
  }
  if (value.allowDowngrade && !value.mandatory) throw new Error('downgrades must be mandatory');
  if (typeof value.notes !== 'string' || value.notes.length > 4000) throw new Error('manifest notes are invalid');
  if (typeof value.keyId !== 'string' || !/^[0-9a-f]{16}$/.test(value.keyId)) {
    throw new Error('manifest key ID is invalid');
  }
  if (!Array.isArray(value.assets) || value.assets.length === 0 || value.assets.length > 16) {
    throw new Error('manifest assets are invalid');
  }

  const targets = new Set<string>();
  for (const asset of value.assets) {
    if (!isRecord(asset)) throw new Error('manifest asset must be an object');
    if (asset.os !== 'linux' && asset.os !== 'windows') throw new Error('unsupported asset OS');
    if (asset.arch !== 'amd64' && asset.arch !== 'arm64') throw new Error('unsupported asset architecture');
    const target = `${asset.os}/${asset.arch}`;
    if (targets.has(target)) throw new Error(`duplicate asset for ${target}`);
    targets.add(target);
    if (asset.name !== assetName(value.version, asset.os, asset.arch)) {
      throw new Error(`invalid asset name for ${target}`);
    }
    if (asset.url !== assetPath(value.version, asset.os, asset.arch)) {
      throw new Error(`invalid asset URL for ${target}`);
    }
    const size = asset.size;
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0 || size > MAX_ASSET_SIZE) {
      throw new Error(`invalid asset size for ${target}`);
    }
    if (typeof asset.sha256 !== 'string' || !digestPattern.test(asset.sha256)) {
      throw new Error(`invalid asset digest for ${target}`);
    }
  }
}

export function validateReleaseMetadata(value: unknown): asserts value is ReleaseMetadata {
  if (!isRecord(value)) throw new Error('release metadata must be an object');
  validatePayload({
    schemaVersion: value.schemaVersion,
    channel: 'stable',
    version: value.version,
    releasedAt: '1970-01-01T00:00:00.000Z',
    mandatory: value.mandatory,
    allowDowngrade: value.allowDowngrade,
    notes: value.notes,
    keyId: '0000000000000000',
    assets: value.assets,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
