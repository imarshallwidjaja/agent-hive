import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adaptGuide, extractKeywords, extractLegacyRules, fencedLines, gateBanner, linkTargets, readTarFiles, writeSync } from './sync-modern-web-guidance.js';
import type { GuideMeta } from './sync-modern-web-guidance.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A skill directory with hand-authored files, one current guide, and a guide, an index, and a legacy-pattern file the next render drops. */
function skillDir(skillMd: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mwg-sync-'));
  tempDirs.push(root);
  const files: Record<string, string> = {
    'SKILL.md': skillMd,
    'UPSTREAM.md': '# Upstream\n',
    'LICENSE.apache-2.0': 'Apache\n',
    'LICENSE.cc-by-4.0': 'CC-BY\n',
    'guides/css/current.md': '# Current\n\nOld body.\n',
    'guides/css/old.md': '# Old\n',
    'references/index/old.md': '# Old index\n',
    'references/legacy-patterns.md': '# Legacy Web Patterns and Verification Rubrics\n',
  };
  for (const [relative, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    writeFileSync(path.join(root, relative), text);
  }
  return root;
}

function snapshot(root: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const relative of readdirSync(root, { recursive: true, encoding: 'utf8' }).sort()) {
    const file = path.join(root, relative);
    files.set(relative, statSync(file).isDirectory() ? '<dir>' : readFileSync(file, 'utf8'));
  }
  return files;
}

const render = new Map([
  ['guides/css/current.md', '# Current\n\nNew body.\n'],
  ['references/index/css.md', '# css guides\n\n- [`current`](../../guides/css/current.md)\n'],
]);

describe('writeSync stale targets', () => {
  const staleTarget = /does not resolve after the sync removes its stale target/;
  for (const [label, link, error] of [
    ['inline link', '[x](references/index/old.md)', staleTarget],
    ['reference link', '[the guide][old]\n\n[old]: guides/css/old.md', staleTarget],
    ['reference link whose definition spans lines', '[the guide][old]\n\n[old]:\n  guides/css/old.md', staleTarget],
    ['reference definition no link uses', '[old]: guides/css/old.md', staleTarget],
    ['reference definition no link uses, split across lines', '[old]:\n  guides/css/old.md', staleTarget],
    ['reference definition no link uses, inside a list item', '- [old]: guides/css/old.md', staleTarget],
    ['reference definition whose label contains a caret', '[old^ref]: guides/css/old.md', staleTarget],
    ['duplicate reference definition shadowed by an earlier one', '[dup]: guides/css/current.md\n\n[dup]: guides/css/old.md', staleTarget],
    ['href with a character reference inside a closed <div> HTML block', '<div><a href="guides/css/old&#46;md">stale</a></div>\n', staleTarget],
    ['link inside a closed <div> HTML block', '<div>\n[old](guides/css/old.md)\n</div>\n\nProse after the block.', staleTarget],
    ['spaced uppercase HREF attribute inside a closed <div> HTML block', '<div>\n  <A HREF = "guides/css/old.md">old</A>\n</div>\n', staleTarget],
    ['link inside a <div> HTML block left open at the end of the file', '<div>\n[old](guides/css/old.md)', /SKILL\.md ends inside an open code fence or HTML block/],
    ['link written without indentation right after a list-item code block', '- ```md\n  example\n\n[old](guides/css/old.md)\n\n```md\nanother\n```', staleTarget],
  ] as const) {
    it(`rejects a ${label} to a stale generated file before writing anything`, () => {
      const root = skillDir(`# Skill\n\nSee the index.\n\n${link}\n`);
      const before = snapshot(root);

      expect(() => writeSync(render, root)).toThrow(error);
      expect(snapshot(root)).toEqual(before);
    });
  }

  it('ignores a reference definition inside an indented code block', () => {
    const root = skillDir('# Skill\n\nSee [the css index](references/index/css.md).\n\nParagraph:\n\n    [old]: guides/css/missing.md\n');

    expect(() => writeSync(render, root)).not.toThrow();
    expect(readFileSync(path.join(root, 'guides/css/current.md'), 'utf8')).toBe('# Current\n\nNew body.\n');
  });

  it('decodes a character reference in an href and accepts the existing file it names', () => {
    const root = skillDir('# Skill\n\n<div><a href="guides/css/current&#46;md#1-foundations">ok</a></div>\n\n');

    expect(() => writeSync(render, root)).not.toThrow();
    expect(readFileSync(path.join(root, 'guides/css/current.md'), 'utf8')).toBe('# Current\n\nNew body.\n');
  });

  it('removes stale generated files and writes changes when nothing links to them', () => {
    const root = skillDir('# Skill\n\nSee [the css index](references/index/css.md).\n');

    const plan = writeSync(render, root);

    expect(plan.stale.sort()).toEqual(['guides/css/old.md', 'references/index/old.md', 'references/legacy-patterns.md']);
    expect(existsSync(path.join(root, 'guides/css/old.md'))).toBe(false);
    expect(existsSync(path.join(root, 'references/index/old.md'))).toBe(false);
    expect(existsSync(path.join(root, 'references/legacy-patterns.md'))).toBe(false);
    expect(readFileSync(path.join(root, 'guides/css/current.md'), 'utf8')).toBe('# Current\n\nNew body.\n');
  });
});

