export interface ParsedTaskLaunchOutput {
  task_id: string;
}

export interface ParsedTaskOutputError {
  kind: 'transient' | 'terminal';
  message: string;
}

export interface ParsedTaskStatusOutput {
  task_id: string;
  runtimeState?: string;
  timedOut?: boolean;
  result?: string;
  error?: ParsedTaskOutputError;
}

const TASK_ID_PATTERN = /\btask[_-]id\b\s*[":=]?\s*["']?([A-Za-z0-9_-]+)/i;
const TRANSIENT_ERROR_PATTERN = /\b(not found|unknown task|no task|missing task|expired|process)\b/i;

export function parseTaskLaunchOutput(output: string): ParsedTaskLaunchOutput | undefined {
  const task_id = extractTaskId(output);
  return task_id ? { task_id } : undefined;
}

export function parseTaskStatusOutput(output: string): ParsedTaskStatusOutput | undefined {
  const parsedJson = parseJsonObject(output);
  if (parsedJson) {
    const task_id = readString(parsedJson, 'task_id') ?? readString(parsedJson, 'taskId');
    if (!task_id) {
      return undefined;
    }

    const runtimeState = readString(parsedJson, 'runtimeState') ?? readString(parsedJson, 'status') ?? readString(parsedJson, 'state');
    const timedOut = readBoolean(parsedJson, 'timedOut') ?? readBoolean(parsedJson, 'timed_out');
    const result = readString(parsedJson, 'result') ?? readString(parsedJson, 'output');
    const errorMessage = readString(parsedJson, 'error');

    return pruneUndefined({
      task_id,
      runtimeState,
      timedOut,
      result,
      error: errorMessage ? { kind: classifyError(errorMessage), message: errorMessage } : undefined,
    });
  }

  const task_id = extractTaskId(output);
  if (!task_id) {
    return undefined;
  }

  const runtimeState = extractField(output, ['runtimeState', 'status', 'state']);
  const timedOutText = extractField(output, ['timedOut', 'timed_out']);
  const result = extractField(output, ['result', 'output']);
  const explicitError = extractField(output, ['error']);
  const message = explicitError ?? extractFirstLine(output);
  const error = message && (explicitError || TRANSIENT_ERROR_PATTERN.test(message))
    ? { kind: classifyError(message), message }
    : undefined;

  return pruneUndefined({
    task_id,
    runtimeState,
    timedOut: parseBoolean(timedOutText),
    result,
    error,
  });
}

function parseJsonObject(output: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(output);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function extractTaskId(output: string): string | undefined {
  return output.match(TASK_ID_PATTERN)?.[1];
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function readBoolean(source: Record<string, unknown>, key: string): boolean | undefined {
  const value = source[key];
  return typeof value === 'boolean' ? value : undefined;
}

function extractField(output: string, fieldNames: string[]): string | undefined {
  for (const fieldName of fieldNames) {
    const match = output.match(new RegExp(`\\b${fieldName}\\b\\s*[":=]\\s*["']?([^\\n"']+)`, 'i'));
    const value = match?.[1]?.trim();
    if (value) {
      return value;
    }
  }

  return undefined;
}

function extractFirstLine(output: string): string | undefined {
  const line = output.split('\n').map((part) => part.trim()).find(Boolean);
  return line || undefined;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (!value) {
    return undefined;
  }

  if (/^true$/i.test(value)) {
    return true;
  }

  if (/^false$/i.test(value)) {
    return false;
  }

  return undefined;
}

function classifyError(message: string): 'transient' | 'terminal' {
  return TRANSIENT_ERROR_PATTERN.test(message) ? 'transient' : 'terminal';
}

function pruneUndefined<T extends Record<string, unknown>>(value: T): T {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) {
      delete value[key];
    }
  }

  return value;
}
