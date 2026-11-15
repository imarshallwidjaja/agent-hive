---
name: modern-web-guidance
description: Use when auditing a codebase's UI and UX, modernizing a frontend, or refactoring it to modern web guidelines, and when authoring, updating, or reviewing HTML, CSS, DOM and UI components, including dialogs, popovers, menus, tables, dark mode and theming, responsive layout, container queries, anchor positioning, View Transitions and scroll-driven motion, forms, validation and autofill, web accessibility, Core Web Vitals (LCP, INP, CLS), client-side security (CSP, Trusted Types, HTML sanitization, passkeys and WebAuthn, origin validation, cookies, SRI), privacy, JavaScript Temporal dates and time zones, Web Components, PWAs, WebAssembly, Built-in AI, and WebMCP. Not for backend, SQL, or API routes, infrastructure or CI, build-tool configuration, or copy-only changes.
---

# Modern Web Guidance

<!-- Adapted from GoogleChrome/modern-web-guidance v1.0.0 (Apache-2.0): rewritten for local Markdown indexes, a legacy-pattern rubric reference, and a codebase UI/UX audit and modernization workflow; see UPSTREAM.md and LICENSE.apache-2.0 -->

This skill is a local library of 208 guides on modern web platform patterns: which native HTML, CSS, and DOM capabilities replace older workarounds, how to adopt them with correct fallbacks, and the accessibility, performance, and security gotchas that training data gets wrong. The guides are plain Markdown in this skill's directory, so finding and reading them takes only search and file reads.

## Authority

Models trained on older web code reach for legacy HTML, CSS, and JavaScript workarounds: `div` soup, hand-written focus traps, `body { overflow: hidden }` scroll locks, `max-height` transitions, JavaScript resize, scroll, and parent-state listeners, `:invalid` errors that fire before the user finishes typing, six-box OTP inputs, `Enter` handlers that submit during IME composition, `Date` time-zone bugs, and raw `innerHTML`. Neighboring files in an older codebase repeat the same patterns.

Look up and read the matching guides from this skill **before** you design, implement, audit, or refactor web UI or client-side code, instead of copying patterns from memory or from neighboring files. The guides are the preferred standard for the project: do not invent guide IDs or rules, and do not set aside a retrieved guide's requirements.

Explicit operator instructions, the project's `AGENTS.md`, and a `.mwgrc` file at the project root govern project policy. Within those boundaries, these guides set the web-platform bar in vanilla and framework codebases alike.

## Choosing a workflow

- A named feature, component, page, or bug, including a request to audit or review one specific component: use Workflow 1.
- An open-ended request to audit, critique, modernize, or refactor an app's or codebase's UI, UX, CSS, accessibility, performance, or modern-web compliance, where no single target is named: use Workflow 2.

## Workflow 1: author, update, or review a feature or component

