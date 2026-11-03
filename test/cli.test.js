import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli.js';
import { saveCurrent } from '../src/accounts.js';
import { DEFAULT_SERVICE, makeSandbox } from './helpers/sandbox.js';

const binPath = fileURLToPath(new URL('../bin/ccpro.js', import.meta.url));
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

function capture() {
  const stream = new PassThrough();
  let text = '';
  stream.on('data', (chunk) => { text += chunk; });
  return { stream, text: () => text };
}

function interactive(box, overrides = {}) {
  const input = new PassThrough();
  input.isTTY = true;
  const stdout = capture();
  const stderr = capture();
  const ctx = { ...box.ctx, platform: 'darwin', stdin: input, stdout: stdout.stream, stderr: stderr.stream, ...overrides };
  return { ctx, input, stdout, stderr };
}

async function twoAccounts(t) {
  const box = await makeSandbox(t);
  await box.login('b@x.com', 'rt-b');
  await saveCurrent(box.ctx);
  await box.login('a@x.com', 'rt-a');
  await saveCurrent(box.ctx);
  return box;
}

const liveEmail = async (box) => (await box.readGlobalConfig()).oauthAccount.emailAddress;

test('--version prints the package version', () => {
  const result = spawnSync(process.execPath, [binPath, '--version'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), packageJson.version);
});

