import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readItem, writeItem } from '../src/keychain.js';
import { makeSandbox } from './helpers/sandbox.js';

test('a missing item reads as null', async (t) => {
  const box = await makeSandbox(t);
  assert.equal(await readItem(box.ctx, 'nothing-here'), null);
});

test('data round-trips through the keychain', async (t) => {
  const box = await makeSandbox(t);
  await writeItem(box.ctx, 'svc', { claudeAiOauth: { refreshToken: 'rt' } });
  assert.deepEqual(await readItem(box.ctx, 'svc'), { claudeAiOauth: { refreshToken: 'rt' } });
});

test('non-ASCII data survives, even though security prints it back as hex', async (t) => {
  const box = await makeSandbox(t);
  await writeItem(box.ctx, 'svc', { mcpOAuth: { '飞书': { accessToken: 'x' } } });
  assert.deepEqual(await readItem(box.ctx, 'svc'), { mcpOAuth: { '飞书': { accessToken: 'x' } } });
});

test('tokens stay out of the process list for ordinary payloads', async (t) => {
  const box = await makeSandbox(t);
  await writeItem(box.ctx, 'svc', { claudeAiOauth: { refreshToken: 'secret-token' } });
  const hex = Buffer.from('secret-token').toString('hex');
  for (const argv of await box.securityCalls()) {
    assert.ok(!argv.some((arg) => arg.includes('secret-token') || arg.includes(hex)), `leaked in ${argv}`);
  }
});

test('payloads too long for security -i still get written', async (t) => {
  const box = await makeSandbox(t);
  const big = { mcpOAuth: { server: { accessToken: 'x'.repeat(5000) } } };
  await writeItem(box.ctx, 'svc', big);
  assert.deepEqual(await readItem(box.ctx, 'svc'), big);
});

test('a rejected write is reported', async (t) => {
  const box = await makeSandbox(t);
  await box.failKeychainWrites(['svc']);
  await assert.rejects(writeItem(box.ctx, 'svc', { a: 1 }), /钥匙串/);
});
