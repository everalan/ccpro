import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { saveCurrent } from '../src/accounts.js';
import { DEFAULT_SERVICE, makeSandbox, oauthAccount, oauthTokens } from './helpers/sandbox.js';

test('save stores the logged-in account under the email from its account info', async (t) => {
  const box = await makeSandbox(t);
  await box.login('a@x.com', 'rt-a');

  assert.equal(await saveCurrent(box.ctx), 'a@x.com');

  const item = await box.readItem(box.profileService('a@x.com'));
  assert.equal(item.claudeAiOauth.refreshToken, 'rt-a');
  const profile = JSON.parse(await readFile(join(box.profileDir('a@x.com'), '.claude.json'), 'utf8'));
  assert.deepEqual(profile.oauthAccount, oauthAccount('a@x.com'));
});

test('save leaves MCP logins out of the saved copy', async (t) => {
  const box = await makeSandbox(t);
  await box.login('a@x.com', 'rt-a', { mcpOAuth: { server: { accessToken: 'mcp' } } });

  await saveCurrent(box.ctx);

  assert.equal((await box.readItem(box.profileService('a@x.com'))).mcpOAuth, undefined);
});

test('saving again keeps the newest tokens', async (t) => {
  const box = await makeSandbox(t);
  await box.login('a@x.com', 'rt-1');
  await saveCurrent(box.ctx);
  await box.login('a@x.com', 'rt-2');

  await saveCurrent(box.ctx);

  assert.equal((await box.readItem(box.profileService('a@x.com'))).claudeAiOauth.refreshToken, 'rt-2');
});

test('a saved profile can be started without onboarding', async (t) => {
  const box = await makeSandbox(t);
  await box.login('a@x.com', 'rt-a');
  await saveCurrent(box.ctx);

  const profile = JSON.parse(await readFile(join(box.profileDir('a@x.com'), '.claude.json'), 'utf8'));
  assert.equal(profile.hasCompletedOnboarding, true);
});

test('saving refuses when nobody is logged in', async (t) => {
  const box = await makeSandbox(t);
  await assert.rejects(saveCurrent(box.ctx), /未登录/);
  assert.deepEqual(await box.keychain(), {});
});

test('saving refuses when the account has no usable token', async (t) => {
  const cases = [
    { name: 'keychain empty', item: undefined },
    { name: 'token cleared by Claude Code', item: { claudeAiOauth: oauthTokens('', { accessToken: '' }) } },
  ];
  for (const { name, item } of cases) {
    await t.test(name, async (st) => {
      const box = await makeSandbox(st);
      await box.writeGlobalConfig({ oauthAccount: oauthAccount('a@x.com') });
      if (item) await box.writeItem(DEFAULT_SERVICE, item);

      await assert.rejects(saveCurrent(box.ctx), /未登录/);
      assert.equal(await box.readItem(box.profileService('a@x.com')), undefined);
    });
  }
});

test('a corrupt config file is reported rather than treated as logged out', async (t) => {
  const box = await makeSandbox(t);
  await box.writeItem(DEFAULT_SERVICE, { claudeAiOauth: oauthTokens('rt-a') });
  await import('node:fs/promises').then((fs) => fs.writeFile(box.globalConfigPath, '{not json'));

  await assert.rejects(saveCurrent(box.ctx), /无法解析/);
});
