# vscode-arkive

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

VS Code companion for reviewing and commenting on Hive `.hive/` output: sidebar, `plan.md` and `overview.md` review, and inline comments.

## Why Hive?

OpenCode runs the work. This extension keeps plans, comments, context, task reports, and feature status close to your editor.

## Installation

### From VSIX

Download `vscode-arkive.vsix` from [GitHub Releases](https://github.com/imarshallwidjaja/agent-hive/releases) and install manually.

The single VSIX works on every platform: it carries the Koffi native module and its prebuilt binaries, which Hive uses for crash-released locks. Koffi needs Node 16, so the extension requires VS Code 1.67 or later.

## Features

### Feature Sidebar
Feature tree with status indicators and grouping. A **Project Context** root sits above the status groups and lists the project-wide context documents in `.hive/context/`. Each feature keeps its own Context folder. Archived features appear in a collapsed **Archived** group. Use the inline **Archive Feature** action on a planning, approved, or executing feature row to hide it from normal agent status without deleting worktrees, branches, tasks, or commits.

### Context inspection and archive

Expand **Project Context** or a feature's Context folder to see Markdown documents with their classifications and sizes. Document counts are paginated: the folder lists the first ten documents and an explicit **Load more context documents** node reveals the next page. Every document keeps its normal open-in-editor behavior, and `overview.md` keeps its review comments.

The folder header shows the document count, durable usage against the scope's guidelines (feature: 8 files / 40,000 UTF-16 characters; project: 32 files / 160,000 characters), and durable byte and character totals. Bytes come from file stats; exact character totals exist only after the explicit **Scan Context Character Totals** action (folder context menu), which reads the durable bodies once. Until then the header reports `chars unavailable`, and a measurement taken before later changes is reported as stale rather than current. A warning icon appears when durable usage exceeds either guideline or when a durable project document is missing owner/review metadata or its review is overdue. Tooltips show description, read_when guidance, kind, task association, project owner and review date with due state, per-document diagnostics, update time, automatic execution/network inclusion, and consolidation hints. Evidence is excluded from automatic injection, not protected from explicit reads or disclosure.

Empty scopes keep an expandable folder whose **No context documents** node explains how context is created; expansion never creates directories, metadata, or writer locks, including in read-only workspaces. A lock held by a live writer, or a lock file left by an older Hive host, takes precedence over every other state, including a leftover pending mutation marker: the folder shows `Waiting for context changes to finish` and reads again after the next watcher refresh or manual Refresh. With no live writer, a leftover pending marker shows **Reconciliation required** and an invalid context index shows **Invalid context index** — both with a bounded observational recovery inspection (revision, control digests, pending operation and affected names) plus the out-of-band recovery guidance and raw open entries for the index, pending marker, and archive manifest. Nothing in the tree repairs, resets, or reclassifies anything. Oversized inventories show an explicit inventory-too-large state whose diagnostic names the exact construction limit exceeded; catalog listing and Archive Context share that limit and stay blocked until the inventory is reduced out of band through trusted local editing, after which the tree refreshes normally. This viewer snapshot is not execution authority, and internal lock-file events alone do not refresh the tree.

Right-click the Project Context folder, a feature Context folder, or a document and choose **Archive Context**. The picker lists the scope's durable, evidence, and reserved documents and offers **Load more context documents** when a page is incomplete. Select documents, enter a nonblank reason, and confirm the exact filenames; the operation captures the revision and each document's content hash before confirmation, then checks both when archiving. Cancellation changes nothing. If the revision changed while the picker was open, the operation fails without retrying; reopen it to review current documents. The confirmation flags a document if its byte size differs from the listing or it carries a warning that its bytes differ from the last managed write; you can still proceed. Archived files leave active context and remain available for audit.

Direct editor saves are unmanaged: they bypass context metadata revisions and mutation-time caps. Use managed context tools in OpenCode when those guarantees matter.

### Worklogs

A Worklog is the short account primary agents keep of where work stands: a current briefing, milestone checkpoints, and the recorded task facts beside them. Each feature has one shared log, and each ad-hoc primary session has its own log under its host (OpenCode v1 or OpenCode v2). The viewer reads the log files directly, so logs from finished sessions, cleaned-up worktrees, and completed or archived features stay readable without a running OpenCode host.

The **Worklogs** view names the project it reads (the first workspace folder's Hive project) and has three groups:

- **Selected**: the log you last opened. It changes only when you open another log; new activity elsewhere never replaces it. If the selected log becomes unreadable or disappears, the row says why and stays in place.
- **Pinned**: logs you pinned by their full key. Pins and the selection are stored in this VS Code workspace's state, not in `.hive`. A pin that cannot be read keeps a row with the reason so you can inspect or unpin it.
- **Recent**: logs in order of last change, ten at a time behind **Load more worklogs**. Unreadable log files appear beside readable ones with the failure reason, and selecting one opens the raw file unchanged.

Rows show the stored title, the feature name or session host, and how long ago the last checkpoint was recorded. **Hive: Open Worklog...** (the search action in the view title) pages through every log, including older and archived ones, and also opens a log from a full key such as `feature:checkout` or `session:opencode-v2:ses_abc123`, the same key agents show in chat. Each feature in the Features view also has a **Worklog** row for its shared log.

Opening a log shows a read-only plain-text document: title, key, project, revision and last update, the briefing with who wrote it and when, a recorded-facts summary, and the three newest checkpoints. When the recorded task facts differ from those stored with the briefing, the document marks the briefing's source records as changed; it never rewrites the briefing. **Show Worklog History** lists full checkpoints ten at a time, anchored at the revision it opened with, and reports newer checkpoints instead of shifting the page. **Show Worklog Facts** lists task rows with their status files. **Load More Worklog Entries** in the editor title continues either document.

Worklog text is written by agents and is shown as plain text; a line break inside recorded text starts an indented continuation line, so it cannot pose as a heading of the document. The viewer turns a recorded reference into a link only for a regular file inside the project reached without symbolic links, or for an `http` or `https` URL; any other reference stays text with the reason. VS Code's own link detection works separately from this rule: it can still underline URL-like text anywhere in the document, including agent-written text, and opens such a link only when you activate it, through VS Code's usual link handling. Recorded facts describe stored task state and do not show that a worker is running or that work was verified or merged. Reading never writes to `.hive`. Documents refresh when `.hive` changes or on **Hive: Refresh**.

### Session standing constraints

Run **Hive: Inspect Session Standing Constraints** from the command palette and explicitly choose a session. The picker lists only sessions with constraints from the project's authoritative session registry, with agent, feature, kind, activity and ID for disambiguation. It reads the OpenCode v1 and OpenCode v2 registries separately, so the same session ID can appear once per host and each entry opens from its own host's registry; an unreadable registry is reported without hiding the other. It does not infer an active session or use feature-local mirrors.

The read-only text document shows the selected identity and scope, stable entry IDs, verbatim constraint text, revision, and usage against 8,000 characters. It omits directive prompts, paths, and recovery metadata. Existing documents refresh on `.hive` changes or **Hive: Refresh**. Manage constraints through OpenCode; the inspector has no editing controls.

### Inline Review
Add comments on a feature's `plan.md` and `context/overview.md`. **Done Review** prompts for feedback and copies the review summary to the clipboard for the next planning step; it does not approve the plan in Hive.

### Task reports

Expand a feature's **Tasks** group and a task to open its `spec.md`, **Successor handoff** (`handoff.md`), **Latest report** (`report.md`), or **Report history**. Each appears only when its file exists. History lists numbered report revisions and any finalization reports, newest first.

### File Watching
Watches `.hive/` for changes and refreshes automatically.

### Background Jobs
Viewer + limited operator archive tree for the background boards `.hive/background-jobs.json` (OpenCode v1) and `.hive/runtime/opencode-v2/background-jobs.json` (OpenCode v2). It shows scoped background job state written by `oc-arkive`, including runtime state and coordination metadata. Rows from the v2 board are marked `OpenCode v2`, and every row action (open, archive) targets only its own board; an unreadable board is reported without hiding the other. Use the inline **Archive Background Job** action on an archiveable job row to move it to the collapsed Ignored group without cancelling or killing any running process.

### Tracked Repositories
Viewer-only tree for the optional Hive-managed project-local repository manifest in `.hive/repositories.json`. It shows the project-relative repositories that `oc-arkive` uses for manifest-backed workspaces.

## Usage

### Review a Hive feature

1. Create or open a repository that already has `.hive/` output from `oc-arkive`
2. Click the Hive icon in the Activity Bar
3. Open `plan.md` or `overview.md` from the sidebar and review
4. Add comments directly on the document, then click **Done Review** to copy your feedback for the next OpenCode planning step

### What this extension does

- **Document review**: inspect the feature plan and optional overview, with inline comments on both; unresolved plan comments block plan approval
- **Sidebar visibility**: features, tasks, status, latest reports, and report history in one place
- **Background visibility**: Background Jobs and Tracked Repositories views read Hive state without agentic control
- **Worklogs**: read feature and session worklogs offline, pin them, and page through their history
- **Operator archive**: Use the inline row actions to archive features and background jobs; right-click a context folder or document for **Archive Context**
- **Inline comments**: discuss changes directly in `plan.md` and `overview.md`
- **File watching**: tracks `.hive/` changes and refreshes in real time

## Commands

| Contributed title | Command ID | Description |
|-------------------|------------|-------------|
| Hive: Refresh | `hive.refresh` | Refresh all four views, open worklog documents, and the constraints inspector |
| Open File | `hive.openFile` | Open a file or repository path from the sidebar |
| Copy ID | `hive.copyToClipboard` | Copy a background job alias or repository ID from the sidebar |
| Done Review | `hive.plan.doneReview` | Copy plan or overview review feedback to the clipboard |
| Add Comment | `hive.comment.create` | Add an inline comment on a feature plan or overview |
| Reply | `hive.comment.reply` | Reply to an existing comment |
| Resolve Thread | `hive.comment.resolve` | Resolve a comment thread |
| Delete Comment | `hive.comment.delete` | Delete a comment |
| Archive Feature | `hive.feature.archive` | Archive a planning, approved, or executing feature; preserve its files and worktrees |
| Archive Background Job | `hive.job.archive` | Move a background job to Ignored without cancelling its process |
| Archive Context | `hive.context.archive` | Selectively archive documents in the selected project or feature scope |
| Load More Context Documents | `hive.context.loadMore` | Reveal the next page of context documents in the selected scope |
| Scan Context Character Totals | `hive.context.scanChars` | Scan durable bodies in the selected scope for exact UTF-16 character totals |
| Hive: Inspect Session Standing Constraints | `hive.constraints.inspect` | Choose a session and open its read-only constraints document |
| Hive: Open Worklog... | `hive.worklog.open` | Find a worklog by paging the list or entering its key, and open its read-only briefing |
| Show Worklog History | `hive.worklog.showHistory` | Open a worklog's checkpoints with full details, newest first |
| Show Worklog Facts | `hive.worklog.showFacts` | Open a worklog's recorded task facts with per-task rows |
| Pin Worklog | `hive.worklog.pin` | Keep a worklog in the Pinned group for this workspace |
| Unpin Worklog | `hive.worklog.unpin` | Remove a worklog from the Pinned group |
| Load More Worklog Entries | `hive.worklog.loadMore` | Show the next page of recent worklogs, history checkpoints, or task rows |

### Tips

- **Context management**: Check `.hive/features/<name>/context/` for notes. `overview.md` is reserved operational context; other notes such as `decisions.md` or `architecture.md` are durable by default.
- **Plan and overview review**: `plan.md` and the feature's `context/overview.md` support inline comments. The overview is optional and its comments do not block plan approval.

## Pair with OpenCode

For the supported workflow, install [oc-arkive](https://www.npmjs.com/package/oc-arkive) and use this extension as the review/sidebar companion.

## Scope: viewer + limited operator archive

This extension is **viewer-first** with limited operator archive actions. It reads `.hive/` artifacts (features, plans, tasks, contexts, comments, worklogs, background jobs, and repository manifests) and surfaces them in the sidebar and review flow. Viewing and review actions include Refresh, Open File, Copy ID, Inspect Session Standing Constraints, Done Review, and inline comments.

Three explicit **operator archive** actions allow cleaning up stale state:
- **Archive Context**: selectively archives confirmed durable, evidence, or reserved documents in the selected project or feature scope, using a captured context revision, actual content hashes, a required reason, and a confirmation warning when byte size differs from the listing or the document carries a last-managed-write warning.
- **Archive Feature**: marks a feature with `archived` status, excluding it from ordinary agent status and implicit sole-live resolution. Preserves all `.hive/` files for audit or manual recovery. Does not delete worktrees, branches, tasks, or commits.
- **Archive Background Job**: moves a background job to the collapsed Ignored group using existing ignored/archive fields. Does not mutate runtime state and does not cancel or kill any running process.

It does not start worktrees, commit changes, merge branches, cancel jobs, or reconcile jobs; archiving a background job is its only job mutation. It contributes no `languageModelTools`. Use `oc-arkive` in OpenCode for those other operations. Multi-repo orchestration (composite workspaces, per-repo base commits, aggregate diff/commit/merge) is owned by `hive-core` and exposed through `oc-arkive`; any per-repo metadata the sidebar shows is read-through from those files. Reintroducing agentic command surfaces beyond archive would change the security and review posture of this extension and is out of scope.

## Requirements

- VS Code 1.67.0 or higher
- A project with `.hive/` folder (created by `oc-arkive`)

## License

`vscode-arkive` is released under the [MIT License](LICENSE).
