# Arkive Worklog

The Worklog (`/worklog` in Arkive) is a short, human-readable account of where a piece of work stands and how it got there. A reader should be able to catch up in about thirty seconds. A good briefing usually runs to 100–200 explanatory words; that figure is writing guidance, and the service does not enforce it.

Each log holds two kinds of narrative written by primary agents:

- **Checkpoints**: append-only entries recorded at milestones. A checkpoint is never edited or deleted. A mistaken checkpoint is corrected by appending a new checkpoint that names the original in `corrects`.
- **The current briefing**: the latest summary of the whole log. It always lives inside the checkpoint that set it, so the log never stores a second, mutable copy.

Beside the narrative, reads project **recorded facts**: task statuses, dependencies, blockers, and integrity problems as they are stored on disk. Facts are computed at read time from task records and are never written into the log. They describe stored state only; they say nothing about whether a worker is alive or whether work was verified or integrated.

This document is the contract for the `hive-core` service (`packages/hive-core/src/services/worklogService.ts`) and the behavior expected of the clients that will use it.

## Logs and their lifetime

| Log | Identity | Storage | Shared by |
|---|---|---|---|
| Feature log | `{ kind: 'feature', featureName }` | `worklog.json` inside the resolved feature directory | Every primary session working on the feature |
| Session log | `{ kind: 'session', owner, sessionId }` | `.hive/worklogs/sessions/<owner>/<sha256(sessionId)>.json` | One native-owner primary session, for ad-hoc work |

`owner` is a `NativeObservationOwner` (`opencode-v1` or `opencode-v2`). The same session ID under two owners names two different logs, matching how session and background stores are already separated.

Logs outlive the sessions and worktrees that wrote them. A session log stays readable after the session ends, after its ad-hoc worktree is cleaned up, and without any entry in the session index. A feature log stays readable after the feature is completed or archived. The service never deletes, rotates, or compacts a log.

### Keys

`getWorklogKey(ref)` returns a stable, human-copyable identity:

- `feature:<featureName>`, for example `feature:checkout`
- `session:<owner>:<sessionId>`, for example `session:opencode-v2:ses_abc123`

The key carries the full identity, not a shortened ID, so it is safe to pin in a viewer or paste into a tool call. `parseWorklogKey(key)` turns it back into a ref. Session IDs may contain colons; only the first colon after the owner separates the fields.

### Feature resolution

A feature log requires a real feature. The service accepts the logical feature name only, and resolves it to exactly one feature directory whose `feature.json` names it. When a directory named exactly like the feature also exists, it then checks that the canonical `getFeaturePath` resolver lands on the same directory; without such a directory the unique metadata match is the canonical result, and the resolver's scan of sibling metadata is not run. The read or record fails with:

- `feature_not_found` when no directory's metadata names the feature, including when the caller passes a directory alias such as `01_checkout`;
- `feature_ambiguous` when two directories claim the name, or `getFeaturePath` resolves elsewhere;
- `feature_unreadable` when a candidate directory's metadata cannot be read, so uniqueness cannot be established.

A failed resolution creates nothing, so a typo never produces a phantom feature directory. Recording on a completed or archived feature is allowed so late corrections can be made; the service never touches `feature.json`, so recording never reopens a feature.

### Which log a call targets

Core takes an explicit ref; it does not route. The host resolves the ref before calling core:

1. An explicit feature argument targets that feature's log.
2. Otherwise, a feature selected for the calling session (through `hive_feature_select`) targets that feature's log.
3. Otherwise, the call targets the caller's own session log.

The host must not fall back to the sole live feature or a feature detected from the working directory. Those fallbacks suit task tools, but a narrative written into the wrong shared log is hard to notice and cannot be deleted. Explicit null selection therefore means the session log. `SessionService.peekGlobal(sessionId)` supports this resolution: it reads the session index without the reset-on-corruption behavior of `getGlobal`, so resolving a route can never discard the index. It returns `undefined` only when the index file is absent. An unparseable index, one without a `sessions` array, and one holding the literal JSON `null` all throw and stay untouched.

## Writing

### Authority

