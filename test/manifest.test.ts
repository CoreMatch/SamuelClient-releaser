import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  assetPath,
  publicKeyId,
  signManifest,
  verifyManifest,
  type ManifestPayload,
} from '../src/manifest';

function fixture() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const payload: ManifestPayload = {
    schemaVersion: 1,
    channel: 'stable',
    version: 'v0.3.2',
    releasedAt: '2026-11-24T12:00:00.000Z',
    mandatory: false,
    allowDowngrade: false,
    notes: 'Test release',
    keyId: publicKeyId(publicKey),
    assets: [{
      os: 'linux',
      arch: 'amd64',
      name: 'SamuelClient-v0.3.2-linux-amd64',
      url: assetPath('v0.3.2', 'linux', 'amd64'),
      size: 1234,
      sha256: 'a'.repeat(64),
    }],
  };
  return { privateKey, publicKey, payload };
}

describe('signed manifest', () => {
  it('round-trips a signed payload', () => {
    const { privateKey, publicKey, payload } = fixture();
    const signed = signManifest(payload, privateKey);
    expect(verifyManifest(JSON.stringify(signed), publicKey)).toEqual(payload);
  });

  it('rejects a modified signature', () => {
    const { privateKey, publicKey, payload } = fixture();
    const signed = signManifest(payload, privateKey);
    signed.signature = `${signed.signature[0] === 'A' ? 'B' : 'A'}${signed.signature.slice(1)}`;
    expect(() => verifyManifest(JSON.stringify(signed), publicKey)).toThrow('signature is invalid');
  });

  it('rejects an untrusted key', () => {
    const { privateKey, payload } = fixture();
    const other = generateKeyPairSync('ed25519').publicKey;
    const signed = signManifest(payload, privateKey);
    expect(() => verifyManifest(JSON.stringify(signed), other)).toThrow('signature is invalid');
  });

  it('rejects asset URLs outside the release path', () => {
    const { privateKey, payload } = fixture();
    payload.assets[0].url = 'https://example.com/binary';
    expect(() => signManifest(payload, privateKey)).toThrow('invalid asset URL');
  });

  it('requires downgrade manifests to be mandatory', () => {
    const { privateKey, payload } = fixture();
    payload.allowDowngrade = true;
    expect(() => signManifest(payload, privateKey)).toThrow('downgrades must be mandatory');
  });
});
