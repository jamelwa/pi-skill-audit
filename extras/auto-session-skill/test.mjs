import assert from 'node:assert/strict';
import { test, beforeEach, after } from 'node:test';
import { copyFile, mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const temp = await mkdtemp(join(tmpdir(), 'auto-skill-test-'));
const config = join(temp, 'config.json');
await copyFile(new URL('./index.ts', import.meta.url), join(temp, 'index.ts'));
const piRoot = process.env.PI_PACKAGE_DIR ?? '/usr/lib/node_modules/@earendil-works/pi-coding-agent';
await mkdir(join(temp, 'node_modules', '@earendil-works'), { recursive: true });
await symlink(join(dirname(piRoot), 'pi-tui'), join(temp, 'node_modules', '@earendil-works', 'pi-tui'), 'dir');
const { default: extension } = await import(pathToFileURL(join(temp, 'index.ts')).href);
beforeEach(() => rmSync(config, { force: true }));
after(() => rm(temp, { recursive: true, force: true }));

function harness(branch = []) {
  const events = {}, commands = {}, appended = [], messages = [], notices = [];
  const pi = { on: (name, handler) => { events[name] = handler; }, registerCommand: (name, command) => { commands[name] = command; }, appendEntry: (customType, data) => { const entry = { type: 'custom', customType, data }; branch.push(entry); appended.push(entry); }, sendMessage: (...args) => messages.push(args) };
  const ctx = { mode: 'tui', hasUI: true, hasPendingMessages: () => false, isIdle: () => true, getSystemPromptOptions: () => ({ skills: [] }), sessionManager: { getBranch: () => branch, getLeafId: () => 'leaf' }, ui: { notify: (...args) => notices.push(args), confirm: async () => true } };
  extension(pi);
  const event = { outcome: 'completed', continue: false, entries: [], context: { canContinue: false, pendingMessages: [] } };
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

test('sensitivity thresholds and safety guidance', async () => {
  for (const [level, users, tools, single] of [['low', 3, 50, 80], ['medium', 2, 25, 45], ['high', 2, 12, 20]]) {
    for (const [u, t, expected] of [[users - 1, tools, false], [users, tools - 1, false], [users, tools, true], [1, single - 1, false], [1, single, true]]) {
      const h = harness(branch(u, t));
      await h.commands['auto-skill'].handler(`sensitivity ${level}`, h.ctx);
      const result = h.events.agent_before_settle(h.event, h.ctx);
      assert.equal(Boolean(result), expected, `${level}: ${u} users, ${t} tools`);
      if (result) {
        assert.match(result.entries[1].content, /repeated, complex, tedious or error-prone/);
        assert.match(result.entries[1].content, /successfully verified outcome/);
        assert.match(result.entries[1].content, /Repetition or difficulty alone is not proof/);
      }
    }
  }
});

test('sensitivity and enabled state persist independently on a branch', async () => {
  const h = harness(branch(2, 15));
  await h.commands['auto-skill'].handler('off', h.ctx);
  await h.commands['auto-skill'].handler('sensitivity high', h.ctx);
  assert.equal(h.events.agent_before_settle(h.event, h.ctx), undefined);
  await h.commands['auto-skill'].handler('status', h.ctx);
  assert.match(h.notices.at(-1)[0], /off, sensitivity high/);
  await h.commands['auto-skill'].handler('on', h.ctx);
  assert.ok(h.events.agent_before_settle(h.event, h.ctx));
  await h.commands['auto-skill'].handler('status', h.ctx);
  assert.match(h.notices.at(-1)[0], /on, sensitivity high.*12 tools \+ 2 messages, or 20 tools/);
  const count = h.appended.length;
  await h.commands['auto-skill'].handler('sensitivity extreme', h.ctx);
  assert.equal(h.appended.length, count);
  assert.match(h.notices.at(-1)[0], /Usage:/);
  // Settings restored from old on/off entries default to medium, including after resume.
  const old = harness([...branch(2, 15), { type: 'custom', customType: 'auto-session-skill-setting', data: { enabled: true } }]);
  assert.equal(old.events.agent_before_settle(old.event, old.ctx), undefined);
  await old.commands['auto-skill'].handler('status', old.ctx);
  assert.match(old.notices.at(-1)[0], /on, sensitivity medium/);
});

test('global model selection requires consent and preserves model ID case', async () => {
  const h = harness();
  const model = { provider: 'provider', id: 'Vendor/Model' };
  h.ctx.modelRegistry = { find: (p, id) => p === model.provider && id === model.id ? model : undefined };
  h.ctx.ui.confirm = async () => false;
  await h.commands['auto-skill'].handler('model provider/Vendor/Model', h.ctx);
  assert.throws(() => readFileSync(config));
  h.ctx.ui.confirm = async () => true;
  await h.commands['auto-skill'].handler('model provider/Vendor/Model', h.ctx);
  assert.deepEqual(JSON.parse(readFileSync(config)), { model: 'provider/Vendor/Model' });
  await h.commands['auto-skill'].handler('model unknown/model', h.ctx);
  assert.equal(JSON.parse(readFileSync(config)).model, 'provider/Vendor/Model');
  await h.commands['auto-skill'].handler('model current', h.ctx);
  assert.equal(JSON.parse(readFileSync(config)).model, 'current');
});

test('searchable picker filters by model substring and cancellation preserves config', { skip: !existsSync(join(dirname(piRoot), 'pi-tui')) }, async () => {
  const h = harness();
  h.ctx.modelRegistry = { getAvailable: () => [{ provider: 'provider', id: 'vendor/model' }, { provider: 'other', id: 'fast' }], find: (provider, id) => ({ provider, id }) };
  let keysToSend = [...'vendor/model', '\r'];
  const renders = [];
  h.ctx.ui.custom = async (factory) => {
    let result;
    const keys = { matches: (data, key) => ({ 'tui.select.confirm': '\r', 'tui.select.cancel': '\x1b', 'tui.select.up': '\x1b[A', 'tui.select.down': '\x1b[B' })[key] === data };
    const component = factory({ requestRender() {} }, { fg: (_color, text) => text }, keys, (value) => { result = value; });
    component.focused = true;
    for (const key of keysToSend) { component.handleInput(key); renders.push(component.render(80).join('\n')); }
    return result;
  };
  await h.commands['auto-skill'].handler('model', h.ctx);
  assert.equal(JSON.parse(readFileSync(config)).model, 'provider/vendor/model');
  assert.doesNotMatch(renders.at(-2), /other\/fast/);
  keysToSend = ['\x1b'];
  await h.commands['auto-skill'].handler('model', h.ctx);
  assert.equal(JSON.parse(readFileSync(config)).model, 'provider/vendor/model');
});

test('installed Pi loader invokes searchable model picker', { skip: !existsSync(join(piRoot, 'dist/core/extensions/loader.js')) }, async () => {
  const { loadExtensions, createExtensionRuntime } = await import(pathToFileURL(join(piRoot, 'dist/core/extensions/loader.js')).href);
  const loaded = await loadExtensions([join(temp, 'index.ts')], temp, undefined, createExtensionRuntime());
  assert.deepEqual(loaded.errors, []);
  const handler = loaded.extensions[0].commands.get('auto-skill').handler;
  const ctx = {
    mode: 'tui', hasUI: true,
    modelRegistry: { getAvailable: () => [{ provider: 'p', id: 'vendor/model' }], find: (provider, id) => ({ provider, id }) },
    ui: {
      confirm: async () => true, notify() {},
      custom: async (factory) => {
        let result;
        const keys = { matches: (data, key) => ({ 'tui.select.confirm': '\r', 'tui.select.cancel': '\x1b' })[key] === data };
        const component = await factory({ requestRender() {} }, { fg: (_color, text) => text }, keys, (value) => { result = value; });
        for (const key of [...'vendor/model', '\r']) component.handleInput(key);
        return result;
      },
    },
  };
  await handler('model', ctx);
  assert.equal(JSON.parse(readFileSync(config)).model, 'p/vendor/model');
});

test('separate reviewer receives bounded text and inventory; candidate is untrusted and must be independently checked', async () => {
  writeFileSync(config, JSON.stringify({ model: 'provider/vendor/model' }));
  const h = harness([...branch(2, 25), { type: 'message', message: { role: 'user', content: 'Fix repeated build failures' } },
    { type: 'message', message: { role: 'toolResult', content: 'SECRET TOOL OUTPUT' } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'SECRET THINKING' }, { type: 'text', text: 'Tests passed' }] } }]);
  h.events.before_agent_start({ systemPromptOptions: { skills: [{ name: 'build', description: 'Build project' }] } }, h.ctx);
  let call;
  h.ctx.modelRegistry = { find: (p, id) => ({ provider: p, id }), streamSimple: (model, context, options) => {
    call = { model, context, options };
    return { result: async () => ({ stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify({ decision: 'candidate', reason: 'Repeated build validation' }) }] }) };
  } };
  h.event.entries.push({ type: 'custom', customType: 'other-extension' });
  const result = await h.events.agent_before_settle(h.event, h.ctx);
  assert.equal(result.continue, true);
  assert.equal(result.entries[0].customType, 'other-extension');
  const payload = JSON.parse(call.context.messages[0].content);
  assert.match(payload.transcript, /Fix repeated build failures/);
  assert.doesNotMatch(payload.transcript, /SECRET TOOL OUTPUT|SECRET THINKING/);
  assert.deepEqual(payload.skills, [{ name: 'build', description: 'Build project' }]);
  assert.equal(call.context.tools, undefined);
  assert.equal(call.model.id, 'vendor/model');
  assert.match(result.entries.at(-1).content, /untrusted advisory data/);
  assert.match(result.entries.at(-1).content, /Verify everything independently/);
});

