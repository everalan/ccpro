import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { CcproError } from './context.js';

const execFileAsync = promisify(execFile);

const ITEM_NOT_FOUND = 44;
// `security -i` cuts longer lines and stores what is left, so going over this limit
// corrupts the item rather than failing. Claude Code uses the same limit.
const INTERACTIVE_LINE_LIMIT = 4032;

// security prints data containing non-ASCII bytes as hex instead of text.
function decode(output) {
  const text = output.replace(/\n$/, '');
  if (/^([0-9a-f]{2})+$/.test(text)) return Buffer.from(text, 'hex').toString('utf8');
  return text;
}

export async function readItem(ctx, service) {
  try {
    const { stdout } = await execFileAsync(ctx.securityBin, [
      'find-generic-password', '-a', ctx.keychainAccount, '-w', '-s', service,
    ], { env: ctx.env });
    return JSON.parse(decode(stdout));
  } catch (error) {
    if (error.code === ITEM_NOT_FOUND) return null;
    if (error instanceof SyntaxError) throw new CcproError(`钥匙串条目 ${service} 不是有效的 JSON`);
    throw new CcproError(`读取钥匙串失败：${error.stderr?.trim() || error.message}`);
  }
}

// Returns false when there was nothing to delete.
export async function deleteItem(ctx, service) {
  try {
    await execFileAsync(ctx.securityBin, [
      'delete-generic-password', '-a', ctx.keychainAccount, '-s', service,
    ], { env: ctx.env });
    return true;
  } catch (error) {
    if (error.code === ITEM_NOT_FOUND) return false;
    throw new CcproError(`删除钥匙串条目失败：${error.stderr?.trim() || error.message}`);
  }
}

function runInteractive(ctx, line) {
  return new Promise((resolve, reject) => {
    const child = spawn(ctx.securityBin, ['-i'], { env: ctx.env, stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(Object.assign(new Error(`security exited with ${code}`), { stderr }));
    });
    child.stdin.end(line);
  });
}

export async function writeItem(ctx, service, data) {
  const hex = Buffer.from(JSON.stringify(data), 'utf8').toString('hex');
  const line = `add-generic-password -U -a "${ctx.keychainAccount}" -s "${service}" -X "${hex}"\n`;
  try {
    if (Buffer.byteLength(line) <= INTERACTIVE_LINE_LIMIT) {
      // Through stdin so the tokens never appear in the process list.
      await runInteractive(ctx, line);
    } else {
      await execFileAsync(ctx.securityBin, [
        'add-generic-password', '-U', '-a', ctx.keychainAccount, '-s', service, '-X', hex,
      ], { env: ctx.env });
    }
  } catch (error) {
    throw new CcproError(`写入钥匙串失败：${error.stderr?.trim() || error.message}`);
  }
}
