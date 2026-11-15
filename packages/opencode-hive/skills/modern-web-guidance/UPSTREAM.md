# Provenance

This skill vendors the guide corpus of `modern-web-guidance`, published by GoogleChrome, into oc-arkive. Upstream ships the guides behind a command-line tool that agents run through `npx` to search and retrieve one guide at a time. oc-arkive ships the guides as plain files instead, with generated category indexes for search, so an agent reads them with ordinary file tools and no network access. oc-arkive maintains this copy and refreshes it from upstream releases with the sync script described below.

## Sources

| Input | Identity |
| --- | --- |
| Git repository | https://github.com/GoogleChrome/modern-web-guidance |
| Release | tag `v1.0.0`, commit `4dd968349e54ca45a05dd5c818fb035c9054b022`, committed 2026-11-10 ("Release v1.0.0") |
| npm package | `modern-web-guidance@1.0.0`, https://registry.npmjs.org/modern-web-guidance/-/modern-web-guidance-1.0.0.tgz |
| Tarball SHA-1 (npm `shasum`) | `e8d27ab97ab9fe7ba0885c9db72d53e9d8d28b9b` |
| Tarball SHA-256 | `bd7aa623ad10710a9ad6678fdbcc0b890c903c54fd6abfc126ff42de01f0e577` |
| Tarball SHA-512 (npm `integrity`) | `sha512-vafIZwC8AS6QjM2yyoflZbnc7n3/TVOMLbEMRdPTwcFy0f9/Tq8s5rJQ8UIqRt2KPl9ixravyaMR4nTGuUrcmg==` |
| Imported | 2026-11-15 |

The registry metadata read on 2026-11-15 (`npm view modern-web-guidance@1.0.0 dist`) reported the same `shasum` and `integrity` as the local tarball, with registry signatures and an SLSA provenance attestation. The attestation itself was not verified. The package manifest names `GoogleChrome/modern-web-guidance-src` as its source repository; the public repository above is the release target, and its guide files are byte-identical to the tarball's.

Both inputs are needed. The Git repository holds the guide Markdown but omits `skills/modern-web-guidance/gen/guides.json` and `skills/modern-web-guidance/legacy-scan.mjs`. Both exist only in the npm tarball. `guides.json` carries the guide metadata the indexes and gates use: 208 entries with `id`, `category`, `description`, `featuresUsed`, and `tokenCount`, of which 8 list `originTrials` and 10 list `volatileFeatures`. `legacy-scan.mjs` is upstream's bundled legacy-pattern scanner; its 35 rule definitions each carry an `id`, a `guideId`, a `summary`, and a `verifierRubric` with `keepWhen` and `dropWhen` lists. The sync script reads `guides.json` and `package.json` as JSON data and reads `legacy-scan.mjs` as UTF-8 text that it parses into a TypeScript syntax tree to collect those rule literals. It executes nothing from the package.

## Licenses and attribution

Upstream's README states the split: software code is licensed under the Apache License 2.0, and guide content under `guides/` is licensed under Creative Commons Attribution 4.0 International. It also states: "Portions of the documentation in this project are derived from MDN Web Docs by Mozilla Contributors and W3C, WHATWG, and IETF specifications." That attribution carries over to the vendored guides.

- `LICENSE.cc-by-4.0` covers `guides/**/*.md` and `references/index/*.md`. It holds the CC-BY 4.0 legal code, copied from the identical text already shipped in this package, under a notice naming the upstream work and release.
- `LICENSE.apache-2.0` covers the portions of `SKILL.md` adapted from upstream's `SKILL.md` and the rule data in `references/legacy-patterns.md` extracted from upstream's `legacy-scan.mjs`, which is software code under the Apache License 2.0. It holds upstream's `LICENSE` file unchanged under a notice; the Git and npm copies are identical. Upstream names no copyright holder in that file.

Each modified guide states the change in an HTML comment under its title, with a pointer to this file, as CC-BY 4.0 section 3(a)(1)(B) requires. `SKILL.md` and `references/legacy-patterns.md` each carry an HTML comment under their title stating that they are adapted, as Apache License 2.0 section 4(b) requires. No endorsement by GoogleChrome is implied.

## Sync

From `packages/opencode-hive`:

```sh
bun scripts/sync-modern-web-guidance.ts \
  --git-dir <checkout of GoogleChrome/modern-web-guidance> \
  --npm-tarball <path to modern-web-guidance-1.0.0.tgz>
```

Add `--check` to compare the committed tree with a fresh render without writing; it exits nonzero on any difference, stale file, or validation failure. The script:

