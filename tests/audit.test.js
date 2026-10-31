import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assess, discover, snapshot, parseJev, parseLlm, renderReport, MAX_SKILL_BYTES } from '../extensions/skill-audit/core.js';
import extension from '../extensions/skill-audit/index.ts';

const good = { repeatability: 'high', contract: 'high', judgment: 'low', side_effects: 'no' };
const answers = Object.fromEntries(Object.entries(good).map(([key, choice]) => [key, { type: 'choice', choice, confidence: 0.9 }]));

test('local gates are conservative and deterministic', () => {
  assert.equal(assess(good, []).recommendation, 'tool candidate');
  assert.equal(assess({ ...good, judgment: 'high' }, []).recommendation, 'keep as skill');
  assert.equal(assess({ ...good, contract: 'medium' }, []).recommendation, 'hybrid');
  assert.equal(assess({ ...good, side_effects: 'unknown' }, []).recommendation, 'needs review');
  assert.equal(assess(good, [{ line: 1, text: 'approval' }]).recommendation, 'needs review');
  assert.throws(() => assess({ ...good, judgment: 'maybe' }, []), /Invalid/);
});

test('Jev handles model failures, uncertain and invalid answers', () => {
  assert.equal(parseJev({ stopReason: 'stop', answers }, 'Safe local read.').recommendation, 'tool candidate');
  assert.equal(parseJev({ stopReason: 'stop', answers: { ...answers, contract: { ...answers.contract, confidence: 0.3 } } }, 'Local read.').recommendation, 'needs review');
  assert.throws(() => parseJev({ stopReason: 'error', errorMessage: 'unavailable' }, ''), /unavailable/);
  assert.throws(() => parseJev({ stopReason: 'stop', answers: {} }, ''), /Invalid Jev/);
});

test('LLM JSON validation and literal evidence checking', () => {
  const result = parseLlm(JSON.stringify({ dimensions: good, evidence: ['exact phrase', 'invented'], boundary: 'extract locally' }), 'first\nexact phrase here');
  assert.deepEqual(result.quotes, [{ line: 2, text: 'exact phrase' }]);
  assert.throws(() => parseLlm('not JSON', ''), /invalid JSON/);
  assert.throws(() => parseLlm(JSON.stringify({ dimensions: { ...good, judgment: 'invented' } }), ''), /Invalid/);
  assert.equal(parseLlm(JSON.stringify({ dimensions: good }), 'Request approval.').recommendation, 'needs review');
});

test('discover and snapshot enforce bounds and do not traverse nested skill roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-audit-'));
  try {
    await mkdir(join(root, 'a', 'nested'), { recursive: true });
    await mkdir(join(root, 'node_modules', 'ignored'), { recursive: true });
    await writeFile(join(root, 'a', 'SKILL.md'), 'one');
    await writeFile(join(root, 'a', 'nested', 'SKILL.md'), 'nested');
    await writeFile(join(root, 'node_modules', 'ignored', 'SKILL.md'), 'ignored');
    await symlink(join(root, 'a'), join(root, 'link'));
    assert.deepEqual(await discover(root), [join(root, 'a', 'SKILL.md')]);
    assert.equal((await snapshot(await discover(root)))[0].text, 'one');
    await assert.rejects(discover(join(root, 'link')), /Symlink/);
    await writeFile(join(root, 'a', 'SKILL.md'), 'x'.repeat(MAX_SKILL_BYTES + 1));
    await assert.rejects(snapshot([join(root, 'a', 'SKILL.md')]), /exceeds/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('report escapes terminal control characters and reports failures', () => {
  const report = renderReport([{ path: 'skill\u001b[31m', llmError: 'error: offline' }], 'compare');
  assert.ok(!report.includes('\u001b'));
  assert.match(report, /error: offline/);
  assert.match(report, /unknown \(not measured\)/);
});

function setup(root, confirms, mode, opts = {}) {
  let handler;
  extension({ registerCommand(name, options) { if (name === 'skill-audit') handler = options.handler; } });
  const calls = [], notices = [], editors = [];
  const ctx = {
    hasUI: true, cwd: root, model: { provider: 'example', id: 'model' },
    getSystemPromptOptions: () => ({ skills: [{ name: 'one', filePath: join(root, 'SKILL.md') }] }),
    ui: {
      select: async (_title, options) => options[0],
      confirm: async (title, text) => { calls.push({ title, text }); return confirms.shift() ?? false; },
      editor: async (title, text) => { editors.push({ title, text }); },
      input: async () => 'report.md',
      notify: (text) => notices.push(text),
    },
    modelRegistry: {
      complete: async (_model, context) => { calls.push({ llm: context }); if (opts.llmError) throw Error('offline'); return { stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify({ dimensions: good, evidence: ['local read'] }) }] }; },
      findOfType: () => ({ provider: 'typesafe', id: 'jev-latest' }),
      classify: async (_model, context) => { calls.push({ jev: context }); return { stopReason: 'stop', answers }; },
    },
  };
  return { run: () => handler(`run --mode ${mode}`, ctx), calls, notices, editors, ctx };
}

test('command requires consent and compare sends identical snapshots without conversation history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-audit-'));
  try {
    await writeFile(join(root, 'SKILL.md'), 'local read');
    const cancelled = setup(root, [false], 'compare');
    await cancelled.run();
    assert.equal(cancelled.calls.filter((c) => c.llm || c.jev).length, 0);
    const run = setup(root, [true, true], 'compare');
    await run.run();
    const llm = run.calls.find((c) => c.llm).llm;
    const jev = run.calls.find((c) => c.jev).jev;
    assert.deepEqual(JSON.parse(llm.messages[0].content[0].text), { skill: 'local read' });
    assert.equal(jev.state.skill, 'local read');
    assert.equal(llm.messages.length, 1);
    assert.match(run.editors[0].text, /example\/model/);
    assert.match(await readFile(join(root, 'report.md'), 'utf8'), /tool candidate/);
    const again = setup(root, [true, true], 'compare');
    await again.run();
    assert.ok(again.notices.some((n) => n.includes('EEXIST')));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('JSON report contains the normalized result and no complete skill text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-audit-'));
  try {
    await writeFile(join(root, 'SKILL.md'), 'local read\nprivate synthetic detail');
    const run = setup(root, [true, true], 'llm');
    let selects = 0;
    run.ctx.ui.select = async (_title, options) => ++selects === 1 ? options[0] : 'JSON';
    run.ctx.ui.input = async () => 'report.json';
    await run.run();
    const report = JSON.parse(await readFile(join(root, 'report.json'), 'utf8'));
    assert.equal(report.results[0].llm.recommendation, 'tool candidate');
    assert.ok(!JSON.stringify(report).includes('private synthetic detail'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('compare preserves one backend failure without silently falling back', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-audit-'));
  try {
    await writeFile(join(root, 'SKILL.md'), 'local read');
    const run = setup(root, [true, false], 'compare', { llmError: true });
    await run.run();
    assert.match(run.editors[1].text, /error: offline/);
    assert.match(run.editors[1].text, /tool candidate/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
