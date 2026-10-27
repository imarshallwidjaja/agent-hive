# Formal verification method

Read this reference when the requested verification capability uses a model checker, prover, code-level verifier, or exhaustive property check. It adds method, not authority: the role, the assignment, and the tooling scope agreed with the project's operators still decide what you may install, write, or run. The limits on what each kind of result proves are in `verification`.

## Choosing the invariant

A test checks the cases someone wrote. Formal verification checks every case in a stated scope: every interleaving in a model, every input up to a bound, or every input. Spend it where that matters: a promise the code makes, whose break harms users, and whose breaking cases ordinary tests rarely reach, such as concurrent writers, retries, state machines, parsers, or unsafe memory. Start from the area or bug the operator named. Otherwise choose the strongest such promise rather than the easiest to verify, and state the property and the harm it prevents in one plain sentence each.

## Choosing the tool by question

Let the question choose the tool, within the project's agreed scope:
- Whether events can happen in a bad order usually suits a model checker over a small model of the design.
- Whether the code behaves for every input, such as memory safety, overflow, or a data-structure invariant, usually suits a verifier that runs on the code itself.
- When no verifier runs on the language, test the real code with generated inputs rather than a hand-written model of the function, and report the result as sampled.
- A property that must hold at every size, where a bound is not enough, can need a proof.

Prefer a tool the project's developers can install and run, and say why you chose it. Installing a tool is a scoping decision for the operators, never a default step.

## Keeping the model true to the code

- Every element of the model or proof points to code a reviewer can open, using the repository's own names.
- What the verification treats as one indivisible step is one indivisible step in the code. When a step becomes two, or a lock, transaction, or check moves, the model must change.
- Look for new writers: code that reaches the guarded state through a new function, path, or caller is covered code even when no covered file changed.
- Covered code that is renamed, split, or moved is still covered code. Record which files and functions each check covers and the commit at which you last confirmed the verification describes them, and move that commit forward only after confirming the description again.
- Update a model or harness from the code, before rerunning, and not from what would make the check pass. Change a property only for a promise that changed on purpose, citing the evidence; keep bounds unless the change makes them wrong, and report any bound you reduce.

## Showing the check can fail

A check never seen failing proves nothing. Give each property a negative control on the surface the check actually reads: a scratch break, such as a removed check or a reordered step, that the check catches.
- When the verifier runs on the code itself, break the code it guards.
- When the check runs on a detached model, break the model. That shows only that the model check is sensitive to the property, which supports design analysis within the model's scope; it does not show that the check detects a change to the code.
- Claim that the check detects a code defect only after you observe the connection: a mutated source file that the check reads and rejects.

Drop the scratch break afterwards and confirm the check is back to its earlier result.

## Reading results

- When the current code breaks the property, that is a finding. Report it with the counterexample retold as a short sequence of steps in the code's own terms and the harm in one sentence. Do not weaken the property or the model until it passes, and change product code only with implementation scope that covers the fix.
- Replay a counterexample against the real code step by step. A step the code cannot take means the verification is wrong; fix the verification and say what was wrong. When every step can happen, it is a bug.
- A pass covers the model or the bound, not the whole system. State what is verified, under which bounds and assumptions, and what is left out.
- Keep the check cheap to rerun: one command, a reproducible tool version, and a run short enough to use on every relevant change.

When maintaining an existing check, run it once as it stands before changing anything, and read every change to covered code since the recorded commit. For each change, decide whether it has no effect on what the verification describes, makes the description stale, changes the promise on purpose (with evidence), or may break the promise. A check that passed before an update and fails after it was passing on a stale description.