test('--help describes the commands', () => {
  const result = spawnSync(process.execPath, [binPath, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  for (const word of ['save', 'remove', '--help', '--version', '--update']) assert.ok(result.stdout.includes(word), word);
});

test('the executable exits non-zero for an unknown command', () => {
  const result = spawnSync(process.execPath, [binPath, 'nonsense'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /nonsense/);
});

test('--update installs the latest published package', async (t) => {
  const box = await makeSandbox(t);
  const { ctx } = interactive(box);

  assert.equal(await main(['--update'], ctx), 0);

  const argv = JSON.parse(await readFile(join(box.home, 'fake-npm.json'), 'utf8'));
  assert.deepEqual(argv, ['install', '-g', `${packageJson.name}@latest`]);
});

test('--update reports failure from npm', async (t) => {
  const box = await makeSandbox(t);
  await writeFile(join(box.home, 'fake-npm-exit'), '3');
  const { ctx } = interactive(box);

  assert.equal(await main(['--update'], ctx), 3);
});

test('save prints the account it stored', async (t) => {
  const box = await makeSandbox(t);
  await box.login('a@x.com', 'rt-a');
  const { ctx, stdout } = interactive(box);

  assert.equal(await main(['save'], ctx), 0);

  assert.match(stdout.text(), /a@x\.com/);
  assert.equal((await box.readItem(box.profileService('a@x.com'))).claudeAiOauth.refreshToken, 'rt-a');
});

test('save explains how to add the next account', async (t) => {
  const box = await makeSandbox(t);
  await box.login('a@x.com', 'rt-a');
  const { ctx, stdout } = interactive(box);

  await main(['save'], ctx);

  assert.match(stdout.text(), /claude auth login/);
  assert.doesNotMatch(stdout.text(), /logout/);
});

test('save takes no arguments', async (t) => {
  const box = await makeSandbox(t);
  await box.login('a@x.com', 'rt-a');
  const { ctx, stderr } = interactive(box);

  assert.equal(await main(['save', 'a@x.com'], ctx), 1);

  assert.match(stderr.text(), /save/);
  assert.equal(await box.readItem(box.profileService('a@x.com')), undefined);
});

test('remove deletes the account and says which one', async (t) => {
  const box = await twoAccounts(t);
  const { ctx, stdout } = interactive(box);

  assert.equal(await main(['remove', 'b@x.com'], ctx), 0);

  assert.match(stdout.text(), /b@x\.com/);
  assert.equal(await box.readItem(box.profileService('b@x.com')), undefined);
});

test('remove needs exactly one email', async (t) => {
  for (const args of [[], ['b@x.com', 'a@x.com']]) {
    await t.test(`${args.length} arguments`, async (st) => {
      const box = await twoAccounts(st);
      const { ctx, stderr } = interactive(box);

      assert.equal(await main(['remove', ...args], ctx), 1);

      assert.match(stderr.text().split('\n')[0], /remove.*邮箱/);
      assert.notEqual(await box.readItem(box.profileService('b@x.com')), undefined);
    });
  }
});

test('errors are printed instead of thrown', async (t) => {
  const box = await makeSandbox(t);
  const { ctx, stderr } = interactive(box);

  assert.equal(await main(['save'], ctx), 1);

  assert.match(stderr.text(), /未登录/);
});

test('picking an account switches to it and says to reopen windows', async (t) => {
  const box = await twoAccounts(t);
  const { ctx, input, stdout } = interactive(box);

  const running = main([], ctx);
  await new Promise((resolve) => setTimeout(resolve, 50));
  input.write('\r');

  assert.equal(await running, 0);
  assert.equal(await liveEmail(box), 'b@x.com');
  assert.equal((await box.readItem(DEFAULT_SERVICE)).claudeAiOauth.refreshToken, 'rt-b');
  assert.match(stdout.text(), /claude --resume/);
});

test('the list shows usage for every account', async (t) => {
  const box = await twoAccounts(t);
  await box.configureClaude({ usage: { 'a@x.com': { session: 10, week: 20 }, 'b@x.com': { session: 60, week: 70 } } });
  const { ctx, input, stdout } = interactive(box);

  const running = main([], ctx);
  await new Promise((resolve) => setTimeout(resolve, 600));
  input.write('\x03');
  await running;

  for (const remaining of ['90%', '80%', '40%', '30%']) assert.ok(stdout.text().includes(remaining), remaining);
});

test('switching waits for a usage run that is refreshing the target token', async (t) => {
  const box = await twoAccounts(t);
  await box.configureClaude({ delayMs: 400, rotate: { 'b@x.com': 'rt-b-rotated' } });
  const { ctx, input } = interactive(box);

  const running = main([], ctx);
  await new Promise((resolve) => setTimeout(resolve, 50));
  input.write('\r');
  await running;

  assert.equal((await box.readItem(DEFAULT_SERVICE)).claudeAiOauth.refreshToken, 'rt-b-rotated');
});

test('cancelling changes nothing', async (t) => {
  const box = await twoAccounts(t);
  const { ctx, input } = interactive(box);

  const running = main([], ctx);
  await new Promise((resolve) => setTimeout(resolve, 50));
  input.write('\x03');

  assert.equal(await running, 0);
  assert.equal(await liveEmail(box), 'a@x.com');
});

test('an empty list points at save', async (t) => {
  const box = await makeSandbox(t);
  const { ctx, stderr } = interactive(box);

  assert.equal(await main([], ctx), 1);

  assert.match(stderr.text(), /ccpro save/);
});

test('the list needs a terminal', async (t) => {
  const box = await twoAccounts(t);
  const { ctx, input, stderr } = interactive(box);
  input.isTTY = false;

  assert.equal(await main([], ctx), 1);

  assert.match(stderr.text(), /终端/);
});

test('only macOS is supported', async (t) => {
  const box = await twoAccounts(t);
  const { ctx, stderr } = interactive(box, { platform: 'linux' });

  assert.equal(await main(['save'], ctx), 1);

  assert.match(stderr.text(), /macOS/);
});

test('--help still works off macOS', async (t) => {
  const box = await makeSandbox(t);
  const { ctx } = interactive(box, { platform: 'linux' });
  assert.equal(await main(['--help'], ctx), 0);
});

test('the list is in colour in a terminal unless NO_COLOR is set', async (t) => {
  const cases = [
    { name: 'terminal', env: {}, want: true },
    { name: 'NO_COLOR', env: { NO_COLOR: '1' }, want: false },
  ];
  for (const { name, env, want } of cases) {
    await t.test(name, async (st) => {
      const box = await twoAccounts(st);
      const { ctx, input, stdout } = interactive(box);
      stdout.stream.isTTY = true;

      const running = main([], { ...ctx, env: { ...box.env, ...env } });
      await new Promise((resolve) => setTimeout(resolve, 50));
      input.write('\x03');
      await running;

      assert.equal(/\x1b\[[0-9;]*m/.test(stdout.text()), want);
    });
  }
});