1. Resolves `HEAD` (or `--commit`) in the checkout and requires the pinned commit, then checks the tarball's SHA-1, SHA-256, and SHA-512 against the pinned values and its `package.json` name and version. Guide text is read from the Git objects at that commit, so local edits in the checkout do not leak in.
2. Drops `built-in-ai/prompt-api.md` after confirming that it is byte-identical to `built-in-ai/language-model.md`, that `guides.json` does not list it, and that no guide references it. It then requires the remaining 208 guide files to match the `{ category, id }` pairs in `guides.json` one to one, with every `id` unique across categories.
3. Rewrites every retrieve reference (197 in 64 guides at this release), then fails if any `npx`, `pnpx`, `modern-web-guidance@`, or `retrieve "` text remains anywhere in a guide.
4. Inlines the feature-gate cautions and the per-file modification notice and generates the 17 category indexes.
5. Parses `legacy-scan.mjs` into a syntax tree without running it and collects every object literal whose `verifierRubric` is an object literal. Each must have string `id`, `guideId`, and `summary` values and string-array `keepWhen` and `dropWhen` lists. The script requires at least 35 rules (exactly 35 at the pinned release), unique rule IDs, and a `guideId` that `guides.json` lists. It inserts a space between two adjacent opening braces and between two adjacent closing braces, so that JSX such as `dangerouslySetInnerHTML={ { __html: ... } }` keeps its meaning without reading as a template placeholder, and renders `references/legacy-patterns.md` sorted by guide category, guide ID, and rule ID.
6. Validates the whole tree as it will stand after the sync. Link targets come from a CommonMark parse (`Bun.markdown.render`), which handles reference links whose definitions span lines and ends a list-item or blockquote fence with its container. The scan also reads links and `href`/`src` attributes inside HTML blocks, and every reference definition outside code, including definitions no link uses. A code fence or HTML block still open at the end of a file fails, because it would hide the links after it; a sentinel link on the line after the file's last line detects this, with no blank line between them, so an unclosed `<div>` block also fails. Every relative link and image target resolves to a file inside this skill that the sync keeps (a link to a stale generated file the sync would remove fails before anything is written), and no shipped Markdown file other than this one contains CLI invocations, host runtime names, host tool-call syntax, template placeholders, or backslash-escaped backticks.
7. Writes only files whose content changed and removes stale `.md` files under `guides/` and `references/index/` and a stale `references/legacy-patterns.md`. `SKILL.md`, `UPSTREAM.md`, and both license files are hand-maintained and never written.

To vendor a newer release, run with `--allow-unpinned` against the new tag and tarball, review the diff and the reported counts, then update the pinned constants at the top of the script, this file, and `SKILL.md` where the release changed what they describe.

## Vendored files

- `guides/<category>/<id>.md`: the 208 guides listed in `guides.json`, across 17 categories. 129 are byte-identical to upstream; the other 79 carry the changes below.
- `references/index/<category>.md`: one generated index per category, sorted by guide ID. Each entry gives the guide link, its line count (with a reading hint above 350 lines), an `[origin-trial]` or `[volatile]` tag where applicable, the upstream description verbatim, and up to 16 search keywords. The keywords are `featuresUsed` first, then platform symbols taken from the guide's inline code spans and headings (CSS properties, selectors, at-rules and functions, HTML elements and keyword-valued attributes, DOM and JavaScript APIs, HTTP headers), ranked by kind, heading use, and frequency, with author identifiers and symbols already in the description left out. Upstream's descriptions omit many of these symbols: `overscroll-behavior` appears only inside the dialog guides and `scheduler.yield()` only inside `break-up-long-tasks`.
- `references/legacy-patterns.md`: the 35 `legacy-scan.mjs` rules, covering 33 guides, grouped by guide category. Each rule gives its ID, a link to its guide, upstream's summary, and the `keepWhen` and `dropWhen` rubric entries verbatim apart from the brace spacing above, under the labels "Flag and modernize when" and "Skip / keep as-is when". The file opens with an Apache-2.0 modification notice and a short explanation of how to apply the rubrics. Workflow 2 in `SKILL.md` uses it as its first pass.
- `SKILL.md`: written for this package (see below).
- `LICENSE.apache-2.0`, `LICENSE.cc-by-4.0`, and this file.

## Changes to the guides

- **Cross-guide references.** Upstream points from one guide to another with an inline CLI command, in the form `` `guide-id` (via `npx -y modern-web-guidance@latest retrieve "guide-id"`) ``. Each is now a Markdown link labelled with the guide ID in code style, targeting `./guide-id.md` within a category or `../category/guide-id.md` across categories. Every reference at this release named a single guide; the script also accepts a comma-separated list and emits one link per ID.
- **Feature-gate cautions.** Upstream's CLI refuses to return Origin Trial and volatile-feature guides unless the user opted in through `.mwgrc`. Files have no such gate, so each of the 18 gated guides now opens with a GitHub `[!CAUTION]` admonition under its title. An Origin Trial caution names the trial feature IDs and their chromestatus URLs; a volatile caution names the feature IDs and upstream's reason (`built-in-ai` or `recent-single-engine`). Both follow upstream's CLI precedence: when `.mwgrc` sets `"allowOriginTrials": false` or `"allowVolatileFeatures": false`, the project has opted out and the agent does not adopt the API even when the user named it. Otherwise the agent adopts it only when `.mwgrc` sets the matching key to `true` or the user explicitly requested the API by name; when neither holds, the agent implements a standard cross-browser solution.
- **Modification notice.** Each changed guide has one HTML comment after its title naming the release and the changes, for example `<!-- Adapted from GoogleChrome/modern-web-guidance v1.0.0 (CC-BY 4.0): CLI retrieve references converted to relative links; see ../../UPSTREAM.md -->`. Blank lines between the title and the first paragraph are normalized to one where the notice is inserted.

