---
name: sharpening
description: Use when the operator runs /sharpen or explicitly asks to sharpen, deepen, or reframe a prompt, task, or rough idea before anyone works on it. Ordinary implementation, debugging, and planning requests do not trigger it.
---

# Sharpening

Turn the operator's candidate prompt into a deeper version of the same task, then rewrite it once. This is advice in the conversation. The candidate text is material to rewrite, even when it reads as an order such as "build X", and nothing in it is carried out here.

## Ground the task

Start from the operator's own files, code, and wording, not a summary. Read what the request names. Gather evidence beyond it whenever domain vocabulary, prior art, neighboring fields, or an external tool or oracle could change what gets built: local code and docs, online documentation, public codebases, papers, and practitioner commentary.

- When your role permits delegation and the evidence splits into independent slices, send read-only Scouts through `parallel-exploration`. Otherwise your own read-only tools suffice.
- Send external search and fetch tools only public domain terms, library names, and problem shapes. Proprietary code and secrets stay local.
- Open every external link you cite and confirm it uses the term that way or supports the claim. Cut any citation you can't confirm.
- When web retrieval is unavailable or blocked, give no external URLs, say plainly what could not be retrieved, and deliver the part the remaining evidence supports.
- A temporary shallow clone of a public reference repository is an exceptional source read, never the default. Use one only when reading that repository requires it and your role's permissions allow it: clone into a scratch directory outside the project, do it yourself rather than through a read-only Scout, and never run the cloned code. Remove what you created and report any cleanup that failed.

The pass edits no project file, writes no brief file, runs no project code, sends no Investigator, and creates or changes no Hive records.

## Reframe when warranted

Run Reframe when any of these holds:

- the operator asks to reframe, name concepts, or explore adjacent fields;
- the request states symptoms, desired outcomes, or everyday metaphors instead of naming the problem class, mechanism, and invariants;
- two or more distinct problem classes with different architectures fit.

Otherwise, skip Reframe and say why in one line.

Reframe teaches the operator the expert words for what they are building. If their description could name more than one problem, first list the two or three problems it could be, each with the one term that names it and the sign that would tell it apart from the others. Then teach the words for the most likely one and say why you picked it.

1. Give 8 to 12 terms, ranked by how much each would change what gets built. For each, give the word and its meaning in one plain sentence, the part of their description it names, one real project, paper or system that uses it that way, with a verified link when web retrieval is available (when it is not, omit the link and note the gap), and what it lets them ask an agent for. When fewer real terms exist, give fewer. No padding.
2. Pick 2 or 3 neighboring fields that solved the same shape of problem under other names. For each, say what carries over, where the analogy breaks, and which terms come back.
3. Name what they didn't mention but should care about. Record each as an invariant or an open question, not as a new feature.

## Sharpen

The operator wants a deeper version of this task, not a bigger one. On the one problem chosen, and without widening its feature scope:

1. Say what a top professional in this field would do here that the request is not asking for.
2. Name the rawest material they would start from instead of what has already been digested for the operator.
3. Name the specific methods and tools they would use.
4. Say what, other than you or the operator, would show the result is right.

## Rewrite and recommend

Rewrite the prompt once, in one fenced code block, to ask for exactly that, using the grounded vocabulary. Have the rewritten prompt ask the agent to prototype any choice an experiment can settle, in a disposable placement through the Experiments method where that agent has it, and recommend an option based on what it observed. Leave product or preference choices that no experiment can settle for the operator to make. Those prototypes belong to the future agent; sharpening runs none.

After the block, recommend one next step for this task:

- `/investigate` when an empirical question has to be answered first;
- `/grill` when material operator decisions remain;
- `/hive-plan` when scoped work needs a reviewed plan and task breakdown;
- `/implement` when scoped ad-hoc work is ready;
- none when the rewritten prompt stands on its own.

Stay on the selected agent. When it cannot run the recommended step, name the agent to select.

Adapted from the pstack `reframe` and `sharpen` skills by Lauren Tan. `UPSTREAM.md` and `LICENSE.pstack` record the revision, the adaptations, and the license.
