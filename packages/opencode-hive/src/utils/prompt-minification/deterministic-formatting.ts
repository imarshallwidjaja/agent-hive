function protectSpans(input: string): { text: string; restore: (text: string) => string } {
  const protectedValues: string[] = [];
  let tokenPrefix = '__HIVE_PROMPT_MINIFY_PROTECTED__';

  while (input.includes(tokenPrefix)) {
    tokenPrefix += '_X';
  }

  const stash = (value: string): string => {
    const index = protectedValues.push(value) - 1;
    return `${tokenPrefix}${index}__`;
  };

  let text = input.replace(/```[\s\S]*?```/g, stash);
  text = text.replace(/`[^`\n]+`/g, stash);

  const restore = (nextText: string): string => {
    const tokenPattern = new RegExp(`${tokenPrefix}(\\d+)__`, 'g');
    return nextText.replace(tokenPattern, (_, index) => {
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
  const lines = protectedSpans.text.split('\n');
  const missionStart = lines.findIndex((line) => /^##\s+Your Mission\s*$/.test(line));

  const rewrittenLines = missionStart === -1
    ? normalizeAssignmentDetailsTable(lines)
    : [
      ...normalizeAssignmentDetailsTable(lines.slice(0, missionStart)),
      ...lines.slice(missionStart),
    ];

  const normalizedText = normalizeUnprotectedText(rewrittenLines.join('\n'));
  return protectedSpans.restore(normalizedText);
}
