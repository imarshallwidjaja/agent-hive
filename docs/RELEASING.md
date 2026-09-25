# Releasing Arkive Packages

## Upgrade note

Restart OpenCode after upgrade. Finish or abandon old live workers first. Remove stale copied user-authored workflow instructions yourself; Hive does not silently overwrite global settings. Old attempt and lease files are left unread. Useful plans, tasks, context, reports, and workspace files remain readable.

This fork's release workflow builds the shared `hive-core` package, builds and tests `packages/opencode-hive` and `packages/vscode-hive`, publishes `oc-arkive` to npm, attaches `vscode-arkive.vsix` to the GitHub Release, and creates the GitHub Release from the matching release note file.

The `Release` workflow publishes only on tags matching `v*`. Manual `workflow_dispatch` runs default to `rehearse`: they build and test the candidate without publishing to npm or creating a GitHub Release. Recovery mode is only for existing `vX.Y.Z` tags and reuses that tagged commit.

## 1. One-time release setup

Publishing to npm uses [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers) through GitHub Actions OIDC, so no npm token or repository secret is required. On npmjs.com, create a trusted publisher for the account that owns `oc-arkive` with the GitHub repository `imarshallwidjaja/agent-hive`, workflow filename `release.yml`, and permission `npm publish`.

After the first OIDC publish succeeds, remove the `NPM_KEY` repository secret on GitHub and revoke the old npm automation token. These are manual account steps; the workflow change does not remove the secret or revoke the token.

The workflow authenticates through the GitHub OIDC token: the publish job declares `permissions: contents: read` and `id-token: write` and publishes with Node 24 and npm CLI 11.5+ (`npm install -g npm@^11.5.1`) on a GitHub-hosted runner, which meets the npm Trusted Publishing requirements.

Trusted Publishing is configured on the existing `oc-arkive` package. The CI skip check runs `npm view oc-arkive@<requested version>` anonymously: an absent requested version is publish-ready and an already-published requested version skips publishing. The check also treats registry lookup failures as publish-ready; investigate registry errors before retrying a failed publish. The workflow keeps public access explicit with `npm publish --access public`. Publishes through Trusted Publishing from GitHub Actions automatically generate npm provenance attestations, so the workflow does not pass `--provenance` explicitly.

## 2. Prep the release locally

Release preparation is manual. Update the release branch explicitly for `vX.Y.Z`:

- bump the root version, `packages/hive-core/package.json`, `packages/opencode-hive/package.json`, and `packages/vscode-hive/package.json` to `X.Y.Z`
- set `packages/opencode-hive/package.json`'s `devDependencies.hive-core` and `packages/vscode-hive/package.json`'s `dependencies.hive-core` to that exact `X.Y.Z` version
- regenerate `bun.lock` and `package-lock.json`; a stale exact pin can resolve `hive-core` from the registry instead of linking the local workspace
- regenerate `packages/opencode-hive/plugin.json` by running the package build
- regenerate and commit `packages/vscode-hive/dist/extension.js` with the package build; run `bun run --filter vscode-arkive package` to inspect the local `packages/vscode-hive/vscode-arkive.vsix` (gitignored). CI builds its own VSIX.
- add `docs/releases/vX.Y.Z.md`
- add the `X.Y.Z` entry near the top of `CHANGELOG.md`
- update OpenCode install or release docs if the package contract changed

The release workflow uses `docs/releases/vX.Y.Z.md` as the GitHub Release body for the resolved release tag, so the matching release note file must exist before tagging.

The pushed tag must also match the root package version. A `v1.2.3` tag on a commit whose `package.json` version is still `1.2.2` is invalid and fails before publish jobs run. The release artifact check verifies both exact `hive-core` pins, the npm local-workspace link, and the packed `oc-arkive` dependency and module-reference boundaries.

## 3. Run local release preflight

Before tagging, run the canonical release check:

```bash
bun run release:check
```

You can also verify your local npm login and package access, but CI does not require either check:

```bash
npm whoami
npm access list collaborators oc-arkive --json
```

These checks are not preparation shortcuts:

- `npm whoami` confirms your local npm login works.
- `npm access list collaborators oc-arkive --json` lists package collaborators for human inspection. It does not verify GitHub OIDC Trusted Publishing or authority to make the first publish.
- `bun run release:check` installs dependencies; builds `hive-core` and `vscode-arkive`; checks release artifacts, the workflow, and VS Code bundle reproducibility; then builds `oc-arkive` and runs the three package test suites. The artifact check also builds and packs `oc-arkive` and runs the release documentation contract in an isolated staging tree.

The documentation contract checks that canonical documents exist, the 37-tool manifest contains required tools, the manifest and runtime omit retired tools, and the release guide includes `workflow_dispatch` without a preparation shortcut. `release-artifacts.test.mjs` also runs it in an isolated staging tree without Git metadata:

```bash
node --test release-docs.test.mjs
```

An isolated staging copy does not need a staging-only Git index.

The npm checks are optional local validation only and are not CI gates: CI authenticates with the GitHub OIDC token exchanged by npm Trusted Publishing and never uses a static npm token.

Fix any `bun run release:check` failure before creating a tag. A failed optional npm check only affects local npm operations; CI publishing authenticates independently through OIDC.

## 4. Rehearse the GitHub workflow

After merging release prep, run the `Release` GitHub Actions workflow manually with `workflow_dispatch` from the branch head you will tag, normally `main`. Select that branch in the workflow UI; rehearsal checks out its selected commit.

Use the default `rehearse` mode to confirm:

- the workflow boots on the current branch
- build and test steps pass in CI
- generated release artifacts look correct
- no publish step runs during the manual rehearsal

The real npm publish and GitHub Release creation happen only from a pushed `vX.Y.Z` tag or from a later tag-backed recovery run.

## 5. Tag and release

After merging the release prep changes to `main`, create and push the release tag:

```bash
git checkout main
git pull
git tag -a vX.Y.Z -m "Release X.Y.Z"
git push origin vX.Y.Z
```

That tag triggers `.github/workflows/release.yml` to build, test, publish `oc-arkive`, attach `vscode-arkive.vsix`, and create the GitHub Release.

If you push the wrong tag before release prep is complete, do not use recovery mode to publish from that bad tag. Prepare the correct release commit first, then decide explicitly whether to recreate the tag or move to the next patch version.

Users can then install the forked OpenCode plugin with:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["oc-arkive@latest"]
}
```

VS Code users can download `vscode-arkive.vsix` from the GitHub Release and install it locally:

```bash
code --install-extension ./vscode-arkive.vsix
```

## Missed-release recovery

When a tag already exists but one or more release targets failed, recover by manually dispatching the `Release` workflow in `recover` mode for that existing tag.

### Recovery contract

- Recovery is tag-only: set `release_mode=recover` and provide an existing `recovery_tag` such as `vX.Y.Z`.
- Recovery requires a recovery tag and at least one explicit target toggle.
- Recovery toggles are operator-selected: enable only `recover_oc_arkive` and/or `recover_github_release` for the unfinished target.
- Rerun only the unfinished targets. If npm already published but the GitHub Release failed, enable only `recover_github_release`.
- Recovery does not repair a tag that points at the wrong package version or lacks the matching release note file. Fix the release commit/tag relationship first.

### Operator flow for a partially published version

1. Check whether `oc-arkive@X.Y.Z` exists on npm and whether the GitHub Release exists for `vX.Y.Z` with the `vscode-arkive.vsix` asset attached.
2. Check the trusted publisher configuration (GitHub repository, workflow filename `release.yml`, allowed action, and environment if configured), the publish job `permissions` (`contents: read` and `id-token: write`), the GitHub-hosted `ubuntu-latest` runner, and supported Node 24 / npm 11.5+ versions.
3. Open the `Release` workflow with `workflow_dispatch`.
4. Set `release_mode` to `recover`.
5. Set `recovery_tag` to the existing release tag.
6. Enable only the unfinished target: `oc-arkive` and/or GitHub Release.
7. Run the workflow and verify only the selected targets executed.

Release-only recovery remains possible when npm was intentionally skipped. Do not start the next patch release until the current tag is fully recovered from its tagged commit.
