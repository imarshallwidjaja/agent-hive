# vscode-arkive

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

VS Code companion for reviewing and commenting on Hive `.hive/` output: sidebar, `plan.md` and `overview.md` review, and inline comments.

## Why Hive?

OpenCode runs the work. This extension keeps plans, comments, context, task reports, and feature status close to your editor.

## Installation

### From VSIX

Download `vscode-arkive.vsix` from [GitHub Releases](https://github.com/imarshallwidjaja/agent-hive/releases) and install manually.

The single VSIX carries the Koffi native module and its prebuilt binaries for Linux, macOS, Windows, FreeBSD and OpenBSD on the architectures supplied by Koffi. Hive uses it for crash-released locks. Locking has been exercised on Linux x64 under Node and Bun; packaged coverage does not establish runtime validation on the other platforms. Koffi needs Node 16, so the extension requires VS Code 1.67 or later.

Before upgrading from a release before 5.2.0, stop all older OpenCode processes, workers and Git children, and all VS Code instances that can write the same project or shared global Hive configuration. Old and new locking protocols cannot safely share writers. Follow the [upgrade and lock recovery instructions](../../docs/OPERATOR-GUIDE.md#upgrade) before restarting.

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

### Explorations

An exploration is the record an agent keeps of one investigation, such as a debugging session or a security audit: a goal, a frontier of targets it must settle, and the observations it recorded along the way. Agents write them with `hive_explore_update` under `.hive/explorations/active/` and move them to `.hive/explorations/closed/` when they conclude or abandon them. The viewer reads these files directly, so explorations from finished sessions stay readable without a running OpenCode host.

The **Explorations** view names the project it reads and has two groups:

- **Active** lists explorations that agents can still update. Each row shows the ID and the goal.
- **Closed** lists concluded and abandoned explorations, most recently changed file first. The view lists them by file name and reads a record only when you hover over its row or open it, so a large archive does not slow the view down.

An active record that cannot be read keeps its row with a warning icon and the reason, for example `Unreadable: exploration_corrupt`. A closed record is not read until you need it, so its row looks like any other; hovering over it or opening it shows the reason. If the explorations directory itself cannot be read, the view shows one row that says why.

To open an exploration, select its row, or run **Hive: Open Exploration...** (the search action in the view title, also in the command palette) and pick an ID. Each exploration opens in one editor tab, and opening it again returns to that tab. The tab shows:

- The goal, ID, subject, status, revision, last update and the agent that made it, and how many targets are settled. A closed exploration also shows when it closed and its conclusion or reason.
- A map of the exploration. The **Frontier** frame holds one node per target, in the order the agent recorded them, with its state: open, covered, blocked or dropped. Targets have no recorded links to each other, so the map draws none. The **Observations** frame draws an arrow from an observation to the one it supersedes, and each node also says so in text ("Supersedes ...", "Superseded by ..."). A superseded observation keeps the status it was recorded with. Observations with no supersedes link are listed under **Not linked**.
- A details pane for the selected node: the target's question, evidence or reason, an observation's summary and links, the revision that last changed it, and its references.

Use the mouse or the keyboard:

- Tab moves between the buttons, the frontier, the observations and the details pane.
- In the frontier or the observations, the arrow keys, Home and End move the selection, and the details pane follows. With Shift, Ctrl, Alt or Cmd held, these keys keep their usual editor shortcuts.
- When the details pane has focus, the arrow and Page keys scroll it.
- A supersedes chain wider than the tab says so below it, scrolls sideways, and can take focus so the arrow keys scroll it.
- In the details pane, the **Supersedes** and **Superseded by** buttons select the linked observation.

The selected node carries a **Selected** label and its own background; the keyboard focus is an outline. The tab follows the Light, Dark and High Contrast themes and the operating system's forced colours.

References are shown as recorded text and are never opened; copy one to follow it. All recorded text is shown as plain text, so it cannot add links, markup or commands to the tab. When an exploration names a prior exploration, **Open prior exploration** opens it in its own tab, or says in place that the prior record is not in this project.

**Live** in an active exploration's tab means the tab reads the record again whenever the watcher sees its file change, when you return to the tab, and when you select **Refresh** in the tab or run **Hive: Refresh**. Items changed since the revision the tab showed before get a dashed outline and a `Changed in revision N` label, and the tab keeps your selection, focus, and the scroll position of the page, the details pane and each chain. The tab does the same when you leave it and come back: VS Code discards a hidden tab's page, and the tab restores its place when it loads again. If the item you had focused is gone, or the record cannot be read, focus moves to the nearest control that remains, such as the first node of the same group or **Refresh**. When the agent closes the exploration, the same tab shows the closed record. Live describes the record only: it shows what agents recorded, and it does not show whether an agent is still working. Entries are agent notes, not verified results. Reading never writes to `.hive` or to workspace state.

### Session standing constraints

Run **Hive: Inspect Session Standing Constraints** from the command palette and explicitly choose a session. The picker lists only sessions with constraints from the project's authoritative session registry, with agent, feature, kind, activity and ID for disambiguation. It reads the OpenCode v1 and OpenCode v2 registries separately, so the same session ID can appear once per host and each entry opens from its own host's registry; an unreadable registry is reported without hiding the other. It does not infer an active session or use feature-local mirrors.

The read-only text document shows the selected identity and scope, stable entry IDs, verbatim constraint text, revision, and usage against 16,000 characters. It omits directive prompts, paths, and recovery metadata. Existing documents refresh on `.hive` changes or **Hive: Refresh**. Manage constraints through OpenCode; the inspector has no editing controls.

### Inline Review
Add comments on a feature's `plan.md` and `context/overview.md`. **Done Review** prompts for feedback and copies the review summary to the clipboard for the next planning step; it does not approve the plan in Hive.

### Task reports

Expand a feature's **Tasks** group and a task to open its `spec.md`, **Successor handoff** (`handoff.md`), **Latest report** (`report.md`), or **Report history**. Each appears only when its file exists. History lists numbered report revisions and any finalization reports, newest first.

### File Watching
Watches `.hive/` for changes and refreshes automatically. A write to an exploration refreshes only the Explorations view and that exploration's open tab; temporary write files and locks refresh nothing.

### Repositories & Work

One tree per configured repository (the project root counts as one when there is no `.hive/repositories.json`). Under each repository:

- **The repository checkout**: its current branch and commit. When it is registered as a retained checkout, the row is named by the registered branch and shows that record's state.
- **Retained checkouts** from `.hive/checkouts`, labelled by branch. The description gives the recorded readiness and the declared next destination, for example `Ready → develop`, `Waiting → develop`, `Changed since readiness → develop`, or `Retained` when no readiness was recorded, and how many workers are bound to it. A managed checkout whose directory is gone shows `Missing`, one whose HEAD cannot be read shows `Unavailable`, and one on another branch shows `Off intended branch`, in place of its readiness. Expand a checkout for its bound workers, then the full waiting condition, readiness commit and time, purpose, HEAD, location, and its record file.
- **Temporary workers** from `.hive/.worktrees`, nested under the retained checkout each was bound to. Workers with no declared target, or a target that is not a retained checkout in that repository, are listed under **Other workers / unresolved**; their destination is not guessed. A worker whose worktree was removed while its branch was kept stays listed. Expand a worker for its branch, location, target, start commit, worker sessions, task spec, latest report, and feature worklog.
- **Other local branches**, collapsed, lists local branches that no Hive record represents. Branches are read from local refs only when you expand it; nothing is fetched.

Records that cannot be read stay visible: an unreadable checkout record or worker keeps its row with the problem, entries with no configured repository appear under **Not in a configured repository**, and stray files under `.hive` appear under **Unreadable Hive entries**.

Readiness is what a primary agent declared at a commit. It is not a verification result and does not say whether Git can merge the branch; when HEAD has moved past the declared commit the row says `Changed since readiness`. Worker sessions come from each host's session registry: `.hive/sessions.json` for OpenCode v1 and `.hive/runtime/opencode-v2/sessions.json` for OpenCode v2. A worker lists a **Session** row for each session record that names its exact task or ad-hoc run, with the agent, the host, and the time the record was last updated, and the worker row shows its most recent update, for example `last session update 5 min ago`. A session record shows that a session was dispatched for the work and when it last recorded activity; it does not show that the session is still running. When two placements share a task and the records do not say which one they belong to, the worker shows the activity as ambiguous. If a session registry cannot be read and no matching session can be shown, activity shows as unknown.

Git state is read when the view opens, when it becomes visible again, when the window regains focus, on **Hive: Refresh**, and when Hive records under `.hive` change. File changes inside worker and retained checkouts do not trigger a read. The view title shows when Git was last read.

Selecting a row expands it. The inline actions **Open in New Window** and **Open in Terminal** open a checkout's directory; a window opened on a worker or retained checkout reads the Hive project that holds it; the context menu adds **Copy Path**, **Copy Branch Name**, and **Copy Commit SHA**. The view has no merge, rebase, push, branch deletion, or worktree cleanup actions; use `oc-arkive` for those.

#### Removing a stale checkout record

When the directory of a managed retained checkout is deleted outside Hive, for example with `git worktree remove` or by deleting the folder, its record in `.hive/checkouts` stays behind and the row shows `Missing`. Refreshing the view only reads; it never removes the record. To remove it, right-click the row and choose **Remove Stale Hive Record...**. The extension inspects the checkout again before it offers anything:

- If an unfinished task, a targeted worker, or another checkout's next-target declaration still names the checkout, if a file that could name it cannot be read, or if an interrupted worktree operation guards its repository, the extension lists these and does not offer removal. Select a task, worker, or checkout in the list to open the file that names it; unreadable files and interrupted operations are listed as text.
- Otherwise one confirmation shows the project, the checkout ID, its intended branch, the missing directory, and the record file. Confirming deletes only the record file.

The extension only reads Git and never changes it, so the branch and every Git worktree registration stay as they are. After you confirm, the removal checks the record and directory, scans the references again, and checks the record and directory once more before it deletes the file. If the record changed, the directory came back, or the scan finds a reference or a file it cannot read, the record is not removed, the view refreshes, and the error says why; inspect the row again before retrying.

The scan reads each file once. Hive worktree and retained checkout operations on the repository wait for the removal, but task records do not: a task that names the checkout, written after the scan read its file, is not detected. If you need that assurance, stop agents that could create or update tasks targeting this checkout until the removal finishes.

## Usage

### Review a Hive feature

1. Create or open a repository that already has `.hive/` output from `oc-arkive`
2. Click the Hive icon in the Activity Bar
3. Open `plan.md` or `overview.md` from the sidebar and review
4. Add comments directly on the document, then click **Done Review** to copy your feedback for the next OpenCode planning step

### What this extension does

- **Document review**: inspect the feature plan and optional overview, with inline comments on both; unresolved plan comments block plan approval
- **Sidebar visibility**: features, tasks, status, latest reports, and report history in one place
- **Work visibility**: Repositories & Work shows repositories, retained checkouts, workers, and their recorded sessions without agentic control
- **Worklogs**: read feature and session worklogs offline, pin them, and page through their history
- **Explorations**: find active and closed explorations and read each one as a live, read-only map
- **Operator archive**: Use the inline row action to archive features; right-click a context folder or document for **Archive Context**
- **Stale checkout records**: right-click a `Missing` retained checkout in Repositories & Work for **Remove Stale Hive Record...**
- **Inline comments**: discuss changes directly in `plan.md` and `overview.md`
- **File watching**: tracks `.hive/` changes and refreshes in real time

## Commands

| Contributed title | Command ID | Description |
|-------------------|------------|-------------|
| Hive: Refresh | `hive.refresh` | Refresh all four views, open worklog documents, open exploration tabs, and the constraints inspector |
| Open File | `hive.openFile` | Open a file from the sidebar |
| Copy ID | `hive.copyToClipboard` | Copy a worklog key from the sidebar |
| Done Review | `hive.plan.doneReview` | Copy plan or overview review feedback to the clipboard |
| Add Comment | `hive.comment.create` | Add an inline comment on a feature plan or overview |
| Reply | `hive.comment.reply` | Reply to an existing comment |
| Resolve Thread | `hive.comment.resolve` | Resolve a comment thread |
| Delete Comment | `hive.comment.delete` | Delete a comment |
| Archive Feature | `hive.feature.archive` | Archive a planning, approved, or executing feature; preserve its files and worktrees |
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
| Hive: Open Exploration... | `hive.exploration.open` | Pick an active or closed exploration by ID and open its read-only map tab |
| Open in New Window | `hive.repositories.openInNewWindow` | Open a repository, retained checkout, worker, or branch checkout in a new VS Code window |
| Open in Terminal | `hive.repositories.openTerminal` | Start a terminal in a repository, retained checkout, worker, or branch checkout directory |
| Copy Path | `hive.repositories.copyPath` | Copy the directory of a row in Repositories & Work |
| Copy Branch Name | `hive.repositories.copyBranch` | Copy the branch name of a row in Repositories & Work |
| Copy Commit SHA | `hive.repositories.copyCommit` | Copy the full commit SHA of a row in Repositories & Work |
| Remove Stale Hive Record... | `hive.repositories.removeStaleRecord` | Remove the record of a managed retained checkout whose directory is gone; reads Git without changing it |

### Tips

- **Context management**: Check `.hive/features/<name>/context/` for notes. `overview.md` is reserved operational context; other notes such as `decisions.md` or `architecture.md` are durable by default.
- **Plan and overview review**: `plan.md` and the feature's `context/overview.md` support inline comments. The overview is optional and its comments do not block plan approval.

## Pair with OpenCode

For the supported workflow, install [oc-arkive](https://www.npmjs.com/package/oc-arkive) and use this extension as the review/sidebar companion.

## Scope: viewer + limited operator actions

This extension is **viewer-first** with limited operator actions. It reads `.hive/` artifacts (features, plans, tasks, contexts, comments, worklogs, explorations, worker session records, repository manifests, retained checkout records, and worker placements) and surfaces them in the sidebar and review flow. Viewing and review actions include Refresh, Open File, Copy ID, the Repositories & Work open and copy actions, Inspect Session Standing Constraints, Open Exploration, Done Review, and inline comments. The exploration tab is the extension's only webview; it reads records and can ask the extension only to read the record again or to open the recorded prior exploration.

Two explicit **operator archive** actions allow cleaning up stale state:
- **Archive Context**: selectively archives confirmed durable, evidence, or reserved documents in the selected project or feature scope, using a captured context revision, actual content hashes, a required reason, and a confirmation warning when byte size differs from the listing or the document carries a last-managed-write warning.
- **Archive Feature**: marks a feature with `archived` status, excluding it from ordinary agent status and implicit sole-live resolution. Preserves all `.hive/` files for audit or manual recovery. Does not delete worktrees, branches, tasks, or commits.

One **record cleanup** action removes a retained checkout record that no longer describes anything on disk:
- **Remove Stale Hive Record**: deletes the `.hive/checkouts/<repoId>/<slug>.json` record of a managed retained checkout whose directory is gone, after a fresh inspection finds nothing that references it and you confirm. It reads Git but changes nothing there, so branches and Git worktree registrations stay unchanged.

It does not start worktrees, commit changes, merge branches, or cancel, reconcile, or archive background jobs. It contributes no `languageModelTools`. Use `oc-arkive` in OpenCode for those other operations. Multi-repo orchestration (composite workspaces, per-repo base commits, aggregate diff/commit/merge) is owned by `hive-core` and exposed through `oc-arkive`; any per-repo metadata the sidebar shows is read-through from those files. Reintroducing agentic command surfaces beyond these operator actions would change the security and review posture of this extension and is out of scope.

## Requirements

- VS Code 1.67.0 or higher
- A project with `.hive/` folder (created by `oc-arkive`)

## License

`vscode-arkive` is released under the [MIT License](LICENSE).
