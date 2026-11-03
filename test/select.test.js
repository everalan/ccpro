import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { selectAccount } from '../src/select.js';

const UP = '\x1b[A';
const DOWN = '\x1b[B';
const ENTER = '\r';
const CTRL_C = '\x03';
const ESC = '\x1b';

// Wall-clock time in Beijing and Singapore, which are both UTC+8.
const utc8 = (year, month, day, hour, minute) => Date.UTC(year, month, day, hour - 8, minute);
const NOW = utc8(2026, 10, 3, 16, 40);

function harness(accounts, options = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  if (options.columns) output.columns = options.columns;
  let written = '';
  output.on('data', (chunk) => { written += chunk; });
  return {
    input,
    output,
    written: () => written,
    // The screen as last drawn, without terminal control sequences.
    frame: () => written.split(/\x1b\[\d+A\x1b\[0J/).at(-1).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''),
    press: (...keys) => { for (const key of keys) input.write(key); },
    run: () => selectAccount({ accounts, input, output, now: () => NOW, color: options.color ?? false }),
  };
}

function displayWidth(text) {
  let total = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    total += (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xff00 && cp <= 0xff60) ? 2 : 1;
  }
  return total;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const lineWith = (frame, text) => frame.split('\n').find((line) => line.includes(text));
const detailLine = (frame) => {
  const lines = frame.split('\n');
  return lines[lines.findIndex((line) => line.startsWith('├')) + 1];
};

const usage = (session, week) => ({
  session: { remaining: session, resetsAt: utc8(2026, 10, 3, 18, 50) },
  week: { remaining: week, resetsAt: utc8(2026, 10, 5, 16, 0) },
});

const accounts = () => [
  { email: 'a@x.com', current: true, usage: Promise.resolve(null) },
  { email: 'b@x.com', current: false, usage: Promise.resolve(null) },
  { email: 'c@x.com', current: false, usage: Promise.resolve(null) },
];

test('the cursor starts on the first account you can switch to', async () => {
  const h = harness(accounts());
  const selection = h.run();
  h.press(ENTER);
  assert.equal(await selection, 'b@x.com');
});

test('the cursor starts on the first row when no account is current', async () => {
  const h = harness(accounts().map((account) => ({ ...account, current: false })));
  const selection = h.run();
  h.press(ENTER);
  assert.equal(await selection, 'a@x.com');
});

test('arrow keys move the cursor', async () => {
  const cases = [
    { keys: [DOWN], want: 'c@x.com' },
    { keys: [UP], want: 'a@x.com' },
    { keys: [DOWN, UP], want: 'b@x.com' },
    { keys: [DOWN, DOWN], want: 'a@x.com' },
    { keys: [UP, UP], want: 'c@x.com' },
  ];
  for (const { keys, want } of cases) {
    const h = harness(accounts());
    const selection = h.run();
    h.press(...keys, ENTER);
    assert.equal(await selection, want, JSON.stringify(keys));
  }
});

test('cancelling returns no selection', async () => {
  for (const key of [CTRL_C, ESC]) {
    const h = harness(accounts());
    const selection = h.run();
    h.press(key);
    assert.equal(await selection, null);
  }
});

test('the input stops being read once a choice is made', async () => {
  const h = harness(accounts());
  const selection = h.run();
  h.press(ENTER);
  await selection;
  assert.equal(h.input.listenerCount('keypress'), 0);
});

test('the current account is starred right after its email', async () => {
  const h = harness(accounts());
  const selection = h.run();
  await settle();
  h.press(ENTER);
  await selection;
  assert.ok(h.frame().includes('a@x.com ∗'));
  assert.doesNotMatch(lineWith(h.frame(), 'b@x.com'), /∗/);
});

test('the current account is drawn in green', async () => {
  const h = harness(accounts(), { color: true });
  const selection = h.run();
  await settle();
  h.press(ENTER);
  await selection;
  assert.match(h.written(), /\x1b\[32ma@x\.com ∗/);
  assert.doesNotMatch(h.written(), /\x1b\[32m(?:\x1b\[1m)?b@x\.com/);
});

test('the selected account is not bold', async () => {
  const cases = [
    { name: 'another account', keys: [], email: 'b@x.com' },
    { name: 'the current account', keys: [UP], email: 'a@x.com' },
  ];
  for (const { name, keys, email } of cases) {
    const h = harness([
      { email: 'a@x.com', current: true, usage: Promise.resolve(usage(93, 95)) },
      { email: 'b@x.com', current: false, usage: Promise.resolve(usage(80, 62)) },
    ], { color: true });
    const selection = h.run();
    await settle();
    h.press(...keys, ENTER);
    assert.equal(await selection, email, name);
    const lines = h.written().split(/\x1b\[\d+A\x1b\[0J/).at(-1).split('\n');
    const selectedRow = lines.find((line) => line.includes('❯'));
    const detail = lines[lines.findIndex((line) => line.includes('├')) + 1];
    assert.ok(selectedRow.includes(email), name);
    assert.doesNotMatch(selectedRow, /\x1b\[1m/, `${name}: row`);
    assert.doesNotMatch(detail, /\x1b\[1m/, `${name}: detail`);
  }
});

test('colour stays off unless asked for', async () => {
  const h = harness([
    { email: 'a@x.com', current: true, usage: Promise.resolve(usage(93, 95)) },
    { email: 'b@x.com', current: false, usage: Promise.resolve(usage(0, 40)) },
  ]);
  const selection = h.run();
  await settle();
  h.press(ENTER);
  await selection;
  assert.doesNotMatch(h.written(), /\x1b\[[0-9;]*m/);
});

test('percentages take the colour of their row', async () => {
  const h = harness([
    { email: 'a@x.com', current: true, usage: Promise.resolve(usage(93, 15)) },
    { email: 'b@x.com', current: false, usage: Promise.resolve(usage(0, 40)) },
  ], { color: true });
  const selection = h.run();
  await settle();
  h.press(ENTER);
  await selection;
  const rows = h.written().split(/\x1b\[\d+A\x1b\[0J/).at(-1).split('\n');
  const current = rows.find((row) => row.includes('a@x.com'));
  const other = rows.find((row) => row.includes('b@x.com'));

  for (const value of ['93%', '15%']) assert.match(current, new RegExp(`\\x1b\\[32m *${value}`), value);
  for (const value of ['0%', '40%']) {
    assert.ok(other.includes(value), value);
    assert.doesNotMatch(other, new RegExp(`\\x1b\\[3[0-7]m *${value}`), value);
  }
});

test('bars are twelve cells wide and show what is left', async () => {
  const h = harness([
    { email: 'a@x.com', current: true, usage: Promise.resolve(usage(93, 50)) },
    { email: 'b@x.com', current: false, usage: Promise.resolve(usage(0, 100)) },
  ]);
  const selection = h.run();
  await settle();
  h.press(ENTER);
  await selection;
  const current = lineWith(h.frame(), 'a@x.com');
  const other = lineWith(h.frame(), 'b@x.com');
  assert.ok(current.includes(`${'▰'.repeat(11)}▱  93%`), current);
  assert.ok(current.includes(`${'▰'.repeat(6)}${'▱'.repeat(6)}  50%`), current);
  assert.ok(other.includes(`${'▱'.repeat(12)}   0%`), other);
  assert.ok(other.includes(`${'▰'.repeat(12)} 100%`), other);
});

test('the box lines up whatever each row shows', async () => {
  const h = harness([
    { email: 'work@example.com', current: true, usage: Promise.resolve(usage(93, 95)) },
    { email: 'alt@example.com', current: false, usage: new Promise(() => {}) },
    { email: 'backup@example.com', current: false, usage: Promise.resolve(usage(0, 40)) },
    { email: 'old@example.com', current: false, usage: Promise.resolve(null) },
  ]);
  const selection = h.run();
  await settle();
  const boxLines = h.frame().split('\n').filter((line) => /^[╭│├╰]/.test(line));
  h.press(ENTER);
  await selection;

  assert.equal(boxLines.length, 4 + 6);
  assert.equal(new Set(boxLines.map(displayWidth)).size, 1, boxLines.join('\n'));
});

test('usage shows up as it arrives', async () => {
  let deliver;
  const pending = new Promise((resolve) => { deliver = resolve; });
  const h = harness([
    { email: 'a@x.com', current: true, usage: Promise.resolve(null) },
    { email: 'b@x.com', current: false, usage: pending },
  ]);
  const selection = h.run();
  await settle();
  assert.match(lineWith(h.frame(), 'b@x.com'), /查询中/);

  deliver(usage(93, 95));
  await settle();

  assert.match(lineWith(h.frame(), 'b@x.com'), /93%.*95%/);
  h.press(ENTER);
  await selection;
});

test('unknown usage is shown as such', async () => {
  const h = harness(accounts());
  const selection = h.run();
  await settle();
  h.press(ENTER);
  await selection;
  assert.match(lineWith(h.frame(), 'c@x.com'), /额度未知/);
});

test('a choice made while usage is loading does not wait for it', async () => {
  const h = harness([
    { email: 'a@x.com', current: true, usage: new Promise(() => {}) },
    { email: 'b@x.com', current: false, usage: new Promise(() => {}) },
  ]);
  const selection = h.run();
  h.press(ENTER);
  assert.equal(await selection, 'b@x.com');
});

test('the spinner stops once a choice is made', async () => {
  const h = harness([
    { email: 'a@x.com', current: true, usage: new Promise(() => {}) },
    { email: 'b@x.com', current: false, usage: new Promise(() => {}) },
  ]);
  const selection = h.run();
  await new Promise((resolve) => setTimeout(resolve, 250));
  const framesWhileLoading = h.written().split('\x1b[0J').length;
  h.press(ENTER);
  await selection;
  const lengthAfterChoice = h.written().length;
  await new Promise((resolve) => setTimeout(resolve, 250));

  assert.ok(framesWhileLoading > 2, 'spinner never redrew');
  assert.equal(h.written().length, lengthAfterChoice);
});

test('the detail line describes the account under the cursor', async () => {
  const h = harness([
    { email: 'a@x.com', current: true, usage: Promise.resolve(usage(93, 95)) },
    { email: 'b@x.com', current: false, usage: Promise.resolve(usage(80, 62)) },
    { email: 'c@x.com', current: false, usage: Promise.resolve(null) },
  ]);
  const selection = h.run();
  await settle();
  const detail = () => detailLine(h.frame());
  assert.match(detail(), /b@x\.com/);
  h.press(DOWN);
  assert.match(detail(), /c@x\.com.*额度未知/);
  h.press(ENTER);
  await selection;
});

test('the detail line says when each limit resets', async () => {
  const cases = [
    {
      name: 'used-up 5h limit, as reported',
      session: { remaining: 0, resetsAt: utc8(2026, 10, 3, 19, 23) },
      week: { remaining: 40, resetsAt: utc8(2026, 10, 9, 16, 0) },
      want: 'b@x.com · 5h 额度 19:23 重置 · 周额度 11-09 重置',
    },
    { name: 'later today', session: { remaining: 80, resetsAt: utc8(2026, 10, 3, 18, 50) }, want: '5h 额度 18:50 重置' },
    { name: 'after midnight', session: { remaining: 80, resetsAt: utc8(2026, 10, 4, 2, 5) }, want: '5h 额度 11-04 02:05 重置' },
    { name: 'not started', session: { remaining: 100, resetsAt: null }, want: '5h 额度未开始计时' },
    { name: 'used-up week', week: { remaining: 0, resetsAt: utc8(2026, 10, 12, 16, 0) }, want: '周额度 11-12 重置' },
  ];
  for (const { name, session, week, want } of cases) {
    const h = harness([
      { email: 'a@x.com', current: true, usage: Promise.resolve(null) },
      { email: 'b@x.com', current: false, usage: Promise.resolve({ ...usage(50, 50), ...(session && { session }), ...(week && { week }) }) },
    ]);
    const selection = h.run();
    await settle();
    h.press(ENTER);
    await selection;
    assert.ok(detailLine(h.frame()).includes(want), `${name}: ${detailLine(h.frame())}`);
  }
});

test('a narrow terminal shortens long emails instead of breaking the box', async () => {
  const h = harness([
    { email: 'someone.with.a.very.long.name@example.com', current: true, usage: Promise.resolve(usage(93, 95)) },
    { email: 'b@x.com', current: false, usage: Promise.resolve(usage(80, 62)) },
  ], { columns: 72 });
  const selection = h.run();
  await settle();
  h.press(ENTER);
  await selection;

  const lines = h.frame().split('\n').filter(Boolean);
  for (const line of lines) assert.ok(displayWidth(line) <= 72, `${displayWidth(line)}: ${line}`);
  assert.match(lineWith(h.frame(), 'someone'), /someone\.w.*… ∗/);
});
