import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const KEYCHAIN_ACCOUNT_PATTERN = /^[a-zA-Z0-9._-]+$/;

export class CcproError extends Error {}

// Claude Code keeps the default login in one keychain item and gives every
// other config directory its own, named after a hash of the directory.
export function credentialService(configDir) {
  if (!configDir) return 'Claude Code-credentials';
  const hash = createHash('sha256').update(configDir.normalize('NFC')).digest('hex').slice(0, 8);
  return `Claude Code-credentials-${hash}`;
}

function keychainAccount(env) {
  const user = env.USER || os.userInfo().username;
  return KEYCHAIN_ACCOUNT_PATTERN.test(user) ? user : 'claude-code-user';
}

export function createContext({ env = process.env, ...overrides } = {}) {
  const home = env.HOME || os.homedir();
  const customDir = env.CLAUDE_CONFIG_DIR?.normalize('NFC');
  const configDir = customDir ?? path.join(home, '.claude');

  return {
    env,
    home,
    configDir,
    globalConfigFile: path.join(customDir ?? home, '.claude.json'),
    defaultService: credentialService(customDir),
    profilesDir: path.join(home, '.ccpro', 'profiles'),
    securityBin: '/usr/bin/security',
    keychainAccount: keychainAccount(env),
    lockRetries: { retries: 60, minTimeout: 100, maxTimeout: 500 },
    usageTimeoutMs: 20000,
    platform: process.platform,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    ...overrides,
  };
}
