import { lstat, readFile, mkdir, writeFile, rmdir } from 'node:fs/promises';
import { join } from 'node:path';

export const MAX_TRANSCRIPT = 32_000;
const MAX_INVENTORY = 512 * 1024;
const MAX_FILE = 128 * 1024;
const namePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Only user and assistant text on the current branch. Never include tool output,
// tool arguments, thinking blocks, images, shell output, or abandoned branches.
export function sessionText(branch) {
  const messages = [];
  for (const entry of branch) {
    if (entry.type !== 'message') continue;
    const message = entry.message;
    if (message?.role !== 'user' && message?.role !== 'assistant') continue;
    const text = typeof message.content === 'string' ? message.content : Array.isArray(message.content)
      ? message.content.filter((part) => part.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n') : '';
    const safeText = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '');
    if (safeText.trim()) messages.push(`[${message.role}]\n${safeText}`);
  }
  const text = messages.join('\n\n');
  return { text: text.slice(-MAX_TRANSCRIPT), truncated: text.length > MAX_TRANSCRIPT };
}

// Every loaded skill must be readable; never silently omit one from the overlap check.
export async function snapshotExisting(skills) {
  let total = 0;
  const result = [];
  for (const skill of skills) {
    const stat = await lstat(skill.filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE) throw new Error(`Cannot inspect loaded skill: ${skill.filePath}`);
    const bytes = await readFile(skill.filePath);
    total += bytes.length;
    if (bytes.length > MAX_FILE || total > MAX_INVENTORY) throw new Error('Loaded skills exceed review size limits; narrow the Pi skill configuration.');
    result.push({ name: skill.name, description: skill.description, instructions: bytes.toString('utf8') });
  }
  return result;
}

export function parseReview(raw, transcript, skills) {
  let result;
  try { result = JSON.parse(raw); } catch { throw new Error('Review model returned invalid JSON.'); }
  if (!result || !['no_skill', 'candidate'].includes(result.decision) || typeof result.reason !== 'string' || !result.reason.trim() || result.reason.length > 2000) throw new Error('Invalid review response.');
  if (result.decision === 'no_skill') return { decision: 'no_skill', reason: result.reason };
  const { name, description, body, evidence } = result;
  if (typeof name !== 'string' || name.length > 64 || !namePattern.test(name)) throw new Error('Invalid proposed skill name.');
  if (skills.some((skill) => skill.name.toLowerCase() === name.toLowerCase())) throw new Error('Proposed skill name duplicates a loaded skill.');
  if (typeof description !== 'string' || !description.trim() || description.length > 1024 || /[\r\n\x00-\x1f]/.test(description)) throw new Error('Invalid skill description.');
  if (typeof body !== 'string' || !body.trim() || body.length > 16000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(body) || /^\s*---(?:\r?\n|$)/.test(body)) throw new Error('Invalid skill body.');
  if (!Array.isArray(evidence)) throw new Error('Missing evidence.');
  const required = ['procedure', 'verification'];
  for (const kind of required) {
    const item = evidence.find((e) => e && e.kind === kind && typeof e.quote === 'string' && e.quote.trim().length >= 10 && e.quote.length <= 500 && transcript.includes(e.quote));
    if (!item) throw new Error(`Missing exact ${kind} evidence from the selected transcript.`);
  }
  return { decision: 'candidate', reason: result.reason, name, description, body, evidence: evidence.filter((e) => required.includes(e?.kind) && typeof e.quote === 'string' && e.quote.length <= 500 && transcript.includes(e.quote)).slice(0, 6) };
}

export function skillFile(result) {
  return `---\nname: ${JSON.stringify(result.name)}\ndescription: ${JSON.stringify(result.description)}\n---\n\n${result.body.trim()}\n`;
}

export function validateEdited(text, result) {
  const header = `---\nname: ${JSON.stringify(result.name)}\ndescription: ${JSON.stringify(result.description)}\n---\n\n`;
  if (typeof text !== 'string' || !text.startsWith(header) || !text.slice(header.length).trim() || text.length > 18000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(text)) throw new Error('Draft must keep the proposed frontmatter and a nonempty body.');
  return text.endsWith('\n') ? text : text + '\n';
}

// Atomic directory creation prevents overwriting an existing skill, including symlinks.
export async function createSkill(root, name, content) {
  if (typeof name !== 'string' || name.length > 64 || !namePattern.test(name)) throw new Error('Invalid skill name.');
  const dir = join(root, name);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await mkdir(dir, { mode: 0o700 });
  try {
    const path = join(dir, 'SKILL.md');
    await writeFile(path, content, { flag: 'wx', mode: 0o600 });
    return path;
  } catch (error) {
    await rmdir(dir).catch(() => {});
    throw error;
  }
}
