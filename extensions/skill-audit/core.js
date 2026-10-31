import { readdir, readFile, lstat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

export const MAX_SKILL_BYTES = 96 * 1024;
export const MAX_SKILLS = 20;
const SKIP = new Set(['.git', 'node_modules', '.venv']);

// Discovery never follows symlinks, executes scripts, or reads referenced files.
export async function discover(path) {
  const root = resolve(path);
  const files = [];
  let directories = 0;
  async function visit(p) {
    const stat = await lstat(p);
    if (stat.isSymbolicLink()) throw new Error(`Symlink not allowed: ${p}`);
    if (stat.isFile()) {
      if (basename(p) !== 'SKILL.md') throw new Error(`Expected SKILL.md: ${p}`);
      files.push(p);
      return;
    }
    if (!stat.isDirectory()) throw new Error(`Not a file or directory: ${p}`);
    if (++directories > 1000) throw new Error('Directory limit exceeded (1000). Choose a narrower path.');
    const entries = await readdir(p, { withFileTypes: true });
    const skill = entries.find((e) => e.name === 'SKILL.md' && e.isFile());
    if (skill) { files.push(join(p, skill.name)); return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory() && !SKIP.has(e.name)) await visit(join(p, e.name));
    }
  }
  await visit(root);
  return files;
}

