# Auto session skill

Automatically reviews the **active session branch** for hard-won reusable procedures. It does not search other sessions. In interactive Pi, after successful settlement with no queued work, the extension requests one additional agent continuation once either:

- 25 tool results and two user messages have accumulated since the last review; or
- 45 tool results have accumulated since the last review.

These are eligibility heuristics, not proof of difficulty or completion. The agent looks for difficulties, failed attempts, and corrections whose eventual resolutions are verified. It checks for existing skills and, where a material gap exists, prefers a targeted improvement to a relevant regular, non-symlink `SKILL.md` in the user skills directory. Otherwise it may create one new skill there. It changes at most one skill per review, avoids duplicating skills, and reports its decision. It is instructed not to modify external, shared, project, package-managed, or symlinked skills, overwrite a path when creating a skill, execute the procedure, include secrets, or relax approval requirements. This uses the current conversation/model and incurs an additional model turn plus any tool calls; there is no separate transcript upload or model configuration.

This is model-directed automation, not a security boundary: the model can make mistakes, and the extension does not independently enforce path restrictions, validate skill changes, or enforce secret redaction. Review created and updated files before relying on them. If a skill changes, the agent asks you to run `/reload` in Pi; no reload is needed when nothing changes.

## Commands

- `/auto-skill` or `/auto-skill status` — show branch-local state and counters.
- `/auto-skill off` / `/auto-skill on` — disable/enable automatic review on this branch; persists across reload and resume.
- `/auto-skill now` — run a review immediately when idle, irrespective of thresholds or the on/off setting. It still applies all quality gates.

The checkpoint follows the session branch, including through reload/resume and tree navigation. A new branch before a checkpoint may be reviewed independently. An aborted or failed review is not automatically retried until another threshold of activity; use `/auto-skill now` to retry. In non-interactive modes, automation and manual review are disabled. The extension does not equate agent settlement with task completion.

Install by keeping this directory under `~/.pi/agent/extensions/`, then run `/reload` in the target session. Tests: `node --test ~/.pi/agent/extensions/auto-session-skill/test.mjs`.
