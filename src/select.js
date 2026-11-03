import readline from 'node:readline';
import { wallClock } from './time.js';

const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
// Long rows are clipped instead of wrapped, which would break the redraw.
const NO_LINE_WRAP = '\x1b[?7l';
const LINE_WRAP = '\x1b[?7h';

const BAR_CELLS = 12;
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
const SPIN_MS = 80;
const TITLE = 'ccpro · 切换 Claude Code 账号';
const KEYS = '↑↓ 选择 · 回车切换 · Esc 取消';
// U+2217 rather than "*": terminal fonts such as Monaco draw the ASCII asterisk
// up at cap height, while this one sits in the middle of the line.
const CURRENT_MARK = ' ∗';
const MIN_EMAIL_CELLS = 8;
// "100%": the number and its percent sign.
const PERCENT_CELLS = 4;
// Everything in a row except the email: pointer, gaps and the two bars.
const ROW_FIXED_CELLS = 2 + 2 + (3 + BAR_CELLS + 1 + PERCENT_CELLS) + 3 + (3 + BAR_CELLS + 1 + PERCENT_CELLS);

function palette(color) {
  const wrap = (on, off) => (text) => (color ? `\x1b[${on}m${text}\x1b[${off}m` : text);
  return {
    bold: wrap('1', '22'), gray: wrap('90', '39'), cyan: wrap('36', '39'),
    green: wrap('32', '39'), yellow: wrap('33', '39'), red: wrap('31', '39'),
  };
}

// Terminal cells taken by the text: CJK characters take two.
function width(text) {
  let total = 0;
  for (const ch of text.replace(/\x1b\[[0-9;]*m/g, '')) {
    const cp = ch.codePointAt(0);
    const wide = (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3)
      || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60)
      || (cp >= 0xffe0 && cp <= 0xffe6);
    total += wide ? 2 : 1;
  }
  return total;
}

const pad = (text, cells) => text + ' '.repeat(Math.max(0, cells - width(text)));

function truncate(text, cells) {
  if (width(text) <= cells) return text;
  let kept = '';
  for (const ch of text) {
    if (width(kept + ch) > cells - 1) break;
    kept += ch;
  }
  return `${kept}…`;
}

const twoDigits = (value) => String(value).padStart(2, '0');
const monthDay = (instant) => {
  const date = wallClock(instant);
  return `${twoDigits(date.getUTCMonth() + 1)}-${twoDigits(date.getUTCDate())}`;
};

function clock(instant, now) {
  const date = wallClock(instant);
  const time = `${twoDigits(date.getUTCHours())}:${twoDigits(date.getUTCMinutes())}`;
  return monthDay(instant) === monthDay(now) ? time : `${monthDay(instant)} ${time}`;
}

function describeSession(window, now) {
  if (!window) return null;
  if (window.resetsAt === null) return window.remaining === 100 ? '5h 额度未开始计时' : '5h 额度重置时间未知';
  return `5h 额度 ${clock(window.resetsAt, now)} 重置`;
}

function describeWeek(window) {
  if (!window || window.resetsAt === null) return null;
  return `周额度 ${monthDay(window.resetsAt)} 重置`;
}

