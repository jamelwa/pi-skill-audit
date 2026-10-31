# pi-skill-audit

A Pi extension that reviews agent skills for possible conversion into tools or hybrid workflows. It compares repeatability, input/output clarity, required judgment, and possible side effects. The result is a starting point for human review—not a tool generator or a safety approval.

Use your current Pi chat model, TypeSafe's Jev classifier, or compare both on the same skill snapshots.

## Install

Requires Pi 1.4.0 or later with model-registry classifier support. Install from Git:

```sh
pi install git:github.com/jamelwa/pi-skill-audit
```

Restart Pi or reload extensions using `/reload`. To try a local checkout without installing it:

```sh
pi -e ./extensions/skill-audit/index.ts
```

Review an extension's source before installing it: Pi extensions run with the same operating-system permissions as Pi.

## Use

In Pi:

```text
/skill-audit
```

Choose one loaded skill or all loaded skills, then select **Current Pi model**, **Jev**, or **Compare both**. Review the listed files and destinations, and explicitly confirm before their contents are sent. No model call is made if you decline.

You can also specify an action, mode, and a path to a skill directory or `SKILL.md`:

```text
/skill-audit scan
/skill-audit scan ./skills
/skill-audit run --mode llm ./skills/example
/skill-audit run --mode jev ./skills/example/SKILL.md
/skill-audit run --mode compare ./skills/example
```

`scan` is local only. Paths are relative to Pi's working directory. Without a path, selection uses Pi's loaded skills. A run is limited to 20 skills, each at most 96 KiB; choose an individual skill or a narrower directory for larger collections. Directory scanning ignores symlinks and common dependency directories; it stops descending when it finds a skill root. Only `SKILL.md` is inspected—not scripts or referenced files. Skills requiring those files may be classified incorrectly.

The report is displayed in a Pi editor dialog. Closing the dialog does not save edits. You can then choose to save the original report as Markdown or JSON. Saving creates a new file with restrictive permissions and refuses to overwrite an existing file. Saved reports can contain paths, skill excerpts, and model output: review them before sharing or committing.

## Model setup

**Current Pi model** uses the model selected via `/model` and its existing Pi credentials. The extension sends a separate request containing the selected skill, not the Pi conversation history. The model is asked for JSON; invalid responses are reported as errors rather than accepted or silently retried.

**Jev** uses Pi's built-in `typesafe/jev-latest` classifier. Set the TypeSafe key in the environment before starting Pi:

```sh
export TYPESAFE_API_KEY="your-key"
pi
```

Get a key from the [TypeSafe console](https://console.typesafe.ai/keys). The extension does not save the key. Jev uses Pi's model registry, so codemode and a separate TypeSafe SDK are not required. If Jev is unavailable, its error is shown; the extension does not silently switch providers. Compare mode can report a failure for one backend while retaining the other result.

Both modes can incur provider charges. The report shows request time and token counts when supplied by Pi. It does not estimate monetary cost or savings. Direct extension requests may not appear in Pi's normal conversation usage totals; consult your provider for billing.

## Interpreting results

| Result | Meaning |
| --- | --- |
| Tool candidate | The assessed workflow appears repeatable, with clear inputs/outputs and little required judgment. |
| Hybrid | Some parts may be suitable for code while other parts need judgment. |
| Keep as skill | The workflow appears to rely substantially on interpretation. |
| Needs review | The result is uncertain, a side effect or approval is reported, or a local review signal is present. |

The local review signals are simple keyword matches. They can be wrong in either direction. A missing signal or a model's `no` answer **does not prove safety**. The Jev confidence review threshold of 0.65 is provisional and has not been calibrated on a labeled dataset. LLM excerpts are shown only if they occur on a single line in the skill; suggested boundaries are model-generated. Model results can still be incorrect, influenced by malicious skill text, or inconsistent.

The audit does not measure how often a skill is used, predict cost savings, execute its instructions, convert it, or modify the skill. To evaluate actual savings, benchmark an implemented tool and original skill on the same tasks, including tool schemas, outputs, provider costs, and failure rates.

## Privacy

The extension reads the selected skill files locally, then previews their paths and target providers before asking for permission to send their **full contents**. Selection is explicit; there is no automatic audit or background upload. It does not inspect references, scripts, environment variables, or session history for the audit. The models and their providers may log or retain submitted content according to their own policies. Don't submit sensitive or work material unless you are authorized to share it with the selected provider. Confirmation is not a substitute for redaction or a security review.

## Development

With Node.js 22.18 or later:

```sh
npm test
```

Tests use synthetic skills and mocked provider responses. An optional end-to-end smoke test exercises Pi's RPC interface and both provider paths against a localhost-only mock server:

```sh
python3 tests/rpc-smoke.py
```

The smoke test requires `pi` on `PATH`; no network credentials are required. The package has no runtime dependencies beyond Pi's host APIs and Node built-ins.

## License

[MIT](LICENSE)
