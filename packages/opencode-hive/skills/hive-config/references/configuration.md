# Agent Hive configuration

## Files and precedence

| File | Scope | Notes |
|---|---|---|
| `~/.config/opencode/agent_hive.json` | Global, authoritative | Path is built from `$HOME` (`USERPROFILE` on Windows). `OPENCODE_CONFIG_DIR` and `XDG_CONFIG_HOME` do not move it |
| `<project>/.hive/agent-hive.override.json` | Project | Only `model` and `variant` for agents already present in the effective global or default config |
| `<project>/.hive/agent-hive.json`, `<project>/.opencode/agent_hive.json` | none | Ignored. Moving settings here does nothing |
| `opencode.json` | OpenCode | Plugin list, providers, model `variants`, global `permission`, `skills.paths`/`skills.urls`. Not Agent Hive config |

<!-- hive-host opencode-v1 -->
When the global file is missing, the plugin's config hook creates it at host startup with the defaults and three `*-example-template` custom agents. Configuration is read at that point and then cached.
<!-- /hive-host -->
<!-- hive-host opencode-v2 -->
The v2 entry never creates the global file. When it is missing, Hive uses the built-in defaults without the example custom agents, and writing the file is a manual step. Configuration is read once when the plugin activates and then cached.
<!-- /hive-host -->

After editing either Agent Hive file:

1. If OpenCode loads the plugin from a local checkout (a `file://.../packages/opencode-hive/dist/index.js` plugin entry), rebuild that checkout first (`bun run build`). A build inside a Hive worktree updates only that worktree's bundle.
2. Identify the long-lived OpenCode process that loaded the plugin, name it, and ask the operator before restarting it: restarting the host interrupts every session it serves. It may be an `opencode` TUI, an `opencode serve` process, or a service unit that runs one. One operator's setup, for example, runs `opencode serve` as the `opencode.service` user unit (`systemctl --user restart opencode.service`); do not assume that unit exists elsewhere. Restarting a client that attaches to a server does not reload the server's plugin.
<!-- hive-host opencode-v1 -->
3. Start fresh sessions. Existing child sessions keep their creation-time permissions and prompts.
<!-- /hive-host -->
<!-- hive-host opencode-v2 -->
3. Send a new message in each session and launch fresh child sessions. Hive adds role instructions to every request from the catalog built at activation, so an open session picks up the reloaded settings on its next request. A child captures its route and constraints when it is dispatched.
<!-- /hive-host -->
4. Confirm that no `Failed to read global config` or `Failed to read project agent override` warning appeared. The plugin raises it as an "Agent Hive Config Warning" notification (or a `[hive:config]` host log line when notifications are unavailable), and `hive_status` repeats it in its `warning` field. Either warning means that file was ignored.

## Validation failure falls back to defaults

The global file is all-or-nothing. Any of these makes the runtime ignore the **entire** file and use built-in defaults, with a warning:

- invalid JSON, or a non-object root;
- an unknown top-level key (only the keys in the table below are accepted);
- a wrong type on a known key, such as a non-string `model` or a non-array `autoLoadSkills`;
- `description` on a built-in agent that is not one of the seven custom bases;
- an `agents.<name>` value that is not an object, or a wrong type on one of its known fields;
- a `council.groups.<name>` entry without a non-empty string array `members`. Declaring a group replaces the default group of that name, so a group that only changes `description` or `maxMembers` still needs `members`;
- any other wrong type inside `council` (`defaultGroup` string, `maxMembers` positive integer, `excludedAgents` string array, `groups` object);
- an unknown key inside `taskTraceSummarizer`, or a non-string `model` or `variant` there;
- an `enableToolsFor` or `disableSkills` value that is not a string array, or a `hook_cadence` value that is not a positive integer;
- `repositoryRoot` without `repositories` (or the reverse), a relative `repositoryRoot`, or an empty or malformed `repositories` array.

Not validated at this stage, so they never invalidate the file: unknown keys inside an `agents.<name>` declaration (ignored), unknown keys inside `council` or a council group, and anything under `customAgents`. Bad custom agents are skipped one at a time with a warning. The removed key `omoSlimEnabled` is ignored with a warning. The removed setting `temperature`, with any value, is dropped from `agents`, `customAgents` and `taskTraceSummarizer` before validation, with one warning per read that names the file but not the value; the rest of the file applies and the file is not rewritten. Hive sets no sampling options, so each model's native defaults apply. An invalid project override file is ignored on its own; the global file still applies.

## Model settings are checked, not repaired

After the project override and custom-agent inheritance are applied, every `model` and `variant` the files supply is checked, and a failure stops the plugin at startup instead of falling back to defaults:

- A supplied `model` must be an explicit `provider/model-id` without spaces or `#`. A supplied `variant` must be a name without spaces or `#`. A blank string is an error, not an omission.
- A `variant` needs an explicit Hive `model` on the same effective declaration: the role's global entry, its project override, or, for a custom agent, its resolved Hive base role. OpenCode's own model settings never complete it.
- `taskTraceSummarizer.variant` needs `taskTraceSummarizer.model`.

The error names the file or files, each property path and the remedy, never the values. Fix the file: set the explicit model, or remove the variant so the role inherits the native model. Hive writes (`set`, first-run creation) check the global file on its own, so a project override cannot make a written global variant valid. Neither `model` nor `variant` means the role, custom agent or summarizer uses the native OpenCode model.

After editing, check that the JSON parses and that every top-level key is in the table. After the restart, confirm that no `Failed to read global config` warning appeared (step 4 above). The published JSON Schema (`$schema` URL below) is the machine-readable reference; it is stricter than the runtime in places.

## Top-level keys

| Key | Type | Runtime effect |
|---|---|---|
| `$schema` | string | Editor validation only. `https://raw.githubusercontent.com/imarshallwidjaja/agent-hive/main/packages/opencode-hive/schema/agent_hive.schema.json` |
| `agentMode` | `"dedicated"` (default) or `"unified"` | Dedicated: `architect-planner` plans and `swarm-orchestrator` executes; `hive-master` is hidden. Unified: `hive-master` is the default planner and orchestrator. `hive-builder`, workers, reviewers, and `hive-helper` exist in both |
| `agents` | object keyed by built-in agent name | Per-agent `model`, `variant`, `autoLoadSkills`; `description` only on custom bases. See below |
| `customAgents` | object keyed by new agent ID | Derived subagents. See below |
| `disableSkills` | string[] | Stops materializing and auto-loading the named Hive-bundled skills. A native or user skill with the same name is not blocked |
| `council` | object | `/council` groups: `defaultGroup`, `maxMembers`, `excludedAgents`, `groups.<name>.{description, members, maxMembers}`. Partial values merge with defaults; a declared group replaces that group and must include non-empty `members` |
| `taskTraceSummarizer` | `{ model?, variant? }` | Model for `hive_task_trace({ recovery: true })` only. Empty: each recovery uses the invoking caller's native model and variant. `model` alone uses that model's default variant. No other keys |
| `enableToolsFor` | string[] | Accepted; no runtime effect. It does not grant tools |
| `hook_cadence` | object of positive integers | Accepted; currently no runtime effect |
| `repositoryRoot`, `repositories` | legacy | Migration-only multi-repo topology. Use `.hive/repositories.json` through `hive_repositories_update` |

## Built-in agents (`agents.<name>`)

Names: `hive-master`, `architect-planner`, `swarm-orchestrator`, `hive-builder`, `scout-researcher`, `forager-worker`, `hive-helper`, `plan-reviewer`, `code-reviewer`, `simplicity-reviewer`, `approach-advisor`, `vulnerability-reviewer`. The hidden review primaries `dash-reviewer` and `vulnerability-review-primary` are not configurable here.

| Field | Meaning |
|---|---|
| `model` | `provider/model-id`. Omit `model` and `variant` to use the native OpenCode model for the role |
| `variant` | Requires an explicit Hive `model` (see above). Passed to OpenCode, which looks it up in the model's resolved variants: the provider's built-in variants for that model, overlaid by `provider.<provider>.models.<model>.variants` in `opencode.json` (which can add, change, or disable entries). Observed OpenCode host behavior, not enforced by Hive: an unknown key is a no-op, and an explicit variant on a prompt wins |
| `autoLoadSkills` | Skill names to advertise as high-priority loads. **Merged** with the agent's defaults and de-duplicated; you cannot remove a default by listing `[]`. Names resolve through native/user skills first, then eligible Hive bundles; unknown or disabled names warn and are skipped. `onboarding` is silently dropped for every agent except `hive-master` and `architect-planner` (custom agents included) before any lookup |
| `description` | Only on `scout-researcher`, `forager-worker`, `plan-reviewer`, `code-reviewer`, `simplicity-reviewer`, `approach-advisor`, `vulnerability-reviewer`: overrides the routing description primaries see. Blank inherits the default |
| `skills` | Legacy; accepted, no effect |

Defaults (shipped): `hive-master`, `architect-planner`, `swarm-orchestrator` auto-load `parallel-exploration`; `forager-worker` loads `verification`; `hive-builder` loads `verification` and `parallel-exploration`; `hive-helper` loads `hive-config`; others load none.

`hive-helper` is special: its operator `autoLoadSkills` is ignored and it always gets exactly its defaults. To stop it loading `hive-config`, add `hive-config` to `disableSkills` (which disables the bundled skill for every agent).

