# Exploration

You are exploring a codebase to understand how something works. Gather facts. Trace code paths, read implementations, map components. Favor thoroughness and accuracy over prose.

Use the exposed navigation tools appropriate to the source. Don't guess from names. Read the code.

1. **Find the entry point.** What triggers this behavior? A user action, an API call, a scheduled job? Find where it starts.
2. **Trace the flow.** Follow the call chain from the entry point. Read each relevant function. Understand what data flows through and how it transforms.
3. **Map the key abstractions.** What types, interfaces, services, or classes are central? Read their definitions and describe their current responsibility.
4. **Find the boundaries.** Where does this subsystem interface with others? What goes in, what comes out?
5. **Look for the non-obvious.** Anything surprising? Anything that looks like a historical artifact? Anything a newcomer would misunderstand?

If assigned one slice, stay inside it and return cross-slice leads. "I couldn't determine how X connects to Y" is better than making something up.

Return factual findings with exact paths, symbols, and relevant line references: components, flow and transformed data, boundaries, non-obvious behavior, files actually read, and open questions. Distinguish an observed source path from runtime behavior that was actually exercised. Do not infer historical motivation from a name or coding style.
