import { loadSigningKeys } from '../src/keys';
import {
  compareVersions,
  normalizeVersion,
  signManifest,
  validateReleaseMetadata,
  verifyManifest,
  type ManifestPayload,
  type ReleaseMetadata,
} from '../src/manifest';
import { createStorageClient, getObject, putObject, storageConfig } from '../src/storage';

const STABLE_KEY = 'manifests/stable.json';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const version = normalizeVersion(requiredArg(args, '--version'));
  const notes = typeof args['--notes'] === 'string' && args['--notes'].trim()
    ? args['--notes'].trim()
    : `Rollback to ${version} after a problematic stable release.`;
  const keys = loadSigningKeys();
  const config = storageConfig();
  const client = createStorageClient(config);

  const currentRaw = await getObject(client, config, STABLE_KEY);
  if (!currentRaw) throw new Error('there is no active stable manifest to roll back');
  const current = verifyManifest(currentRaw.toString('utf8'), keys.publicKey);
  if (compareVersions(version, current.version) >= 0) {
    throw new Error('rollback target must be older than the active stable version');
  }

  const release = await readRelease(client, config, version);
  const payload: ManifestPayload = {
    schemaVersion: 1,
    channel: 'stable',
    version,
    releasedAt: new Date().toISOString(),
    mandatory: true,
    allowDowngrade: true,
    notes,
    keyId: keys.keyId,
    assets: release.assets,
  };
  const signed = signManifest(payload, keys.privateKey);
  await putObject(client, config, STABLE_KEY, JSON.stringify(signed), 'application/json', 'no-store');
  console.log(`Rolled stable back to ${version}; clients on ${current.version} will be required to downgrade`);
}

async function readRelease(
  client: ReturnType<typeof createStorageClient>,
  config: ReturnType<typeof storageConfig>,
  version: string,
): Promise<ReleaseMetadata> {
  const raw = await getObject(client, config, `releases/${version}/release.json`);
  if (!raw) throw new Error(`release metadata for ${version} does not exist`);
  const value: unknown = JSON.parse(raw.toString('utf8'));
  validateReleaseMetadata(value);
  if (value.version !== version) throw new Error('release metadata version does not match its object key');
  return value;
}

function parseArgs(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag?.startsWith('--') || index + 1 >= argv.length) throw new Error(`invalid argument ${flag ?? ''}`);
    result[flag] = argv[++index];
  }
  return result;
}

function requiredArg(args: Record<string, string>, flag: string): string {
  const value = args[flag];
  if (!value) throw new Error(`${flag} is required`);
  return value;
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
