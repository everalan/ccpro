import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listAccounts, saveCurrent } from '../src/accounts.js';
import { fetchUsage, parseUsage } from '../src/usage.js';
import { makeSandbox } from './helpers/sandbox.js';

// Captured from a real `claude -p /usage` run.
const REAL_OUTPUT = `You are currently using your subscription to power your Claude Code usage

Current session: 7% used · resets Oct 30 at 6:50pm (Asia/Singapore)
Current week (all models): 5% used · resets Nov 5 at 4pm (Asia/Singapore)
Current week (Fable): 0% used · resets Nov 5 at 4pm (Asia/Singapore)

What's contributing to your usage?
Approximate · sessions on this machine only · shares overlap

Last 24h · 324 requests · 6 sessions
  88%  Give "general-purpose" subagents a cheaper model
`;

test('usage text becomes remaining percentages', () => {
  // 12:00 on Oct 30 in Singapore.
  const now = Date.UTC(2026, 9, 30, 4, 0);
  const cases = [
    {
      name: 'real output',
      text: REAL_OUTPUT,
      want: {
        session: { remaining: 93, resetsAt: Date.UTC(2026, 9, 30, 10, 50) },
        week: { remaining: 95, resetsAt: Date.UTC(2026, 10, 5, 8, 0) },
      },
    },
    {
      name: 'fully used window',
      text: 'Current session: 100% used · resets Oct 30 at 6:50pm (Asia/Singapore)\nCurrent week (all models): 40% used · resets Nov 5 at 4pm (Asia/Singapore)',
      want: {
        session: { remaining: 0, resetsAt: Date.UTC(2026, 9, 30, 10, 50) },
        week: { remaining: 60, resetsAt: Date.UTC(2026, 10, 5, 8, 0) },
      },
    },
    {
      name: 'window that has not started has no reset time',
      text: 'Current session: 0% used\nCurrent week (all models): 12% used · resets Nov 5 at 4pm (Asia/Singapore)',
      want: {
        session: { remaining: 100, resetsAt: null },
        week: { remaining: 88, resetsAt: Date.UTC(2026, 10, 5, 8, 0) },
      },
    },
    {
      name: 'plan with a single weekly limit',
      text: 'Current session: 10% used · resets Oct 30 at 6:50pm (Asia/Singapore)\nCurrent week: 20% used · resets Nov 5 at 4pm (Asia/Singapore)',
      want: {
        session: { remaining: 90, resetsAt: Date.UTC(2026, 9, 30, 10, 50) },
        week: { remaining: 80, resetsAt: Date.UTC(2026, 10, 5, 8, 0) },
      },
    },
    {
      name: 'report from a logged-out config',
      text: 'Total cost:            $0.0000\nTotal duration (API):  0s',
      want: null,
    },
  ];
  for (const { name, text, want } of cases) assert.deepEqual(parseUsage(text, now), want, name);
});

test('reset times become the moment they happen', () => {
  const noonInSingapore = Date.UTC(2026, 9, 30, 4, 0);
  const cases = [
    { text: 'Oct 30 at 6:50pm (Asia/Singapore)', now: noonInSingapore, want: Date.UTC(2026, 9, 30, 10, 50) },
    { text: 'Oct 30, 6:50pm (Asia/Singapore)', now: noonInSingapore, want: Date.UTC(2026, 9, 30, 10, 50) },
    { text: 'Oct 31 at 12am (Asia/Singapore)', now: noonInSingapore, want: Date.UTC(2026, 9, 30, 16, 0) },
    { text: 'Oct 31 at 12pm (Asia/Singapore)', now: noonInSingapore, want: Date.UTC(2026, 9, 31, 4, 0) },
    { text: '6:50pm (Asia/Singapore)', now: noonInSingapore, want: Date.UTC(2026, 9, 30, 10, 50) },
    { text: '2am (Asia/Singapore)', now: noonInSingapore, want: Date.UTC(2026, 9, 30, 18, 0) },
    { text: 'Jan 2 at 4pm (Asia/Singapore)', now: Date.UTC(2026, 11, 30, 4, 0), want: Date.UTC(2027, 0, 2, 8, 0) },
    { text: 'Jan 2, 2027 at 4pm (Asia/Singapore)', now: noonInSingapore, want: Date.UTC(2027, 0, 2, 8, 0) },
    { text: 'Oct 30 at 6:50pm (Asia/Shanghai)', now: noonInSingapore, want: Date.UTC(2026, 9, 30, 10, 50) },
    { text: 'Oct 30 at 6:50pm', now: noonInSingapore, want: Date.UTC(2026, 9, 30, 10, 50) },
  ];
  for (const { text, now, want } of cases) {
    const usage = parseUsage(`Current session: 50% used · resets ${text}`, now);
    assert.equal(usage.session.resetsAt, want, text);
  }
});

