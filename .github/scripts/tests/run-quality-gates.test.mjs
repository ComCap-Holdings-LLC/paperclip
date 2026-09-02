import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findExistingComment } from '../run-quality-gates.mjs';

test('findExistingComment: paginates until it finds the commitperclip comment', async () => {
  const seenPaths = [];
  const comment = await findExistingComment(async (path) => {
    seenPaths.push(path);
    if (path.endsWith('page=1')) {
      return Array.from({ length: 100 }, (_, index) => ({
        id: index + 1,
        user: { login: 'someone-else' },
        body: 'unrelated',
      }));
    }
    if (path.endsWith('page=2')) {
      return [{
        id: 200,
        user: { login: 'commitperclip[bot]' },
        body: 'Looks good.\n\n— commitperclip',
      }];
    }
    return [];
  }, 'token', 'paperclipai/paperclip', 6469);

  assert.equal(comment.id, 200);
  assert.deepEqual(seenPaths, [
    '/repos/paperclipai/paperclip/issues/6469/comments?per_page=100&page=1',
    '/repos/paperclipai/paperclip/issues/6469/comments?per_page=100&page=2',
  ]);
});

test('findExistingComment: finds its own prior comment when posted as github-actions[bot] (COMMITPERCLIP_TOKEN_MODE=fallback)', async () => {
  const comment = await findExistingComment(async () => ([
    {
      id: 5,
      user: { login: 'github-actions[bot]' },
      body: 'All checks passing.\n\n— commitperclip',
    },
  ]), 'token', 'paperclipai/paperclip', 6469);

  assert.equal(comment.id, 5);
});

test('findExistingComment: returns null when no signed comment exists', async () => {
  const comment = await findExistingComment(async () => ([
    {
      id: 1,
      user: { login: 'commitperclip[bot]' },
      body: 'Unsigned status update',
    },
  ]), 'token', 'paperclipai/paperclip', 6469);

  assert.equal(comment, null);
});

test('findExistingComment: ignores a non-bot comment that copies the public signature (hijack/griefing control)', async () => {
  // COMMENT_SIGNATURE is a public string any commenter can read from source
  // and paste into an ordinary comment. Without the identity gate, this
  // would be found and PATCHed by the bot's own token on the next push,
  // silently overwriting content the commenter (possibly the untrusted fork
  // PR's own author, since this runs on pull_request_target) never intended
  // the bot to touch.
  const comment = await findExistingComment(async () => ([
    {
      id: 9,
      user: { login: 'some-pr-author' },
      body: 'thanks — commitperclip',
    },
  ]), 'token', 'paperclipai/paperclip', 6469);

  assert.equal(comment, null);
});