`record(ref, input, author)` treats `author` as supplied by a trusted host boundary: the native session that called the tool and its agent name. Core validates the author's shape, and for a session log it requires `author.owner` and `author.sessionId` to equal the ref, so one session cannot write into another session's log. Core does not decide whether the author is a primary agent; the host must check the actual primary before calling `record`. Any primary may record into a feature log and may update its briefing.

Timestamps come from the service clock, not from the caller.

### Input

```ts
type WorklogReference =
  | { kind: 'path'; path: string; label?: string }
  | { kind: 'url'; url: string; label?: string };

interface WorklogCheckpointInput {
  summary: string;
  detail?: string;
  references?: WorklogReference[];
  corrects?: number[];
}

interface WorklogRecordInput {
  operationId: string;
  title?: string;
  checkpoint: WorklogCheckpointInput;
  briefing?: string;
  expectedRevision?: number;
}

interface WorklogAuthor {
  owner: NativeObservationOwner;
  sessionId: string;
  agent: string;
}
```

Every record appends exactly one checkpoint. There is no briefing-only event: a briefing change is recorded together with the checkpoint that explains it, and both commit or neither does.

- `operationId` is the caller's retry key: 1–128 bytes of letters, digits, `.`, `_`, `:` and `-`, starting with a letter or digit.
- `title` applies only when the record creates the log. When omitted, the title defaults to the first checkpoint's summary. A later record may repeat the same title; a different title is rejected with `title_conflict`. There is no rename operation.
- `briefing` replaces the current briefing. `expectedRevision` is required exactly when `briefing` is supplied, and must equal the log's current revision (0 for a log that does not exist yet). Supplying one without the other is `invalid_argument`. Omitting both leaves the briefing unchanged.
- `corrects` lists earlier entry IDs in the same log. Each must already exist, and an entry may be named by at most 64 corrections; otherwise the record fails with `invalid_correction`. When an entry reaches that cap, correct the latest correction instead.

### Revision

A log has a single revision that increases by one with every entry, and an entry's `id` equals the revision it committed. One counter is deliberate: a briefing author who read revision 7 and writes with `expectedRevision: 7` is rejected if anyone appended a checkpoint in between, not only if someone changed the briefing. The briefing therefore always reconciles every checkpoint its author had a chance to read.

### Commit order

`record` validates every argument first. It then takes the log's lock file (`<log>.lock`, the standard `acquireLockSync` helper) and, while holding it:

1. reads and validates the stored document, failing loudly on corruption or an unsupported schema;
2. looks for an existing entry with the same `operationId` from the same author `owner` and `sessionId`;
3. checks the title, then `expectedRevision`, then corrections;
4. builds the new document, rejects it if it would exceed the storage limit, and publishes it with `writeAtomicDurable` (temporary file, flush, rename, directory flush);
5. releases the lock.

No step reads outside the lock and writes inside it, and no other helper lock is taken while the log lock is held. Any rejection in steps 1–4 writes nothing.

### Retries

Retry identity is the log plus the author's `owner`, `sessionId`, and `operationId`. The agent name is not part of it, so a retry after an agent switch within the same session still matches.

Each record stores a SHA-256 `requestHash` of the authored request in canonical JSON: whether a title was supplied and its value, the checkpoint, the briefing, and `expectedRevision`. The hash excludes runtime facts, timestamps, and the agent name.

The duplicate check (step 2) runs before the revision check. A caller whose response was lost can therefore resend the identical request, even after other primaries have appended, and receive the original entry with `replayed: true`. Resending the same `operationId` with a different payload fails with `operation_conflict` and names the original entry. Receipts are part of the stored entries and are never trimmed.

### Result

```ts
interface WorklogRecordResult {
  ref: WorklogRef;
  key: string;
  entry: WorklogEntry;          // on replay, the original entry exactly as first committed
  committedRevision: number;    // equals entry.id
  currentRevision: number;      // the log's revision when this call returned
  replayed: boolean;
  briefingUpdated: boolean;     // whether this entry carries a briefing
}

interface WorklogEntry {
  id: number;
  operationId: string;
  author: WorklogAuthor;
  recordedAt: string;
  checkpoint: WorklogCheckpointInput;
  briefing?: { text: string; factsFingerprint: string | null };
  correctedBy?: number[];       // read views only
}
```

