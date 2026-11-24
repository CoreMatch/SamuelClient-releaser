import { createHash, generateKeyPairSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const privatePath = resolve(process.env.OTA_PRIVATE_KEY_PATH || '.keys/ota-ed25519-private.pem');
const publicPath = resolve(process.env.OTA_PUBLIC_KEY_PATH || 'keys/ota-ed25519-public.pem');

if (existsSync(privatePath) || existsSync(publicPath)) {
  throw new Error('signing keys already exist; refusing to overwrite them');
}

mkdirSync(dirname(privatePath), { recursive: true, mode: 0o700 });
mkdirSync(dirname(publicPath), { recursive: true });

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const privatePem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const publicPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();

writeFileSync(privatePath, privatePem, { flag: 'wx', mode: 0o600 });
chmodSync(privatePath, 0o600);
writeFileSync(publicPath, publicPem, { flag: 'wx', mode: 0o644 });

const der = publicKey.export({ format: 'der', type: 'spki' });
const raw = der.subarray(der.length - 32);
const keyId = createHash('sha256').update(raw).digest('hex').slice(0, 16);

console.log(`Private key: ${privatePath} (0600, gitignored)`);
console.log(`Public key: ${publicPath}`);
console.log(`Key ID: ${keyId}`);
console.log(`Trusted public key (base64): ${raw.toString('base64')}`);