export async function snapshot(files) {
  if (!files.length) throw new Error('No SKILL.md files found.');
  if (files.length > MAX_SKILLS) throw new Error(`Limit is ${MAX_SKILLS} skills per audit. Choose fewer.`);
  const result = [];
  for (const file of files) {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Not a regular file: ${file}`);
    if (stat.size > MAX_SKILL_BYTES) throw new Error(`${file} exceeds ${MAX_SKILL_BYTES} bytes.`);
    const bytes = await readFile(file);
    if (bytes.length > MAX_SKILL_BYTES) throw new Error(`${file} exceeds ${MAX_SKILL_BYTES} bytes.`);
    result.push({ path: resolve(file), text: bytes.toString('utf8'), bytes: bytes.length });
  }
  return result;
}

export const questions = {
  repeatability: {
    type: 'choice', instructions: 'How explicitly repeatable are the steps in this skill?',
    criteria: { high: 'Steps are clearly specified and repeatable', medium: 'Some steps are repeatable but others are underspecified', low: 'Steps depend mostly on interpretation', unknown: 'Not enough information' },
  },
  contract: {
    type: 'choice', instructions: 'How clearly are the inputs and outputs defined?',
    criteria: { high: 'Inputs and outputs are explicitly defined', medium: 'Some inputs or outputs are defined', low: 'Inputs and outputs are vague', unknown: 'Not enough information' },
  },
  judgment: {
    type: 'choice', instructions: 'How much contextual judgment does the workflow require?',
    criteria: { high: 'Judgment is central throughout', medium: 'Some steps require judgment', low: 'Little judgment is required', unknown: 'Not enough information' },
  },
  side_effects: {
    type: 'choice', instructions: 'Does the skill describe writes to external systems, sensitive actions, or approval checkpoints?',
    criteria: { yes: 'Such actions or approval checkpoints are described', no: 'No such actions are described in the supplied text', unknown: 'The text is ambiguous' },
  },
};

const values = {
  repeatability: ['high', 'medium', 'low', 'unknown'],
  contract: ['high', 'medium', 'low', 'unknown'],
  judgment: ['high', 'medium', 'low', 'unknown'],
  side_effects: ['yes', 'no', 'unknown'],
};

// These are review signals, not an exhaustive security scanner.
const riskPattern = /\b(approval|approve|authori[sz]ation|credential|password|secret|token|deploy(?:ment)?|production|publish|delete|destructive|send|upload|write|modif(?:y|ication))\b/i;
export function riskEvidence(text) {
  return text.split(/\r?\n/).flatMap((line, index) => riskPattern.test(line) ? [{ line: index + 1, text: line.trim().slice(0, 240) }] : []).slice(0, 5);
}

export function assess(dimensions, evidence, uncertain = false) {
  for (const [key, allowed] of Object.entries(values)) {
    if (!allowed.includes(dimensions[key])) throw new Error(`Invalid or missing ${key}`);
  }
  const d = dimensions;
  let recommendation;
  if (uncertain || evidence.length || d.side_effects !== 'no' || Object.values(d).includes('unknown')) recommendation = 'needs review';
  else if (d.repeatability === 'high' && d.contract === 'high' && d.judgment === 'low') recommendation = 'tool candidate';
  else if (d.judgment === 'high' || d.repeatability === 'low') recommendation = 'keep as skill';
  else recommendation = 'hybrid';
  return { dimensions: d, recommendation, evidence, uncertain };
}

export function parseLlm(text, skillText) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error('LLM returned invalid JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !parsed.dimensions || typeof parsed.dimensions !== 'object') throw new Error('LLM response is missing dimensions');
  const dimensions = Object.fromEntries(Object.keys(values).map((key) => [key, parsed.dimensions[key]]));
  const lineList = skillText.split(/\r?\n/);
  const quotes = Array.isArray(parsed.evidence) ? parsed.evidence.slice(0, 3).flatMap((quote) => {
    if (typeof quote !== 'string' || !quote.trim() || quote.length > 240) return [];
    const line = lineList.findIndex((value) => value.includes(quote));
    return line < 0 ? [] : [{ line: line + 1, text: quote }];
  }) : [];
  const result = assess(dimensions, riskEvidence(skillText));
  return { ...result, quotes, boundary: typeof parsed.boundary === 'string' ? parsed.boundary.slice(0, 400) : '' };
}

export function parseJev(response, skillText) {
  if (response.stopReason !== 'stop') throw new Error(`Jev request ${response.stopReason}: ${response.errorMessage || 'no details'}`);
  const dimensions = {};
  const confidences = {};
  let uncertain = false;
  for (const key of Object.keys(values)) {
    const answer = response.answers?.[key];
    if (!answer || answer.type !== 'choice' || !values[key].includes(answer.choice)) throw new Error(`Invalid Jev answer: ${key}`);
    if (typeof answer.confidence !== 'number' || !Number.isFinite(answer.confidence) || answer.confidence < 0.65 || answer.confidence > 1) uncertain = true;
    confidences[key] = typeof answer.confidence === 'number' && Number.isFinite(answer.confidence) ? answer.confidence : null;
    dimensions[key] = answer.choice;
  }
  return { ...assess(dimensions, riskEvidence(skillText), uncertain), confidences };
}

function safe(value) { return String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\|/g, '\\|'); }
export function renderReport(rows, mode) {
  const out = ['# Skill audit', '', `Mode: ${safe(mode)}`, '', 'Advisory only. Results are model judgments, not safety guarantees or measured savings.', '', '| Skill | LLM | Jev |', '| --- | --- | --- |'];
  for (const row of rows) out.push(`| ${safe(row.path)} | ${safe(row.llm?.recommendation ?? row.llmError ?? '—')} | ${safe(row.jev?.recommendation ?? row.jevError ?? '—')} |`);
  for (const row of rows) {
    out.push('', `## ${safe(row.path)}`);
    for (const mode of ['llm', 'jev']) {
      const r = row[mode];
      if (!r) continue;
      out.push('', `### ${mode.toUpperCase()}: ${r.recommendation}`, '', `- Dimensions: ${safe(JSON.stringify(r.dimensions))}`);
      if (r.model) out.push(`- Model: ${safe(r.model)}`);
      if (Number.isFinite(r.elapsedMs)) out.push(`- Request time: ${r.elapsedMs} ms`);
      if (r.usage && Number.isFinite(r.usage.input) && Number.isFinite(r.usage.output)) out.push(`- Reported tokens: ${r.usage.input} input, ${r.usage.output} output`);
      if (r.confidences) out.push(`- Jev confidence: ${safe(JSON.stringify(r.confidences))}`);
      if (r.uncertain) out.push('- Jev confidence below the provisional review threshold or unavailable.');
      if (r.boundary) out.push(`- Suggested boundary (model-generated): ${safe(r.boundary)}`);
      for (const item of r.quotes || []) out.push(`- Verified model quote, line ${item.line}: ${safe(item.text)}`);
      for (const item of r.evidence) out.push(`- Local review signal, line ${item.line}: ${safe(item.text)}`);
    }
  }
  out.push('', 'Token savings and usage frequency: unknown (not measured). Cost is not estimated.', 'Review signals are incomplete and can include false positives; absence of a signal does not mean a skill is safe.', '');
  return out.join('\n');
}