When a briefing is written, the service stores the current recorded-facts fingerprint beside it. Later reads compare that fingerprint with the current facts to report whether the facts have moved since the briefing was written.

## Reading

Reads never write. They create no directories, locks, logs, or repairs, they never dereference a reference, and they never follow a symbolic link. A missing feature log returns `exists: false` after confirming that the feature itself exists; a missing session log returns `exists: false` without any check.

```ts
service.read(ref, { view?: 'brief' | 'history' | 'facts', limit?, cursor?, maxBytes? })
service.list({ kind?: 'feature' | 'session', limit?, cursor?, maxBytes? })
```

### Brief view (default)

```ts
interface WorklogBriefRead {
  view: 'brief';
  ref: WorklogRef;
  key: string;
  exists: boolean;
  title: string | null;
  revision: number;
  entryCount: number;
  createdAt: string | null;
  updatedAt: string | null;
  briefing: {
    text: string;
    factsFingerprint: string | null;
    entryId: number;
    author: WorklogAuthor;
    recordedAt: string;
  } | null;
  checkpointsSinceBriefing: number;
  facts: WorklogFactsSummary;
  changedSinceBriefing: boolean | null;
  recent: { entries: WorklogEntry[]; nextCursor: string | null };
}
```

The brief view is what a person or a resuming primary reads first. `checkpointsSinceBriefing` counts entries after the one that set the briefing (all entries when there is no briefing). `changedSinceBriefing` is `true` or `false` only when both the stored and the current facts fingerprints are known; it is `null` for session logs, when no briefing exists, or when facts were unavailable at either time.

`recent` holds the newest checkpoints, three by default or `limit` when given. Unlike the other views, the brief shortens `recent` to fit the byte budget instead of failing, because the briefing and facts matter more. `recent.nextCursor` continues in the history view.

### History view

```ts
interface WorklogHistoryRead {
  view: 'history';
  ref: WorklogRef;
  key: string;
  exists: boolean;
  anchorRevision: number;
  currentRevision: number;
  entries: WorklogEntry[];   // complete entries, newest first
  complete: boolean;
  nextCursor: string | null;
}
```

The first page anchors at the log's current revision. Every later page in the same cursor chain stays below that anchor, so checkpoints appended while a reader pages do not shift or duplicate entries; `currentRevision` shows that newer entries exist. `correctedBy` is computed from entries up to the anchor, so it is stable across the chain as well.

A history cursor binds the full log key, the log file's random `logId`, the anchor, and the next position. A cursor from another log is `invalid_cursor`. A cursor whose log file was replaced, for example deleted and created again, is `stale_cursor`.

### Facts view

```ts
interface WorklogFactsRead {
  view: 'facts';
  ref: WorklogRef;
  key: string;
  exists: boolean;
  facts: WorklogFactsSummary;
  rows: WorklogFactRow[];
  complete: boolean;
  nextCursor: string | null;
}

interface WorklogFactsSummary {
  state: 'recorded' | 'partial' | 'unavailable' | 'not_applicable';
  notice: string;
  observedAt: string;
  fingerprint: string | null;
  featureStatus: FeatureStatusType | null;
  taskCount: number;
  counts: Record<TaskStatusType | 'invalid', number>;
  runnableCount: number;
  dependencyBlockedCount: number;
  diagnostics: string[];
}

interface WorklogFactRow {
  folder: string;
  name: string;
  status: TaskStatusType | null;
  origin?: TaskOrigin;
  planTitle?: string;
  dependsOn: string[];
  blocker?: { reason: string; truncated: boolean };
  integrity?: { reason: 'status_missing' | 'status_unreadable'; error?: string };
  runnable: boolean;
  waitingOn: string[];
  sources: { status: string; report?: string; spec?: string };
}
```

