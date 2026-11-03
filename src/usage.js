import { execFile } from 'node:child_process';
import os from 'node:os';
import { DAY, fromWallClock, wallClock } from './time.js';

// Any of these would make claude ignore the login in the config directory.
const LOGIN_OVERRIDES = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_SECURESTORAGE_CONFIG_DIR',
];

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
// Claude Code writes reset times like "Oct 30 at 6:50pm (Asia/Singapore)",
// leaving out the year when it is this year and the date when it is today.
const RESET = /^(?:([a-z]{3}) (\d{1,2})(?:, (\d{4}))?(?: at |, | ))?(\d{1,2})(?::(\d{2}))? ?([ap]m)(?: \([^)]+\))?$/i;

function parseReset(text, now) {
  const match = text?.match(RESET);
  if (!match) return null;
  const [, monthName, day, year, hour, minute = '0', half] = match;
  const hours = (Number(hour) % 12) + (half.toLowerCase() === 'pm' ? 12 : 0);
  const today = wallClock(now);

  if (!monthName) {
    const at = fromWallClock(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), hours, Number(minute));
    return at < now ? at + DAY : at;
  }
  const month = MONTHS.indexOf(monthName.toLowerCase());
  if (month === -1) return null;
  const at = (inYear) => fromWallClock(inYear, month, Number(day), hours, Number(minute));
  if (year) return at(Number(year));
  const thisYear = today.getUTCFullYear();
  return at(thisYear) < now - DAY ? at(thisYear + 1) : at(thisYear);
}

function parseWindow(text, label, now) {
  const match = text.match(new RegExp(`^${label}: (\\d+)% used(?: · resets (.+))?$`, 'm'));
  if (!match) return null;
  return { remaining: 100 - Number(match[1]), resetsAt: parseReset(match[2], now) };
}

export function parseUsage(text, now = Date.now()) {
  const session = parseWindow(text, 'Current session', now);
  const week = parseWindow(text, 'Current week(?: \\(all models\\))?', now);
  return session || week ? { session, week } : null;
}

// Runs the real claude so that it refreshes tokens and talks to Anthropic itself.
// The current account's saved copy may be stale, so it goes through the normal
// config; using that copy would spend a refresh token that has already rotated.
export function fetchUsage(ctx, account) {
  const env = { ...ctx.env };
  for (const name of LOGIN_OVERRIDES) delete env[name];
  if (!account.current) env.CLAUDE_CONFIG_DIR = account.dir;

  return new Promise((resolve) => {
    execFile('claude', ['-p', '/usage', '--output-format', 'json'], {
      env,
      cwd: os.tmpdir(),
      timeout: ctx.usageTimeoutMs,
    }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      try {
        resolve(parseUsage(JSON.parse(stdout).result));
      } catch {
        resolve(null);
      }
    });
  });
}
