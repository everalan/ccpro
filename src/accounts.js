import { mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CcproError, credentialService } from './context.js';
import { deleteItem, readItem, writeItem } from './keychain.js';
import { withClaudeLocks } from './locks.js';

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    if (error instanceof SyntaxError) throw new CcproError(`无法解析 ${file}`);
    throw error;
  }
}

function hasLiveToken(oauth) {
  return Boolean(oauth?.refreshToken);
}

function isUsable(oauth) {
  if (!hasLiveToken(oauth)) return false;
  return !oauth.refreshTokenExpiresAt || oauth.refreshTokenExpiresAt > Date.now();
}

function profileDir(ctx, email) {
  if (!/^[^/\\\0]+@[^/\\\0]+$/.test(email)) throw new CcproError(`邮箱格式不正确：${email}`);
  return path.join(ctx.profilesDir, email);
}

async function storeProfile(ctx, oauthAccount, claudeAiOauth) {
  const dir = profileDir(ctx, oauthAccount.emailAddress);
  const file = path.join(dir, '.claude.json');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeItem(ctx, credentialService(dir), { claudeAiOauth });
  const existing = await readJson(file);
  await writeFile(file, JSON.stringify({ ...existing, hasCompletedOnboarding: true, oauthAccount }, null, 2), { mode: 0o600 });
}

async function readProfile(ctx, email) {
  const dir = profileDir(ctx, email);
  const { oauthAccount } = await readJson(path.join(dir, '.claude.json'));
  const item = await readItem(ctx, credentialService(dir));
  if (!oauthAccount || !item) throw new CcproError(`账号 ${email} 未保存`);
  return { oauthAccount, claudeAiOauth: item.claudeAiOauth };
}

// Replaces the file in one step, writing through a symlink rather than over it.
async function writeGlobalConfig(ctx, config) {
  const file = await realpath(ctx.globalConfigFile).catch(() => ctx.globalConfigFile);
  const temp = `${file}.ccpro.tmp`;
  await writeFile(temp, JSON.stringify(config, null, 2), { mode: 0o600 });
  try {
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

export async function listAccounts(ctx) {
  const { oauthAccount } = await readJson(ctx.globalConfigFile);
  const currentEmail = oauthAccount?.emailAddress;
  const entries = await readdir(ctx.profilesDir, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });

  const saved = [];
  for (const entry of entries.filter((item) => item.isDirectory())) {
    const dir = path.join(ctx.profilesDir, entry.name);
    const email = (await readJson(path.join(dir, '.claude.json'))).oauthAccount?.emailAddress;
    if (email) saved.push({ email, dir, current: email === currentEmail });
  }
  saved.sort((a, b) => a.email.localeCompare(b.email));

  const current = saved.find((account) => account.current)
    ?? (currentEmail ? { email: currentEmail, dir: null, current: true } : null);
  return [...(current ? [current] : []), ...saved.filter((account) => !account.current)];
}

export function switchTo(ctx, email) {
  return withClaudeLocks(ctx, async () => {
    const config = await readJson(ctx.globalConfigFile);
    if (config.oauthAccount?.emailAddress === email) return { changed: false };

    const target = await readProfile(ctx, email);
    if (!isUsable(target.claudeAiOauth)) {
      throw new CcproError(`账号 ${email} 的登录已失效，请用 claude auth login 重新登录后运行 ccpro save`);
    }

    // Refresh tokens rotate, so the live copy is the only one certain to work:
    // it has to reach the saved profile before it gets replaced.
    const live = await readItem(ctx, ctx.defaultService);
    if (config.oauthAccount?.emailAddress && hasLiveToken(live?.claudeAiOauth)) {
      await storeProfile(ctx, config.oauthAccount, live.claudeAiOauth);
    }

    // The same keychain item holds MCP logins, which stay as they are.
    await writeItem(ctx, ctx.defaultService, { ...live, claudeAiOauth: target.claudeAiOauth });
    try {
      await writeGlobalConfig(ctx, { ...config, oauthAccount: target.oauthAccount });
    } catch (error) {
      await writeItem(ctx, ctx.defaultService, live ?? {});
      throw error;
    }
    return { changed: true };
  });
}

// Under the locks so a switch cannot make the account current midway.
export function removeAccount(ctx, email) {
  return withClaudeLocks(ctx, async () => {
    const wanted = email.toLowerCase();
    const account = (await listAccounts(ctx)).find((item) => item.email.toLowerCase() === wanted);
    if (account?.current) {
      throw new CcproError(`${account.email} 是当前账号，不能删除；请先运行 ccpro 切换到其他账号`);
    }
    if (!account) throw new CcproError(`账号 ${email} 未保存`);

    // Keychain first: if that fails the profile stays listed and can be retried.
    await deleteItem(ctx, credentialService(account.dir));
    await rm(account.dir, { recursive: true, force: true });
    return account.email;
  });
}

export function saveCurrent(ctx) {
  return withClaudeLocks(ctx, async () => {
    const { oauthAccount } = await readJson(ctx.globalConfigFile);
    const live = await readItem(ctx, ctx.defaultService);
    if (!oauthAccount?.emailAddress || !hasLiveToken(live?.claudeAiOauth)) {
      throw new CcproError('Claude Code 未登录，请先运行 claude auth login');
    }
    await storeProfile(ctx, oauthAccount, live.claudeAiOauth);
    return oauthAccount.emailAddress;
  });
}