Facts come from the same task-status reader as `TaskService.listStatusEntries`, and from `computeRunnableAndBlocked`, the same sources as `hive_status`. The reader is pointed at the feature directory the log resolved to, and the tasks directory and each `status.json` are checked for symbolic links before they are read. The summary counts every task status plus `invalid` for status files that are missing, unreadable, linked, or malformed. A status file is malformed when `status` is not a known status, `origin` is not `plan` or `manual`, `planTitle` is not a string, `dependsOn` is not an array of strings, or `blocker` is not an object with a string `reason`. A file that omits these optional fields is valid, and a missing `dependsOn` reads as `[]`; a malformed value is never coerced to `[]`. `runnableCount` counts pending tasks whose dependencies are all done; `dependencyBlockedCount` counts pending tasks waiting on an unfinished dependency, which is different from the explicit `blocked` status in `counts.blocked`.

- `recorded`: every task status was readable.
- `partial`: some task folders have integrity problems; those rows carry `integrity` and are counted as `invalid`, and the other rows are unaffected.
- `unavailable`: task records could not be listed at all, for example when `tasks` is a symbolic link or not a directory. The fingerprint is `null`, rows are empty, and `complete` is `false` with no cursor, so an empty list is never mistaken for "no tasks".
- `not_applicable`: session logs, which have no task ledger. Rows are empty and `complete` is `true`.

Rows carry project-relative pointers to `status.json`, `report.md`, and `spec.md` instead of their contents. The `report.md` and `spec.md` pointers are optional: a task folder with an integrity problem is not probed for them, and a healthy row whose folder cannot be probed omits them and adds a diagnostic. Neither case changes `state`, counts, or the fingerprint, and neither fails the read. A blocker row includes only its reason, shortened to 1 KiB, and `truncated` is true when the reason was shortened or the blocker has other fields; the full blocker stays in `status.json`.

The fingerprint is a SHA-256 of canonical JSON over the feature status and each task's folder, status, origin, plan title, dependencies, blocker, and integrity reason. It excludes `observedAt` and source pointers. A facts cursor binds the log key and fingerprint, so any change to recorded facts makes it `stale_cursor`.

### List

```ts
interface WorklogListResult {
  worklogs: WorklogSummary[];
  errors: WorklogListError[];
  complete: boolean;
  nextCursor: string | null;
}

interface WorklogSummary {
  ref: WorklogRef;
  key: string;
  title: string;
  revision: number;
  entryCount: number;
  briefingEntryId: number | null;
  createdAt: string;
  updatedAt: string;
  location: string;            // project-relative storage path
}

interface WorklogListError {
  location: string;
  reason: WorklogErrorReason;
  message: string;
}
```

Discovery looks only in fixed places: `worklog.json` inside each directory under `.hive/features/`, including completed and archived features, and `<sha256>.json` files under `.hive/worklogs/sessions/<owner>/` for each known owner. It does not consult the session index or any live session. Candidates are stat'ed, ordered by modification time (newest first) and then by location, and only the candidates on the requested page are parsed.

A log that cannot be read appears in `errors` with its location and reason, and the good logs on the same page are still returned. Errors count toward `limit`. A list cursor binds the kind filter and a fingerprint of the whole candidate inventory (location, device, inode, size, and modification time), so any new, removed, or appended log makes an outstanding cursor `stale_cursor`; restart the list.

### Pagination and budgets

| Setting | Default | Maximum |
|---|---|---|
| `limit` (history, facts, list) | 10 | 50 |
| `limit` (brief `recent`) | 3 | 50 |
| `maxBytes` | 16 KiB | 64 KiB |

`maxBytes` covers the whole serialized response, including the envelope and the continuation cursor. A page holds as many items as fit. If the first item alone does not fit, history, facts, and list fail with `response_too_large` and report `requiredBytes`, so a caller never receives an empty page with a cursor that cannot advance. Every stored entry fits within the 64 KiB maximum: the record-time entry cap and the per-entry correction cap leave room for the envelope and cursor. Non-integer, zero, negative, or over-maximum values for `limit` and `maxBytes` are `invalid_argument`. Cursors are opaque, at most 4 KiB, and validated on decode.

### Input limits