1. **Locate.** Grep `references/index/` in this skill's directory for one to three concrete UI or platform nouns, or CSS, HTML, or DOM symbols. Translate product intent into the platform primitive first: "confirm delete" becomes `dialog`; "stop the page scrolling behind the modal" becomes `overscroll-behavior`; "time zones" or "durations" becomes `Temporal`. Search each capability of a multi-feature task separately. Each index line holds the guide link, its line count, any gate tag, the upstream description, and the symbols the guide covers. When a search finds nothing relevant, rephrase it once with the concrete HTML, CSS, or component noun (`dialog`, `popover`, `table`, `form`) or open the category index from the table below. When no guide covers the topic after that, proceed without reading unrelated guides.
2. **Read.** Read the matching use-case guides (`guides/<category>/<id>.md`) and every foundational guide that applies to the work: [`html`](guides/html/html.md), [`css`](guides/css/css.md), [`css-layout`](guides/css/css-layout.md), [`forms`](guides/forms/forms.md), [`accessibility`](guides/accessibility/accessibility.md), [`color`](guides/visual-design/color.md), [`dark-mode`](guides/visual-design/dark-mode.md), [`typography`](guides/visual-design/typography.md), [`motion`](guides/ui-behaviors/motion.md), [`performance`](guides/performance/performance.md), [`security`](guides/security/security.md), or [`privacy`](guides/privacy/privacy.md). When the index marks a guide as a large guide (over 350 lines), grep its `^## ` headings and read the relevant sections by line range; read it in full for broad work. Follow a guide's relative links when it hands a sub-problem to another guide.
3. **Apply and verify compliance.** Implement the guide's pattern and the fallback its Baseline status requires, without adding features the task did not ask for. Adapt vanilla examples to the project's framework as described in [Framework adaptation](#framework-adaptation). Before finishing, cross-check the implementation against every requirement and fallback in each retrieved guide, and confirm that the implementation fully satisfies the request.

## Workflow 2: codebase UI/UX audit and modernization

1. **Orient and pair.** Identify the frontend source roots, the framework, component, and styling setup, and the browser-support target (`.mwgrc`, `browserslist`, `AGENTS.md`, or the Widely available default described under [Browser support and feature gates](#browser-support-and-feature-gates)). When visual hierarchy, layout composition, or cleanup of generic SaaS styling is also in scope and the `stop-design-slop` skill is available, use it alongside this one: `stop-design-slop` governs product-derived visual composition and hierarchy, and this skill governs UX ergonomics, HTML, CSS, and DOM primitives, accessibility, motion, performance, and security.
2. **Pass 1: legacy-pattern sweep.** Read [`references/legacy-patterns.md`](references/legacy-patterns.md): 35 curated legacy-to-modern detection rules covering about 20% of the catalog. Search stylesheets, templates and JSX, client scripts, and `package.json` for each rule's legacy idiom and for single-purpose wrapper packages, such as `react-wrap-balancer`, `aos`, `scrollreveal`, `wowjs`, `tippy.js`, `fitty`, `autosize`, `noUiSlider`, `humanize-duration`, `::-webkit-scrollbar` styling, `max-height` transitions, inputs without `autocomplete`, `:invalid` without `:user-invalid`, and `Enter` handlers that ignore IME composition. Check every candidate against its rule's **Flag and modernize when (`keepWhen`)** and **Skip / keep as-is when (`dropWhen`)** lists, and drop false positives: intentional `@supports` or `CSS.supports` fallbacks, scrollable `max-height` containers, interactive click menus, SSR paths, vendor code, and lookalikes with distinct behavior.
3. **Pass 2: seven-axis UI/UX and platform sweep.** Pass 1 misses most semantic and UX problems. Inspect the real screens and shared primitives on all seven axes, and read the linked foundational and component guides for every area you touch:
   - **UX and form factor** ([`content-first-noise-reduction`](guides/user-experience/content-first-noise-reduction.md), [`form-factor-adaptation`](guides/user-experience/form-factor-adaptation.md), [`natural-interactions`](guides/user-experience/natural-interactions.md)): remove interstitials that block content at load; keep each fixed or sticky bar under 12% of the viewport height; require usable touch targets, safe-area insets, reflow down to 320 CSS pixels, container queries (`@container`) on reusable components, and keyboard-reachable alternatives to hover and swipe actions.
   - **HTML semantics and overlays** ([`html`](guides/html/html.md), [`dialog`](guides/ui-components/dialog.md), [`responsive-table`](guides/ui-atoms/responsive-table.md), [ui-components index](references/index/ui-components.md)): landmarks (`<header>`, `<nav>`, `<main>`, `<search>`, `<footer>`), heading levels that do not skip, `<button>` for actions and `<a>` for navigation, native `<dialog>` and `popover` with `overscroll-behavior: contain` in place of `body { overflow: hidden }` scroll locks that shift layout, and semantic responsive tables.
   - **CSS architecture, visual design, and dark mode** ([`css`](guides/css/css.md), [`css-layout`](guides/css/css-layout.md), [`dark-mode`](guides/visual-design/dark-mode.md), [`typography`](guides/visual-design/typography.md), [`color`](guides/visual-design/color.md)): `@layer` cascade order, `:where()`, `:has()`, `@scope`, intrinsic Grid, Flexbox, and subgrid layout with `gap` and `min-inline-size: 0`, scalable `rem` and `em` type with no fixed heights on text-bearing controls, `<meta name="color-scheme">` with a root `color-scheme` and `light-dark()`, and forced-colors support.
   - **Forms and validation** ([`forms`](guides/forms/forms.md), [`accessible-error-announcement`](guides/accessibility/accessible-error-announcement.md)): a visible `<label>` for every field, `aria-describedby` for hints and errors, `autocomplete`, `inputmode`, and `enterkeyhint`, a single-input OTP, `type="text"` (never `type="number"`) for identifiers and codes, validation on blur or submit that clears on input, `:user-invalid` synchronized with `aria-invalid`, and IME-safe `Enter` handling (`!event.isComposing`).
   - **Motion and view continuity** ([`motion`](guides/ui-behaviors/motion.md), [ui-behaviors index](references/index/ui-behaviors.md)): compositor-friendly `opacity` and transform animation, `@starting-style` with `transition-behavior: allow-discrete`, View Transitions with explicit focus management, scroll-driven animations in place of JavaScript scroll listeners, and `prefers-reduced-motion` handling.
   - **Accessibility and Core Web Vitals** ([`accessibility`](guides/accessibility/accessibility.md), [`performance`](guides/performance/performance.md), [`identify-inp-causes`](guides/performance/identify-inp-causes.md)): accessible names, keyboard and focus order, and live regions; an LCP resource discoverable in the initial HTML with `fetchpriority="high"`, never lazy-loaded; reserved `aspect-ratio` or dimensions against CLS; task yielding with `scheduler.yield()` and no layout thrashing for INP; and `content-visibility: auto` on heavy offscreen sections.
   - **Security, authentication, and privacy** ([`security`](guides/security/security.md), [`privacy`](guides/privacy/privacy.md), [`passkeys`](guides/security/passkeys.md)): `setHTML()` and Trusted Types in place of raw `innerHTML`, a strict CSP, origin validation for `postMessage`, Subresource Integrity on third-party subresources, native WebAuthn passkeys, data minimization, and no sensitive tokens in `localStorage`.
4. **Deliver the audit or the refactor.**
   - **Audit or report only:** group verified findings by surface and user impact. Give each one a `file:line` location, the guide rule it breaks, and the modern fix. State that Pass 1 covers the deterministic legacy patterns (about 20% of the catalog) and Pass 2 covers semantic and UX architecture.
   - **Refactor or modernize:** read every target guide in full, including its `## Fallback strategies` section. Group changes into coherent component or surface slices. Replace legacy JavaScript and CSS workarounds and redundant single-purpose libraries; keep an existing library as a conditional fallback where a guide's Baseline strategy requires one. Keep the behavior of an accessible component system where native HTML does not yet cover a required interaction on the supported browsers. After the changes, rerun the Pass 1 searches on the modified files to confirm each finding is resolved; dropped findings and required fallbacks still match those searches, so leave that code as it is. Verify with the project's checks and with rendered browser, keyboard, and theme behavior.

## Framework adaptation

The guides show vanilla HTML, CSS, and JavaScript. Carry each modern feature into the project's framework instead of dropping it:

- Spread or cast newly shipped HTML attributes (`popover`, `commandfor`, `closedby`, `interestfor`, `switch`) onto the element without editing or merging the framework's global type definitions.
- Guard `window`, `document`, and `HTMLElement` access during server-side rendering.
- Load a polyfill with a bare dynamic `import('<package>')` inside a client-side effect, or raise the bundler's build target when it needs top-level `await`; never copy files out of `node_modules`.
- Generate per-instance IDs and `anchor-name` values, for example with `useId()`.
- Call `showModal()` and similar methods through refs.
- Call `moveBefore()` only on nodes the virtual DOM does not manage.
- Keep `:root` rules and `@starting-style` blocks top-level and unscoped.

## Scope, supply chain, and role boundaries

- **Scoped changes and modernization audits.** In a narrow feature, bug fix, or scoped PR review, enforce the modern HTML, CSS, form, accessibility, Core Web Vitals, and security rules on all touched code, without demanding unrelated repository-wide rewrites of an established accessible component system (such as Radix, shadcn/ui, or React Aria) or of a framework reset such as Tailwind Preflight. In an explicit UI/UX audit or modernization task, evaluate the entire requested scope against these guides.
- **CDN URLs.** Guide fallback snippets sometimes load scripts from unpinned `@latest` CDN URLs (`unpkg.com`, `esm.sh`, `cdn.jsdelivr.net`). Put such a URL into production code only when the user asked for it, pinned to an exact version and protected with Subresource Integrity as [`secure-external-subresources`](guides/security/secure-external-subresources.md) describes.
- **Polyfills.** Treat every polyfill (`@oddbird/popover-polyfill`, `invokers-polyfill`, `temporal-polyfill`, and others) as an explicit package-manager dependency decision, loaded behind feature detection.
- **Role and output.** Keep the caller's role, authority, verdict bar, and output format. Report applied guidance inside the report, review, or PR notes your work already produces, naming a guide ID when it helps the reader; this skill adds no `### Modern Web Guidance` section.
- **Built-in AI latency.** Show fast Built-in AI results immediately; the one- to two-second artificial delay that [`language-model`](guides/built-in-ai/language-model.md) suggests does not apply.
- **Project instruction files.** When the project targets a restricted runtime (Electron, Tauri), excludes specific browsers, hesitates over polyfill size, or asks whether a feature is safe without fallbacks, suggest recording a browser-support policy in `AGENTS.md` or `.mwgrc`. Edit `AGENTS.md` only when asked.

## Categories

| Category | Covers |
| --- | --- |
| [accessibility](references/index/accessibility.md) | Accessibility coding rules, error announcements, generated content, OS text scaling |
| [built-in-ai](references/index/built-in-ai.md) | On-device Prompt, Summarizer, Translator, and Language Detector APIs |
| [css](references/index/css.md) | Cascade architecture, layout, `:has()`, container queries, intrinsic sizing, fluid scaling |
| [forms](references/index/forms.md) | Autofill, validation timing, customizable select, switches, sliders, OTP input |
| [html](references/index/html.md) | HTML semantics, Web Components, custom elements, Shadow DOM |
| [js](references/index/js.md) | `Temporal` dates, time zones, calendar systems, high-precision timestamps, global events |
| [performance](references/index/performance.md) | LCP, INP, and CLS fixes, resource priority, long tasks, lazy loading, analytics beacons |
| [privacy](references/index/privacy.md) | Data minimization, transparency, third-party scripts, privacy headers, fingerprinting |
| [pwa](references/index/pwa.md) | Installable web apps and web app origin migration |
| [security](references/index/security.md) | CSP, Trusted Types, sanitization, passkeys and WebAuthn, origin validation, SRI, Web Crypto |
| [ui-atoms](references/index/ui-atoms.md) | Tooltips, dropdowns, responsive tables, sticky headers, scroll-aware elements |
| [ui-behaviors](references/index/ui-behaviors.md) | Dialog and popover control, View Transitions, scroll-driven effects, drag, swipe, sorting |
| [ui-components](references/index/ui-components.md) | Dialog, menu, tabs, accordion, carousel, toolbar, navigation, toast, progress |
| [user-experience](references/index/user-experience.md) | Form-factor adaptation, natural interactions, noise reduction |
| [visual-design](references/index/visual-design.md) | Color, dark mode, typography, scrollbars, shapes, canvas and WebGL content |
| [wasm](references/index/wasm.md) | Compiling C and C++ to WebAssembly |
| [webmcp](references/index/webmcp.md) | Exposing page tools to AI agents with WebMCP |

## Browser support and feature gates

Each guide states the Baseline status of the features it uses, with a "Baseline since" date where one exists.

- **Widely available** features are safe without fallbacks. A feature counts as widely available once its "Baseline since" date is at least 30 months old, even when the guide text still says Newly available.
- **Newly available** and **Limited availability** features must use the guide's fallback strategy unless the project's browser-support policy waives it. In `.mwgrc`, `"baseline": "newly"` accepts Newly available features, `"baseline": "limited"` waives fallbacks for every feature in the guides, and `"baseline": "YYYY"` accepts features whose "Baseline since" date falls in or before that year. When the user states other browser-support requirements, such as a minimum Safari version, no polyfills, or Newly available features behind feature detection, use the guide's compatibility data to decide which fallbacks they waive.
- **Origin Trial** guides (tagged `[origin-trial]` in the indexes) and **volatile-feature** guides (tagged `[volatile]`) carry a caution notice under their title. When `.mwgrc` sets `"allowOriginTrials": false` or `"allowVolatileFeatures": false`, do not adopt an API of that kind, even one the user named; the project has opted out. Otherwise adopt a gated API only when `.mwgrc` sets `"allowOriginTrials": true` or `"allowVolatileFeatures": true` respectively, or the user explicitly requested that API by name. When neither holds, use the guide for background and implement a standard cross-browser solution.
