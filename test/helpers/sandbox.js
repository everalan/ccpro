import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext } from '../../src/context.js';

const binDir = join(dirname(fileURLToPath(import.meta.url)), 'bin');

export function oauthAccount(email, overrides = {}) {
  return {
    accountUuid: `uuid-${email}`,
    emailAddress: email,
    organizationUuid: `org-${email}`,
    hasExtraUsageEnabled: false,
    billingType: 'stripe_subscription',
    accountCreatedAt: '2025-01-01T00:00:00.000Z',
    subscriptionCreatedAt: '2025-01-02T00:00:00.000Z',
    ccOnboardingFlags: {},
    claudeCodeTrialEndsAt: null,
    claudeCodeTrialDurationDays: null,
    seatTier: null,
    displayName: email,
    fullName: email,
    profileFetchedAt: 1760000000000,
    organizationRole: 'admin',
    workspaceRole: null,
    organizationName: `${email}'s Organization`,
    organizationType: 'claude_pro',
    organizationRateLimitTier: 'default_claude_ai',
    userRateLimitTier: null,
    ...overrides,
  };
}

export function oauthTokens(refreshToken, overrides = {}) {
  return {
    accessToken: `access-${refreshToken}`,
    refreshToken,
    expiresAt: Date.now() + 8 * 3600 * 1000,
    refreshTokenExpiresAt: Date.now() + 30 * 24 * 3600 * 1000,
    scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
    subscriptionType: 'pro',
    subscriptionTypeSource: 'sign_in',
    subscriptionTypeVerifiedAt: 1760000000000,
    rateLimitTier: 'default_claude_ai',
    clientId: 'client-id',
    ...overrides,
  };
}

export const DEFAULT_SERVICE = 'Claude Code-credentials';

export async function makeSandbox(t) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'ccpro-test-')));
  const readOnlyDirs = [];
  t.after(async () => {
    for (const dir of readOnlyDirs) await chmod(dir, 0o700);
    await rm(home, { recursive: true, force: true });
  });

  const env = {
    HOME: home,
    USER: 'tester',
    PATH: `${binDir}:${process.env.PATH}`,
  };

  const box = {
    home,
    env,
    ctx: createContext({ env, securityBin: join(binDir, 'security') }),
    globalConfigPath: join(home, '.claude.json'),

    profileDir: (email) => join(home, '.ccpro', 'profiles', email),
    // Derived here rather than through the code under test.
    profileService(email) {
      const hash = createHash('sha256').update(box.profileDir(email)).digest('hex').slice(0, 8);
      return `${DEFAULT_SERVICE}-${hash}`;
    },

    async keychain() {
      try {
        return JSON.parse(await readFile(join(home, 'fake-keychain.json'), 'utf8'));
      } catch {
        return {};
      }
    },
    async readItem(service) {
      const value = (await box.keychain())[`tester|${service}`];
      return value === undefined ? undefined : JSON.parse(value);
    },
    async writeItem(service, data) {
      const store = await box.keychain();
      store[`tester|${service}`] = JSON.stringify(data);
      await writeFile(join(home, 'fake-keychain.json'), JSON.stringify(store));
    },
    failKeychainWrites: (services) => writeFile(join(home, 'fake-keychain-fail.json'), JSON.stringify(services)),
    async securityCalls() {
      try {
        return (await readFile(join(home, 'fake-security.log'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    },

    readGlobalConfig: async () => JSON.parse(await readFile(box.globalConfigPath, 'utf8')),
    writeGlobalConfig: (config) => writeFile(box.globalConfigPath, JSON.stringify(config, null, 2)),
    configureClaude: (behaviour) => writeFile(join(home, 'fake-claude.json'), JSON.stringify(behaviour)),

    // Logs an account in the way Claude Code leaves things on disk.
    async login(email, refreshToken, extraItem = {}) {
      await box.writeItem(DEFAULT_SERVICE, { ...extraItem, claudeAiOauth: oauthTokens(refreshToken) });
      let config = {};
      try {
        config = await box.readGlobalConfig();
      } catch { /* first login */ }
      await box.writeGlobalConfig({ ...config, oauthAccount: oauthAccount(email) });
    },

    async makeReadOnly(dir) {
      await chmod(dir, 0o500);
      readOnlyDirs.push(dir);
    },
    mkdir: (dir) => mkdir(dir, { recursive: true }),
  };

  await mkdir(join(home, '.claude'), { recursive: true });
  return box;
}