test('no candidate, unavailable or failed models never start a continuation or fall back', async () => {
  for (const kind of ['no_skill', 'missing', 'invalid', 'error']) {
    writeFileSync(config, JSON.stringify({ model: 'provider/model' }));
    const h = harness([...branch(2, 25), { type: 'message', message: { role: 'user', content: 'A work request' } }]);
    let calls = 0;
    h.ctx.modelRegistry = { find: () => kind === 'missing' ? undefined : { provider: 'provider', id: 'model' }, streamSimple: () => {
      calls++;
      return { result: async () => {
        if (kind === 'error') throw new Error('provider failure');
        return { stopReason: 'stop', content: [{ type: 'text', text: kind === 'no_skill' ? '{"decision":"no_skill","reason":"No reusable workflow"}' : 'not json' }] };
      } };
    } };
    const result = await h.events.agent_before_settle(h.event, h.ctx);
    assert.equal(result.continue, undefined, kind);
    assert.equal(result.entries.at(-1).customType, 'auto-session-skill-review');
    assert.equal(calls, kind === 'missing' ? 0 : 1);
    assert.ok(h.notices.length);
  }
});

test('separate manual review respects cancellation and sends candidate to the main agent', async () => {
  writeFileSync(config, JSON.stringify({ model: 'provider/model' }));
  const h = harness([{ type: 'message', message: { role: 'user', content: 'Repeated workflow' } }]);
  h.ctx.modelRegistry = { find: () => ({ provider: 'provider', id: 'model' }), streamSimple: () => ({ result: async () => ({ stopReason: 'stop', content: [{ type: 'text', text: '{"decision":"candidate","reason":"Potential workflow"}' }] }) }) };
  await h.commands['auto-skill'].handler('now', h.ctx);
  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0][0].content, /Potential workflow/);
  assert.match(h.messages[0][0].content, /untrusted advisory data/);
});

