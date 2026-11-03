import assert from 'node:assert/strict';
import { test } from 'node:test';
import extension from './index.ts';

function harness(branch = []) {
  const events = {}, commands = {}, appended = [], messages = [], notices = [];
  const pi = { on: (name, handler) => { events[name] = handler; }, registerCommand: (name, command) => { commands[name] = command; }, appendEntry: (customType, data) => { const entry = { type: 'custom', customType, data }; branch.push(entry); appended.push(entry); }, sendMessage: (...args) => messages.push(args) };
  const ctx = { mode: 'tui', hasPendingMessages: () => false, isIdle: () => true, sessionManager: { getBranch: () => branch }, ui: { notify: (...args) => notices.push(args) } };
  extension(pi);
  const event = { outcome: 'completed', continue: false, context: { canContinue: false, pendingMessages: [] } };
  return { branch, events, commands, ctx, event, appended, messages, notices };
}
const user = () => ({ type: 'message', message: { role: 'user' } });
const tool = () => ({ type: 'message', message: { role: 'toolResult' } });
const branch = (users, tools) => [...Array.from({ length: users }, user), ...Array.from({ length: tools }, tool)];

test('thresholds and safe boundary behavior', () => {
  for (const [u, t, expected] of [[1, 44, false], [1, 45, true], [2, 24, false], [2, 25, true]]) {
    const h = harness(branch(u, t));
    const r = h.events.agent_before_settle(h.event, h.ctx);
    assert.equal(Boolean(r), expected);
    if (r) {
      assert.equal(r.continue, true);
      assert.equal(r.entries[1].type, 'custom_message');
      // The custom message makes continuation legal even when the original last message was an assistant.
      assert.match(r.entries[1].content, /unverified/);
      assert.match(r.entries[1].content, /prefer a small targeted update/);
      assert.match(r.entries[1].content, /failed approaches from what worked/);
      assert.match(r.entries[1].content, /at most one SKILL\.md/);
      assert.match(r.entries[1].content, /If a skill was created or updated.*ask the user to run \/reload/);
      assert.match(r.entries[1].content, /If no skill was changed.*do not mention \/reload/);
      assert.match(r.entries[1].content, /Do not attempt to run slash commands/);
      h.branch.push(...r.entries);
      assert.equal(h.events.agent_before_settle(h.event, h.ctx), undefined);
    }
  }
});

test('skips errors, non-interactive mode, queued work, and other continuations', () => {
  for (const mutate of [
    h => h.event.outcome = 'aborted', h => h.event.outcome = 'error',
    h => h.event.continue = true, h => h.event.context.pendingMessages.push({}),
    h => h.ctx.hasPendingMessages = () => true, h => h.ctx.mode = 'rpc',
  ]) { const h = harness(branch(2, 30)); mutate(h); assert.equal(h.events.agent_before_settle(h.event, h.ctx), undefined); }
});

test('branch-local on/off and checkpoint resets', async () => {
  const h = harness(branch(2, 30));
  await h.commands['auto-skill'].handler('off', h.ctx);
  assert.equal(h.events.agent_before_settle(h.event, h.ctx), undefined);
  await h.commands['auto-skill'].handler('on', h.ctx);
  const r = h.events.agent_before_settle(h.event, h.ctx);
  assert.ok(r); h.branch.push(...r.entries);
  h.branch.push(...branch(2, 24));
  assert.equal(h.events.agent_before_settle(h.event, h.ctx), undefined);
  h.branch.push(tool());
  assert.ok(h.events.agent_before_settle(h.event, h.ctx));
});

test('manual review is bounded and does not run while busy or noninteractive', async () => {
  const h = harness();
  h.ctx.isIdle = () => false;
  await h.commands['auto-skill'].handler('now', h.ctx);
  assert.equal(h.messages.length, 0);
  h.ctx.isIdle = () => true;
  h.ctx.mode = 'rpc';
  await h.commands['auto-skill'].handler('now', h.ctx);
  assert.equal(h.messages.length, 0);
  h.ctx.mode = 'tui';
  await h.commands['auto-skill'].handler('now', h.ctx);
  assert.equal(h.appended.length, 1);
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0][1].triggerTurn, true);
  assert.match(h.messages[0][0].content, /do not include secrets/i);
  assert.match(h.messages[0][0].content, /If no skill was changed.*do not mention \/reload/);
  assert.match(h.messages[0][0].content, /If a skill was created or updated.*ask the user to run \/reload/);
});
