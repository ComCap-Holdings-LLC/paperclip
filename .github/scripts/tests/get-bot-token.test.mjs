import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { resolveInstallationId, resolveBotToken } from '../get-bot-token.mjs';

// Generated at test-run time, never committed: resolveBotToken's App branch
// calls generateJWT(), which needs a real PEM to sign against, and a
// hardcoded "-----BEGIN RSA PRIVATE KEY-----" fixture would itself trip
// check-pr-security.mjs's own secret-scan pattern for this repo's PRs.
const { privateKey: TEST_RSA_KEY } = generateKeyPairSync('rsa', { modulusLength: 2048 });

test('resolveInstallationId: uses the repo installation endpoint when repo context is available', async () => {
  const seenPaths = [];
  const installationId = await resolveInstallationId(async (path) => {
    seenPaths.push(path);
    return { id: 42 };
  }, 'jwt', 'paperclipai/paperclip', 'paperclipai');

  assert.equal(installationId, 42);
  assert.deepEqual(seenPaths, ['/repos/paperclipai/paperclip/installation']);
});

test('resolveInstallationId: falls back to the matching owner installation', async () => {
  const installationId = await resolveInstallationId(async () => ([
    { id: 1, account: { login: 'someone-else' } },
    { id: 7, account: { login: 'PaperclipAI' } },
  ]), 'jwt', undefined, 'paperclipai');

  assert.equal(installationId, 7);
});

test('resolveInstallationId: rejects ambiguous installations without repo or owner context', async () => {
  await assert.rejects(
    resolveInstallationId(async () => ([
      { id: 1, account: { login: 'org-one' } },
      { id: 2, account: { login: 'org-two' } },
    ]), 'jwt'),
    /Multiple commitperclip installations found/
  );
});

test('resolveBotToken: uses the App installation token and reports mode=app when COMMITPERCLIP_KEY is set', async () => {
  const calls = [];
  const { token, mode } = await resolveBotToken({
    privateKey: TEST_RSA_KEY,
    fallbackToken: 'gha-fallback-token',
    repo: 'ComCap-Holdings-LLC/paperclip',
    owner: 'ComCap-Holdings-LLC',
    fetchInstallation: async (path) => {
      calls.push(path);
      if (path.endsWith('/installation')) return { id: 99 };
      return { token: 'app-installation-token' };
    },
  });

  assert.equal(token, 'app-installation-token');
  assert.equal(mode, 'app');
  assert.deepEqual(calls, [
    '/repos/ComCap-Holdings-LLC/paperclip/installation',
    '/app/installations/99/access_tokens',
  ]);
});

test('resolveBotToken: falls back to GITHUB_TOKEN and reports mode=fallback when COMMITPERCLIP_KEY is absent', async () => {
  const { token, mode } = await resolveBotToken({
    privateKey: undefined,
    fallbackToken: 'gha-fallback-token',
    fetchInstallation: async () => {
      throw new Error('must not call the GitHub App API when there is no private key');
    },
  });

  assert.equal(token, 'gha-fallback-token');
  assert.equal(mode, 'fallback');
});

test('resolveBotToken: throws when neither COMMITPERCLIP_KEY nor GITHUB_TOKEN is available', async () => {
  await assert.rejects(
    resolveBotToken({ privateKey: undefined, fallbackToken: undefined }),
    /Neither COMMITPERCLIP_KEY nor GITHUB_TOKEN is set/
  );
});
