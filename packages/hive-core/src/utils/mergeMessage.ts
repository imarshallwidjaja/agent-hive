export type MergeMessageSource = 'explicit' | 'derived' | 'fallback';

export interface MergeMessageCommit {
  hash: string;
  message?: string;
  body?: string;
}

export interface SelectedMergeCommitMessage {
  message: string;
  source: MergeMessageSource;
}

const MAX_MERGE_MESSAGE_LENGTH = 12000;

function cleanMessagePart(value: string | undefined): string {
  return (value ?? '')
    .replace(/\0/g, '')
    .replace(/\r/g, '')
    .trim();
}

function capMessage(value: string): string {
  return value.length > MAX_MERGE_MESSAGE_LENGTH
    ? value.slice(0, MAX_MERGE_MESSAGE_LENGTH).trimEnd()
    : value;
}

function commitSubject(commit: MergeMessageCommit): string {
  return cleanMessagePart(commit.message).split('\n')[0]?.trim() ?? '';
}

export function selectMergeCommitMessage(options: {
  explicitMessage?: string;
  commits: MergeMessageCommit[];
  fallbackMessage: string;
  strategy: 'merge' | 'squash';
}): SelectedMergeCommitMessage {
  const explicitMessage = cleanMessagePart(options.explicitMessage);
  if (explicitMessage) {
    return { message: capMessage(explicitMessage), source: 'explicit' };
  }

  const usableCommits = options.commits.filter((commit) => commitSubject(commit));
  if (usableCommits.length === 1) {
    const subject = commitSubject(usableCommits[0]);
    return { message: capMessage(subject), source: 'derived' };
  }

  if (usableCommits.length > 1) {
    const subject = commitSubject(usableCommits[0]);
    const heading = options.strategy === 'squash' ? 'Squashed commits:' : 'Merged commits:';
    const commitLines = usableCommits.map((commit) => `- ${commit.hash.slice(0, 7)} ${commitSubject(commit)}`);
    return {
      message: capMessage(`${subject}\n\n${heading}\n${commitLines.join('\n')}`),
      source: 'derived',
    };
  }

  return { message: capMessage(cleanMessagePart(options.fallbackMessage)), source: 'fallback' };
}