test('timeout and shutdown abort separate screening without continuing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const action of ['timeout', 'shutdown']) {
    writeFileSync(config, JSON.stringify({ model: 'provider/model' }));
    const h = harness([...branch(2, 25), { type: 'message', message: { role: 'user', content: 'Work request' } }]);
    let signal;
    h.ctx.modelRegistry = { find: () => ({ provider: 'provider', id: 'model' }), streamSimple: (_m, _c, options) => { signal = options.signal; return { result: () => new Promise(() => {}) }; } };
    const running = h.events.agent_before_settle(h.event, h.ctx);
    if (action === 'timeout') t.mock.timers.tick(30_000);
    else h.events.session_shutdown();
    const result = await running;
    assert.equal(signal.aborted, true);
    assert.equal(result?.continue, undefined);
    if (action === 'shutdown') assert.equal(result, undefined);
  }
});

test('queued work or branch navigation prevents stale advisory continuation', async () => {
  for (const action of ['queue', 'branch']) {
    writeFileSync(config, JSON.stringify({ model: 'provider/model' }));
    const h = harness([...branch(2, 25), { type: 'message', message: { role: 'user', content: 'Work request' } }]);
    let resolve;
    h.ctx.modelRegistry = { find: () => ({ provider: 'provider', id: 'model' }), streamSimple: () => ({ result: () => new Promise((done) => { resolve = done; }) }) };
    const running = h.events.agent_before_settle(h.event, h.ctx);
    if (action === 'queue') h.ctx.hasPendingMessages = () => true;
    else h.ctx.sessionManager.getLeafId = () => 'other-branch';
    resolve({ stopReason: 'stop', content: [{ type: 'text', text: '{"decision":"candidate","reason":"Reusable procedure"}' }] });
    assert.equal(await running, undefined);
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