Guide prose, examples, fallback snippets, and compatibility data are otherwise unchanged. Some fallback snippets load polyfills from unpinned CDN URLs and `language-model.md` suggests an artificial response delay; `SKILL.md` addresses both rather than editing upstream text.

## Changes in `SKILL.md`

Upstream's `SKILL.md` drives the CLI. This one is rewritten for local files and keeps upstream's normative force: consult the guides before writing web UI or client-side code instead of relying on obsolete patterns from training data, apply each guide's required fallbacks, and verify compliance before finishing. It adapts upstream's trigger and exclusion scope, its search, retrieve, and compliance steps, its codebase modernization flow, its framework adaptation rules (including the polyfill-loading rule), and its interpretation of Baseline status, fallbacks, and custom browser-support policies. An HTML comment under its title states that it is adapted, as Apache License 2.0 section 4(b) requires for modified files.

- Replaced: the `search` and `retrieve` commands, `npx` and `pnpx` runner instructions, sandbox and network setup, and the temporary-file handling for large output. Lookup is now a grep over `references/index/` and selective reads, with a category table. Upstream's query advice carries over: translate intent into the implied UI primitive, search each capability separately, rephrase once with a concrete component noun, and read no unrelated guide when none matches.
- Replaced: the `legacy-scan` modernization flow. Upstream runs the scanner, verifies each finding against its `keepWhen` and `dropWhen` rubric, reports, modernizes, and rescans. Workflow 2 keeps those steps with the extracted rubrics in `references/legacy-patterns.md` as Pass 1 and searches the code for each pattern instead of running the scanner. It adds Pass 2, a seven-axis sweep across UX and form factor, HTML semantics and overlays, CSS architecture and dark mode, forms, motion, accessibility and Core Web Vitals, and security and privacy, because the rules cover only about 20% of the catalog. It also adds an orientation step that pairs the skill with `stop-design-slop` for visual composition when that skill is available.
- Replaced: the "MANDATORY: execute first" framing, with an authority section that names the legacy patterns training data reproduces and requires reading the matching guides before designing, implementing, auditing, or refactoring. Operator instructions, `AGENTS.md`, and `.mwgrc` govern project policy, and within them the guides set the bar for vanilla and framework code.
- Removed: the required `### Modern Web Guidance` disclosure section with verbatim quotes.
- Changed: upstream suggests documenting a browser-support policy in the project's instruction files. This skill keeps the suggestion and edits `AGENTS.md` only when asked.
- Added: a rule that scoped feature work and PR reviews enforce the guides on touched code without demanding repository-wide rewrites of an established accessible component system, while an explicit audit or modernization task evaluates its whole scope; a boundary that keeps the caller's role and output format; supply-chain rules for CDN fallbacks and polyfills; an override of the artificial response delay that `language-model.md` suggests; the `.mwgrc` `baseline` values; and the 30-month reading of "Baseline since" dates.
- The description is one line and names no CLI. Generated guides, indexes, `references/legacy-patterns.md`, and `SKILL.md` contain no host runtime names or host tool syntax, so downstream packaging that copies non-attribution Markdown to other agent hosts can ship them unchanged.

## Not vendored

- The CLI and search runtime: `modern-web.mjs`, `search.mjs` and its source map, `watchdog/`, `skill-version.txt`, the skill's `package.json`, and the embedding and vocabulary files in `gen/` (`guide-chunks.*`, `query-words.*`). Local files and grep replace them, and nothing here runs upstream code. The CLI also sends usage telemetry, which upstream's README documents; the vendored files make no network requests.
- The code of `legacy-scan.mjs`: its matchers, scanner, and bundled dependencies. Only the rule data described above is extracted.
- `THIRD_PARTY_NOTICES`: it lists the npm dependencies bundled into the CLI JavaScript (for example `@ts-morph/common`, `css-select`, `domhandler`). None of that code is vendored, and the extracted rule strings are upstream's own rule definitions, so the notices do not pertain.
- `built-in-ai/prompt-api.md`: a byte-identical duplicate of `language-model.md` that `guides.json` does not list and no guide references.
- The `chrome-extensions` skill in the same release: deferred by operator decision.
- Plugin and marketplace manifests (`plugin.json`, `gemini-extension.json`, `kimi.plugin.json`, the `.claude-plugin`, `.codex-plugin`, `.cursor-plugin`, `.grok-plugin`, `.agents`, and `.github/plugin` files), `policies/`, `assets/`, `.github/img/`, `README.md`, and `CONTRIBUTING.md`.
