import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { NATIVE_OBSERVATION_OWNERS } from 'hive-core';
import type { HostProfile } from '../runtime/host-profile.js';

/**
 * Packaged skills carry every host's wording as explicit sections, so a skill that a host discovers directly
 * from the package is still complete and readable. Materializing for one host keeps that host's sections and
 * removes the others:
 *
 *   <!-- hive-host opencode-v1 -->
 *   ...text for OpenCode v1...
 *   <!-- /hive-host -->
 *
 * Markers are recognised on their own line, including inside a code fence, so one example can change only the
 * lines that differ. A malformed marker is a packaging error, so it throws instead of shipping a skill that
 * mixes hosts.
 */

const OPEN_MARKER = /^<!-- hive-host ([a-z0-9-]+) -->\r?$/;
const CLOSE_MARKER = /^<!-- \/hive-host -->\r?$/;

export function renderHostMarkdown(content: string, host: HostProfile, label: string): string {
  const output: string[] = [];
  let block: { host: string; line: number } | undefined;
  let collapseBlank = false;

  const lines = content.split('\n');
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    const open = OPEN_MARKER.exec(line);
    if (open) {
      if (block) throw new Error(`${label}:${lineNumber}: host section opened inside the section from line ${block.line}`);
      if (!(NATIVE_OBSERVATION_OWNERS as readonly string[]).includes(open[1])) {
        throw new Error(`${label}:${lineNumber}: unknown host section "${open[1]}"`);
      }
      block = { host: open[1], line: lineNumber };
      continue;
    }
    if (CLOSE_MARKER.test(line)) {
      if (!block) throw new Error(`${label}:${lineNumber}: host section closed without an opening marker`);
      block = undefined;
      collapseBlank = true;
      continue;
    }

    if (block && block.host !== host.host) continue;
    // A removed section leaves its surrounding blank lines; keep one.
    if (collapseBlank && line.trim() === '' && output.length > 0 && output[output.length - 1]!.trim() === '') continue;
    if (line.trim() !== '') collapseBlank = false;
    output.push(line);
  }

  if (block) throw new Error(`${label}:${block.line}: host section "${block.host}" is never closed`);
  return output.join('\n');
}

/**
 * Renders every regular Markdown file under a staged skill directory in place. Symbolic links are neither
 * followed nor rewritten: a link keeps its target text, and nothing is written through it.
 */
export async function renderStagedHostMarkdown(stagedDir: string, host: HostProfile): Promise<void> {
  for (const entry of await fsp.readdir(stagedDir, { withFileTypes: true })) {
    const entryPath = path.join(stagedDir, entry.name);
    if (entry.isDirectory()) {
      await renderStagedHostMarkdown(entryPath, host);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      const original = await fsp.readFile(entryPath, 'utf8');
      const rendered = renderHostMarkdown(original, host, entryPath);
      if (rendered !== original) await fsp.writeFile(entryPath, rendered);
    }
  }
}
