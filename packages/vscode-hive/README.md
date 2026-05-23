# vscode-hive

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/tctinh.vscode-hive)](https://marketplace.visualstudio.com/items?itemName=tctinh.vscode-hive)
[![License: MIT with Commons Clause](https://img.shields.io/badge/License-MIT%20with%20Commons%20Clause-blue.svg)](../../LICENSE)

VS Code companion for reviewing and commenting on Hive `.hive/` output — sidebar, plan.md and overview.md review, and inline comments.

## Why Hive?

OpenCode runs the work. This extension keeps the plan, comments, overviews, and feature status close to your editor.

## Installation

### From VS Code Marketplace

1. Open VS Code
2. Go to Extensions (Ctrl+Shift+X)
3. Search for "Hive"
4. Click Install

### From VSIX

Download from [Releases](https://github.com/tctinh/agent-hive/releases) and install manually.

## Features

### Feature Sidebar
Feature tree with status indicators.

### Inline Review
Add comments on plan.md and overview.md.

### File Watching
Watches `.hive/` for changes and refreshes automatically.

## Usage

### Review a Hive feature

1. Create or open a repository that already has `.hive/` output from `opencode-hive`
2. Click the Hive icon in the Activity Bar
3. Open `plan.md` or `overview.md` from the sidebar and review
4. Add comments directly on the document, then click **Done Review** when ready

### What this extension does

- **Document review**: inspect `plan.md` and `overview.md` as the required review documents
- **Sidebar visibility**: features, tasks, status, and reports in one place
- **Inline comments**: discuss changes directly in `plan.md` and `overview.md`
- **File watching**: tracks `.hive/` changes and refreshes in real time

## Commands

| Command | Description |
|---------|-------------|
| Hive: Refresh | Refresh the feature tree |
| Hive: Open File | Open a file from the sidebar |
| Hive: Done Review | Complete review of plan.md or overview.md |
| Hive: Add Comment | Add an inline comment on plan.md or overview.md |
| Hive: Reply Comment | Reply to an existing comment |
| Hive: Resolve Comment | Mark a comment as resolved |
| Hive: Delete Comment | Delete a comment |

### Tips

- **Context management**: Check `.hive/features/<name>/context/` for optional notes; files like `overview.md`, `decisions.md`, or `architecture.md` are ordinary context files, not separate review gates.
- **Plan and overview review**: `plan.md` and `overview.md` are the review documents available in the sidebar. Both support inline comments.

## Pair with OpenCode

For the supported workflow, install [oc-arkive](https://www.npmjs.com/package/oc-arkive) and use this extension as the review/sidebar companion.

## Requirements

- VS Code 1.80.0 or higher
- A project with `.hive/` folder (created by opencode-hive)

## License

MIT with Commons Clause — Free for personal and non-commercial use. See [LICENSE](../../LICENSE) for details.


