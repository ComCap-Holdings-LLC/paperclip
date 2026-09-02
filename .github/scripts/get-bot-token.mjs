#!/usr/bin/env node
/**
 * get-bot-token.mjs
 * Generates a short-lived GitHub installation token for the commitperclip app,
 * or falls back to the workflow's own GITHUB_TOKEN when COMMITPERCLIP_KEY is
 * unset — see resolveBotToken() below. Prints the token to stdout and, when
 * $GITHUB_OUTPUT is set, appends `mode=app` or `mode=fallback` there too (the
 * one place that decision is computed — callers read it back via
 * steps.token.outputs.mode rather than re-deriving it).
 *
 * Also exports: generateJWT(privateKey), ghFetch(path, token, options)
 * These are used by all other gate scripts.
 */
import { createSign } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const APP_ID = '3718661';
const OWNER_PATTERN = /^[a-zA-Z0-9_.-]+$/;
const REPO_PATTERN = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

export function generateJWT(privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { iat: now - 10, exp: now + 60, iss: APP_ID };
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const data = `${header}.${body}`;
  const sig = createSign('RSA-SHA256').update(data).sign(privateKey, 'base64url');
  return `${data}.${sig}`;
}

// Per-call timeout so a single slow/hung GitHub endpoint cannot eat the entire
// workflow budget. Overridable via options.timeoutMs for callers that need
// different bounds.
export const GH_FETCH_DEFAULT_TIMEOUT_MS = 15_000;

export async function ghFetch(path, token, options = {}) {
  const { timeoutMs = GH_FETCH_DEFAULT_TIMEOUT_MS, signal: externalSignal, ...fetchOptions } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`ghFetch timeout after ${timeoutMs}ms: ${path}`)), timeoutMs);
  const abortOnExternal = () => controller.abort(externalSignal?.reason);
  if (externalSignal) {
    if (externalSignal.aborted) abortOnExternal();
    else externalSignal.addEventListener('abort', abortOnExternal, { once: true });
  }
  try {
    const res = await fetch(`https://api.github.com${path}`, {
      ...fetchOptions,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...fetchOptions.headers,
      },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`GitHub API ${fetchOptions.method ?? 'GET'} ${path} → ${res.status}: ${text}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener('abort', abortOnExternal);
  }
}

export async function resolveInstallationId(fetchInstallation, token, repo, owner) {
  if (repo) {
    if (!REPO_PATTERN.test(repo)) {
      throw new Error('ERROR: GH_REPO/GITHUB_REPOSITORY must be in owner/repo format.');
    }

    const installation = await fetchInstallation(`/repos/${repo}/installation`, token);
    return installation.id;
  }

  const installations = await fetchInstallation('/app/installations', token);
  if (!installations.length) {
    throw new Error(
      'ERROR: No installations found for commitperclip. Install URL: https://github.com/apps/commitperclip/installations/new'
    );
  }

  if (owner) {
    if (!OWNER_PATTERN.test(owner)) {
      throw new Error('ERROR: GITHUB_REPOSITORY_OWNER must be a valid GitHub owner name.');
    }

    const match = installations.find(
      installation => installation.account?.login?.toLowerCase() === owner.toLowerCase()
    );

    if (match) {
      return match.id;
    }
  }

  if (installations.length === 1) {
    return installations[0].id;
  }

  throw new Error(
    'ERROR: Multiple commitperclip installations found. Set GH_REPO or GITHUB_REPOSITORY so the correct installation can be selected.'
  );
}

// Resolves the token this workflow authenticates with, and which MODE it got:
//   'app'      — commitperclip GitHub App installation token. Can authorize
//                everything, including private draft security advisories.
//   'fallback' — the workflow's own GITHUB_TOKEN. Scoped to whatever
//                `permissions:` the workflow declares (PR comments, check-runs).
//                It CANNOT create repository security advisories — that
//                endpoint requires repository_advisories:write, which is only
//                grantable to a GitHub App installation or a PAT with that
//                scope, never to the ambient Actions token. Callers (see
//                check-pr-security.mjs) must check `mode` before attempting
//                anything App-only and degrade instead of failing/crashing.
//
// A ComCap-owned commitperclip App is the eventual fix for 'fallback' mode
// (COM-13395); creating one is blocked on GitHub sudo-mode/passkey setup as
// of 2026-09-01, and copying the upstream paperclipai App's private key is
// not an authorized ComCap repair — the App is owned by upstream, not us.
export async function resolveBotToken({
  privateKey,
  fallbackToken,
  repo,
  owner,
  fetchInstallation = ghFetch,
} = {}) {
  if (!privateKey) {
    if (!fallbackToken) {
      throw new Error(
        'ERROR: Neither COMMITPERCLIP_KEY nor GITHUB_TOKEN is set. At least one is required.\n' +
        'In Actions this workflow always provides GITHUB_TOKEN — seeing this there means the ' +
        'env: block was edited or removed. Running locally: either export GITHUB_TOKEN (a plain ' +
        'PAT is enough for the fallback path), or export COMMITPERCLIP_KEY="$(cat ' +
        '~/.config/commitperclip/private-key.pem)" for the App path.'
      );
    }
    return { token: fallbackToken, mode: 'fallback' };
  }

  const jwt = generateJWT(privateKey);
  const installationId = await resolveInstallationId(fetchInstallation, jwt, repo, owner);

  const { token } = await fetchInstallation(
    `/app/installations/${installationId}/access_tokens`,
    jwt,
    { method: 'POST', headers: { 'Content-Type': 'application/json' } }
  );

  if (!token) {
    throw new Error('ERROR: Failed to get installation token from GitHub API.');
  }

  return { token, mode: 'app' };
}

async function main() {
  const privateKey = process.env.COMMITPERCLIP_KEY;
  const fallbackToken = process.env.GITHUB_TOKEN;
  const repo = process.env.GH_REPO ?? process.env.GITHUB_REPOSITORY;
  const owner = process.env.GITHUB_REPOSITORY_OWNER ?? repo?.split('/')[0];

  if (!privateKey) {
    console.error(
      'WARN: COMMITPERCLIP_KEY not set — falling back to the workflow GITHUB_TOKEN. ' +
      'Quality-gate comments and check-runs still work; private draft security-advisory ' +
      'creation does not (see check-pr-security.mjs) and the security-review check will ' +
      'report "restricted" instead of silently passing when it finds something.'
    );
  }

  const { token, mode } = await resolveBotToken({ privateKey, fallbackToken, repo, owner });

  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    appendFileSync(githubOutput, `mode=${mode}\n`);
  }

  process.stdout.write(token);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
