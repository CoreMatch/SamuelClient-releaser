import { createHash, createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface SigningKeys {
  privateKey: KeyObject;
  publicKey: KeyObject;
  keyId: string;
}

export function loadSigningKeys(): SigningKeys {
  const privatePath = resolve(process.env.OTA_PRIVATE_KEY_PATH || '.keys/ota-ed25519-private.pem');
  const publicPath = resolve(process.env.OTA_PUBLIC_KEY_PATH || 'keys/ota-ed25519-public.pem');
  const privateKey = createPrivateKey(readFileSync(privatePath));
  const publicKey = createPublicKey(readFileSync(publicPath));
  if (privateKey.asymmetricKeyType !== 'ed25519' || publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('OTA signing keys must use Ed25519');
  }
  const derivedPublic = createPublicKey(privateKey);
  if (!derivedPublic.export({ format: 'der', type: 'spki' }).equals(publicKey.export({ format: 'der', type: 'spki' }))) {
    throw new Error('OTA private and public keys do not match');
  }
  const der = publicKey.export({ format: 'der', type: 'spki' });
  const keyId = createHash('sha256').update(der.subarray(der.length - 32)).digest('hex').slice(0, 16);
  return { privateKey, publicKey, keyId };
}
