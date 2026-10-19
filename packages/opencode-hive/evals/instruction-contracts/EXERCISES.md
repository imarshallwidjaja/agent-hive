# Supervised OpenCode exercises

A supervised exercise runs one real primary session of a packed oc-arkive candidate on one exact stock OpenCode host (`opencode-ai@1.18.30` as v1, or `@opencode/cli@2.0.26` as v2) inside a disposable local container, and lets a supervisor drive it turn by turn: answer its questions, decide its permission requests, send it a native slash command, review and approve its plan, switch it to an execution primary, and collect bounded evidence of what it did. Use it when a change needs qualitative evidence that a scripted test cannot give, such as how a planning primary behaves from clarification through approval to completion.

The tooling codifies setup, supervision, inspection and cleanup. It does not contain an exercise scenario, a scorer or a verdict. Each exercise is a temporary question that its supervisor writes, runs once and assesses by reading the evidence.

`exercise.mjs --help` and `exercise.mjs --help <command>` give the exact syntax and JSON field lists without touching Docker or credentials. This guide owns the procedure. The fixed scenario suite in [README.md](README.md) is a different tool and keeps its own semantics.

## Before you start

You need:

- A local Linux Docker engine reached through a unix socket (Docker Desktop on WSL2 qualifies), with memory and swap limits and cgroup v2. Remote or offloaded engines are refused.
- util-linux `flock` on `PATH`. Every command locks the run's lock file through its own open descriptor of it (`prepare` from the moment it creates the run directory), so the lock lasts exactly as long as the command's process: a second command on the run gets `busy` until the first has finished or died, and no Docker client or other child inherits the lock. `prepare` refuses to finish without `flock`.
- The candidate committed in its own worktree. `prepare` takes a full 40-character commit and never packages uncommitted changes. The tooling directory (`packages/opencode-hive/evals/instruction-contracts`) must also be committed and clean in the checkout you run from.
- For a live run only: an OpenAI OAuth credential in the host OpenCode auth file (`$XDG_DATA_HOME/opencode/auth.json`, or `~/.local/share/opencode/auth.json`), with enough remaining lifetime (see [Budget and credential lifetime](#budget-and-credential-lifetime)).
- For a live run only: explicit authorization of the named run, including model usage. Having a credential on the machine does not authorize spending it.

Nothing is installed on the host. Builds and dependency installation happen in credential-free containers.

## Write the exercise inputs

Keep every input in a temporary directory outside the repository, for example `/tmp/opencode/<topic>/`. Do not commit exercise scenarios.

```
/tmp/opencode/readme-tagline/
  request.json
  prompt.md
  brief.md            optional
  repo/               the disposable project's files
    README.md
    package.json
    package-lock.json
```

`request.json` states the question, what you will watch for, and the exact configuration. Paths are relative to the directory holding `request.json`.

```json
{
  "schema": "ic-exercise-request/v1",
  "question": "Does the Architect ask before choosing a tagline, and does Swarm finish only the approved change?",
  "observables": [
    "the primary asks one clarification through the native question tool",
    "a plan reviewer child returns a review",
    "hive_plan_approve uses the revision the supervisor named",
    "execution starts only after the supervisor switches primaries"
  ],
  "stopConditions": ["plan approved and implemented", "any write outside README.md", "deadline"],
  "model": { "ref": "openai/gpt-5.1-codex", "variant": null },
  "agentMode": "dedicated",
  "initialPrimary": "architect-planner",
  "primaryTransitions": [
    { "from": "architect-planner", "to": "swarm-orchestrator" },
    { "from": "architect-planner", "to": "architect-planner", "command": "implement" }
  ],
  "agentModels": { "code-reviewer": { "model": "openai/gpt-5.1-codex", "variant": "high" } },
  "repository": "repo",
  "prompt": "prompt.md",
  "brief": "brief.md",
  "dependencies": [{ "command": "npm-ci", "directory": "." }],
  "artifacts": ["README.md", "test/", ".hive/features/"]
}
```

Rules the tooling enforces:

- `model.ref` is an explicit `openai/<model>`. Every role without an `agentModels` entry inherits it; nothing falls back to another provider. `agentModels` may name only non-primary roles, because a primary runs on the session's model.
- Configuration accepts agent mode, model, variant, transition and skill choices only. Provider URLs, plugins, MCP servers, permission rules, environment variables and host files are refused. So is a copy of `.hive/agent-hive.override.json` in the repository or the artifact list: hive-core applies that project file over the global model and variant choices, so `model` and `agentModels` stay the only way to choose them.
- The repository is copied as regular UTF-8 files: at most 256 files, 256 KiB each and 8 MiB in total; prompt, brief and each skill at most 64 KiB. Links, hardlinks, devices, `.git`, `node_modules`, auth or OpenCode configuration files and paths that escape the directory are refused. The container initializes Git and commits these files as the base.
- `dependencies` runs `npm ci` in the named directory during credential-free setup. It requires a `package-lock.json`. Nothing else is downloaded on the exercise's behalf.
- `artifacts` is the allowlist for later export: exact paths, or prefixes ending in `/`.
- A `primaryTransitions` entry without `command` is a primary switch, taken only by `switch-primary` after an observed approval. An entry with `command` names a native slash command the supervisor may send from `from`, and `to` is the agent that command binds the session to, or `from` again for a command that binds none. Each command has at most one entry per `from`.

Write `prompt.md` as the operator's opening message. The optional brief is appended to it.

## Prepare (credential-free)

```
node packages/opencode-hive/evals/instruction-contracts/exercise.mjs prepare \
  --candidate-ref "$CANDIDATE" --host v1 \
  --input /tmp/opencode/readme-tagline/request.json \
  --run-id readme-tagline-v1 --output-root /tmp/opencode/readme-tagline/runs
```

`prepare` snapshots the inputs into the run directory, builds the packed candidate and the hive-core bundle from the same archived commit, builds the exercise runtime image, and qualifies the selected host. Qualification runs the real lifecycle with a loopback mock model and a synthetic credential, with no network: a native question and its reply in the same session, a child's permission requests answered once and rejected, prompts refused while a question or a child is pending, a child's return, parity between the plugin's `hive_plan_read` and the candidate core's own read (including review comments and approval), refusal of a stale approval, lost acknowledgements for an approval prompt, a primary switch, a question reply, a permission decision and an interrupt (resolved only where the native API names the operation, otherwise left unknown and never replayed), a revision-bound approval and sync whose plan read and approval are direct native tool calls identified by call ID, the caller's primary switch, completion, the guard and the driver reading one clock, a driver that starts after its command cutoff and one whose effect cutoff passes during its observation (each sends nothing, checked by its message ID in the session), lock contention with the lock held only by the acting process, host-auth rotation latching the run, credential-free cleanup, and a guard that stops an abandoned container by itself. A third run sends `/implement` through the `command` operation after an earlier turn under Architect: the command binds no agent, so the session stays on Architect and on the model of the earlier turn, its text (dollar sequences, a shell-looking line and a file reference) reaches the session exactly as written and nothing in it runs, the packaged skill loads, the turn's question is answered through `reply` and the turn finishes; a lost command acknowledgement is resolved by its message ID on v1 and stays unknown on v2. It proves the plumbing works; it says nothing about how a real model behaves.

It is bounded at 7200 s; give your shell or tool timeout more than that. `prepare` holds the run's lock until it ends, so a `stop` issued meanwhile is busy; if your shell or tool kills it first, run `stop` once the process has ended. It prints one JSON line with `status` `prepared` or `failed` and the prepared record's hash. The run directory keeps the records, the snapshot, the artifact and any build log. A run ID is used once: prepare a fresh run for each live exercise, and for each host.

A prepared run is bound to its snapshot. Changing the input files afterwards does not change the run; prepare a new one.

## Authorize and start

Write `authorization.json` as the supervisor. It names the prepared run exactly and what the supervisor allows in it. It is an operational record of a human decision, not a cryptographic proof.

```json
{
  "schema": "ic-exercise-authorization/v1",
  "runId": "readme-tagline-v1",
  "preparedSha256": "<preparedSha256 printed by prepare>",
  "host": "v1",
  "model": { "ref": "openai/gpt-5.1-codex", "variant": null },
  "budgetSeconds": 1800,
  "allowedActions": ["prompt", "command", "reply", "permission", "interrupt", "approve-plan", "switch-primary"],
  "stopConditions": ["plan approved and implemented", "any write outside README.md"],
  "authorizedBy": "<supervisor>"
}
```

```
RUN=/tmp/opencode/readme-tagline/runs/readme-tagline-v1
node packages/opencode-hive/evals/instruction-contracts/exercise.mjs start --run "$RUN" \
  --authorization /tmp/opencode/readme-tagline/authorization.json --budget-seconds 1800
```

`start` creates an isolated container and network, materializes the project, runs dependency setup and starts the host, all before any credential is read. It checks that the container's guard and its driver read one clock, and refuses (`clock_domain_unproven`) if they do not. It then reads the host auth file once, checks the authorization and every snapshotted input for the token (`authorization_contaminated`, `input_contaminated`), binds that file's fingerprint inside the container guard, arms the live deadline, injects an access-only credential (the refresh token never leaves the host), checks that the model, variant and agents exist in the host's actual catalogs, creates the primary session and submits the prompt. A missing model, variant or agent stops the run; there is no substitute. The status line gives `sessionId`, `deadlineAt` and the initial prompt's operation state. Setup may take up to 1260 s, plus a 60 s window after arming.

If `start` fails after creating resources, it attempts cleanup itself and reports the result. Run `stop` anyway if cleanup is not `cleanup_confirmed`.

### Budget and credential lifetime

`--budget-seconds` is the whole live lifetime, 61 to 1800 s, including every pause between commands. It starts when the guard arms and cannot be extended by any command, pause or reconnection. No new work (prompt, command, reply, permission, approval, switch) is admitted in its final 60 s. An interrupt is the one action admitted inside the final window, until 5 s before the hard stop. The host checks the guard's remaining time before each effect, and the driver inside the container checks again at the moment it would send: it receives the end of the command's own budget and the action's cutoff as absolute instants on the clock the guard keeps its deadline on, and reads that clock after its observation, immediately before the request. A command that reaches the effect after either cutoff sends nothing and is recorded as refused. Command budgets run on the host's monotonic clock and wall-clock time is used only for reporting and credential expiry, so changing the system time neither extends nor shortens anything. Inspect and stop still work. At the deadline the guard ends every process in the container even if no supervisor is connected. The budget limits time and exposure. It is not a dollar or request cap. After arming, `start` has 60 s (less if the budget leaves less than that after the reserve) for injection, the catalog check, session creation and the first prompt, with 12 s of it held back for the release check, so a budget barely above 60 s cannot start a run; allow at least 120 s.

At injection the credential must outlive the budget plus the host's refresh window plus 600 s: at least 2400 s for a full 1800 s run on v1 and 2700 s on v2. Later commands repeat the check against the time left. If the credential is too short, `start` refuses. The choice is then yours: prepare a fresh run and authorize an explicitly shorter budget. The tooling never refreshes a credential or extends a run.

## Supervise: inspect, then act

Each command does one finite thing and prints one JSON line. The JSON `status` is authoritative; exit 0 means only that the command completed safely.

| Exit | Meaning |
|---|---|
| 0 | Completed safely: an acknowledged submission, an observation, confirmed cleanup |
| 1 | A refusal or a failed safety or runtime check; read `reason` |
| 2 | Invalid input |
| 3 | The run's lock is busy, or an operation's outcome is unknown and needs resolving or stopping |

`turn` and `inspect` have 60 s each, counted from when they start waiting for the lock; `stop` has 120 s.

### Inspect

```
node packages/opencode-hive/evals/instruction-contracts/exercise.mjs inspect --run "$RUN"
node packages/opencode-hive/evals/instruction-contracts/exercise.mjs inspect --run "$RUN" --request /tmp/opencode/readme-tagline/inspect.json
```

Without a request, `inspect` reports the lifecycle, guard time left, pending interactions and quiescence. Pending questions arrive with their exact request IDs, owning session and choices, each choice with the description its host gave it (`options` holds the labels, `optionDescriptions` the matching descriptions, empty when the host gave none); permission requests with their action and resources. Several pending interactions are all listed.

Each pending interaction states whether it is `complete`. Text and lists are released up to fixed bounds: 16 questions, each question 2000 characters, each header 200, 32 choices of 300 characters, each choice description 500, a permission action of 100 characters and 16 resources of 500. Anything beyond a bound is clipped or left out, the original size or count sits next to it (`questionCount`, `questionChars`, `headerChars`, `optionCount`, `optionChars`, `optionDescriptionChars`, `actionChars`, `resourceCount`, `resourceChars`) and `complete` is `false`. A value that cannot be shown as text also makes the interaction incomplete. The host accepts `complete: true` only when those sizes equal the texts released.

`quiescent: true` means the primary and every descendant are idle, their histories were read completely, no tool is running and nothing is pending. The session tree is enumerated twice around the other reads, and a busy session or a pending interaction outside the tree counts, so a child created during the observation makes it non-quiescent (`tree_changed`, `session_busy_outside_tree`, `pending_outside_tree`). Anything unread or unknown is a `reasons` entry, never a quiet state. A prompt, command or primary switch needs quiescence.

A request adds export:

```json
{
  "schema": "ic-exercise-inspection/v1",
  "runId": "readme-tagline-v1",
  "conversation": { "messagesPerPage": 100, "pages": 10 },
  "plan": { "feature": "readme-tagline" },
  "artifacts": ["README.md"],
  "list": [".hive/features/"],
  "diff": true
}
```

- `conversation`: each session's user and assistant turns, child final returns, tool calls with structured outcomes and exact call IDs, and observed models and variants. The evidence also carries a `selection` summary per session: each assistant turn's model and variant against what its agent should run (an explicit `agentModels` entry for that role, otherwise the run's model and variant). `match`, `mismatch` or `unknown`; a turn whose agent or variant the host did not report, and a session with no assistant turn, is `unknown`. v2 labels a turn that ran no variant `default` and v1 reports none, so neither confirms a requested variant. A mismatch is recorded, never corrected.
- `plan`: the candidate core's own full read of the feature (revision, content hash, status, comments, content, resolved feature path) and the primary's latest plugin `hive_plan_read` of it, with any differences between the two. Only the primary session's own full read that names the feature, made as a direct native `hive_plan_read` call, counts. The plugin registers `hive_plan_read` and `hive_plan_approve` as direct tools on both hosts, so a Code Mode `execute` is never read as either, whatever its code mentions or returns. A reviewer child's read, an outline read and a read that left the feature to the session route do not count either. Before the core reads anything, the tooling checks that `.hive` and `.hive/features` are real directories inside the project and that `plan.md`, the review comments, `feature.json` and the approval marker are bounded regular files (256 KiB for the plan and comments, 64 KiB for metadata; no links, hardlinks or special files).
- `artifacts`: files inside the request's allowlist. `list`: regular file names and sizes under an allowed prefix, at most 1000 entries and 12 levels deep; links, hardlinks, special files, `node_modules`, `.git` and the native session and background stores are counted in `omitted` and never listed or followed, and a cap makes the listing `complete: false`. `diff`: line diffs of the requested artifacts against the snapshot. An artifact path or list prefix with a link anywhere along it is refused, so what is read is the allowlisted path itself.

The native stores of both owners are never exported, at any layout: `.hive/sessions.json`, `.hive/background-jobs.json`, `.hive/runtime/`, and per feature `sessions.json` and `runtime/`. The tooling refuses them in `request.artifacts` and in inspection paths, and refuses a path that resolves into one.

Everything the container returns is checked as raw text and again after decoding, then rebuilt from allowlisted fields with fixed vocabularies for failures, refusals and reasons; a reply that does not fit is discarded. Nothing is written or printed until the credential has been checked again and the exact original token is absent from the decoded content. Status lines do not name the run directory or any other path you chose, because a path can carry an opaque token that only a scanner built from the exact token would find. The one exception is a successful `inspect`: its whole status has passed that final credential check and scan, and it includes the path of the evidence file it wrote. Every status line of `start`, `turn` and `inspect` that can carry container-derived values is scanned whole before it is printed or recorded; one that fails is replaced by fixed words (`status_contaminated`). `prepare`, `stop` and the latched or stopped view of `inspect` have no scanner for the original token, since cleanup never reads the credential. They print only controller facts: fixed words, numbers, booleans and identifiers that the controller or Docker issued.

Maxima: 100 messages per page, 10 pages per session, 32 sessions, 2000 tool records, 16 KiB per turn or child return, 32 artifacts of 64 KiB, 1000 listed files, 256 KiB of diff and 2 MiB per export. You may ask for less. Every record states its original size and whether it was clipped; an oversize source is omitted with a reason. Missing or clipped evidence limits what you can conclude: it cannot show that a step happened, that the run was quiet, or that a plan was fully reviewed.

Each observation is written to `$RUN/evidence/inspect.NNNN.json` after scanning inside the container and again on the host. Inspect never runs project commands or tests. Test evidence is what the session itself ran (native exit metadata in the conversation) and result files you export; a primary saying tests passed is not a test result.

### Act

Write one operation file per action and pass it to `turn`:

```
node packages/opencode-hive/evals/instruction-contracts/exercise.mjs turn --run "$RUN" --operation /tmp/opencode/readme-tagline/op-03.json
```

Every operation names its own unique `id`, the `runId` and the primary `sessionId` from `start`. Only actions in the authorization's `allowedActions` are accepted.

```json
{ "schema": "ic-exercise-operation/v1", "id": "op-03", "runId": "readme-tagline-v1", "sessionId": "ses_...", "action": "reply", "requestId": "que_...", "answers": [["Short and factual"]] }
```

| Action | Fields | Effect |
|---|---|---|
| `prompt` | `text` | A new user message to the current primary; needs quiescence |
| `command` | `name`, `text` | Runs the native slash command `name` in the primary session with exactly `text` after it; needs quiescence and a `primaryTransitions` entry from the current primary that names the command (see below) |
| `reply` | `requestId`, `answers` | Answers a pending question, one array of chosen labels per question, in order. A label is an entry of the question's `options`; the entry at the same position in `optionDescriptions` is its description |
| `permission` | `requestId`, `decision` `once` or `reject` | Decides one pending permission request; `always` is not offered |
| `interrupt` | none | Interrupts the primary's current execution; admitted until 5 s before the deadline |
| `approve-plan` | `project` `/work/proj`, `feature`, `revision`, `contentHash`, `permittedWork` | Sends a revision-bound approval decision (see below) |
| `switch-primary` | `to` | Switches to a primary that `primaryTransitions` allows (see below) |

The tooling never answers or rejects a question on its own. A reply continues the turn that asked, so it is not a new prompt. Each reply or permission decision is checked against the exact pending request before anything is sent. A reply, or a `once` decision, on an interaction that is not `complete` is refused unsent (`request_incomplete`), because it would rest on text that was clipped or left out. `reject` is still accepted for a permission. A question that cannot be shown completely cannot be answered through the tooling: interrupt or stop the run.

An operation file is checked whole, as written and as decoded, against the run's original token once the credential has been confirmed. If its ID, text, answers or any other field carries the token, a 32-character fragment of it or a token-shaped string, `turn` refuses with `operation_contaminated` (exit 2) before recording, sending or echoing any of it. Inspection requests get the same check (`inspection_contaminated`), and so does the authorization file given to `start` (`authorization_contaminated`). Each of these refusals latches the run, and no later input resumes it. Rewriting the file does not help: `turn` answers `run_latched` and `inspect` reports controller facts only. Run `stop` and prepare a fresh run.

### Review and approve a plan

Approval is a decision the supervisor sends to the real primary; the tooling never approves, syncs or edits Hive state itself.

1. Ask the primary, in a prompt, to read the plan with a direct `hive_plan_read` call that names the feature, and present it.
2. When quiet, `inspect` with `"plan": { "feature": "<name>" }`. Check that `pluginRead.differences` is empty, then read the whole plan, its comments and revision in the evidence file. If the plan was clipped, you have not reviewed all of it.
3. Send `approve-plan` with that exact `revision` and `contentHash`, and the local work you permit. Immediately before sending, the tooling rereads the plan through the candidate core and refuses if the revision changed or the primary's latest plugin read does not match. The primary receives a message telling it to approve that revision only, with `hive_plan_approve`, `feature`, `expectedRevision` and `sync: true`.
4. `inspect` again. The evidence's `approvals` list shows the direct `hive_plan_approve` calls of the whole tree: the session, call ID, feature, `expectedRevision`, and separate approval and sync outcomes. A primary that approves another revision, skips sync or does not approve has behaved that way; record it as an observation. It is not authorization.

If the plan changes after your review (new comments, a rewrite), read and decide again.

### Send a native command

A `command` operation is what an operator does by typing `/<name> <text>` in the session: the host's own command route runs it in the same session, with the text after the name sent exactly as written. The text is not trimmed and may be blank. Like every operation file, it is checked against the run's token before anything is recorded or sent.

The request decides which commands may run and which primary each leaves behind. Before sending, the tooling requires a quiescent tree, a `primaryTransitions` entry from the current primary that names the command, and the command in the host's catalog. v1 lists each command's bound agent, so a binding other than the declared `to` is refused unsent (`command_binding_unexpected`). v2 lists none, so there the session must still run the recorded primary, and the binding is read from the session once the host has answered.

The two hosts answer differently. v2 answers once the command has admitted its prompt. v1 answers its command request only when the whole turn has ended, which may be after a question you have to answer. On v1 the acknowledgement is therefore the native user message carrying the supervisor-chosen message ID while the session runs it, or the request's own answer, whichever the driver sees first; the driver then drops the request, and the turn keeps running in the host's session runner. Either way `turn` returns within its budget and leaves the run's lock free, so you `inspect`, `reply` and decide permissions for that turn as for any other.

The acknowledgement names the agent the host ran the command under: the command's own user message on v1, the session on v2. When that agent is the declared `to`, it becomes the current primary. When it is anything else, the current primary is unknown (`primary: null` in the lifecycle) and every prompt, command, approval and switch is refused (`primary_unknown`); the turn already running stays observable. A v2 command that the host refused keeps the recorded primary only when the read after the command names that same agent; a failed or missing read, or another agent, has the same effect. A refused v1 command left no message and changes nothing. Stop the run when the primary is unknown.

### Switch primary

`switch-primary` needs quiescence, a transition listed in `primaryTransitions` from the current primary, and an observed approval that answers your last `approve-plan`: a completed direct `hive_plan_approve` call in the primary session, after the message that carried your decision, naming that feature and revision as `expectedRevision` with `sync: true`, and both outcomes successful. The plan must also still be what that approval left: the candidate core reads it as approved, with the content hash you decided on and the revision the approval reported. If the primary rewrites the plan or a comment arrives after approval, the switch is refused and you decide again. An approval of another feature, one made by a child, or one made before your decision does not count, even with the same revision. Only this operation and a declared command change the primary; nothing in model output does, and `switch-primary` never takes an entry that names a command. On v2 the session's agent is switched natively, after confirming the session still runs the primary you recorded; on v1 the new primary takes effect on the next prompt, which carries the agent explicitly.

## Unknown operations

Before any effect, each operation is recorded with every exact native identity known at that point (the message ID the supervisor's prompt will carry, the request and tool call a reply answers). If the acknowledgement is lost, for example a Docker client timeout, the operation is `unknown`. It is never retried. Every further submission is refused (exit 3) until it is resolved:

```json
{ "schema": "ic-exercise-inspection/v1", "runId": "readme-tagline-v1", "resolve": "op-07" }
```

Resolution uses native evidence that names the operation, and only that:

| Operation | Resolved when |
|---|---|
| `prompt`, `approve-plan` | the message with the supervisor-chosen message ID exists as a user message |
| `command` (v1) | the message with the supervisor-chosen message ID exists as a user message; the agent it names then sets the primary as for an acknowledged command. It shows the command was admitted, not that its turn ran |
| `command` (v2) | never: the native command route takes no caller-chosen ID, so nothing names the operation |
| `reply` (question) | v1: in the completely read history of the session that asked, the only tool call with the question's call ID is a `question` call that completed with exactly the answers sent. v2: the question's own form is answered with exactly those answers |
| `switch-primary` (v2) | the session's agent is the target and the recorded previous primary was a different one |
| `permission`, `interrupt` | never: the native API keeps no record that names them |

A request that is still pending, one that has disappeared, an idle session, a changed timestamp or a matching call in another session is not evidence about a lost reply: the request may still be delivered late. Resolution never matches text, timestamps or the latest session. If the operation cannot be resolved, stop the run. A killed Docker client does not prove the process inside the container stopped, so each driver receives its cutoffs as absolute instants on the container clock: one that starts after its command cutoff does nothing, observing or sending, and one that is still observing when a cutoff passes sends nothing.

## When a run latches

A run latches to stop-only, permanently, when the host auth file is missing, unreadable, malformed or changed since start, when the guard cannot confirm continuity, when the container's stored credential no longer matches what was injected, when the credential's remaining lifetime is too short, or when any scan finds the token, its account ID, a token-shaped string or a 32-character fragment of the token, including in an operation, inspection request or authorization file you supplied. After a latch, `turn` is refused and `inspect` reports only controller facts (fixed codes, numbers and owned resource IDs). Evidence already published stays; the batch being collected is discarded. An operation accepted before a failed postcheck may have executed; it stays unknown.

If you rotate or re-login on the host during a run, that run latches. Prepare a fresh run.

## Stop and clean up

```
node packages/opencode-hive/evals/instruction-contracts/exercise.mjs stop --run "$RUN"
```

Always stop, including after a failure, a latch or the deadline, and after a `prepare` that was interrupted (killed, crashed or timed out by your shell) while it was running; `stop` is busy until that process has ended. `stop` needs no credential and exports nothing. It removes every container and network the run owns by exact ID on the same engine and confirms each is absent. `prepare` records the engine, endpoint, run ID and the identities of the run's ledger and lock (`records/cleanup-binding.json`) as soon as it has verified the engine and before it creates anything, so `stop` works on a run whose `prepare` never wrote its final record. That record is ownership for cleanup only: `start`, `turn` and `inspect` still require a run `prepare` finished and qualified, and refuse any other (`run_not_prepared`). A malformed, inconsistent or replaced binding, or a replaced ledger or lock, is refused (`cleanup_binding_invalid`, `cleanup_binding_mismatch`, `cleanup_ledger_replaced`, `lock_file_replaced`) and nothing is removed; a run whose `prepare` ended before verifying an engine created nothing and has no binding, and `stop` answers `run_not_prepared`. The prepared run also owns the three qualification runs `prepare` made inside it (`qualification`, `qualification-interrupt` and `qualification-command`), which `prepare` registered before any could create anything; `stop` settles each one's own ledger under its own lock, so a qualification container that `prepare` failed to remove is removed and confirmed here. A qualification run that cannot be shown to be owned and settled, such as a missing or replaced directory, ledger or lock, an unreadable ledger or registration, a lock another process holds or a spent budget, is `cleanup_unknown` and appears in `retained` as `{ "subrun": "qualification", "state": "unknown" }`. Nothing about it is read as absent, and nothing unproven is removed.

| Status | Meaning |
|---|---|
| `cleanup_confirmed` | Every owned resource is confirmed absent and every create is settled |
| `cleanup_present` | A resource is still listed after removal; its ID is in `retained` |
| `cleanup_unknown` | Absence could not be confirmed, a create that did not report success has not been found by its nonce, or a registered qualification run could not be settled; IDs, nonces and the run's name are retained |

A create that did not report success, whatever the Docker client printed or how it exited, stays unknown until the resource carrying its nonce is found and removed. An empty listing does not settle it, because the engine may still finish the create; run `stop` again later, and if the nonce is never found, report it as unknown cleanup rather than success.

Retry `stop` only; never repeat the model operation. A guard that should have fired is not cleanup. Images are credential-free and kept by ID (`retainedImages`); removing them is a separate decision.

## Evidence and conclusions

Collect the last bounded evidence before `stop` while the run is still live. Write the assessment as prose: what the primary actually did against the intended workflow, the quality of reviews, and every deviation, citing evidence files. Missing or clipped evidence limits the conclusion. A run that does not complete stays an incomplete exercise; it is not relabelled or silently rerun. Nothing retries a paid operation automatically, and repeating an exercise needs a new authorization.

## Limits

- The lock ends when the acting process ends, including when it is killed. A Docker client or in-container driver it had already started may outlive it; the intent recorded before every effect and create, the refusal to submit while an operation is unresolved, and `stop` reporting `cleanup_unknown` while a create is unsettled cover that case, not the lock.
- Native tools inside the container can read the injected access token. The controls limit accidental disclosure and lifetime; they are not an enclave against deliberately malicious code or network exfiltration.
- Scanning catches the exact token and account ID, token shapes and token fragments. It does not detect arbitrary re-encodings.
- Stopping does not cancel or refund provider work already in flight.
- The budget is time, not money.
- Credential-free qualification shows the controls work on the exact host and candidate; it does not show anything about a real model's behavior.
