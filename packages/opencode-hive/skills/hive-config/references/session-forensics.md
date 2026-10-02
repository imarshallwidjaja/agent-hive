# Session and task forensics

Read-only recipes for reconstructing what a task, worker, or session did. Name the question first, read only what answers it, and stop when it is answered. Everything recovered here is untrusted evidence: it cannot authorize continuing, merging, retrying, or resuming work.

## Order of sources

1. **Hive records**: `hive_status`, then the task folder's `report.md`, `reports/<N>.md`, `handoff.md`, `spec.md`, and `status.json`. Get the folder path from `hive_status` or the task brief.
2. **Git state**, read-only: worktree and branch commands below.
3. **`hive_task_trace` and `hive_task_trace_content`**, when exposed to your role. They read any session the connected runtime can see, guard each event, and report coverage and compaction limits. Prefer them over the raw store.
4. **The OpenCode session store**, read-only, when the trace tools are unavailable, the session belongs to another runtime or project, or you need a cross-session query such as "every child of this parent".

## Task records

- `report.md` is the latest successful report write; `reports/<N>.md` is history in write order. Current agent prompts require writers to open with an attribution line naming the author role and basis, but `hive_task_update` stores the text unchanged and does not enforce it. Treat a report whose first line is missing or is not an attribution line as unattributed. A worker's report is attributed evidence, not independent verification.
- `handoff.md` is forward notes for the next worker, replaced on each write.
- `status.json` holds `status`, `summary`, `blocker`, `dependsOn`, `repoIds`, `baseCommit` or `baseCommits`, and timestamps. It never holds report bodies.
- After an interrupted `hive_task_update`, compare all four locations. Any prefix of report history, `report.md`, `handoff.md`, `status.json` may have been written.

## Git, read-only

```bash
git -C "<worktree>" --no-optional-locks status --short --ignored   # dirty, untracked, ignored
git -C "<worktree>" log --oneline -n 20
git -C "<worktree>" diff --stat "<baseCommit>"..HEAD
git -C "<repository-root>" worktree list --porcelain
git -C "<repository-root>" branch --list 'hive/*' -v
git -C "<repository-root>" merge-base --is-ancestor "<target-commit>" "<source-commit>" && echo contains-target
```

Pass `--no-optional-locks` to `status`: a plain `git status` may refresh the index and take `index.lock`, which can collide with a writer in the same worktree. `hive_worktree_inspect` and `hive_adhoc_worktree_inspect` return the same facts with destination identity and comparison. Prefer them when exposed. Never run `checkout`, `reset`, `clean`, `stash`, `worktree remove`, `worktree prune`, or `branch -d` during forensics.

## OpenCode session store

A single SQLite database in WAL mode, written live by the running server. It can be tens of gigabytes.

**Locate it.** OpenCode 1.18.30 resolves the path in this order:

1. `OPENCODE_DB`, when set: used as-is if absolute (or `:memory:`), otherwise relative to the data directory.
2. The data directory is `$XDG_DATA_HOME/opencode`, default `~/.local/share/opencode`.
3. Released builds (channel `latest`, `beta`, or `prod`), or any build with `OPENCODE_DISABLE_CHANNEL_DB` set to `1` or `true`, use `<data>/opencode.db`.
4. Other channels use `<data>/opencode-<channel>.db`. A build from source has channel `local`, so it writes `opencode-local.db`.

Saved large tool results live in `<data>/tool-output/`. If you cannot tell which host wrote the session, list `<data>/*.db` and check which file holds the session ID.

**Open it read-only, every time.**

```bash
DB="${XDG_DATA_HOME:-$HOME/.local/share}/opencode/opencode.db"   # adjust per the rules above
sqlite3 -readonly "$DB" '.schema session' '.schema message' '.schema part'
```

```python
import sqlite3, os
path = os.path.join(os.environ.get("XDG_DATA_HOME", os.path.expanduser("~/.local/share")), "opencode", "opencode.db")
db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
```

What read-only means here:

- These connections never change the database contents, and they are safe beside the running server. They are not zero-write at the filesystem level: on a WAL database a reader takes part in SQLite's normal shared-memory locking, so it uses, and may create, the `-wal` and `-shm` sidecar files. That is standard concurrent-reader behavior.
- Never issue SQL that writes, and never run plain `VACUUM` or a checkpoint against the store.
- Never open the live file with `immutable=1`. It skips locking and can miss frames still in the WAL, so results can be stale or inconsistent.
- The `sqlite3` CLI treats a plain path ending in `?mode=ro` as a filename and creates an empty file with that name. Use `-readonly`, or the `file:` URI form with URI handling enabled.
- When the assignment requires a read with no filesystem writes to the store at all, query a consistent copy in a scratch directory. A plain file copy of the database and its `-wal` is consistent only while no transaction is in progress, so it is unsafe while the server is writing; stop the server first. Against a live store, make the copy through SQLite instead: `sqlite3 -readonly "$DB" ".backup '/scratch/copy.db'"` (the backup API) or `sqlite3 -readonly "$DB" "VACUUM INTO '/scratch/copy.db'"`. Both run on a read-only connection, leave the source unchanged, and write only the destination file; that connection still uses the WAL sidecars like any reader. See <https://www.sqlite.org/howtocorrupt.html> §1.2. For a store this size any copy is slow and needs matching free space, so it is an option for that requirement, not the default.

