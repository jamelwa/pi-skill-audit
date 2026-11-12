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
    await assert.rejects(snapshot(Array(21).fill(join(root, 'missing', 'SKILL.md'))), /Limit is 20 skills/);
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
      editor: async (title, text) => { editors.push({ title, text }); return opts.cancelPreview && title.startsWith('Review files and providers') ? undefined : text; },
      input: async () => 'report.md',
      notify: (text) => notices.push(text),
    },
    modelRegistry: {
      complete: async (_model, context) => { calls.push({ llm: context }); if (opts.llmError) throw Error('offline'); return { stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify({ dimensions: good, evidence: ['local read'] }) }] }; },
      findOfType: () => ({ provider: 'typesafe', id: 'jev-latest' }),
      classify: async (_model, context) => { calls.push({ jev: context }); return { stopReason: 'stop', answers }; },
    },
  };
  return { run: (args = `run --mode ${mode}`) => handler(args, ctx), calls, notices, editors, ctx };
}

async function fixtureSkills(root, count = 41) {
  const skills = [];
  for (let i = 1; i <= count; i++) {
    const name = `skill-${String(i).padStart(2, '0')}`;
    const directory = join(root, name);
    await mkdir(directory);
    const filePath = join(directory, 'SKILL.md');
    await writeFile(filePath, `local read ${i}`);
    skills.push({ name, filePath });
  }
  return skills;
}

