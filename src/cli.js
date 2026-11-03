import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { listAccounts, saveCurrent, switchTo } from './accounts.js';
import { CcproError, createContext } from './context.js';
import { selectAccount } from './select.js';
import { fetchUsage } from './usage.js';

const packageInfo = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const HELP = `用法：
  ccpro              选择已保存的账号并切换，列表里显示各账号的剩余额度
  ccpro save         保存当前登录的账号，邮箱取自账号信息
  ccpro --update     更新到最新版本
  ccpro --version    显示版本号
  ccpro --help       显示帮助

添加账号：运行 claude auth login 登录后，再运行 ccpro save。
`;

function update(ctx) {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['install', '-g', `${packageInfo.name}@latest`], {
      env: ctx.env,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('error', (error) => reject(new CcproError(`无法运行 npm：${error.message}`)));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

async function save(ctx) {
  const email = await saveCurrent(ctx);
  ctx.stdout.write(`已保存 ${email}\n要添加下一个账号：运行 claude auth login，再运行 ccpro save\n`);
  return 0;
}

async function chooseAndSwitch(ctx) {
  const accounts = await listAccounts(ctx);
  if (accounts.length === 0) throw new CcproError('还没有保存的账号，请先登录 Claude Code，再运行 ccpro save');
  if (!ctx.stdin.isTTY) throw new CcproError('选择账号需要在终端里运行');

  const rows = accounts.map((account) => ({ ...account, usage: fetchUsage(ctx, account) }));
  const color = Boolean(ctx.stdout.isTTY) && ctx.env.NO_COLOR === undefined;
  const email = await selectAccount({ accounts: rows, input: ctx.stdin, output: ctx.stdout, color });
  if (!email) return 0;

  // A usage run may be renewing a token right now. Letting it finish means the
  // rotated token is the one that gets moved, not the copy it just replaced.
  ctx.stdout.write(`正在切换到 ${email}…\n`);
  await Promise.allSettled(rows.map((row) => row.usage));

  const { changed } = await switchTo(ctx, email);
  ctx.stdout.write(changed
    ? `已切换到 ${email}\n请重开 Claude Code 窗口，用 claude --resume 接回对话\n`
    : `当前已经是 ${email}\n`);
  return 0;
}

export async function main(argv, ctx = createContext()) {
  const [command, ...rest] = argv;
  try {
    if (command === '--help' || command === '-h') {
      ctx.stdout.write(HELP);
      return 0;
    }
    if (command === '--version' || command === '-v') {
      ctx.stdout.write(`${packageInfo.version}\n`);
      return 0;
    }
    if (ctx.platform !== 'darwin') throw new CcproError('ccpro 只支持 macOS');
    if (command === '--update') return await update(ctx);
    if (command === 'save') {
      if (rest.length > 0) throw new CcproError('save 不需要参数，邮箱取自当前登录的账号');
      return await save(ctx);
    }
    if (command === undefined) return await chooseAndSwitch(ctx);
    throw new CcproError(`未知命令：${command}\n\n${HELP}`);
  } catch (error) {
    ctx.stderr.write(`${error.message}\n`);
    return 1;
  }
}
