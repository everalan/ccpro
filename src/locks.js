import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import { CcproError } from './context.js';

const REFRESH_LOCK = { stale: 60000, update: 5000 };
const STORAGE_LOCK = { stale: 15000 };

// Taken in the order Claude Code takes them, so the two can never deadlock.
// Holding them keeps a token refresh from landing on top of a switch.
async function claudeLocks(ctx) {
  await mkdir(ctx.configDir, { recursive: true });
  const dir = ctx.configDir;
  const legacyRefreshLock = `${await realpath(dir)}.lock`;
  // proper-lockfile tracks held locks by `file`, so each entry needs its own.
  return [
    { file: dir, lockfilePath: path.join(dir, '.oauth_refresh.lock'), ...REFRESH_LOCK },
    { file: legacyRefreshLock, lockfilePath: legacyRefreshLock, ...REFRESH_LOCK },
    { file: path.join(dir, '.storage-write'), lockfilePath: path.join(dir, '.storage-write.lock'), ...STORAGE_LOCK },
    { file: ctx.globalConfigFile, lockfilePath: `${ctx.globalConfigFile}.lock` },
  ];
}

export async function withClaudeLocks(ctx, action) {
  const releases = [];
  try {
    for (const { file, ...options } of await claudeLocks(ctx)) {
      releases.push(await lockfile.lock(file, {
        ...options,
        realpath: false,
        retries: ctx.lockRetries,
        onCompromised: () => {},
      }));
    }
    return await action();
  } catch (error) {
    if (error.code === 'ELOCKED') throw new CcproError('Claude Code 正在更新登录信息，请稍后再试');
    throw error;
  } finally {
    for (const release of releases.reverse()) await release().catch(() => {});
  }
}
