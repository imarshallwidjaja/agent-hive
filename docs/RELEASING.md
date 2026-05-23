# Releasing oc-arkive

This fork's release workflow is OpenCode-only. It builds the shared `hive-core` package, builds and tests `packages/opencode-hive`, publishes `oc-arkive` to npm, and creates a GitHub Release from the matching release note file.

The `Release` workflow publishes only on tags matching `v*`. Manual `workflow_dispatch` runs default to `rehearse`: they build and test the candidate without publishing to npm or creating a GitHub Release. Recovery mode is only for existing `vX.Y.Z` tags and reuses that tagged commit.

## 1. One-time npm setup

Create an npm automation token for the account that will own `oc-arkive`, then add it to the fork as a repository secret named `NPM_KEY`.

For the first publish, the package does not exist yet. The release helper treats that as first-publish-ready as long as `npm whoami` succeeds with the configured token. After the package exists, the same helper verifies that the publishing account has read-write collaborator access.

## 2. Prep the release locally

Release preparation is manual. Update the release branch explicitly for `vX.Y.Z`:

- bump the root version, `packages/hive-core/package.json`, and `packages/opencode-hive/package.json` to `X.Y.Z`
- refresh `bun.lock` and `package-lock.json`
- regenerate `packages/opencode-hive/plugin.json` by running the package build
- add `docs/releases/vX.Y.Z.md`
- add the `X.Y.Z` entry near the top of `CHANGELOG.md`
- update OpenCode install or release docs if the package contract changed

The release workflow publishes `docs/releases/${github.ref_name}.md` as the GitHub Release body, so the matching release note file must exist before tagging.

## 3. Run local release preflight

Before tagging, confirm local package state and npm access:

```bash
npm whoami
node .github/scripts/verify-npm-publish-access.mjs opencode-hive
bun run release:check
```

These are preflight checks, not preparation shortcuts:

- `npm whoami` confirms your local npm login works.
- `node .github/scripts/verify-npm-publish-access.mjs opencode-hive` reads `packages/opencode-hive/package.json`, so it checks `oc-arkive` even though the package directory is still named `opencode-hive`.
- `bun run release:check` installs dependencies, verifies the release artifacts and workflow contract, builds `hive-core` plus `oc-arkive`, and runs their test suites.

If any preflight fails, fix credentials, access, or branch content before creating a tag.

## 4. Rehearse the GitHub workflow

Before tagging, run the `Release` GitHub Actions workflow manually with `workflow_dispatch` from the release branch or the merge commit you expect to tag.

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

That tag triggers `.github/workflows/release.yml` to build, test, publish `oc-arkive`, and create the GitHub Release.

Users can then install the forked OpenCode plugin with:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["oc-arkive@latest"]
}
```

## Missed-release recovery

When a tag already exists but one or more release targets failed, recover by manually dispatching the `Release` workflow in `recover` mode for that existing tag.

### Recovery contract

- Recovery is tag-only: set `release_mode=recover` and provide an existing `recovery_tag` such as `v1.4.9`.
- Recovery requires a recovery tag and at least one explicit target toggle.
- Recovery toggles are operator-selected: enable only `recover_oc_arkive` and/or `recover_github_release` for the unfinished target.
- Rerun only the unfinished targets. If npm already published but the GitHub Release failed, enable only `recover_github_release`.

### Operator flow for a partially published version

1. Check whether `oc-arkive@X.Y.Z` exists on npm and whether the GitHub Release exists for `vX.Y.Z`.
2. Repair the credential or access issue that caused the partial failure.
3. Open the `Release` workflow with `workflow_dispatch`.
4. Set `release_mode` to `recover`.
5. Set `recovery_tag` to the existing release tag.
6. Enable only the unfinished target: `oc-arkive` npm publish and/or GitHub Release.
7. Run the workflow and verify only the selected targets executed.

Release-only recovery remains possible when npm was intentionally skipped. Do not start the next patch release until the current tag is fully recovered from its tagged commit.
