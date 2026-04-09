export interface ToolInput {
  [key: string]: unknown;
}

export interface ToolConfirmation {
  title: string;
  message: string;
  invocationMessage?: string;
}

export interface LanguageModelToolContribution {
  name: string;
  toolReferenceName: string;
  displayName: string;
  modelDescription: string;
  userDescription: string;
  canBeReferencedInPrompt: true;
  inputSchema: object;
}

export interface ToolRegistration<T extends ToolInput = ToolInput> {
  name: string;
  displayName: string;
  modelDescription: string;
  toolReferenceName?: string;
  userDescription?: string;
  canBeReferencedInPrompt?: boolean;
  inputSchema: object;
  destructive?: boolean;
  readOnly?: boolean;
  confirmation?: ToolConfirmation;
  invoke: (input: T, token: unknown) => Promise<string>;
}

export function createToolResult(content: string): string {
  return content;
}

export function defineTool<T extends ToolInput = ToolInput>(registration: ToolRegistration<T>): ToolRegistration<T> {
  return registration;
}

export function toLanguageModelToolContribution(
  registration: ToolRegistration,
): LanguageModelToolContribution | null {
  if (!registration.canBeReferencedInPrompt || !registration.toolReferenceName) {
    return null;
  }

  return {
    name: registration.name,
    toolReferenceName: registration.toolReferenceName,
    displayName: registration.displayName,
    modelDescription: registration.modelDescription,
    userDescription: registration.userDescription ?? registration.displayName,
    canBeReferencedInPrompt: true,
    inputSchema: registration.inputSchema,
  };
}
