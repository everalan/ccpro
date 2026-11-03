import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, readlink, rename, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import lockfile from 'proper-lockfile';
import { listAccounts, saveCurrent, switchTo } from '../src/accounts.js';
import { DEFAULT_SERVICE, makeSandbox, oauthAccount, oauthTokens } from './helpers/sandbox.js';

// Two saved accounts with a logged in, the state most tests start from.
async function twoAccounts(t) {
  const box = await makeSandbox(t);
  await box.login('b@x.com', 'rt-b');
  await saveCurrent(box.ctx);
  await box.login('a@x.com', 'rt-a');
  await saveCurrent(box.ctx);
  return box;
}

const liveRefreshToken = async (box) => (await box.readItem(DEFAULT_SERVICE)).claudeAiOauth.refreshToken;
const liveEmail = async (box) => (await box.readGlobalConfig()).oauthAccount.emailAddress;

test('switching makes the target the login Claude Code uses', async (t) => {
  const box = await twoAccounts(t);

  await switchTo(box.ctx, 'b@x.com');

  assert.equal(await liveRefreshToken(box), 'rt-b');
  assert.deepEqual((await box.readGlobalConfig()).oauthAccount, oauthAccount('b@x.com'));
});

test('switching keeps MCP logins in place', async (t) => {
  const box = await makeSandbox(t);
  await box.login('b@x.com', 'rt-b');
  await saveCurrent(box.ctx);
  const mcpOAuth = { server: { accessToken: 'mcp-token' } };
  await box.login('a@x.com', 'rt-a', { mcpOAuth });

  await switchTo(box.ctx, 'b@x.com');

  assert.deepEqual((await box.readItem(DEFAULT_SERVICE)).mcpOAuth, mcpOAuth);
});

test('switching leaves the rest of the config alone', async (t) => {
  const box = await twoAccounts(t);
  const config = await box.readGlobalConfig();
  await box.writeGlobalConfig({ ...config, projects: { '/repo': { trusted: true } }, numStartups: 7 });

  await switchTo(box.ctx, 'b@x.com');

  const after = await box.readGlobalConfig();
  assert.deepEqual(after.projects, { '/repo': { trusted: true } });
  assert.equal(after.numStartups, 7);
});

test('a token rotated since the last save survives a round trip', async (t) => {
  const box = await twoAccounts(t);
  await box.login('a@x.com', 'rt-a-rotated');

  await switchTo(box.ctx, 'b@x.com');
  await switchTo(box.ctx, 'a@x.com');

  assert.equal(await liveRefreshToken(box), 'rt-a-rotated');
});

test('an unsaved current account is saved before switching away', async (t) => {
  const box = await twoAccounts(t);
  await box.login('c@x.com', 'rt-c');

  await switchTo(box.ctx, 'b@x.com');

  assert.equal((await box.readItem(box.profileService('c@x.com'))).claudeAiOauth.refreshToken, 'rt-c');
  await switchTo(box.ctx, 'c@x.com');
  assert.equal(await liveEmail(box), 'c@x.com');
});

test('switching to the current account changes nothing', async (t) => {
  const box = await twoAccounts(t);
  const before = await box.keychain();

  const result = await switchTo(box.ctx, 'a@x.com');

  assert.equal(result.changed, false);
  assert.deepEqual(await box.keychain(), before);
});

test('switching works when nobody is logged in', async (t) => {
  const box = await twoAccounts(t);
  await box.writeItem(DEFAULT_SERVICE, {});
  const config = await box.readGlobalConfig();
  delete config.oauthAccount;
  await box.writeGlobalConfig(config);

  await switchTo(box.ctx, 'b@x.com');

  assert.equal(await liveEmail(box), 'b@x.com');
  assert.equal(await liveRefreshToken(box), 'rt-b');
});

test('a dead current token never replaces the saved copy', async (t) => {
  const box = await twoAccounts(t);
  await box.writeItem(DEFAULT_SERVICE, { claudeAiOauth: oauthTokens('', { accessToken: '', expiresAt: 0 }) });

  await switchTo(box.ctx, 'b@x.com');

  assert.equal((await box.readItem(box.profileService('a@x.com'))).claudeAiOauth.refreshToken, 'rt-a');
});

test('switching refuses a target that cannot log in', async (t) => {
  const cases = [
    { name: 'token cleared by Claude Code', tokens: oauthTokens('', { accessToken: '' }) },
    { name: 'refresh token past its expiry', tokens: oauthTokens('rt-b', { refreshTokenExpiresAt: Date.now() - 1000 }) },
  ];
  for (const { name, tokens } of cases) {
    await t.test(name, async (st) => {
      const box = await twoAccounts(st);
      await box.writeItem(box.profileService('b@x.com'), { claudeAiOauth: tokens });

      await assert.rejects(switchTo(box.ctx, 'b@x.com'), /重新登录/);

      assert.equal(await liveRefreshToken(box), 'rt-a');
      assert.equal(await liveEmail(box), 'a@x.com');
    });
  }
});

test('a refresh token with no recorded expiry is accepted', async (t) => {
  const box = await twoAccounts(t);
  await box.writeItem(box.profileService('b@x.com'), { claudeAiOauth: oauthTokens('rt-b', { refreshTokenExpiresAt: undefined }) });

  await switchTo(box.ctx, 'b@x.com');

  assert.equal(await liveEmail(box), 'b@x.com');
});

