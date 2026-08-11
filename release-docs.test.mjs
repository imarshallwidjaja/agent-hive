import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const workspaceRoot = path.resolve(import.meta.dirname);

function readText(relativePath) {
  return fs.readFileSync(path.join(workspaceRoot, relativePath), 'utf8');
}

function normalizeWhitespace(value) {
  return value.replace(/\s+/g, ' ').trim();
}

describe('current documentation contract', () => {
  it('keeps philosophy focused on current references', () => {
    const philosophy = readText('PHILOSOPHY.md');

    assert.doesNotMatch(philosophy, /### v1\.3\.6/i);
    assert.match(philosophy, /\[Operator Guide\]/i);
    assert.match(philosophy, /\[Plugin README\]/i);
  });

  it('documents safe installation into an existing OpenCode config', () => {
    const rootReadme = readText('README.md');
    const gettingStarted = readText('docs/GETTING-STARTED.md');
    const pluginReadme = readText('packages/opencode-hive/README.md');
    const hiveSkill = readText('packages/hive-core/templates/skills/hive.md');

    for (const doc of [rootReadme, gettingStarted, pluginReadme]) {
      assert.match(doc, /append.*oc-arkive@latest/is);
      assert.match(doc, /plugin`?\s+array/i);
      assert.match(doc, /preserve.*unrelated settings/i);
    }

    assert.match(pluginReadme, /reserved.*legacy.*current.*agent.*command/is);
    assert.match(pluginReadme, /disableMcps.*same-name MCP/i);
    assert.match(pluginReadme, /subagent_depth/i);
    assert.match(pluginReadme, /skills\.paths/i);
    assert.match(pluginReadme, /experimental\.primary_tools/i);
    assert.match(pluginReadme, /`simplicity-reviewer`[^.\n]*supported `customAgents` base/i);
    assert.doesNotMatch(pluginReadme, /`simplicity-reviewer`[^.\n]*not a custom-agent base/i);
    assert.match(pluginReadme, /\| `ast_grep` \| Structural search and AST inspection/i);
    assert.doesNotMatch(pluginReadme, /\| `ast_grep` \| .*search and replace/i);
    for (const doc of [rootReadme, gettingStarted]) {
      assert.match(doc, /existing-plugin@version[\s\S]*oc-arkive@latest/i);
      assert.match(doc, /placeholder/i);
    }
    for (const agent of [
      'hive-master',
      'architect-planner',
      'swarm-orchestrator',
      'scout-researcher',
      'forager-worker',
      'hive-builder',
      'hive-helper',
      'plan-reviewer',
      'code-reviewer',
      'simplicity-reviewer',
      'approach-advisor',
      'vulnerability-reviewer',
    ]) {
      assert.match(hiveSkill, new RegExp('`' + agent + '`'));
    }
    assert.doesNotMatch(hiveSkill, /@(?:architect|swarm|scout|forager)\b/);
    assert.match(gettingStarted, /dedicated mode.*hive-builder/is);
    assert.match(gettingStarted, /architect-planner.*(?:does not|not).*ad-?hoc/is);
  });

  it('keeps cadence, compatibility, and blocked-worker recovery docs aligned with runtime contracts', () => {
    const cadence = readText('packages/opencode-hive/docs/HOOK_CADENCE.md');
    const pluginReadme = readText('packages/opencode-hive/README.md');
    const hiveSkill = readText('packages/hive-core/templates/skills/hive.md');
    const schema = JSON.parse(readText('packages/opencode-hive/schema/agent_hive.schema.json'));
    const hookCadenceSchema = schema.properties.hook_cadence;
    const hookCadenceDescription = normalizeWhitespace(hookCadenceSchema.description);
    const hookValueDescription = normalizeWhitespace(hookCadenceSchema.additionalProperties.description);

    assert.match(cadence, /production.*cadence.*`tool\.execute\.before`/is);
    for (const unsupportedHook of [
      'chat.message',
      'experimental.chat.system.transform',
      'experimental.chat.messages.transform',
    ]) {
      assert.doesNotMatch(cadence, new RegExp(`\\b${unsupportedHook.replaceAll('.', '\\.?')}\\b`));
    }
    assert.match(hookCadenceDescription, /production.*gates only `?tool\.execute\.before`?/i);
    assert.match(hookCadenceDescription, /forced to cadence 1/i);
    assert.match(hookCadenceDescription, /other hook keys have no runtime effect/i);
    assert.match(hookValueDescription, /ignored for hooks that do not invoke the production cadence gate/i);
    assert.deepEqual(hookCadenceSchema.examples, [{ 'tool.execute.before': 1 }]);

    assert.match(pluginReadme, /- `command`:[\s\S]*same-key.*user command definitions.*unrelated command keys remain/i);
    assert.match(pluginReadme, /- `agent`:[\s\S]*reserved legacy\/current agent IDs.*unrelated agent IDs remain/i);
    assert.match(pluginReadme, /- `mcp`:[\s\S]*enabled built-in MCP IDs.*same-ID definitions.*unrelated IDs remain.*disableMcps.*prevents.*registered/i);

    assert.doesNotMatch(hiveSkill, /\boracle\b/i);
    assert.match(hiveSkill, /blocked task.*existing worktree.*fresh worker session/is);
  });

  it('updates design docs for the shipped #67 and #69 behavior', () => {
    const design = readText('docs/DESIGN.md');

    assert.match(design, /worker-prompt\.md/i);
    assert.match(design, /do not merge/i);
    assert.match(design, /do not start the next task/i);
    assert.match(design, /manual task/i);
    assert.match(design, /dependsOn/i);
    assert.match(design, /refreshPending/i);
  });

  it('updates plugin docs for bounded worker replay and DAG-aware manual tasks', () => {
    const pluginReadme = readText('packages/opencode-hive/README.md');
    const toolDocs = readText('packages/opencode-hive/docs/HIVE-TOOLS.md');

    assert.match(pluginReadme, /refreshPending/i);
    assert.match(pluginReadme, /manual task/i);

    assert.match(toolDocs, /refreshPending/i);
    assert.match(toolDocs, /manual task/i);
    assert.match(toolDocs, /dependsOn/i);
  });

  it('documents conversational vulnerability-review scope with deterministic flag overrides', () => {
    const rootReadme = readText('README.md');
    const pluginReadme = readText('packages/opencode-hive/README.md');

    assert.match(rootReadme, /\/vuln-review/);
    for (const example of [
      '/vuln-review',
      '/vuln-review --repo api --path src/auth',
      '/vuln-review --range main...HEAD',
      '/vuln-review --base main --target HEAD',
      '/vuln-review --task 03-implement-auth',
      '/vuln-review --feature authentication',
      '/vuln-review --whole-repo',
      '/vuln-review --compare approved/prior-review.md',
      '/vuln-review review the authentication boundary changed in this branch',
      '/vuln-review review authentication --repo api --path src/auth',
    ]) {
      assert.ok(pluginReadme.includes(`\`${example}\``), `missing documented example: ${example}`);
    }

    assert.match(pluginReadme, /legal combinations/i);
    for (const row of [
      '| Current change | No dedicated mode flag; available only when inferred and accepted | Repeatable `--repo <id>`, repeatable `--path <relative-path>`, one `--compare <local-prior-report.md>` |',
      '| Git range | One `--range <base>...<target>` | Repeatable `--repo`, repeatable `--path`, one `--compare` |',
      '| Git refs | One `--base <ref>` | Optional `--target <ref>`, repeatable `--repo`, repeatable `--path`, one `--compare` |',
      '| Hive task | One `--task <task-folder>` | Repeatable `--repo`, repeatable `--path`, one `--compare` |',
      '| Hive feature | One `--feature <feature-name>` | Repeatable `--repo`, repeatable `--path`, one `--compare` |',
      '| Whole repository | `--whole-repo` | Repeatable `--repo`, one `--compare`; `--path` is not allowed |',
    ]) {
      assert.ok(pluginReadme.includes(row), `missing legal-combination row: ${row}`);
    }
    assert.match(pluginReadme, /free text/i);
    assert.match(pluginReadme, /without arguments|no arguments/i);
    assert.doesNotMatch(pluginReadme, /Current change:\s*`\/vuln-review`/i);
    assert.match(pluginReadme, /current change.*inferred and accepted.*not a parser default/is);
    assert.match(pluginReadme, /deterministic fixed overrides/i);
    assert.match(pluginReadme, /exact `scopeEcho`|exact scope echo/i);
    assert.match(pluginReadme, /at most one clarification question/i);
    assert.match(pluginReadme, /BOUNDED.*NEEDS_CLARIFICATION.*STOP/is);
    assert.match(pluginReadme, /stored.*AcceptedCandidate.*materialize/is);
    assert.match(pluginReadme, /PR numbers.*URLs.*inert intent.*--pr.*unsupported/is);
    assert.match(pluginReadme, /local.*--base.*--target.*refs/is);
  });

  it('documents the pinned Stage 1 lifecycle and private comparison capability', () => {
    const pluginReadme = readText('packages/opencode-hive/README.md');
    const toolDocs = readText('packages/opencode-hive/docs/HIVE-TOOLS.md');

    assert.match(pluginReadme, /--compare.*parser-normalized.*project-relative regular file.*current invocation/is);
    assert.match(pluginReadme, /vulnerability-only preview normalization/i);
    assert.match(pluginReadme, /strict.*descriptor.*fingerprint.*equal/is);
    assert.match(pluginReadme, /not a public `excludePaths` option/i);
    assert.doesNotMatch(pluginReadme, /`--exclude(?:-paths)?`/i);

    assert.match(toolDocs, /hive_vulnerability_compare_report_read/);
    assert.match(toolDocs, /accepts no path or token|accepts neither a path nor a token/i);
    assert.match(toolDocs, /child chat metadata.*agent identity.*tool context/is);
    assert.match(toolDocs, /one-use/i);
    for (const revocation of ['replacement', 'later task', 'error', 'idle', 'deletion', 'read failure', 'restart']) {
      assert.match(toolDocs, new RegExp(revocation, 'i'));
    }

    assert.match(toolDocs, /session\.get.*ID.*parent.*time.*no agent/is);
    assert.match(toolDocs, /pre-execution agent lookup failure.*session\.error.*throws.*no after-hook/is);
    assert.match(toolDocs, /caught executor failure.*tool\.execute\.after.*undefined.*task error state/is);
    assert.match(toolDocs, /revokes the exact matching reservation without parsing output/i);
    assert.match(toolDocs, /resolve cannot create/i);
    assert.match(toolDocs, /fresh materialize call.*exact-match.*stored.*AcceptedCandidate.*consume.*create authority/is);
    assert.match(toolDocs, /second ambiguity.*malformed packet.*drift.*cleanup uncertainty.*before claim/is);
  });

  it('documents vulnerability-review safety, retention, and report semantics', () => {
    const pluginReadme = readText('packages/opencode-hive/README.md');

    assert.match(pluginReadme, /authorized use/i);
    assert.match(pluginReadme, /no active exploitation|must not perform active exploitation/i);
    assert.match(pluginReadme, /no network scanning|must not scan networks/i);
    assert.match(pluginReadme, /no shell|shell.*prohibited/i);
    assert.match(pluginReadme, /no source edits|must not edit source/i);
    assert.doesNotMatch(pluginReadme, /\bno file creation\b/i);
    assert.match(pluginReadme, /no product-source.*report.*SARIF.*remediation.*Hive feature\/task files.*created/is);
    assert.match(pluginReadme, /Frame.*create\w*.*disposable frozen workspace.*persisted lease metadata.*lifecycle safety/is);
    assert.match(pluginReadme, /no (?:automatic |auto-?)?fix|does not fix/i);
    assert.match(pluginReadme, /no report file.*SARIF|neither a report file nor SARIF/is);
    assert.match(pluginReadme, /OpenCode session history/i);
    assert.match(pluginReadme, /session retention.*access controls/is);
    assert.match(pluginReadme, /manually export.*approved location/is);

    for (const state of ['CONFIRMED_FINDINGS', 'NO_CONFIRMED_FINDINGS_IN_REVIEWED_SCOPE', 'INCOMPLETE']) {
      assert.match(pluginReadme, new RegExp(state));
    }
    for (const classification of ['new', 'unchanged', 'resolved', 'stale', 'comparison skipped']) {
      assert.match(pluginReadme, new RegExp(`\\b${classification}\\b`, 'i'));
    }

    for (const lens of [
      '`trust-and-identity`: authentication, authorization, tenant/object isolation, session, and privilege boundaries.',
      '`untrusted-data`: parsing, injection, deserialization, path, process, template, and database boundaries.',
      '`secrets-and-platform`: cryptography, secrets/configuration, dependencies, CI/IaC, cloud, and container exposure.',
      '`stateful-abuse`: replay, races/TOCTOU, workflow bypass, business logic, and state-transition invariants.',
    ]) {
      assert.ok(pluginReadme.includes(lens), `missing built-in lens contract: ${lens}`);
    }

    assert.match(pluginReadme, /manifest repository ID.*POSIX-normalized repository-relative (?:primary )?path.*trimmed case-preserving symbol(?: or |-or-)boundary.*lowercase ASCII missing-control slug/is);
    assert.match(pluginReadme, /each non-`?\[a-z0-9\]`? run.*one hyphen.*edge hyphens.*removed/is);
  });

  it('documents the vulnerability-review tool and review-workspace runtime boundaries', () => {
    const pluginReadme = readText('packages/opencode-hive/README.md');
    const toolDocs = readText('packages/opencode-hive/docs/HIVE-TOOLS.md');

    assert.match(pluginReadme, /read.*glob.*grep/is);
    assert.match(pluginReadme, /optional MCP.*coverage gap/is);
    assert.match(pluginReadme, /zero new scanner dependenc|no new scanner dependenc/i);
    assert.match(pluginReadme, /customAgents.*vulnerability-reviewer/is);
    assert.match(pluginReadme, /fixed falsifier/i);

    for (const tool of [
      'hive_review_workspace_create',
      'hive_review_workspace_claim',
      'hive_review_workspace_inspect',
      'hive_review_workspace_cleanup',
    ]) {
      assert.match(toolDocs, new RegExp(tool));
    }
    assert.match(toolDocs, /runtime gate|runtime-gated/i);
    assert.match(toolDocs, /not an OS sandbox|does not provide an OS sandbox/i);
  });

  it('keeps release guidance aligned with the manual workflow_dispatch flow', () => {
    const releasing = readText('docs/RELEASING.md');
    const agents = readText('AGENTS.md');

    assert.doesNotMatch(releasing, /release:prepare/);
    assert.match(releasing, /manual/i);
    assert.match(releasing, /workflow_dispatch/i);

    assert.doesNotMatch(agents, /bun run release:prepare/);
    assert.match(agents, /release:check/);
  });
});
