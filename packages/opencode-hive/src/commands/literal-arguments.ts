/**
 * OpenCode v1 (1.18.30, packages/opencode/src/session/prompt.ts `SessionPrompt.command`) builds a configured command's
 * prompt from its template before any plugin sees it: `$1`..`$N` take whitespace-split arguments, `$ARGUMENTS` is
 * replaced through `String.replaceAll`, whose replacement patterns rewrite `$&`, `$$`, `` $` `` and `$'` in the typed
 * text, the arguments are appended when the template has neither placeholder, every !`...` in the result runs in a
 * shell, and every @path becomes a file or agent part. Only then does `command.execute.before` run, with the untouched
 * arguments and the prompt parts it may still change.
 *
 * A command whose text must arrive as typed keeps that text out of the host's template. Its template carries one
 * positional placeholder that no argument list can fill: `$N` takes argument N only when the tokenized arguments hold N
 * entries, and a JavaScript array holds at most 2^32 - 1, so `$4294967296` always expands to nothing. A placeholder
 * also stops the host from appending the arguments. The hook then replaces the template part, which reached it without
 * any argument text, with the command rendered from the raw arguments. OpenCode v2 hands plugin commands their raw text
 * and needs none of this.
 */
export const V1_UNFILLABLE_ARGUMENT = '$4294967296';

/** Template text the pinned v1 host would rewrite, run or substitute into, besides the one placeholder. */
const HOST_TEMPLATE_SYNTAX = /\$\d|\$ARGUMENTS|!`/;

/**
 * The v1 config template of a literal-argument command: its rendering with the unfillable placeholder as the argument.
 * Throws when the placeholder is not there exactly once or the static text holds anything else the host would act on.
 */
export function v1LiteralTemplate(rendered: string): string {
  const parts = rendered.split(V1_UNFILLABLE_ARGUMENT);
  if (parts.length !== 2 || HOST_TEMPLATE_SYNTAX.test(parts.join(''))) {
    throw new Error('A literal-argument Hive command must render its argument exactly once and no other $N, $ARGUMENTS or !` text.');
  }
  return rendered;
}

/** The template part as the pinned v1 host sends it to `command.execute.before`: the placeholder emptied, then trimmed. */
export function v1TemplateAsSent(template: string): string {
  return template.replace(V1_UNFILLABLE_ARGUMENT, '').trim();
}

/**
 * Puts the command rendered from the raw arguments in place of its template part, in the parts array the host prompts
 * with. The parts must hold exactly one text part, the template as the qualified host sends it; anything else means the
 * prompt was built another way, and the command fails rather than drop or rewrite the operator's text. Other parts,
 * such as files the operator attached, stay as they are.
 */
export function restoreLiteralArguments(parts: unknown[], template: string, rendered: string): void {
  const texts = parts.filter((part): part is { type: 'text'; text: unknown } => (part as { type?: unknown } | null)?.type === 'text');
  if (texts.length !== 1 || texts[0].text !== v1TemplateAsSent(template)) {
    throw new Error('Hive could not find its command template in the prompt OpenCode built, so it cannot pass your text on unchanged. The command was not sent.');
  }
  texts[0].text = rendered;
}
