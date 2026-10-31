import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerReview } from '../extensions/skill-audit/review.ts';
import { createSkill, MAX_TRANSCRIPT, parseReview, sessionText, skillFile, snapshotExisting, validateEdited } from '../extensions/skill-audit/review-core.js';

const procedure = 'Run the fixture and inspect the resulting log.';
const verified = 'The fixture passed after checking the resulting log.';
const transcript = `[user]\n${procedure}\n\n[assistant]\n${verified}`;
const candidate = {
  decision: 'candidate', reason: 'A distinct repeatable procedure.', name: 'fixture-check',
  description: 'Check fixture output when validating a local test.',
  body: '## Prerequisites\nA local fixture.\n\n## Steps\nRun the fixture and inspect its log.\n\n## Validation\nConfirm the expected output.\n\n## Safety\nAsk before external actions.',
  evidence: [{ kind: 'procedure', quote: procedure }, { kind: 'verification', quote: verified }],
};

test('session snapshot uses current-branch user and assistant text only and bounds size', () => {
  const result = sessionText([
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'image', data: 'secret image' }] } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret thinking' }, { type: 'toolCall', arguments: { secret: 'secret argument' } }, { type: 'text', text: 'done' }] } },
    { type: 'message', message: { role: 'toolResult', content: [{ type: 'text', text: 'secret tool result' }] } },
    { type: 'message', message: { role: 'bashExecution', output: 'secret shell output' } },
  ]);
  assert.equal(result.text, '[user]\nhello\n\n[assistant]\ndone');
  assert.equal(result.truncated, false);
  const long = sessionText([{ type: 'message', message: { role: 'user', content: 'x'.repeat(MAX_TRANSCRIPT + 10) } }]);
  assert.equal(long.text.length, MAX_TRANSCRIPT);
  assert.equal(long.truncated, true);
});

test('candidate requires literal evidence and a safe, nonduplicate name', () => {
  const parsed = parseReview(JSON.stringify(candidate), transcript, []);
  assert.equal(parsed.name, 'fixture-check');
  assert.equal(parseReview(JSON.stringify({ decision: 'no_skill', reason: 'No reusable procedure.' }), transcript, []).decision, 'no_skill');
  assert.throws(() => parseReview(JSON.stringify(candidate), transcript, [{ name: 'fixture-check' }]), /duplicates/);
  assert.throws(() => parseReview(JSON.stringify({ ...candidate, name: '../escape' }), transcript, []), /name/);
  assert.throws(() => parseReview(JSON.stringify({ ...candidate, evidence: [{ kind: 'procedure', quote: procedure }, { kind: 'verification', quote: 'invented verification' }] }), transcript, []), /verification evidence/);
  assert.throws(() => parseReview('broken', transcript, []), /invalid JSON/);
  const draft = skillFile(parsed);
  assert.equal(validateEdited(draft, parsed), draft);
  assert.throws(() => validateEdited(draft.replace('fixture-check', 'renamed'), parsed), /frontmatter/);
});

test('existing skill instructions must all be readable and included', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-'));
  try {
    const path = join(root, 'SKILL.md');
    await writeFile(path, 'Existing instructions');
    assert.deepEqual(await snapshotExisting([{ name: 'existing', description: 'Other work', filePath: path }]), [{ name: 'existing', description: 'Other work', instructions: 'Existing instructions' }]);
    await assert.rejects(snapshotExisting([{ name: 'missing', filePath: join(root, 'missing') }]));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('creating a skill is exclusive and cannot escape the target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-'));
  try {
    const file = await createSkill(root, 'fixture-check', 'original');
    await assert.rejects(createSkill(root, 'fixture-check', 'replacement'), /EEXIST/);
    await assert.rejects(createSkill(root, '../escape', 'bad'), /name/);
    assert.equal(await readFile(file, 'utf8'), 'original');
  } finally { await rm(root, { recursive: true, force: true }); }
});

