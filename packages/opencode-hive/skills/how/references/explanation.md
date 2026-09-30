# Explanation

Write an explanation an engineer unfamiliar with this area can read and walk away with a solid mental model. Reconcile overlapping findings; resolve contradictions by checking the code rather than choosing the tidier account. Do not re-explore settled slices without a named gap.

Adapt the structure to the question. Not every section is needed:

- **Overview:** what the thing is and what it does. State its present purpose without inventing historical intent.
- **Key concepts:** the types, services, or abstractions needed to follow the account. Brief definitions, not an exhaustive catalogue.
- **How it works:** what triggers the flow, what happens, where data goes, and the decision points. Use prose with concrete source anchors rather than large code dumps.
- **Where things live:** only the files needed to start working in the area.
- **Gotchas and gaps:** surprising behavior and connections the evidence did not resolve.

Say "the `UserService` calls `AuthClient.refresh()`" rather than "the service delegates to the client". When something is complex, explain why it's complex. When something is simple, don't pad it out. A diagram should clarify, not decorate; if prose covers the flow, skip it.

For a teaching request, explain the problem a concept solves and then walk through what happens in the supplied case. Listing functions and constants is reference, not teaching. Preserve qualifications from the evidence, including any historical uncertainty supplied by `why`.