export function selectAccount({ accounts, input, output, color = false, now = Date.now }) {
  const paint = palette(color);
  const level = (remaining) => (remaining >= 50 ? paint.green : remaining >= 20 ? paint.yellow : paint.red);
  const usage = new Map();
  const labels = accounts.map((account) => account.email + (account.current ? CURRENT_MARK : ''));
  const room = output.columns ? output.columns - 4 - ROW_FIXED_CELLS : Infinity;
  const emailCells = Math.max(MIN_EMAIL_CELLS, Math.min(Math.max(...labels.map(width)), room));
  const inner = Math.max(emailCells + ROW_FIXED_CELLS, width(TITLE) + 1, width(KEYS) + 1);

  return new Promise((resolve) => {
    let cursor = Math.max(accounts.findIndex((account) => !account.current), 0);
    let drawnLines = 0;
    let spin = 0;
    let finished = false;
    let spinner = null;

    function label(account) {
      if (!account.current) return truncate(account.email, emailCells);
      return truncate(account.email, emailCells - width(CURRENT_MARK)) + CURRENT_MARK;
    }

    // The bar shows how much is left; the number is written in the row's colour.
    function bar(window, rowColor) {
      if (!window) return paint.gray('·'.repeat(BAR_CELLS)) + ' '.repeat(1 + PERCENT_CELLS);
      const filled = Math.round((window.remaining / 100) * BAR_CELLS);
      const fill = level(window.remaining)('▰'.repeat(filled)) + paint.gray('▱'.repeat(BAR_CELLS - filled));
      return `${fill} ${rowColor(`${String(window.remaining).padStart(3)}%`)}`;
    }

    function row(account, index) {
      const selected = index === cursor;
      const rowColor = account.current ? paint.green : (text) => text;
      const tint = account.current ? paint.green : paint.gray;
      let name = pad(label(account), emailCells);
      if (account.current) name = paint.green(name);
      else if (selected) name = paint.cyan(name);
      const head = `${selected ? paint.cyan('❯') : ' '} ${name}  `;

      const result = usage.get(account.email);
      if (result === undefined) return `${head}${paint.cyan(SPINNER[spin % SPINNER.length])} ${paint.gray('查询中…')}`;
      if (result === null) return `${head}${paint.gray('额度未知')}`;
      return `${head}${tint('5h')} ${bar(result.session, rowColor)}   ${tint('周')} ${bar(result.week, rowColor)}`;
    }

    function detail() {
      const account = accounts[cursor];
      const dot = paint.gray(' · ');
      const result = usage.get(account.email);
      let parts;
      if (result === undefined) parts = ['正在查询额度…'];
      else if (result === null) parts = ['额度未知'];
      else parts = [describeSession(result.session, now()), describeWeek(result.week)].filter(Boolean);
      const plain = truncate([account.email, ...parts].join(' · '), inner);
      if (!color || plain.endsWith('…')) return plain;
      return [account.email, ...parts].join(dot);
    }

    function draw() {
      const line = (text) => `${paint.gray('│')} ${pad(text, inner)} ${paint.gray('│')}`;
      const edge = (left, text, right) => `${paint.gray(`${left}─ `)}${text}${paint.gray(` ${'─'.repeat(inner - width(text) - 1)}${right}`)}`;
      const title = `${paint.bold('ccpro')}${paint.gray(' · ')}切换 Claude Code 账号`;
      const lines = [
        edge('╭', title, '╮'),
        line(''),
        ...accounts.map((account, index) => line(row(account, index))),
        line(''),
        paint.gray(`├${'─'.repeat(inner + 2)}┤`),
        line(detail()),
        edge('╰', paint.gray(KEYS), '╯'),
      ];
      const rewind = drawnLines ? `\x1b[${drawnLines}A\x1b[0J` : '';
      output.write(`${rewind}${lines.join('\n')}\n`);
      drawnLines = lines.length;
    }

    function stopSpinner() {
      clearInterval(spinner);
      spinner = null;
    }

    function finish(result) {
      finished = true;
      stopSpinner();
      input.removeListener('keypress', onKeypress);
      input.setRawMode?.(false);
      input.pause();
      output.write(SHOW_CURSOR + LINE_WRAP);
      resolve(result);
    }

    function onKeypress(_, key) {
      if (key.name === 'return' || key.name === 'enter') {
        finish(accounts[cursor].email);
      } else if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        finish(null);
      } else if (key.name === 'up' || key.name === 'down') {
        const step = key.name === 'up' ? -1 : 1;
        cursor = (cursor + step + accounts.length) % accounts.length;
        draw();
      }
    }

    readline.emitKeypressEvents(input);
    input.setRawMode?.(true);
    input.resume();
    input.on('keypress', onKeypress);
    output.write(HIDE_CURSOR + NO_LINE_WRAP);
    draw();

    spinner = setInterval(() => {
      spin += 1;
      draw();
    }, SPIN_MS);
    for (const account of accounts) {
      account.usage.then((result) => {
        usage.set(account.email, result);
        if (finished) return;
        if (usage.size === accounts.length) stopSpinner();
        draw();
      });
    }
  });
}
