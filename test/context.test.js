import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createContext, credentialService } from '../src/context.js';

test('credential service names match what Claude Code derives', () => {
  const cases = [
    { dir: undefined, want: 'Claude Code-credentials' },
    { dir: '/Users/tester/.ccpro/profiles/a@x.com', want: 'Claude Code-credentials-4b44f662' },
    { dir: '/tmp/custom-claude', want: 'Claude Code-credentials-5204cebd' },
  ];
  for (const { dir, want } of cases) assert.equal(credentialService(dir), want);
});

test('a custom CLAUDE_CONFIG_DIR moves the login Claude Code uses', () => {
  const ctx = createContext({ env: { HOME: '/Users/tester', USER: 'tester', CLAUDE_CONFIG_DIR: '/tmp/custom-claude' } });
  assert.equal(ctx.configDir, '/tmp/custom-claude');
  assert.equal(ctx.globalConfigFile, '/tmp/custom-claude/.claude.json');
  assert.equal(ctx.defaultService, 'Claude Code-credentials-5204cebd');
});

test('without CLAUDE_CONFIG_DIR the config file sits next to ~/.claude', () => {
  const ctx = createContext({ env: { HOME: '/Users/tester', USER: 'tester' } });
  assert.equal(ctx.configDir, '/Users/tester/.claude');
  assert.equal(ctx.globalConfigFile, '/Users/tester/.claude.json');
  assert.equal(ctx.defaultService, 'Claude Code-credentials');
});

test('the keychain account follows the rule Claude Code uses', () => {
  const cases = [
    { user: 'tester', want: 'tester' },
    { user: 'has space', want: 'claude-code-user' },
  ];
  for (const { user, want } of cases) {
    assert.equal(createContext({ env: { HOME: '/h', USER: user } }).keychainAccount, want);
  }
});
