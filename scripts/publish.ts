import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadSigningKeys } from '../src/keys';
import {
  MAX_ASSET_SIZE,
  assetObjectKey,
  assetPath,
  compareVersions,
  normalizeVersion,
  releaseObjectKey,
  signManifest,
  validateReleaseMetadata,
  verifyManifest,
  type ManifestPayload,
  type ReleaseAsset,
  type ReleaseMetadata,
} from '../src/manifest';
import {
  createStorageClient,
  getObject,
  headObject,
  putObject,
  storageConfig,
} from '../src/storage';

const STABLE_KEY = 'manifests/stable.json';
const immutableCacheControl = 'public, max-age=31536000, immutable';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const version = normalizeVersion(requiredArg(args, '--version'));
  const linuxFile = resolve(requiredArg(args, '--linux-file'));
  const windowsFile = resolve(requiredArg(args, '--windows-file'));
  const notes = readNotes(args);
  const mandatory = args['--mandatory'] === true;

  const keys = loadSigningKeys();
  const config = storageConfig();
  const client = createStorageClient(config);

  const current = await readStableManifest(client, config, keys.publicKey);
  if (current && compareVersions(version, current.version) <= 0) {
    const comparison = compareVersions(version, current.version);
    if (comparison < 0) throw new Error('refusing to downgrade; use npm run rollback -- --version <version>');
    if (current.mandatory === mandatory && current.notes === notes && !current.allowDowngrade) {
      console.log(`${version} is already the active stable release; nothing to do`);
      return;
    }
    throw new Error(`${version} is immutable; publish a newer version instead`);
  }

  const linux = await inspectFile(linuxFile, version, 'linux', 'amd64');
  const windows = await inspectFile(windowsFile, version, 'windows', 'amd64');
  const release: ReleaseMetadata = {
    schemaVersion: 1,
    version,
    mandatory,
    allowDowngrade: false,
    notes,
    assets: [linux.asset, windows.asset],
  };
  validateReleaseMetadata(release);

  const existing = await readReleaseMetadata(client, config, version);
  if (existing && JSON.stringify(existing) !== JSON.stringify(release)) {
    throw new Error(`${version} already exists with different artifacts or release metadata`);
  }

  await Promise.all([
    uploadAsset(client, config, linux.asset, linux.file),
    uploadAsset(client, config, windows.asset, windows.file),
  ]);
  await putObject(
    client,
    config,
    releaseObjectKey(version),
    JSON.stringify(release, null, 2),
    'application/json',
    'no-store',
  );

  const payload: ManifestPayload = {
    schemaVersion: 1,
    channel: 'stable',
    version,
    releasedAt: new Date().toISOString(),
    mandatory,
    allowDowngrade: false,
    notes,
    keyId: keys.keyId,
    assets: release.assets,
  };
  const signed = signManifest(payload, keys.privateKey);
  await putObject(client, config, STABLE_KEY, JSON.stringify(signed), 'application/json', 'no-store');

  console.log(`Published ${version}${mandatory ? ' (mandatory)' : ''}`);
  console.log(`Manifest: https://mlup.mcnb.dev/v1/channels/stable.json`);
  for (const asset of release.assets) {
    console.log(`${asset.os}/${asset.arch}: ${asset.size} bytes, sha256 ${asset.sha256}`);
  }
}

async function inspectFile(
  file: string,
  version: string,
  os: 'linux' | 'windows',
  arch: 'amd64',
): Promise<{ asset: ReleaseAsset; file: string }> {
  const stat = statSync(file);
  if (!stat.isFile() || stat.size <= 0) throw new Error(`${file} is not a non-empty file`);
  if (stat.size > MAX_ASSET_SIZE) throw new Error(`${file} exceeds the 500 MiB update limit`);
  const data = readFileSync(file);
  return {
    file,
    asset: {
      os,
      arch,
      name: fileBaseName(file, version, os, arch),
      url: assetPath(version, os, arch),
      size: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
    },
  };
}

function fileBaseName(file: string, version: string, os: 'linux' | 'windows', arch: 'amd64'): string {
  const name = file.split(/[\\/]/).pop();
  const expected = `SamuelClient-${version}-${os}-${arch}${os === 'windows' ? '.exe' : ''}`;
  if (name !== expected) throw new Error(`${file} must be named ${expected}`);
  return name;
}

async function uploadAsset(
  client: ReturnType<typeof createStorageClient>,
  config: ReturnType<typeof storageConfig>,
  asset: ReleaseAsset,
  file: string,
): Promise<void> {
  const version = asset.url.split('/')[3];
  const key = assetObjectKey(version, asset.os, asset.arch);
  const existing = await headObject(client, config, key);
  if (existing) {
    if (existing.metadata?.sha256 === asset.sha256) return;
    const remote = await getObject(client, config, key);
    if (remote && createHash('sha256').update(remote).digest('hex') === asset.sha256) return;
    throw new Error(`refusing to overwrite immutable asset ${key}`);
  }
  await putObject(
    client,
    config,
    key,
    readFileSync(file),
    'application/octet-stream',
    immutableCacheControl,
    { sha256: asset.sha256 },
  );
}

async function readStableManifest(
  client: ReturnType<typeof createStorageClient>,
  config: ReturnType<typeof storageConfig>,
  publicKey: Parameters<typeof verifyManifest>[1],
): Promise<ManifestPayload | null> {
  const raw = await getObject(client, config, STABLE_KEY);
  return raw ? verifyManifest(raw.toString('utf8'), publicKey) : null;
}

async function readReleaseMetadata(
  client: ReturnType<typeof createStorageClient>,
  config: ReturnType<typeof storageConfig>,
  version: string,
): Promise<ReleaseMetadata | null> {
  const raw = await getObject(client, config, releaseObjectKey(version));
  if (!raw) return null;
  const value: unknown = JSON.parse(raw.toString('utf8'));
  validateReleaseMetadata(value);
  if (value.version !== version) throw new Error('release metadata version does not match its object key');
  return value;
}

function readNotes(args: Record<string, string | true>): string {
  const inline = args['--notes'];
  const notesFile = args['--notes-file'];
  if (inline !== undefined && notesFile !== undefined) throw new Error('use either --notes or --notes-file');
  if (inline === true || notesFile === true) throw new Error('--notes and --notes-file require a value');
  const notes = typeof inline === 'string' ? inline : notesFile ? readFileSync(resolve(notesFile), 'utf8').trim() : '';
  if (!notes) throw new Error('--notes or --notes-file is required');
  return notes;
}

function parseArgs(argv: string[]): Record<string, string | true> {
  const result: Record<string, string | true> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--mandatory') {
      result[flag] = true;
      continue;
    }
    if (!flag?.startsWith('--') || index + 1 >= argv.length) throw new Error(`invalid argument ${flag ?? ''}`);
    result[flag] = argv[++index];
  }
  return result;
}

function requiredArg(args: Record<string, string | true>, flag: string): string {
  const value = args[flag];
  if (typeof value !== 'string' || !value) throw new Error(`${flag} is required`);
  return value;
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