| Field | Limit |
|---|---|
| `title`, `checkpoint.summary` | 256 UTF-8 bytes, single line |
| `briefing` | 4 KiB UTF-8 |
| `checkpoint.detail` | 8 KiB UTF-8 |
| `checkpoint.references` | 16 items; each `path` or `url` 1 KiB, `label` 256 bytes |
| `checkpoint.corrects` | 8 unique positive IDs; each target may be corrected at most 64 times |
| Whole entry, serialized as returned by reads | 48 KiB |
| `author.sessionId`, ref `sessionId` | 256 bytes |
| `author.agent` | 128 bytes |

Text must be non-blank, well-formed UTF-8 (unpaired surrogates are rejected), and free of control characters; `detail` and `briefing` may contain newlines and tabs. Over-limit values fail with `input_too_large`. The whole-entry cap matters only when JSON escaping inflates text that is otherwise within limits, such as references full of quotation marks. Stored text is never shortened. The same limits hold for what is already stored: a stored value past any of them makes the log `worklog_corrupt` (see [Document format](#document-format)).

## Errors

Every failure the service raises is a `WorklogError` with a stable `reason` and structured `details`. A filesystem failure that is not one of the cases below is reported as `io_error`; the service does not let a raw `fs` error escape.

| Reason | Meaning | Caller action |
|---|---|---|
| `invalid_argument`, `input_too_large` | Request shape or size is invalid | Fix the request |
| `invalid_ref`, `invalid_author` | Ref or author shape is invalid | Fix the request |
| `author_mismatch` | Session log written by another session | Write to the caller's own log |
| `feature_not_found`, `feature_ambiguous`, `feature_unreadable` | Feature cannot be uniquely resolved | Repair or name the feature; nothing was created |
| `stale_revision` | `expectedRevision` is behind; `details.currentRevision` names the current one | Read again, reconcile the briefing, record with a new `operationId` |
| `operation_conflict` | `operationId` reused for a different request; `details.entryId` names the original | Use a new `operationId` |
| `title_conflict` | A different title was supplied for an existing log | Omit the title or repeat the stored one |
| `invalid_correction` | `corrects` names an entry that does not exist, or one already corrected 64 times | Fix the IDs, or correct the latest correction |
| `worklog_locked` | The lock was not acquired within the helper timeout; nothing was recorded | Retry with the same `operationId` |
| `worklog_full` | The record would grow the log past the storage limit; nothing was recorded | See [Storage limit](#storage-limit) |
| `worklog_too_large` | The stored file is past the storage limit | See [Storage limit](#storage-limit) |
| `worklog_corrupt`, `unsupported_schema` | The stored file is invalid or newer than this Hive | Inspect the file; the service never resets it |
| `unsafe_path` | A symbolic link or escaping path was found | Inspect the storage path |
| `invalid_cursor`, `stale_cursor` | Cursor is malformed or foreign, or its snapshot changed | Restart from the first page |
| `response_too_large` | One item needs more than `maxBytes` | Retry with a larger `maxBytes` |
| `inventory_too_large` | More than 10,000 candidate files during list | Investigate the storage directories |
| `io_error` | A filesystem call failed. `details.stage` is `path`, `feature`, `lock`, `read`, `write`, or `discover`; `details.code` is the errno when there is one | See below |

A lost or failed record response is resolved by resending the identical request. The replay returns the committed entry if it landed; otherwise the request is processed normally.

Every rejection writes nothing, with one exception. `io_error` with `details.stage: 'write'` also carries `details.publication: 'uncertain'`. The durable write flushes the file, renames it into place, and then flushes the directory, so it can fail after the rename has already published the entry. Such an error does not show whether the entry was appended. Resend the identical request: if the entry landed, the replay returns it with `replayed: true`; if it did not, the request commits normally. Do not retry with a new `operationId`, which would append a second checkpoint. An `io_error` at any other stage did not publish anything; fix the cause and retry, with the same `operationId` for a record. In a list result, an unreadable log file is an `errors` item with reason `io_error`, and a failure to enumerate the storage directories fails the whole call.

## Storage

### Document format

```json
{
  "schemaVersion": 1,
  "logId": "3f1c0e7a9b2d4c6e8f0a1b2c3d4e5f60",
  "ref": { "kind": "feature", "featureName": "checkout" },
  "title": "Checkout rewrite",
  "revision": 2,
  "createdAt": "2026-10-17T03:00:00.000Z",
  "updatedAt": "2026-10-17T04:10:00.000Z",
  "briefingEntryId": 2,
  "entries": [
    {
      "id": 1,
      "operationId": "schema-landed",
      "requestHash": "…64 hex characters…",
      "author": { "owner": "opencode-v1", "sessionId": "ses_a", "agent": "swarm-orchestrator" },
      "recordedAt": "2026-10-17T03:00:00.000Z",
      "checkpoint": { "summary": "Schema task merged" }
    },
    {
      "id": 2,
      "operationId": "api-briefing",
      "requestHash": "…",
      "author": { "owner": "opencode-v2", "sessionId": "ses_b", "agent": "hive-master" },
      "recordedAt": "2026-10-17T04:10:00.000Z",
      "checkpoint": { "summary": "API task started", "references": [{ "kind": "path", "path": "docs/WORKLOG.md" }] },
      "briefing": { "text": "Schema is merged; the API task is running …", "factsFingerprint": "…" }
    }
  ]
}
```

Reads validate the whole document: `schemaVersion` 1, a 32-hex-character `logId`, a `ref` equal to the ref implied by the storage location, a title within the title rules, canonical ISO `createdAt` and `updatedAt`, `revision` equal to the number of entries, IDs contiguous from 1, `briefingEntryId` naming the latest entry that carries a briefing, and for each entry:

- a canonical ISO `recordedAt`, a well-formed `requestHash`, and an `operationId` and author within the input rules;
- a checkpoint within the input rules, with corrections pointing only at earlier entries;
- a briefing, when present, within the briefing rules, with a facts fingerprint that is `null` or a SHA-256 digest;
- a serialized size, as reads return it, within the 48 KiB entry limit.

Across entries, no author session repeats an `operationId`, no entry is corrected more than 64 times, and every entry of a session log was written by that session. A log that reads cleanly can therefore always be paged and rewritten: the limits that `record` enforces are the limits the parser enforces on what is stored. Session documents store the raw session ID in `ref`; the file name is only its SHA-256. Any violation is `worklog_corrupt`, and any other schema version is `unsupported_schema`. The service never resets or rewrites an invalid file, and a `record` against one fails with the same reason and writes nothing.

### Storage limit

A single log may not exceed 16 MiB serialized (`WORKLOG_LOG_MAX_BYTES`). The limit protects readers and writers, which load and rewrite the whole file; it is not a retention policy. At typical milestone sizes it holds thousands of checkpoints, but it is finite: once a log reaches it, `record` returns `worklog_full` and the log stays readable. Nothing is trimmed to make room, and this version provides no rotation, archival, or compaction operation. A file already past the limit is refused on read with `worklog_too_large`.

## Security

- Storage paths are built from the project root, the resolved feature directory, or a fixed session directory plus a SHA-256 file name, so a session ID cannot shape the path. Every existing component below the project root is checked with `lstat`, and a symbolic link anywhere on the path, including the log file itself, is `unsafe_path`. This check runs before every read, including the facts view's check that a log exists. A directory named exactly like the feature that is a symbolic link is `unsafe_path` whether or not its target exists. Feature resolution reads only each candidate directory's own `feature.json` (never through a link) and does not scan sibling metadata through the canonical resolver, so an unrelated feature with a bad or linked `feature.json` neither blocks nor feeds a log. The facts projection checks the tasks directory and each `status.json` the same way: a link to either never contributes facts, and the facts say so. A local actor who can replace directories between the check and the write is outside this protection.
- References are citations for readers. Paths must be normalized project-relative paths without traversal, backslashes, drive letters, or absolute roots. URLs must be `http` or `https` without embedded credentials. Reads never open, fetch, or resolve a reference.
- Titles, summaries, details, briefings, and reference labels are untrusted text written by agents. Clients must display them as data and must not inject them into prompts automatically; a primary reads them only by calling the read tool.
- Recorded facts are labelled with `WORKLOG_FACTS_NOTICE` and make no liveness or verification claim.

## Client behavior

The OpenCode plugin and the VS Code viewer are separate integration lanes. This section states what they must do with the core contract.

### Tools (proposed)

| Tool | Core call | Notes |
|---|---|---|
| `hive_worklog_list` | `list` | Read-only |
| `hive_worklog_read` | `read` | Read-only; default view `brief` |
| `hive_worklog_record` | `record` | Primary-only; the host fills `author` from the calling session and agent |

Arguments mirror the core options. An explicit `feature` argument or explicit `key` selects the log; otherwise the host applies the routing rule in [Which log a call targets](#which-log-a-call-targets). Tool results return the core result shapes unchanged so agents and viewers read the same fields.

Tools surface a `WorklogError` with its `reason` and `details` unchanged. A client that switches on `reason` must handle `io_error` and must pass its `details.stage` and `details.publication` through. After an `io_error` from `hive_worklog_record` with `details.stage: 'write'`, the agent resends the identical request rather than assuming nothing was recorded or choosing a new `operationId`. A viewer treats a list item with reason `io_error` like any other unreadable log.

### Primary guidance

Primaries record at milestones, such as a task merged, a plan approved, a blocker raised or cleared, a direction change, or a hand-over between sessions. They do not record per tool call or on a timer. They update the briefing when it no longer describes the work, reading first and passing the returned revision.

For feature work, the Worklog replaces the progress and history narration that previously accumulated in `context/overview.md`, and the routine narration of execution steps in `execution-decisions`. `overview.md` keeps the feature's purpose and design summary; reviewable decisions and detailed context stay in their context documents.

### Viewer

The VS Code viewer lists logs, lets the operator pin logs by key, and reads them offline from the files alone, without a running OpenCode host. Operators who do not want primaries to keep a Worklog opt out with an ordinary standing constraint; no new setting is introduced.

## Tests

`packages/hive-core/src/services/worklogService.test.ts` owns the contract. It covers key round-trips and storage paths; feature resolution for indexed, unknown, aliased, duplicate, and unreadable features with no phantom directories; archived-feature corrections without lifecycle change; symbolic links on session and feature paths, including a linked tasks directory, a linked `status.json`, a linked sibling `feature.json`, and the facts view's existence check; first record, default title, and runtime author and time; combined rejection with no write for stale briefings, unknown corrections, and mismatched revision guards; briefing dereference and `checkpointsSinceBriefing`; lost-response replay before the revision check, payload conflicts, and per-session retry identity; title stability; correction links; per-owner session isolation and reads without the session index; author, reference, byte, and Unicode limits; concurrent appends from four separate processes; loud failure on corrupt and future-schema files, including stored values past the record-time limits, with bytes unchanged on read and record; read, lock, path, discovery, and write failures as `io_error`, with a retry after a failure before and after the rename; the storage limit on read and record; nonmutating reads across every view and list; anchored history under appends, replaced files, and foreign cursors; request bounds and byte budgets including envelopes; fact counts, runnable and dependency-blocked tasks, integrity rows, `changedSinceBriefing`, stale facts cursors, and unavailable facts; and list ordering, kind filtering, error items beside good logs, paging, and stale inventory cursors.

`taskService.test.ts` owns the stored task-status rules that facts rely on. `sessionService.test.ts` covers `peekGlobal` returning sessions while leaving a corrupt, malformed, or literal `null` index untouched, and returning nothing only when the index is absent.

## Remaining integration obligations

| Obligation | Owner |
|---|---|
| Register `hive_worklog_list`, `hive_worklog_read`, `hive_worklog_record`; fill `author` from the runtime; enforce primary-only record on both hosts; implement routing with `peekGlobal` and no sole-live or detected fallback | OpenCode plugin lane |
| Update role grants, tool docs, and tool-count pins; add primary prompt guidance for milestone cadence and the overview and `execution-decisions` changes | OpenCode plugin lane |
| List, pin by key, and read logs offline; show facts separately from narrative; treat all narrative as untrusted display text | VS Code viewer lane |
| Full root build and test, release artifact checks, and the integrated security review across core, plugin, and viewer | Primary integration |
