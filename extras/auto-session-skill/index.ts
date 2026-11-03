import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Branch-local checkpoints prevent repeated reviews on reload or /tree navigation.
const CHECKPOINT = "auto-session-skill-review";
const SETTING = "auto-session-skill-setting";
const LEVELS = {
  low: { tools: 50, users: 3, single: 80 },
  medium: { tools: 25, users: 2, single: 45 },
  high: { tools: 12, users: 2, single: 20 },
} as const;
type Sensitivity = keyof typeof LEVELS;

function countSinceCheckpoint(branch: readonly any[]) {
  let tools = 0, users = 0;
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type === "custom" && entry.customType === CHECKPOINT) break;
    if (entry.type !== "message") continue;
    if (entry.message?.role === "toolResult") tools++;
    if (entry.message?.role === "user") users++;
  }
  return { tools, users };
}

function settingsFor(branch: readonly any[]): { enabled: boolean; sensitivity: Sensitivity } {
  let enabled: boolean | undefined;
  let sensitivity: Sensitivity | undefined;
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type !== "custom" || entry.customType !== SETTING) continue;
    if (enabled === undefined && typeof entry.data?.enabled === "boolean") enabled = entry.data.enabled;
    const level = entry.data?.sensitivity;
    if (sensitivity === undefined && (level === "low" || level === "medium" || level === "high")) sensitivity = level;
    if (enabled !== undefined && sensitivity !== undefined) break;
  }
  return { enabled: enabled ?? true, sensitivity: sensitivity ?? "medium" };
}

function instruction() {
  const skills = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "skills");
  return `Automatic current-session skill review. This is a bounded review, not a new user task.\n` +
    `Review only the current conversation and its available context. A lengthy session or many tool calls is merely a trigger, not evidence of a useful skill or task completion. ` +
    `Look for repeated, complex, tedious or error-prone steps and hard-won lessons that could form a reusable procedure. ` +
    `Create or update a skill only if there is a clearly reusable, substantial procedure with evidence-backed lessons from a successfully verified outcome. Repetition or difficulty alone is not proof of usefulness or verification. ` +
    `Difficulties, failed attempts, and user corrections are useful only when the eventual resolution or workaround is supported by evidence; distinguish failed approaches from what worked. ` +
    `If work is still underway, blocked, unverified, sensitive, one-off, or no genuinely useful lesson emerged, change nothing. Never infer completion merely because the agent stopped.\n\n` +
    `Before changing anything, check existing available skills and read any potentially relevant SKILL.md for overlap. ` +
    `If an existing skill already covers the workflow and the session demonstrates a material gap, prefer a small targeted update that preserves its existing scope, instructions and safety/approval boundaries. ` +
    `Only update a regular, non-symlink SKILL.md under ${skills}; never modify external, shared, project, package-managed, or symlinked skills automatically. ` +
    `Do not update merely to restate existing guidance. If a relevant skill cannot safely be updated, report the gap instead of creating a duplicate. ` +
    `Otherwise, if no relevant skill exists, create one new portable skill under ${skills}/<new-kebab-case-name>/SKILL.md. ` +
    `Change at most one SKILL.md per review; never overwrite an existing path when creating a new skill, and do not create scripts or other files. Use valid YAML frontmatter with name matching the directory and a specific description describing when to use it. ` +
    `Include prerequisites, concrete verified steps, failure modes, validation, and safety/approval boundaries as applicable; mark limitations and unverified claims honestly. ` +
    `Generalize session-specific values; do not include secrets, credentials, tokens, cookies, raw payloads, private customer data, or unnecessary personal identifiers. ` +
    `Do not run the procedure or take external actions. Keep all original user and project safety requirements. ` +
    `If a skill was created or updated, report its path, the evidence and key change, and ask the user to run /reload in Pi to refresh skill discovery. ` +
    `If no skill was changed, briefly say why; do not mention /reload. Do not attempt to run slash commands or report that you could not run /reload.`;
}

export default function (pi: ExtensionAPI) {
  pi.on("agent_before_settle", (event, ctx) => {
    // Avoid subagents, batch automation, retries, queued work, and other extensions' continuations.
    if (ctx.mode !== "tui" || event.outcome !== "completed" || event.continue ||
        event.context.pendingMessages.length || ctx.hasPendingMessages()) return;
    const branch = ctx.sessionManager.getBranch();
    const { enabled, sensitivity } = settingsFor(branch);
    if (!enabled) return;
    const { tools, users } = countSinceCheckpoint(branch);
    const threshold = LEVELS[sensitivity];
    if (tools < threshold.single && (tools < threshold.tools || users < threshold.users)) return;
    return {
      entries: [
        { type: "custom", customType: CHECKPOINT, data: { tools, users } },
        { type: "custom_message", customType: CHECKPOINT, content: instruction(), display: true },
      ],
      continue: true,
    };
  });

  pi.registerCommand("auto-skill", {
    description: "Review session skills: status, on, off, now, or sensitivity low|medium|high",
    handler: async (args, ctx) => {
      const cmd = args.trim().toLowerCase() || "status";
      if (cmd === "status") {
        const branch = ctx.sessionManager.getBranch();
        const { tools, users } = countSinceCheckpoint(branch);
        const { enabled, sensitivity } = settingsFor(branch);
        const threshold = LEVELS[sensitivity];
        ctx.ui.notify(`Auto-skill ${enabled ? "on" : "off"}, sensitivity ${sensitivity} (this branch); since last review: ${tools} tool results, ${users} user messages. Trigger: ${threshold.tools} tools + ${threshold.users} messages, or ${threshold.single} tools.`, "info");
      } else if (cmd === "on" || cmd === "off") {
        pi.appendEntry(SETTING, { enabled: cmd === "on" });
        ctx.ui.notify(`Auto-skill ${cmd} for this session branch.`, "info");
      } else if (/^sensitivity\s+(low|medium|high)$/.test(cmd)) {
        const sensitivity = cmd.split(/\s+/)[1] as Sensitivity;
        pi.appendEntry(SETTING, { sensitivity });
        const threshold = LEVELS[sensitivity];
        ctx.ui.notify(`Auto-skill sensitivity ${sensitivity} for this session branch: ${threshold.tools} tools + ${threshold.users} messages, or ${threshold.single} tools.`, "info");
      } else if (cmd === "now") {
        if (ctx.mode !== "tui") { ctx.ui.notify("Manual skill review requires interactive mode.", "warning"); return; }
        if (!ctx.isIdle() || ctx.hasPendingMessages()) { ctx.ui.notify("Wait for current and queued work to finish before reviewing.", "warning"); return; }
        pi.appendEntry(CHECKPOINT, { manual: true });
        pi.sendMessage({ customType: CHECKPOINT, content: instruction(), display: true }, { triggerTurn: true });
      } else {
        ctx.ui.notify("Usage: /auto-skill [status|on|off|now|sensitivity low|medium|high]", "warning");
      }
    },
  });
}
