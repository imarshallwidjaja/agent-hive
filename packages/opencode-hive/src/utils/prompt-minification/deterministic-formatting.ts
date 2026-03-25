function protectSpans(input: string): { text: string; restore: (text: string) => string } {
  const protectedValues: string[] = [];

  const stash = (value: string): string => {
    const index = protectedValues.push(value) - 1;
    return `__HIVE_PROMPT_MINIFY_PROTECTED_${index}__`;
  };

  let text = input.replace(/```[\s\S]*?```/g, stash);
  text = text.replace(/`[^`\n]+`/g, stash);

  const restore = (nextText: string): string => {
    return nextText.replace(/__HIVE_PROMPT_MINIFY_PROTECTED_(\d+)__/g, (_, index) => {
      const value = protectedValues[Number(index)];
      return value ?? '';
    });
  };

  return { text, restore };
}

function normalizeAssignmentDetailsTable(lines: string[]): string[] {
  const normalized: string[] = [];
  let inAssignmentDetails = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';

    if (/^##\s+Assignment Details\s*$/.test(line)) {
      inAssignmentDetails = true;
      normalized.push(line);
      continue;
    }

    if (inAssignmentDetails && /^##\s+/.test(line)) {
      inAssignmentDetails = false;
    }

    if (
      inAssignmentDetails
      && /^\|\s*Field\s*\|\s*Value\s*\|\s*$/.test(line)
      && /^\|\s*-+\s*\|\s*-+\s*\|\s*$/.test(lines[i + 1] ?? '')
    ) {
      const pairs: string[] = [];
      let j = i + 2;

      while (j < lines.length) {
        const row = lines[j] ?? '';
        const match = row.match(/^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$/);
        if (!match) {
          break;
        }

        const key = match[1].trim().toLowerCase().replace(/\s+/g, '-');
        const value = match[2].trim();
        pairs.push(`${key}:${value}`);
        j += 1;
      }

      normalized.push(...pairs);
      i = j - 1;
      continue;
    }

    normalized.push(line);
  }

  return normalized;
}

function normalizeUnprotectedText(text: string): string {
  const withoutTabs = text.replace(/\t/g, ' ');
  const withoutEmphasis = withoutTabs.replace(/\*\*(.*?)\*\*/g, '$1');
  const withoutTrailingSpaces = withoutEmphasis
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n');
  const collapsedNewlines = withoutTrailingSpaces.replace(/\n{3,}/g, '\n\n');

  return collapsedNewlines;
}

export function minifyWorkerPromptDeterministic(prompt: string): string {
  const protectedSpans = protectSpans(prompt);
  const rewrittenLines = normalizeAssignmentDetailsTable(protectedSpans.text.split('\n'));
  const normalizedText = normalizeUnprotectedText(rewrittenLines.join('\n'));
  return protectedSpans.restore(normalizedText);
}
