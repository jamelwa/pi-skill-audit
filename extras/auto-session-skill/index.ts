import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Branch-local checkpoints prevent repeated reviews on reload or /tree navigation.
const CHECKPOINT = "auto-session-skill-review";
const SETTING = "auto-session-skill-setting";
const MIN_TOOLS = 25;
const MIN_USERS = 2;
const SINGLE_REQUEST_TOOLS = 45;

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

function enabledFor(branch: readonly any[]) {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type === "custom" && entry.customType === SETTING) return entry.data?.enabled !== false;
  }
  return true;
}

function instruction() {
  const skills = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "skills");
  return `Automatic current-session skill review. This is a bounded review, not a new user task.\n` +
    `Review only the current conversation and its available context. A lengthy session or many tool calls is merely a trigger, not evidence of a useful skill or task completion. ` +
    `Create or update a skill only if there is a clearly reusable, substantial procedure with hard-won, evidence-backed lessons from a successfully verified outcome. ` +
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
    if (!enabledFor(branch)) return;
    const { tools, users } = countSinceCheckpoint(branch);
    if (tools < SINGLE_REQUEST_TOOLS && (tools < MIN_TOOLS || users < MIN_USERS)) return;
    return {
      entries: [
        { type: "custom", customType: CHECKPOINT, data: { tools, users } },
        { type: "custom_message", customType: CHECKPOINT, content: instruction(), display: true },
      ],
      continue: true,
    };
  });

  pi.registerCommand("auto-skill", {
    description: "Create or improve skills from this session: status, on, off, or now",
    handler: async (args, ctx) => {
      const cmd = args.trim().toLowerCase() || "status";
      if (cmd === "status") {
        const branch = ctx.sessionManager.getBranch();
        const { tools, users } = countSinceCheckpoint(branch);
        ctx.ui.notify(`Auto-skill ${enabledFor(branch) ? "on" : "off"} (this branch); since last review: ${tools} tool results, ${users} user messages. Trigger: ${MIN_TOOLS} tools + ${MIN_USERS} messages, or ${SINGLE_REQUEST_TOOLS} tools.`, "info");
      } else if (cmd === "on" || cmd === "off") {
        pi.appendEntry(SETTING, { enabled: cmd === "on" });
        ctx.ui.notify(`Auto-skill ${cmd} for this session branch.`, "info");
      } else if (cmd === "now") {
        if (ctx.mode !== "tui") { ctx.ui.notify("Manual skill review requires interactive mode.", "warning"); return; }
        if (!ctx.isIdle() || ctx.hasPendingMessages()) { ctx.ui.notify("Wait for current and queued work to finish before reviewing.", "warning"); return; }
        pi.appendEntry(CHECKPOINT, { manual: true });
        pi.sendMessage({ customType: CHECKPOINT, content: instruction(), display: true }, { triggerTurn: true });
      } else {
        ctx.ui.notify("Usage: /auto-skill [status|on|off|now]", "warning");
      }
    },
  });
}