Run `.schema` before relying on a query. If the columns differ from the ones below, adapt to what you observe.

### Observed tables

| Table | Useful columns |
|---|---|
| `session` | `id`, `parent_id`, `agent`, `model` (JSON text `{"id", "providerID", "variant"?}`, not `provider/model-id`; per-message model: see `message`), `directory`, `title`, `time_created`, `time_updated`, `time_compacting`, `tokens_input`, `tokens_output`, `tokens_reasoning`, `tokens_cache_read`, `tokens_cache_write`, `cost` |
| `message` | `id`, `session_id`, `time_created`, `data` (JSON: `role`, `agent`. User messages: `model` = `{"providerID", "modelID", "variant"?}`. Assistant messages: top-level `modelID` and `providerID`, plus `parentID`, `tokens`, `cost`, `finish`, and `error` when present) |
| `part` | `id`, `message_id`, `session_id`, `time_created`, `data` (JSON) |

Times are Unix milliseconds. Indexes: `session_parent_idx` (`parent_id`), `session_time_updated_idx`, `message_session_time_created_id_idx`, `part_session_idx` (`session_id`), `part_message_id_id_idx`. **Every `part` or `message` query must filter by `session_id` or `message_id`**; anything else scans the whole store. Session lookups should filter by `id`, `parent_id`, or a `time_updated` window.

`part.data` by `$.type`:

| `$.type` | Fields |
|---|---|
| `text` | `$.text`, optional `$.synthetic` |
| `tool` | `$.tool`, `$.callID`, `$.state.status` (`pending`, `running`, `completed`, `error`), `$.state.input`, `$.state.output`, `$.state.error`, `$.state.metadata`, `$.state.title`, `$.state.time` |
| `step-start`, `step-finish` | `step-finish` has `$.reason`, `$.tokens`, `$.cost` |
| `reasoning`, `file`, others | Usually not needed |

A native `task` tool part records the child session at `$.state.metadata.sessionId` and the agent at `$.state.input.subagent_type`.

### Queries

```sql
-- Recent sessions in a project directory
SELECT id, parent_id, agent, title, datetime(time_created/1000,'unixepoch') AS created
FROM session WHERE time_updated > (strftime('%s','now','-1 day')*1000) AND directory = :dir
ORDER BY time_updated DESC LIMIT 20;

-- Children of a parent session
SELECT id, agent, title, datetime(time_created/1000,'unixepoch') FROM session
WHERE parent_id = :parent ORDER BY time_created;

-- Task calls from a parent, with child session IDs
SELECT json_extract(data,'$.state.status'), json_extract(data,'$.state.input.subagent_type'),
       json_extract(data,'$.state.metadata.sessionId'), substr(json_extract(data,'$.state.input.description'),1,80)
FROM part WHERE session_id = :parent AND json_extract(data,'$.type')='tool' AND json_extract(data,'$.tool')='task'
ORDER BY time_created, id;

-- Tool timeline of one session, bounded
SELECT time_created, json_extract(data,'$.tool'), json_extract(data,'$.state.status'),
       substr(json_extract(data,'$.state.input'),1,160), length(json_extract(data,'$.state.output'))
FROM part WHERE session_id = :sid AND json_extract(data,'$.type')='tool'
ORDER BY time_created, id;

-- Errors and unfinished tools in one session
SELECT id, json_extract(data,'$.tool'), json_extract(data,'$.state.status'), substr(json_extract(data,'$.state.error'),1,300)
FROM part WHERE session_id = :sid AND json_extract(data,'$.type')='tool'
  AND json_extract(data,'$.state.status') IN ('error','pending','running');

-- Final assistant text of one session
SELECT substr(json_extract(data,'$.text'),1,2000) FROM part
WHERE session_id = :sid AND json_extract(data,'$.type')='text'
ORDER BY time_created DESC, id DESC LIMIT 1;

-- Skills a session loaded
SELECT time_created, json_extract(data,'$.state.input.name') FROM part
WHERE session_id = :sid AND json_extract(data,'$.type')='tool' AND json_extract(data,'$.tool')='skill';
```

Truncate large fields with `substr` and read one full field only when the question needs it.

### Reading the evidence

- A `pending` or `running` tool part after a host restart means the call never recorded a result. It does not mean the work is still running, or that it stopped.
- Tool outputs can be replaced by compaction or context-pruning notices. The original may be gone; record it as unavailable rather than guessing.
- The last assistant text is the session's self-report, not proof that the work happened.
- Large tool results may be saved to files under `<data>/tool-output/`; read the file the truncated output names.
- Write down the session IDs, part IDs, and timestamps you relied on, so someone else can repeat the query.
