import assert from 'node:assert/strict';
import { stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import lockfile from 'proper-lockfile';
import { listAccounts, removeAccount, saveCurrent } from '../src/accounts.js';
import { DEFAULT_SERVICE, makeSandbox } from './helpers/sandbox.js';

// Two saved accounts with a logged in.
async function twoAccounts(t, other = 'b@x.com') {
  const box = await makeSandbox(t);
  await box.login(other, 'rt-b');
  await saveCurrent(box.ctx);
  await box.login('a@x.com', 'rt-a');
  await saveCurrent(box.ctx);
  return box;
}

const exists = (path) => stat(path).then(() => true, () => false);

test('removing deletes the saved profile and its keychain item', async (t) => {
  const box = await twoAccounts(t);

  assert.equal(await removeAccount(box.ctx, 'b@x.com'), 'b@x.com');

  assert.equal(await exists(box.profileDir('b@x.com')), false);
  assert.equal(await box.readItem(box.profileService('b@x.com')), undefined);
  assert.deepEqual((await listAccounts(box.ctx)).map((account) => account.email), ['a@x.com']);
});

test('removing leaves the other accounts and the live login alone', async (t) => {
  const box = await twoAccounts(t);

  await removeAccount(box.ctx, 'b@x.com');

  assert.equal((await box.readItem(DEFAULT_SERVICE)).claudeAiOauth.refreshToken, 'rt-a');
  assert.equal((await box.readItem(box.profileService('a@x.com'))).claudeAiOauth.refreshToken, 'rt-a');
  assert.equal(await exists(box.profileDir('a@x.com')), true);
});

test('the current account cannot be removed', async (t) => {
  for (const typed of ['a@x.com', 'A@X.com']) {
    await t.test(typed, async (st) => {
      const box = await twoAccounts(st);

      await assert.rejects(removeAccount(box.ctx, typed), /当前/);

      assert.equal(await exists(box.profileDir('a@x.com')), true);
      assert.equal((await box.readItem(box.profileService('a@x.com'))).claudeAiOauth.refreshToken, 'rt-a');
    });
  }
});

test('removing an account that was never saved fails', async (t) => {
  const box = await twoAccounts(t);
  const before = await box.keychain();

  await assert.rejects(removeAccount(box.ctx, 'c@x.com'), /c@x\.com 未保存/);

  assert.deepEqual(await box.keychain(), before);
});

test('the email is matched regardless of case', async (t) => {
  const box = await twoAccounts(t, 'SoulMate@x.com');

  assert.equal(await removeAccount(box.ctx, 'soulmate@X.COM'), 'SoulMate@x.com');

  assert.equal(await box.readItem(box.profileService('SoulMate@x.com')), undefined);
  assert.deepEqual((await listAccounts(box.ctx)).map((account) => account.email), ['a@x.com']);
});

test('a failed keychain delete keeps the account listed', async (t) => {
  const box = await twoAccounts(t);
  await box.failKeychainWrites([box.profileService('b@x.com')]);

  await assert.rejects(removeAccount(box.ctx, 'b@x.com'), /钥匙串/);

  assert.equal((await box.readItem(box.profileService('b@x.com'))).claudeAiOauth.refreshToken, 'rt-b');
  assert.deepEqual((await listAccounts(box.ctx)).map((account) => account.email), ['a@x.com', 'b@x.com']);
});

test('a profile whose keychain item is already gone is still removed', async (t) => {
  const box = await twoAccounts(t);
  const store = await box.keychain();
  delete store[`tester|${box.profileService('b@x.com')}`];
  await writeFile(join(box.home, 'fake-keychain.json'), JSON.stringify(store));

  await removeAccount(box.ctx, 'b@x.com');

  assert.equal(await exists(box.profileDir('b@x.com')), false);
});

// A switch running at the same time could make the account current between
// the check and the delete.
test('removing waits for a switch that holds the config lock', async (t) => {
  const box = await twoAccounts(t);
  const lockPath = `${box.globalConfigPath}.lock`;
  const release = await lockfile.lock(lockPath, { lockfilePath: lockPath, realpath: false });
  t.after(() => release());
  const ctx = { ...box.ctx, lockRetries: { retries: 1, minTimeout: 10, maxTimeout: 10 } };

  await assert.rejects(removeAccount(ctx, 'b@x.com'), /稍后再试/);

  assert.equal(await exists(box.profileDir('b@x.com')), true);
});
