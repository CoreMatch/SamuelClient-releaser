import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { StorageClient } from './storage';

const execFileAsync = promisify(execFile);
const wranglerCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx';

export function createWranglerStorage(bucket: string): StorageClient {
  return {
    async getObject(key) {
      const directory = mkdtempSync(join(tmpdir(), 'samuelclient-r2-'));
      const file = join(directory, 'object');
      try {
        await run(['r2', 'object', 'get', `${bucket}/${key}`, '--file', file, '--remote']);
        return readFileSync(file);
      } catch (error) {
        if (isMissingObject(error)) return null;
        throw error;
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },

    async headObject(key) {
      return await this.getObject(key) ? {} : null;
    },

    async putObject(key, body, contentType, cacheControl) {
      const directory = mkdtempSync(join(tmpdir(), 'samuelclient-r2-'));
      const file = join(directory, 'object');
      try {
        writeFileSync(file, body);
        await run([
          'r2', 'object', 'put', `${bucket}/${key}`,
          '--file', file,
          '--content-type', contentType,
          '--cache-control', cacheControl,
          '--remote',
        ]);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  };
}

async function run(args: string[]): Promise<void> {
  try {
    await execFileAsync(wranglerCommand, ['wrangler', ...args], {
      maxBuffer: 1024 * 1024,
      timeout: 15 * 60 * 1000,
    });
  } catch (error) {
    const failure = error as Error & { stderr?: string };
    throw new Error(failure.stderr?.trim() || failure.message);
  }
}

function isMissingObject(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const message = 'message' in error && typeof error.message === 'string' ? error.message : '';
  return message.includes('The specified key does not exist.');
}