No role has a shipped model. A stored `model` is kept as written, including one equal to a model older releases generated; to switch a role to native inheritance, delete its `model` and `variant` together.

## Custom agents (`customAgents.<id>`)

```json
{
  "customAgents": {
    "forager-ui": {
      "baseAgent": "forager-worker",
      "description": "Use for UI implementation touching components, styling, accessibility, or browser-visible behavior.",
      "model": "anthropic/claude-sonnet-4-20250514",
      "variant": "high",
      "autoLoadSkills": ["verification"]
    }
  }
}
```

- `baseAgent` (required): one of `scout-researcher`, `forager-worker`, `plan-reviewer`, `code-reviewer`, `simplicity-reviewer`, `approach-advisor`, `vulnerability-reviewer`. Primaries, `hive-builder`, `architect-planner`, and `hive-helper` cannot be bases.
- `description` (required, nonblank): routing guidance shown to eligible primaries. Primaries pick a custom agent only when its description is a closer fit for the work than the base; importance, size, or a stronger model are not routing reasons. It cannot widen the base role.
- `model`, `variant`: each one omitted inherits the base agent's resolved Hive value, including the base's project override. With no model on the custom agent or its base, it uses the native OpenCode model. This is Hive configuration inheritance; a native OpenCode override of the base agent is not inherited.
- `autoLoadSkills`: merged with the base agent's effective list.
- Tools and permissions: exactly the base's. Config cannot add tools.
- IDs must not contain `*` or `?`, and must not be reserved: every built-in name, `dash-reviewer`, `vulnerability-review-primary`, `__hive_task_trace_summarizer`, `general`, `explore`, `hive`, `architect`, `swarm`, `scout`, `forager`, `hygienic`, `hygienic-reviewer`, `receiver`, `build`, `builder`, `plan`, `code`. Reserved or invalid entries are skipped with a warning.
- The `*-example-template` entries that a v1 startup seeds into a new file are placeholders; rename or delete them before use.

## Project override (`.hive/agent-hive.override.json`)

```json
{
  "$schema": "https://raw.githubusercontent.com/imarshallwidjaja/agent-hive/main/packages/opencode-hive/schema/agent_hive.override.schema.json",
  "agents": { "forager-worker": { "model": "anthropic/claude-sonnet-4-20250514", "variant": "high" } },
  "customAgents": { "forager-ui": { "variant": "medium" } }
}
```

Only `$schema`, `agents`, and `customAgents` are allowed. Each entry needs at least one of `model` or `variant`, both strings, and nothing else. A `variant`-only entry is valid when the agent's global entry (or custom base) supplies the model. Names that do not match an effective built-in or custom agent are ignored and never create agents. An unsupported key, a non-string value or invalid JSON makes the runtime ignore the whole override file with a warning. A blank string for an agent that matches is a model-setting error that stops the plugin like a blank global value, so correct or delete it.

## Tool access is not configuration

Hive role permissions are registered by the plugin, not by Agent Hive config or `tools` maps.
<!-- hive-host opencode-v1 -->
OpenCode applies agent rules after global `permission` rules, so a global allow cannot re-grant a Hive tool a role denies. Native `general`/`explore` overrides for Hive tools, `task`, `question`, `skill`, and `explore` edit are dropped with a warning.
<!-- /hive-host -->
<!-- hive-host opencode-v2 -->
On OpenCode v2 the user's `permissions` rules decide what an agent can see, and Hive enforces role and child boundaries inside its own tools and the public execution hook, so a native allow rule cannot authorize a forbidden Hive operation or native effect. Native `general` and `explore` get no Hive tools. Delegated Architect helper calls need `experimental.subagent_depth` of at least 2 in the OpenCode configuration; Hive does not change it.
<!-- /hive-host -->
To change who can call a tool, change the plugin source; see [tool-ownership.md](tool-ownership.md) for the current matrix.

## Skills

Hive-bundled skills are copied at startup into `<OpenCode config dir>/agent-hive/generated/opencode-skills/<hash>/` and registered ahead of user `skills.paths`. Edit packaged sources in the plugin, never the generated copy. A native or user skill with the same frontmatter `name` takes precedence over the bundle, and the packaged directory with it. On v1, a conflict Hive detects keeps the bundled `SKILL.md` and its `references/` out of the materialized copy for that name. On v2, the materialized copy can still hold the bundle, and the host's effective skill catalog resolves the name to the unique user skill. In both cases the user skill's directory is the one loaded for that name, nothing falls back to an older generated copy, and no caller searches generated copies for one. Guidance that must hold without a reference lives in the skill's `SKILL.md`. If configured `skills.urls` cannot be scanned, Hive skips bundled materialization and bundled auto-load for that run.