test('a reset time it cannot read is left unknown', () => {
  const usage = parseUsage('Current session: 50% used · resets whenever', Date.UTC(2026, 9, 30, 4, 0));
  assert.deepEqual(usage.session, { remaining: 50, resetsAt: null });
});

async function accountsFixture(t) {
  const box = await makeSandbox(t);
  await box.login('b@x.com', 'rt-b');
  await saveCurrent(box.ctx);
  await box.login('a@x.com', 'rt-a');
  await saveCurrent(box.ctx);
  await box.configureClaude({ usage: { 'a@x.com': { session: 10, week: 20 }, 'b@x.com': { session: 60, week: 70 } } });
  const accounts = await listAccounts(box.ctx);
  return { box, current: accounts[0], other: accounts[1] };
}

test('the current account reports through the normal config', async (t) => {
  const { box, current } = await accountsFixture(t);
  assert.equal((await fetchUsage(box.ctx, current)).session.remaining, 90);
});

test('a saved account reports through its own config directory', async (t) => {
  const { box, other } = await accountsFixture(t);
  assert.equal((await fetchUsage(box.ctx, other)).session.remaining, 40);
});

test('the current account never reads its stale saved copy', async (t) => {
  const { box, current } = await accountsFixture(t);
  assert.notEqual(current.dir, null);
  await box.login('a@x.com', 'rt-a-rotated');

  await box.configureClaude({ usage: { 'a@x.com': { session: 10, week: 20 } }, rotate: { 'a@x.com': 'rt-a-after-usage' } });
  await fetchUsage(box.ctx, current);

  const saved = await box.readItem(box.profileService('a@x.com'));
  assert.equal(saved.claudeAiOauth.refreshToken, 'rt-a');
});

test('login overrides in the environment do not hide the stored account', async (t) => {
  const { box, other } = await accountsFixture(t);
  const ctx = { ...box.ctx, env: { ...box.env, CLAUDE_CODE_OAUTH_TOKEN: 'env-token' } };
  assert.equal((await fetchUsage(ctx, other)).session.remaining, 40);
});

test('usage is unknown when claude cannot answer', async (t) => {
  const cases = [
    { name: 'exits with an error', behaviour: { exitCode: 1 } },
    { name: 'prints no usage', behaviour: {} },
  ];
  for (const { name, behaviour } of cases) {
    await t.test(name, async (st) => {
      const { box, other } = await accountsFixture(st);
      await box.configureClaude(behaviour);
      assert.equal(await fetchUsage(box.ctx, other), null);
    });
  }
});

test('usage is unknown when claude is missing', async (t) => {
  const { box, other } = await accountsFixture(t);
  const ctx = { ...box.ctx, env: { ...box.env, PATH: '/nonexistent' } };
  assert.equal(await fetchUsage(ctx, other), null);
});

test('usage is unknown when claude takes too long', async (t) => {
  const { box, other } = await accountsFixture(t);
  await box.configureClaude({ delayMs: 2000, usage: { 'b@x.com': { session: 60, week: 70 } } });
  const started = Date.now();

  assert.equal(await fetchUsage({ ...box.ctx, usageTimeoutMs: 200 }, other), null);

  assert.ok(Date.now() - started < 1500);
});
