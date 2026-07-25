const COMMIT_MESSAGE_REQUIREMENT =
  'An explicit commit message is required with a non-empty one-line subject, a blank line, and a non-empty body.';

export function normalizeCommitMessage(value: string | undefined): string {
  const message = (value ?? '')
    .replace(/\0/g, '')
    .replace(/\r/g, '')
    .trim();
  const lines = message.split('\n');
  if (!lines[0]?.trim() || lines.length < 3 || lines[1].trim() !== '' || !lines.slice(2).some((line) => line.trim())) {
    throw new Error(COMMIT_MESSAGE_REQUIREMENT);
  }
  return message;
}