test('large catalogs audit only the explicitly chosen batch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-audit-'));
  try {
    const skills = await fixtureSkills(root);
    const run = setup(root, [true, false], 'compare');
    // Unselected paths need not even be readable; only the approved batch is snapshotted.
    run.ctx.getSystemPromptOptions = () => ({ skills: skills.map((skill, i) =>
      i >= 20 && i < 40 ? skill : { ...skill, filePath: join(root, 'missing', skill.name, 'SKILL.md') }) });
    const selections = [];
    run.ctx.ui.select = async (title, options) => {
      selections.push({ title, options });
      return selections.length === 1 ? options[0] : options[1];
    };
    await run.run();
    assert.equal(selections.length, 2);
    assert.match(selections[0].title, /41 loaded/);
    assert.match(selections[1].title, /max 20 per audit/);
    assert.deepEqual(selections[1].options, [
      'Batch 1/3: 1–20 of 41 skills', 'Batch 2/3: 21–40 of 41 skills', 'Batch 3/3: 41–41 of 41 skills',
    ]);
    const expected = Array.from({ length: 20 }, (_, i) => `local read ${i + 21}`);
    assert.deepEqual(run.calls.filter(c => c.llm).map(c => JSON.parse(c.llm.messages[0].content[0].text).skill), expected);
    assert.deepEqual(run.calls.filter(c => c.jev).map(c => c.jev.state.skill), expected);
    assert.equal(run.calls.filter(c => c.title === 'Send selected skill contents?').length, 1);
    assert.match(run.editors[0].text, /skill-21/);
    assert.doesNotMatch(run.editors[0].text, /missing/);
    assert.deepEqual(run.notices.filter(n => n.startsWith('skill-audit:')), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('batch boundaries retain the cap and never automatically run another batch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-audit-'));
  try {
    const skills = await fixtureSkills(root);
    for (const [total, expectedRequests] of [[20, 20], [21, 1], [40, 20], [41, 1]]) {
      const run = setup(root, [true, false], 'llm');
      run.ctx.getSystemPromptOptions = () => ({ skills: skills.slice(0, total) });
      const selections = [];
      run.ctx.ui.select = async (title, options) => {
        selections.push(title);
        return selections.length === 1 ? options[0] : options.at(-1);
      };
      await run.run();
      assert.equal(selections.length, total === 20 ? 1 : 2);
      assert.equal(run.calls.filter(c => c.llm).length, expectedRequests, `${total} skills`);
      assert.equal(run.calls.filter(c => c.title === 'Send selected skill contents?').length, 1);
      assert.deepEqual(run.notices.filter(n => n.startsWith('skill-audit:')), []);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an individual skill remains selectable from a large catalog', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-audit-'));
  try {
    const skills = await fixtureSkills(root, 21);
    const run = setup(root, [true, false], 'llm');
    run.ctx.getSystemPromptOptions = () => ({ skills });
    let selections = 0;
    run.ctx.ui.select = async (_title, options) => { selections++; return options.at(-1); };
    await run.run();
    assert.equal(selections, 1);
    const calls = run.calls.filter(c => c.llm);
    assert.equal(calls.length, 1);
    assert.equal(JSON.parse(calls[0].llm.messages[0].content[0].text).skill, 'local read 21');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('cancelling the catalog or batch picker stops before file reads and consent', async () => {
  for (const cancelAt of [1, 2]) {
    const run = setup('/synthetic-unreadable-catalog', [true], 'llm');
    run.ctx.getSystemPromptOptions = () => ({ skills: Array.from({ length: 21 }, (_, i) =>
      ({ name: `skill-${i}`, filePath: `/synthetic-unreadable-catalog/${i}/SKILL.md` })) });
    let selections = 0;
    run.ctx.ui.select = async (_title, options) => ++selections === cancelAt ? undefined : options[0];
    await run.run();
    assert.equal(selections, cancelAt);
    assert.deepEqual(run.calls, []);
    assert.deepEqual(run.editors, []);
    assert.deepEqual(run.notices, []);
  }
});

test('directory runs offer batches while directory scans retain the full inventory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-audit-'));
  try {
    await fixtureSkills(root, 21);
    const run = setup(root, [true, false], 'llm');
    const selections = [];
    run.ctx.ui.select = async (title, options) => { selections.push(title); return options.at(-1); };
    await run.run('run --mode llm .');
    assert.equal(selections.length, 1);
    assert.match(selections[0], /Choose one batch/);
    assert.equal(run.calls.filter(c => c.llm).length, 1);
    assert.equal(JSON.parse(run.calls.find(c => c.llm).llm.messages[0].content[0].text).skill, 'local read 21');
    const scan = setup(root, [], 'llm');
    scan.ctx.ui.select = async () => { throw Error('Directory scan must not request a batch'); };
    await scan.run('scan .');
    assert.match(scan.editors[0].title, /inventory \(21; no model call\)/);
    assert.equal(scan.editors[0].text.split('\n').length, 21);
    assert.deepEqual(scan.calls, []);
    assert.deepEqual(scan.notices, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('selected batches still require preview submission and separate send consent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-audit-'));
  try {
    const skills = await fixtureSkills(root, 21);
    for (const cancelPreview of [true, false]) {
      const run = setup(root, [false], 'llm', { cancelPreview });
      run.ctx.getSystemPromptOptions = () => ({ skills });
      let selections = 0;
      run.ctx.ui.select = async (_title, options) => ++selections === 1 ? options[0] : options.at(-1);
      await run.run();
      assert.equal(selections, 2);
      assert.equal(run.editors.length, 1);
      assert.match(run.editors[0].text, /skill-21/);
      assert.doesNotMatch(run.editors[0].text, /skill-01/);
      assert.equal(run.calls.filter(c => c.llm || c.jev).length, 0);
      assert.equal(run.calls.filter(c => c.title === 'Send selected skill contents?').length, cancelPreview ? 0 : 1);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

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

test('cancelling the file preview stops before consent or provider calls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-audit-'));
  try {
    await writeFile(join(root, 'SKILL.md'), 'local read');
    const run = setup(root, [true, true], 'compare', { cancelPreview: true });
    await run.run();
    assert.equal(run.editors.length, 1);
    assert.equal(run.calls.length, 0);
    assert.equal(run.notices.length, 0);
    await assert.rejects(readFile(join(root, 'report.md')), { code: 'ENOENT' });
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