describe('linkTargets fence containers', () => {
  it('ignores links in a list-item fence and checks the link after it closes', () => {
    const text = ['- ```md', '  [a](in-list.md)', '  ```', '[b](after-list.md)'].join('\n');
    expect(linkTargets(text, 'list.md')).toEqual(['after-list.md']);
  });

  it('ends a blockquote fence where the blockquote ends', () => {
    const text = ['> ```md', '> [c](in-quote.md)', '> [d]: in-quote-def.md', 'Plain [e](after-quote.md) and [f][].', '', '[f]: <after-def.md>'].join('\n');
    expect(linkTargets(text, 'quote.md')).toEqual(['after-quote.md', 'after-def.md']);
  });

  it('keeps a top-level fence open across a literal list-marker fence line inside it', () => {
    const text = ['```md', '- ```', '[x](inside-code.md)', '[x]: inside-code-def.md', '```', '', '[y](after-code.md)', '', '[z]: unused-after-code.md'].join('\n');
    expect(linkTargets(text, 'nested.md')).toEqual(['after-code.md', 'unused-after-code.md']);
  });

  it('ends a list-item fence at unindented prose and reads definitions after it', () => {
    const text = ['- ```md', '  [a]: in-list-def.md', '', 'Prose [b](after-list.md).', '', '[c]: unused-after-list.md'].join('\n');
    expect(linkTargets(text, 'list.md')).toEqual(['after-list.md', 'unused-after-list.md']);
  });

  it('accepts a <div> HTML block that a trailing blank line closes at the end of the file', () => {
    expect(linkTargets('<div>\nPlain text\n</div>\n\n', 'closed.md')).toEqual([]);
  });

  for (const [label, opener] of [
    ['fenced code block', '```js'],
    ['raw HTML block', '<textarea>'],
  ]) {
    it(`rejects a ${label} still open at the end of the file, naming the file`, () => {
      const text = ['# Title', '', opener, 'code', '[g](broken.md)'].join('\n');
      expect(() => linkTargets(text, 'guides/css/unclosed.md')).toThrow('guides/css/unclosed.md ends inside an open code fence or HTML block');
    });
  }
});

