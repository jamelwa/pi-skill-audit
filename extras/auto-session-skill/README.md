# Auto session skill

Automatically reviews the **active session branch** for reusable procedures. It does not search other sessions. In interactive Pi, after successful settlement with no queued work, the extension requests one additional agent continuation when either threshold is met:

| Sensitivity | Multiple requests | Long single request |
| --- | --- | --- |
| Low | 50 tool results and 3 user messages | 80 tool results |
| Medium (default) | 25 tool results and 2 user messages | 45 tool results |
| High | 12 tool results and 2 user messages | 20 tool results |

These are activity heuristics, not detection of repetition or proof of difficulty or completion. High sensitivity checks sooner and more often; it does not continuously scan or guarantee detection. Each review looks for repeated, complex, tedious or error-prone steps and difficulties, failed attempts, and corrections whose eventual resolutions are verified. It checks for existing skills and, where a material gap exists, prefers a targeted improvement to a relevant regular, non-symlink `SKILL.md` in the user skills directory. Otherwise it may create one new skill there. It changes at most one skill per review, avoids duplicating skills, and reports its decision. It is instructed not to modify external, shared, project, package-managed, or symlinked skills, overwrite a path when creating a skill, execute the procedure, include secrets, or relax approval requirements. By default the existing conversation continues with its current model. An optional separate model can screen the session first; see Model selection below.

This is model-directed automation, not a security boundary: the model can make mistakes, and the extension does not independently enforce path restrictions, validate skill changes, or enforce secret redaction. Review created and updated files before relying on them. If a skill changes, the agent asks you to run `/reload` in Pi; no reload is needed when nothing changes.

## Commands

- `/auto-skill` or `/auto-skill status` — show branch-local state and counters.
- `/auto-skill off` / `/auto-skill on` — disable/enable automatic review on this branch; persists across reload and resume.
- `/auto-skill sensitivity low` / `medium` / `high` — set the branch-local sensitivity; persists across reload and resume. A new branch before the setting inherits earlier branch state, or defaults to medium. Changing sensitivity does not reset counters or enable reviews that are off.
- `/auto-skill now` — run a review immediately when idle, irrespective of thresholds or the on/off setting. It still applies all quality gates.
- `/auto-skill model` — search for an available screening model; choosing a separate model requires confirmation.
- `/auto-skill model provider/model-id` — pin a separate screening model globally after confirmation; model IDs may contain slashes.
- `/auto-skill model current` — use the chat model directly as before, without a separate screening call.

Sensitivity changes review frequency, not the evidence, verification, privacy, or approval requirements. More frequent reviews can add model turns and cost; they do not relax the rule to leave blocked, unverified, sensitive or one-off work unchanged.

The checkpoint follows the session branch, including through reload/resume and tree navigation. A new branch before a checkpoint may be reviewed independently. An aborted or failed review is not automatically retried until another threshold of activity; use `/auto-skill now` to retry. In non-interactive modes, automation and manual review are disabled. The extension does not equate agent settlement with task completion.

## Model selection and privacy

The model preference is global to this extension installation and is saved in `config.json` beside `index.ts`, not in the chat model setting. Other sessions using the same installation pick it up on their next review. Branch-local sensitivity and enabled state are independent. The default, `current`, uses the current chat model directly.

A pinned model receives a **separate tool-free screening request** containing up to the most recent 12,000 characters of user and assistant text from the current branch, plus up to 200 loaded skill names and descriptions (the inventory may be incomplete). Tool results, thinking blocks, and expanded skill wrappers are omitted; this is **not secret redaction**. Text may still contain sensitive information. Before saving a pinned model, Pi asks for confirmation; the choice applies to future automatic reviews as well. Choose only a provider authorized for that context.

The screening model returns a candidate/no-candidate judgment. If it suggests a candidate, the chat agent independently examines session evidence and existing skills before any edit; the suggestion is untrusted, not proof. If it reports no candidate, the extension skips the chat-agent review, so false negatives are possible. Invalid output, unavailable models, errors, and the 30-second timeout skip the review without silently using another provider. The checkpoint prevents immediate automatic retries; use `/auto-skill now` to retry. A separate request may add latency and provider charges; its usage is not included in Pi's chat usage totals. No model call or skill change is guaranteed by a trigger.

Install by keeping this directory under `~/.pi/agent/extensions/`, then run `/reload` in the target session. Tests: `node --test ~/.pi/agent/extensions/auto-session-skill/test.mjs` (set `PI_PACKAGE_DIR` to the installed Pi package path to test the terminal picker).
