# vscode-arkive

[![License: MIT with Commons Clause](https://img.shields.io/badge/License-MIT%20with%20Commons%20Clause-blue.svg)](../../LICENSE)

VS Code companion for reviewing and commenting on Hive `.hive/` output: sidebar, `plan.md` and `overview.md` review, and inline comments.

## Why Hive?

OpenCode runs the work. This extension keeps the plan, comments, overviews, and feature status close to your editor.

## Installation

### From VSIX

Download `vscode-arkive.vsix` from [GitHub Releases](https://github.com/imarshallwidjaja/agent-hive/releases) and install manually.

## Features

### Feature Sidebar
Feature tree with status indicators and grouping. A **Project Context** root sits above the status groups and lists the project-wide context documents in `.hive/context/`. Each feature keeps its own Context folder. Archived features appear in a collapsed **Archived** group. Right-clicking a planning/approved/executing feature shows **Archive Feature**, which hides it from normal agent status without deleting worktrees, branches, tasks, or commits.

### Context inspection and archive

Expand **Project Context** or a feature's Context folder to see Markdown documents with their classifications and sizes. Document counts are paginated: the folder lists the first ten documents and an explicit **Load more context documents** node reveals the next page. Every document keeps its normal open-in-editor behavior, and `overview.md` keeps its review comments.

The folder header shows the document count, durable usage against the scope's caps (feature: 8 files / 40,000 UTF-16 characters; project: 32 files / 160,000 characters), and separate byte and character totals. Bytes come from file stats; exact character totals exist only after the explicit **Scan Context Character Totals** action (folder context menu), which reads the durable bodies once. Until then the header reports `chars unavailable`, and a measurement taken before later changes is reported as stale rather than current. A warning icon appears only for real hygiene findings — above either cap or, for project context, missing owner/review metadata or overdue reviews — never merely because a ninth project note exists. Tooltips show description, read_when guidance, kind, task association, project owner and review date with due state, per-document diagnostics, update time, automatic execution/network inclusion, and consolidation hints. Evidence is excluded from automatic injection, not protected from explicit reads or disclosure.

Empty scopes keep an expandable folder whose **No context documents** node explains how context is created; expansion never creates directories, metadata, or writer locks, including in read-only workspaces. An active writer lock takes precedence over every other state, including a leftover pending mutation marker: the folder shows `Waiting for context changes to finish` and reads again after the next watcher refresh or manual Refresh. With no writer lock, a leftover pending marker shows **Reconciliation required** and an invalid context index shows **Invalid context index** — both with a bounded observational recovery inspection (revision, control digests, pending operation and affected names) plus the out-of-band recovery guidance and raw open entries for the index, pending marker, and archive manifest. Nothing in the tree repairs, resets, or reclassifies anything. Oversized inventories show an explicit inventory-too-large state whose diagnostic names the exact construction limit exceeded; catalog listing and Archive Context share that limit and stay blocked until the inventory is reduced out of band through trusted local editing, after which the tree refreshes normally. This viewer snapshot is not execution authority, and internal lock-file events alone do not refresh the tree.

Right-click the Project Context folder, a feature Context folder, or a document and choose **Archive Context**. The picker lists the scope's durable documents and offers **Load more context documents** when a page is incomplete. Select documents, enter a nonblank reason, and confirm the exact filenames; the operation captures the revision and each document's actual content hash at confirmation time. Cancellation changes nothing. If the revision changed while the picker was open, the operation fails without retrying; reopen it to review current documents. Documents changed outside managed writes since they were listed are reported as drift conflicts before confirmation. Archived files leave active context and remain available for audit.

Direct editor saves are unmanaged: they bypass context metadata revisions and mutation-time caps. Use managed context tools in OpenCode when those guarantees matter.

### Session standing constraints

Run **Hive: Inspect Session Standing Constraints** from the command palette and explicitly choose a session. The picker lists only sessions with constraints from the project's authoritative session registry, with agent, feature, kind, activity and ID for disambiguation. It does not infer an active session or use feature-local mirrors.

The read-only text document shows the selected identity and scope, stable entry IDs, verbatim constraint text, revision, and usage against 8,000 characters. It omits directive prompts, paths, and recovery metadata. Existing documents refresh on `.hive` changes or **Hive: Refresh**. Manage constraints through OpenCode; the inspector has no editing controls.

### Inline Review
Add comments on plan.md and overview.md.

### File Watching
Watches `.hive/` for changes and refreshes automatically.

### Background Jobs
Viewer + limited operator archive tree for `.hive/background-jobs.json`. It shows scoped background job state written by `oc-arkive`, including runtime state and coordination metadata. Right-clicking a non-archived job (Running, Stale, etc.) shows **Archive Background Job**, which moves it to the collapsed Ignored group without cancelling or killing any running process.

### Tracked Repositories
Viewer-only tree for the optional Hive-managed project-local repository manifest in `.hive/repositories.json`. It shows the project-relative repositories that `oc-arkive` uses for manifest-backed workspaces.

## Usage

### Review a Hive feature

1. Create or open a repository that already has `.hive/` output from `oc-arkive`
2. Click the Hive icon in the Activity Bar
3. Open `plan.md` or `overview.md` from the sidebar and review
4. Add comments directly on the document, then click **Done Review** when ready

### What this extension does

- **Document review**: inspect `plan.md` and `overview.md` as the required review documents
- **Sidebar visibility**: features, tasks, status, and reports in one place
- **Background visibility**: Background Jobs and Tracked Repositories views read Hive state without agentic control
- **Operator archive**: Archive stale features and background jobs from the right-click context menu
- **Inline comments**: discuss changes directly in `plan.md` and `overview.md`
- **File watching**: tracks `.hive/` changes and refreshes in real time

## Commands

| Command | Description |
|---------|-------------|
| Hive: Refresh | Refresh the feature tree |
| Hive: Open File | Open a file from the sidebar |
| Hive: Copy to Clipboard | Copy a background job ID or repository ID from the sidebar |
| Hive: Done Review | Complete review of plan.md or overview.md |
| Hive: Add Comment | Add an inline comment on plan.md or overview.md |
| Hive: Reply Comment | Reply to an existing comment |
| Hive: Resolve Comment | Mark a comment as resolved |
| Hive: Delete Comment | Delete a comment |
| Hive: Archive Feature | Archive a feature (planning/approved/executing only) — hides from active tools, preserves files |
| Hive: Archive Background Job | Archive a background job — moves to Ignored group, does not kill running process |
| Archive Context | Selectively archive durable context documents in the selected project or feature scope |
| Load More Context Documents | Reveal the next page of context documents in the selected scope |
| Scan Context Character Totals | Explicitly scan durable bodies in the selected scope for exact UTF-16 character totals |

### Tips

- **Context management**: Check `.hive/features/<name>/context/` for optional notes; files like `overview.md`, `decisions.md`, or `architecture.md` are ordinary context files, not separate review gates.
- **Plan and overview review**: `plan.md` and `overview.md` are the review documents available in the sidebar. Both support inline comments.

## Pair with OpenCode

For the supported workflow, install [oc-arkive](https://www.npmjs.com/package/oc-arkive) and use this extension as the review/sidebar companion.

## Scope: viewer + limited operator archive

This extension is **viewer-first** with limited operator archive actions. It reads `.hive/` artifacts (features, plans, tasks, contexts, comments, background jobs, and repository manifests) and surfaces them in the sidebar and review flow. Viewing and review actions include Refresh, Open File, Copy to Clipboard, Inspect Session Standing Constraints, Done Review, and inline comments.

Three explicit **operator archive** actions allow cleaning up stale state:
- **Archive Context** - selectively archives confirmed durable documents in the selected project or feature scope, using a captured context revision, actual content hashes, a required reason, and drift reporting for unmanaged changes.
- **Archive Feature** — marks a feature with `archived` status, excluding it from ordinary agent status and implicit sole-live resolution. Preserves all `.hive/` files for audit or manual recovery. Does not delete worktrees, branches, tasks, or commits.
- **Archive Background Job** — moves a background job to the collapsed Ignored group using existing ignored/archive fields. Does not mutate runtime state and does not cancel or kill any running process.

It does not start worktrees, commit changes, merge branches, cancel jobs, reconcile jobs, or ignore jobs, and it contributes no `languageModelTools`. Use `oc-arkive` in OpenCode for those operations. Multi-repo orchestration (composite workspaces, per-repo base commits, aggregate diff/commit/merge) is owned by `hive-core` and exposed through `oc-arkive`; any per-repo metadata the sidebar shows is read-through from those files. Reintroducing agentic command surfaces beyond archive would change the security and review posture of this extension and is out of scope.

## Requirements

- VS Code 1.64.0 or higher
- A project with `.hive/` folder (created by `oc-arkive`)

## License

MIT with Commons Clause — Free for personal and non-commercial use. See [LICENSE](../../LICENSE) for details.