describe('legacy-scan rule extraction', () => {
  const rule = (id: string, guideId: string, keepWhen: string, dropWhen: string) =>
    `{id:"${id}",guideId:"${guideId}",guideHash:h,summary:'Summary of ${id}.',matcher:m,verifierRubric:{keepWhen:["${keepWhen}"],dropWhen:[${dropWhen}]}}`;
  const bundle = [
    `var a=${rule('dialog', 'dialog', 'A click listener closes the <dialog>.', '"The dialog is already declarative."')};`,
    `var b=${rule('sanitize/js-innerhtml', 'sanitize-untrusted-html', 'Assigns element.innerHTML.', '"JSX using dangerouslySetInnerHTML={{ __html: x }} in React."')};`,
    // The scanner forwards a rule's rubric into each result; that object is not a rule.
    'function r(Y){return{ruleId:Y.id,...Y.verifierRubric?{verifierRubric:Y.verifierRubric}:{}}}',
  ].join('\n');

  it('collects rule literals in source order without the forwarded rubric, spacing doubled braces', () => {
    expect(extractLegacyRules(bundle)).toEqual([
      { id: 'dialog', guideId: 'dialog', summary: 'Summary of dialog.', keepWhen: ['A click listener closes the <dialog>.'], dropWhen: ['The dialog is already declarative.'] },
      {
        id: 'sanitize/js-innerhtml',
        guideId: 'sanitize-untrusted-html',
        summary: 'Summary of sanitize/js-innerhtml.',
        keepWhen: ['Assigns element.innerHTML.'],
        dropWhen: ['JSX using dangerouslySetInnerHTML={ { __html: x } } in React.'],
      },
    ]);
  });

  it('rejects a rule whose rubric entry is computed rather than a string literal', () => {
    expect(() => extractLegacyRules(`var a=${rule('dialog', 'dialog', 'Flag it.', 'skipWhen')};`)).toThrow('rule dialog verifierRubric.dropWhen has an entry that is not a nonempty string literal');
  });

  it('ships all 35 pinned rules in references/legacy-patterns.md with resolving guide links', () => {
    const skill = path.resolve(import.meta.dir, '../skills/modern-web-guidance');
    const text = readFileSync(path.join(skill, 'references/legacy-patterns.md'), 'utf8');
    const ruleIds = [...text.matchAll(/^### `([^`]+)`$/gm)].map((match) => match[1]);
    const guideLinks = [...text.matchAll(/^Guide: \[`[^`]+`\]\(([^)]+)\)$/gm)].map((match) => match[1]);

    expect(ruleIds).toHaveLength(35);
    expect(new Set(ruleIds).size).toBe(35);
    expect(guideLinks).toHaveLength(35);
    for (const link of guideLinks) expect(existsSync(path.join(skill, 'references', link)), link).toBe(true);
    expect(text).toContain('dangerouslySetInnerHTML={ { __html: ... } }');
    expect(text).not.toMatch(/\{\{|@@|%HOST%/);
  });

  it('states that a dropWhen match dismisses only that rule match, using a real autofill-payment-form conflict', () => {
    const text = readFileSync(path.resolve(import.meta.dir, '../skills/modern-web-guidance/references/legacy-patterns.md'), 'utf8');
    const preamble = text.slice(0, text.indexOf('\n## '));
    const rule = text.slice(text.indexOf('### `autofill-payment-form`'), text.indexOf('### `autofill-sign-in-form`'));

    expect(preamble).toContain('Dismissing one rule match does not suppress an independent defect on the same element');
    expect(preamble).toContain('`autocomplete="cc-number"` skips the missing-autofill check, while `type="number"` on that card field still violates `autofill-payment-form`');
    expect(preamble).not.toContain('When any of them applies, the code stays unchanged');
    // The example holds only while the rule both drops a valid cc-* token and flags type="number".
    expect(rule).toContain('- The input already provides a valid payment autocomplete token (such as "cc-number"');
    expect(rule).toContain('- The card number uses type="number"');
  });
});

describe('adaptGuide fence containers', () => {
  const meta = (id: string): GuideMeta => ({ id, category: 'css', description: `${id}.`, featuresUsed: [], originTrials: [], volatileFeatures: [] });
  const byId = new Map([['guide', meta('guide')], ['other', meta('other')]]);
  const cli = (id: string) => `\`${id}\` (via \`npx -y modern-web-guidance@latest retrieve "${id}"\`)`;

  it('keeps a top-level fence open across a literal `- ```` line and converts the reference after it', () => {
    const inCode = `See ${cli('other')} inside the example.`;
    const source = ['# Guide', '', '```md', '- ```', inCode, '```', '', `Read ${cli('other')}.`, ''].join('\n');

    const adapted = adaptGuide('css/guide.md', source, meta('guide'), byId, '1.0.0');

    expect(adapted.text).toContain(`\n${inCode}\n`);
    expect(adapted.text).toContain('Read [`other`](./other.md).');
    expect(adapted.references).toBe(1);
  });

  it('ends a list-item fence at unindented prose and converts the reference in that prose', () => {
    const inCode = `  ${cli('other')}`;
    const source = ['# Guide', '', '- ```md', inCode, '', `Unindented prose with ${cli('other')}.`, ''].join('\n');

    expect(fencedLines(source, 'css/guide.md')).toEqual([false, false, true, true, true, false, false]);
    const adapted = adaptGuide('css/guide.md', source, meta('guide'), byId, '1.0.0');

    expect(adapted.text).toContain(`\n${inCode}\n`);
    expect(adapted.text).toContain('Unindented prose with [`other`](./other.md).');
    expect(adapted.references).toBe(1);
  });

  it('treats a fence in a later block of a list item as code for references and keywords', () => {
    const inCode = `    See ${cli('other')} and \`fencedOnlyToken\``;
    const source = ['# Guide', '', '1.  Step one', '', '    ```md', inCode, '    ```', '', `After list: ${cli('other')} and \`proseToken\`.`, ''].join('\n');

    const adapted = adaptGuide('css/guide.md', source, meta('guide'), byId, '1.0.0');

    expect(adapted.text).toContain(`\n${inCode}\n`);
    expect(adapted.text).toContain('After list: [`other`](./other.md) and `proseToken`.');
    expect(adapted.references).toBe(1);
    const keywords = extractKeywords(adapted);
    expect(keywords).toContain('proseToken');
    expect(keywords).not.toContain('fencedOnlyToken');
  });

  it('expands a tab after a list marker to the next 4-column stop, so a 4-space fence stays in the item', () => {
    const inCode = `    See ${cli('other')} and \`fencedOnlyToken\``;
    const source = ['- \tItem', '', '    ```md', inCode, '    ```', '', `After list: \`proseToken\`.`, ''].join('\n');

    expect(fencedLines(source, 'css/guide.md')).toEqual([false, false, true, true, true, false, false, false]);
    const adapted = adaptGuide('css/guide.md', source, meta('guide'), byId, '1.0.0');

    expect(adapted.text).toContain(`\n${inCode}\n`);
    expect(adapted.references).toBe(0);
    const keywords = extractKeywords(adapted);
    expect(keywords).toContain('proseToken');
    expect(keywords).not.toContain('fencedOnlyToken');
  });

  it('treats a fence indented four columns past the list item content as an indented code block', () => {
    const source = ['- Item', '', '      ```md', '      text', ''].join('\n');
    expect(fencedLines(source, 'css/guide.md')).toEqual([false, false, false, false, false]);
  });
});

describe('readTarFiles', () => {
  it('rejects an entry whose declared size runs past the archive', () => {
    const header = Buffer.alloc(512);
    header.write('package/package.json', 0);
    header.write('00000001000\0', 124); // 512 bytes declared
    header.write('0', 156);
    const tar = Buffer.concat([header, Buffer.from('{"name":"x"}')]);

    expect(() => readTarFiles(tar, new Set(['package/package.json']))).toThrow('tar entry at offset 0 is truncated');
  });
});

describe('gateBanner', () => {
  const meta: GuideMeta = {
    id: 'example',
    category: 'css',
    description: 'Example.',
    featuresUsed: [],
    originTrials: [{ id: 'trial-api', chromestatus_url: 'https://chromestatus.com/feature/1' }],
    volatileFeatures: [{ id: 'volatile-api', reason: 'recent-single-engine' }],
  };

  it('orders the opt-out, the opt-in or named request, and the fallback for each gate', () => {
    const lines = gateBanner(meta);
    for (const key of ['allowOriginTrials', 'allowVolatileFeatures']) {
      expect(lines).toContain(
        `> When the project's \`.mwgrc\` sets \`"${key}": false\`, do not adopt this API. Otherwise adopt it only when \`.mwgrc\` sets \`"${key}": true\` or the user explicitly requested this API by name; when neither holds, implement a standard cross-browser solution.`,
      );
    }
  });
});