test('switching to an unknown account fails', async (t) => {
  const box = await twoAccounts(t);
  await assert.rejects(switchTo(box.ctx, 'nobody@x.com'), /未保存/);
  assert.equal(await liveEmail(box), 'a@x.com');
});

test('a failed write-back stops before the live login is touched', async (t) => {
  const box = await twoAccounts(t);
  await box.failKeychainWrites([box.profileService('a@x.com')]);

  await assert.rejects(switchTo(box.ctx, 'b@x.com'), /钥匙串/);

  assert.equal(await liveRefreshToken(box), 'rt-a');
  assert.equal(await liveEmail(box), 'a@x.com');
});

test('a failed keychain swap leaves the config on the old account', async (t) => {
  const box = await twoAccounts(t);
  await box.failKeychainWrites([DEFAULT_SERVICE]);

  await assert.rejects(switchTo(box.ctx, 'b@x.com'), /钥匙串/);

  assert.equal(await liveEmail(box), 'a@x.com');
});

test('a failed config write rolls the keychain back', async (t) => {
  const box = await twoAccounts(t);
  const dotfiles = join(box.home, 'dotfiles');
  await mkdir(dotfiles);
  await rename(box.globalConfigPath, join(dotfiles, 'claude.json'));
  await symlink(join(dotfiles, 'claude.json'), box.globalConfigPath);
  await box.makeReadOnly(dotfiles);

  await assert.rejects(switchTo(box.ctx, 'b@x.com'));

  assert.equal(await liveRefreshToken(box), 'rt-a');
  assert.equal(await liveEmail(box), 'a@x.com');
});

test('a symlinked config stays a symlink', async (t) => {
  const box = await twoAccounts(t);
  const real = join(box.home, 'claude.json');
  await rename(box.globalConfigPath, real);
  await symlink(real, box.globalConfigPath);

  await switchTo(box.ctx, 'b@x.com');

  assert.ok((await lstat(box.globalConfigPath)).isSymbolicLink());
  assert.equal(await readlink(box.globalConfigPath), real);
  assert.equal(JSON.parse(await readFile(real, 'utf8')).oauthAccount.emailAddress, 'b@x.com');
});

test('the config keeps its private file mode', async (t) => {
  const box = await twoAccounts(t);

  await switchTo(box.ctx, 'b@x.com');

  assert.equal((await stat(box.globalConfigPath)).mode & 0o777, 0o600);
});

const CLAUDE_LOCKS = [
  { name: 'token refresh', path: (box) => join(box.home, '.claude', '.oauth_refresh.lock'), stale: 60000 },
  { name: 'legacy token refresh', path: (box) => join(box.home, '.claude.lock'), stale: 60000 },
  { name: 'credential write', path: (box) => join(box.home, '.claude', '.storage-write.lock'), stale: 15000 },
  { name: 'config write', path: (box) => join(box.home, '.claude.json.lock'), stale: 10000 },
];

test('switching waits for each lock Claude Code may hold', async (t) => {
  for (const { name, path, stale } of CLAUDE_LOCKS) {
    await t.test(name, async (st) => {
      const box = await twoAccounts(st);
      const release = await lockfile.lock(path(box), { lockfilePath: path(box), realpath: false, stale });

      const switching = switchTo(box.ctx, 'b@x.com');
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(await liveEmail(box), 'a@x.com');

      await release();
      await switching;
      assert.equal(await liveEmail(box), 'b@x.com');
    });
  }
});

test('a lock that is never released gives up with an explanation', async (t) => {
  const box = await twoAccounts(t);
  const lockPath = join(box.home, '.claude', '.storage-write.lock');
  const release = await lockfile.lock(lockPath, { lockfilePath: lockPath, realpath: false, stale: 15000 });
  t.after(() => release());
  const ctx = { ...box.ctx, lockRetries: { retries: 1, minTimeout: 10, maxTimeout: 10 } };

  await assert.rejects(switchTo(ctx, 'b@x.com'), /稍后再试/);

  assert.equal(await liveEmail(box), 'a@x.com');
});

test('all locks are released afterwards', async (t) => {
  const box = await twoAccounts(t);

  await switchTo(box.ctx, 'b@x.com');

  for (const { path } of CLAUDE_LOCKS) {
    await assert.rejects(stat(path(box)), { code: 'ENOENT' });
  }
});

test('the list shows saved accounts and marks the current one', async (t) => {
  const box = await twoAccounts(t);

  const accounts = await listAccounts(box.ctx);

  assert.deepEqual(accounts.map(({ email, current }) => ({ email, current })), [
    { email: 'a@x.com', current: true },
    { email: 'b@x.com', current: false },
  ]);
});

test('the list includes a current account that was never saved', async (t) => {
  const box = await twoAccounts(t);
  await box.login('c@x.com', 'rt-c');

  const accounts = await listAccounts(box.ctx);

  assert.deepEqual(accounts.map(({ email, current }) => ({ email, current })), [
    { email: 'c@x.com', current: true },
    { email: 'a@x.com', current: false },
    { email: 'b@x.com', current: false },
  ]);
});

test('the list is empty before anything is saved or logged in', async (t) => {
  const box = await makeSandbox(t);
  assert.deepEqual(await listAccounts(box.ctx), []);
});