function setup(root, { send = true, write = false, response = candidate, cancelEditor = '' } = {}) {
  let handler;
  registerReview({ registerCommand(name, options) { assert.equal(name, 'skill-review'); handler = options.handler; } });
  const calls = [], notices = [], dialogs = [];
  const ctx = {
    hasUI: true, model: { provider: 'mock', id: 'model' },
    sessionManager: { getBranch: () => [
      { type: 'message', message: { role: 'user', content: procedure } },
      { type: 'message', message: { role: 'toolResult', content: [{ type: 'text', text: 'do not send tool result' }] } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: verified }] } },
    ] },
    getSystemPromptOptions: () => ({ skills: [{ name: 'existing', description: 'An unrelated procedure', filePath: join(root, 'existing.md') }] }),
    ui: {
      editor: async (title, text) => { dialogs.push({ title, text }); return title.startsWith(cancelEditor) && cancelEditor ? undefined : text; },
      confirm: async (title) => title === 'Send session review payload?' ? send : write,
      notify: (text) => notices.push(text),
    },
    modelRegistry: { complete: async (_model, context) => { calls.push(context); return { stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify(response) }] }; } },
  };
  return { run: () => handler('', ctx), calls, notices, dialogs };
}

test('review requires send and write approvals and checks loaded instructions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    await writeFile(join(root, 'existing.md'), 'Existing skill instructions');
    const declined = setup(root, { send: false, write: true });
    await declined.run();
    assert.equal(declined.calls.length, 0);
    const reviewed = setup(root, { send: true, write: false });
    await reviewed.run();
    assert.equal(reviewed.calls.length, 1);
    const payload = JSON.parse(reviewed.calls[0].messages[0].content[0].text);
    assert.equal(payload.transcript, transcript);
    assert.equal(payload.existing_skills[0].instructions, 'Existing skill instructions');
    assert.ok(!JSON.stringify(payload).includes('do not send tool result'));
    await assert.rejects(lstat(join(root, 'skills', 'fixture-check')));
    const approved = setup(root, { send: true, write: true });
    await approved.run();
    assert.match(await readFile(join(root, 'skills', 'fixture-check', 'SKILL.md'), 'utf8'), /name: "fixture-check"/);
    assert.ok(approved.notices.some((n) => n.includes('/reload')));
    const second = setup(root, { send: true, write: true });
    await second.run();
    assert.ok(second.notices.some((n) => n.includes('EEXIST')));
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('changed loaded instructions prevent creation after approval', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    const path = join(root, 'existing.md');
    await writeFile(path, 'Original instructions');
    const run = setup(root, { write: true });
    // Change the local inventory while the model response is in flight.
    // The second snapshot must reject the stale overlap check.
    const result = JSON.stringify(candidate);
    let handler;
    registerReview({ registerCommand(_name, options) { handler = options.handler; } });
    const ctx = {
      hasUI: true, model: { provider: 'mock', id: 'model' },
      sessionManager: { getBranch: () => [{ type: 'message', message: { role: 'user', content: transcript } }] },
      getSystemPromptOptions: () => ({ skills: [{ name: 'existing', description: 'Other', filePath: path }] }),
      ui: { editor: async (_title, text) => text, confirm: async () => true, notify: (message) => run.notices.push(message) },
      modelRegistry: { complete: async () => { await writeFile(path, 'Changed instructions'); return { stopReason: 'stop', content: [{ type: 'text', text: result }] }; } },
    };
    await handler('', ctx);
    assert.ok(run.notices.some((n) => n.includes('inventory changed')));
    await assert.rejects(lstat(join(root, 'skills', 'fixture-check')));
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('no-skill and cancelled preview never create a skill', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    await writeFile(join(root, 'existing.md'), 'Other instructions');
    const noSkill = setup(root, { write: true, response: { decision: 'no_skill', reason: 'No verified reusable procedure.' } });
    await noSkill.run();
    assert.equal(noSkill.calls.length, 1);
    assert.ok(noSkill.dialogs.some((d) => d.title === 'No skill proposed'));
    const cancelled = setup(root, { write: true, cancelEditor: 'Payload for' });
    await cancelled.run();
    assert.equal(cancelled.calls.length, 0);
    await assert.rejects(lstat(join(root, 'skills')));
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
