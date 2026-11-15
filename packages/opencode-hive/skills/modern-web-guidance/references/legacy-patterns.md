# Legacy Web Patterns and Verification Rubrics

<!-- Adapted from GoogleChrome/modern-web-guidance v1.0.0 legacy-scan.mjs (Apache-2.0): extracted as static audit rubrics with relative guide links; see ../UPSTREAM.md and ../LICENSE.apache-2.0 -->

35 detection rules for legacy web idioms that a modern platform feature replaces, covering 33 guides (about 20% of the catalog). Each rule names the legacy pattern to search for, the guide that holds its replacement, and two lists:

- **Flag and modernize when (`keepWhen`):** conditions that make a candidate a real finding. A candidate counts only when it matches at least one of them.
- **Skip / keep as-is when (`dropWhen`):** conditions that dismiss **that specific rule match** because the pattern is an intentional fallback, out of scope, or already satisfied. Dismissing one rule match does not suppress an independent defect on the same element (for example, an input that already has `autocomplete="cc-number"` skips the missing-autofill check, while `type="number"` on that card field still violates `autofill-payment-form`).

Search the stylesheets, templates and JSX, client scripts, and `package.json` for each rule's pattern, then check every candidate against both lists before reporting or editing it. Read the linked guide before changing the code; its fallback strategy decides whether the old code stays as a fallback. Code whose rule match was dismissed, and fallbacks a guide requires, still match a text search after modernization; leave those matched constructs in place unless an independent rule flags another defect on them.

Categories: [css](#css), [forms](#forms), [html](#html), [js](#js), [performance](#performance), [security](#security), [ui-atoms](#ui-atoms), [ui-behaviors](#ui-behaviors), [ui-components](#ui-components), [visual-design](#visual-design).

## css

### `animate-to-intrinsic-sizes`

Guide: [`animate-to-intrinsic-sizes`](../guides/css/animate-to-intrinsic-sizes.md)

CSS transition on max-height simulates intrinsic size animation; modernize with interpolate-size: allow-keywords or calc-size().

**Flag and modernize when (`keepWhen`):**

- The CSS rule animates or transitions max-height (or transitions all alongside a max-height declaration) to simulate accordion, dropdown, drawer, or modal expansion/collapse.
- The element uses max-height as a proxy for natural content height because pure height cannot transition to auto without interpolate-size.

**Skip / keep as-is when (`dropWhen`):**

- The container is a scrollable panel with overflow: scroll or overflow: auto where max-height defines a legitimate scrolling boundary.
- The stylesheet already specifies interpolate-size: allow-keywords or uses calc-size().
- The transition property is none or explicitly excludes height/max-height.
- The max-height property is none or an unconstrained reset.

### `child-state-based-styling/js-parent-class`

Guide: [`child-state-based-styling`](../guides/css/child-state-based-styling.md)

JavaScript form control event listeners toggle classes on parent/closest containers to simulate container state styling; replace with CSS container :has() selectors.

**Flag and modernize when (`keepWhen`):**

- A JavaScript or jQuery event listener on a form control (focus, blur, focusin, focusout, change, or input) toggles state classes (focus, focused, active, checked, valid, invalid, empty, filled, has-value) on parentElement, parentNode, closest(...), $(this).parent(...), or $(this).parents(...) to visually style the parent container.
- The parent state synchronization can be replaced by the native CSS :has() selector on the container (e.g. .field:has(:focus) or .field:has(:invalid)).

**Skip / keep as-is when (`dropWhen`):**

- The listener also triggers imperative JavaScript animations, non-styling application state changes, form wizard navigation, or analytics.
- The listener manages modal dialog or dropdown overlay opening/closing rather than form input container state styling.
- The code is guarded by a feature query checking support for CSS :has().

## forms

### `autofill-address-form`

Guide: [`autofill-address-form`](../guides/forms/autofill-address-form.md)

Postal address form fields (<input> or <textarea>) inside a <form> should specify standard autocomplete attributes (e.g. street-address, postal-code).

**Flag and modernize when (`keepWhen`):**

- The input or textarea is part of an address, billing, checkout, or shipping form collecting postal street address or postal code data.
- The field lacks a standard autocomplete attribute or specifies autocomplete="off", preventing browser and password-manager address autofill.

**Skip / keep as-is when (`dropWhen`):**

- The input is a search box, filter query, or location search autocomplete input (type="search" or search field).
- The input is disabled, readonly, hidden, or part of a non-form test fixture or XML data schema.
- The component receives its autocomplete attribute dynamically via props, context, or JSX spread.

### `autofill-payment-form`

Guide: [`autofill-payment-form`](../guides/forms/autofill-payment-form.md)

Payment card input in checkout form should specify standard autocomplete="cc-*" attributes and avoid type="password" or type="number".

**Flag and modernize when (`keepWhen`):**

- The input is part of a payment, checkout, or billing form collecting payment card details (card number, expiration, security code, or cardholder name).
- The payment card input lacks an autocomplete attribute (e.g. autocomplete="cc-number", "cc-exp", "cc-csc", "cc-name") or specifies autocomplete="off", preventing browser payment autofill.
- The card number uses type="number" or card security code uses type="password", contrary to payment form best practices.

**Skip / keep as-is when (`dropWhen`):**

- The input already provides a valid payment autocomplete token (such as "cc-number", "cc-exp", "cc-csc", "cc-name").
- The input collects non-card numbers such as bank routing numbers, IBAN, gift cards, loyalty cards, or phone numbers.
- The input is disabled, readonly, hidden, or display-only.
- The autocomplete attribute is bound dynamically via framework attributes or JSX spread.

### `autofill-sign-in-form`

Guide: [`autofill-sign-in-form`](../guides/forms/autofill-sign-in-form.md)

Password input in sign-in or credential form should specify autocomplete="current-password" or autocomplete="new-password".

**Flag and modernize when (`keepWhen`):**

- The password input is part of a user-facing authentication, current-password verification, or sign-in form.
- The password input lacks an autocomplete attribute or specifies autocomplete="off" on credentials, preventing browser password manager autofill.

**Skip / keep as-is when (`dropWhen`):**

- The password input is disabled, readonly, hidden, or a non-interactive display widget.
- The password input already provides a valid credential autocomplete token (such as "current-password", "new-password", or "one-time-code").
- The password input is for creating or confirming a new password (owned by autofill-sign-up-form).
- The password input is for external service, infrastructure, or device configuration (such as database connections, proxy credentials, SMTP settings, webhooks, or API keys/tokens).
- The input is not contained within a form or form-like authentication context.
- The component receives its autocomplete attribute dynamically via props, context, or JSX spread.

### `autofill-sign-up-form`

Guide: [`autofill-sign-up-form`](../guides/forms/autofill-sign-up-form.md)

Password inputs in sign-up and account registration forms should specify autocomplete="new-password".

**Flag and modernize when (`keepWhen`):**

- The password input creates or confirms a new account password in a user sign-up, registration, or new-account creation form.
- The password input lacks an autocomplete attribute or specifies autocomplete="off" / autocomplete="current-password" on new account credentials, preventing browser password manager generation and autofill.

**Skip / keep as-is when (`dropWhen`):**

- The password input is disabled, readonly, hidden, or a non-interactive display widget.
- The password input already provides autocomplete="new-password".
- The password input is part of a login/sign-in form (owned by autofill-sign-in-form), an authenticated password-change or profile-settings form, a password-reset/recovery form, an admin user-management CRUD form, or a device/encryption passphrase dialog.
- The component receives its autocomplete attribute dynamically via props, context, or JSX spread.

### `form-fields-automatically-fit-contents`

Guide: [`form-fields-automatically-fit-contents`](../guides/forms/form-fields-automatically-fit-contents.md)

Imperative JavaScript auto-resizing of textareas and inputs using scrollHeight or autosize() should be replaced with CSS field-sizing: content.

**Flag and modernize when (`keepWhen`):**

- A keyup, input, change, or keydown event listener dynamically recalculates a textarea or text input height/width using scrollHeight or scrollWidth to auto-expand the field as the user types.
- A helper function resets .style.height to "auto", "0px", or "1px" and sets it to scrollHeight to fit contents.
- The application invokes the autosize() library on a textarea or input collection.

**Skip / keep as-is when (`dropWhen`):**

- The code is guarded by a feature query checking CSS.supports("field-sizing", "content") or field-sizing support.
- The scrollHeight measurement calculates scrollbar thumb sizes, virtual scroll windowing, or scroll progress in a long document/dialog.
- The element being resized is a canvas, iframe, or modal container rather than a form input or textarea.

### `ime-safe-enter-submit`

Guide: [`ime-safe-enter-submit`](../guides/forms/ime-safe-enter-submit.md)

Flag keydown event listeners on inputs or textareas intercepting Enter (event.key or event.code "Enter") to submit forms, send messages, or trigger actions without checking event.isComposing or event.keyCode === 229, breaking IME input in CJK languages.

**Flag and modernize when (`keepWhen`):**

- Keydown event listeners on inputs or textareas checking event.key === "Enter" or event.code === "Enter" to trigger submission, search, or message sending without checking event.isComposing or event.keyCode === 229.
- Custom enter-to-submit implementations intercepting Enter to call form.submit(), form.requestSubmit(), or trigger a click on a submit button without IME composition gating.

**Skip / keep as-is when (`dropWhen`):**

- Keyup or keypress event listeners (composition has already ended by keyup).
- Handlers that check event.isComposing or event.keyCode === 229.
- Handlers that detect Enter only through event.keyCode === 13 or event.which === 13 (the keydown that confirms an IME composition reports keyCode 229, so these never fire mid-composition).
- Handlers strictly requiring modifier keys (Ctrl+Enter or Cmd+Enter) where IME character selection is not triggered.
- Native form submit events or standard inputs inside a form with no custom Enter keydown listener (native Enter submission handles IME automatically).
- Global document-level hotkeys, non-text UI widgets (buttons, menus, tabs, treeviews, dropdowns, modals, media players), or rich-text/code editor newline/indentation handlers rather than text-input submission.

### `select-menu-interaction/css-select-invalid`

Guide: [`select-menu-interaction`](../guides/forms/select-menu-interaction.md)

CSS select:invalid selectors without :user-invalid should be modernized with select:user-invalid so required dropdowns only show error styles after interaction.

**Flag and modernize when (`keepWhen`):**

- A CSS rule uses select:invalid (standalone or grouped with input:invalid / textarea:invalid without :required) without :user-invalid to apply validation error styling (border, border-color, background, background-color, error text color, or non-none outline/box-shadow).
- A CSS rule uses select:invalid with an adjacent or general sibling combinator (+ or ~) to reveal or style a validation error message element before user interaction.

**Skip / keep as-is when (`dropWhen`):**

- The stylesheet already uses :user-invalid or guards select:invalid inside @supports not selector(:user-invalid).
- The rule declarations solely reset browser default :invalid styles (only setting box-shadow: none or outline: none with no border, background, or error color styling) or only dim unselected placeholder text color/opacity to muted gray tones.
- Every select:invalid selector in the rule is already gated by a post-interaction or submitted state class (.was-validated, .touched, .dirty, .submitted) or targets a custom select widget library (.select2, .chosen-container, .choices, .ts-wrapper).
- The selector explicitly combines :required:invalid or [required]:invalid across both input/textarea and select (owned by required-field-feedback).

### `slider/js-slider`

Guide: [`slider`](../guides/forms/slider.md)

Single-handle noUiSlider.create() calls should be modernized with native HTML <input type="range"> and CSS accent-color.

**Flag and modernize when (`keepWhen`):**

- JavaScript calls noUiSlider.create() with a single numeric start value (e.g., start: 50 or start: [50]) and a linear min/max range to build a basic horizontal single-thumb range slider.
- Custom drag handle divs calculate percentage left offsets on mousemove for a single numeric value.

**Skip / keep as-is when (`dropWhen`):**

- The slider configures multiple handles or thumbs (e.g., start: [20, 80]) for min/max interval selection.
- The slider configures non-linear percentage range stops (e.g., "30%": ...), custom pips/tick rulers (pips: {...}), thumb tooltips/formatters (tooltips: true, format: {...}), or vertical orientation (orientation: "vertical").
- The control is a multi-thumb timeline video scrubbing bar or already uses native <input type="range">.

### `validate-input-after-interaction`

Guide: [`validate-input-after-interaction`](../guides/forms/validate-input-after-interaction.md)

CSS input:invalid and textarea:invalid error-styling rules (including :not(:focus):invalid and :not(:placeholder-shown):invalid workarounds) without :user-invalid should be modernized with :user-invalid so error feedback appears only after user interaction.

**Flag and modernize when (`keepWhen`):**

- A CSS rule uses input:invalid or textarea:invalid (or :not(:focus):invalid / :not(:placeholder-shown):invalid) without :user-invalid to apply error styling (border, border-color, background-color, error text color, or non-none outline/box-shadow) or to reveal an adjacent/sibling error message element.

**Skip / keep as-is when (`dropWhen`):**

- The stylesheet already uses :user-invalid or guards :invalid inside @supports not selector(:user-invalid).
- The rule only resets browser default :invalid styles (such as box-shadow: none or outline: none with no error border, background, or color).
- The selector is already gated by a post-interaction class (.was-validated, .touched, .dirty, .submitted), combines :required:invalid (owned by required-field-feedback), or targets select:invalid (owned by select-menu-interaction).

## html

### `styling-web-components`

Guide: [`styling-web-components`](../guides/html/styling-web-components.md)

Avoid non-standard :host-context() pseudo-classes in web component styles; modernize theming using inherited CSS custom properties or container style queries.

**Flag and modernize when (`keepWhen`):**

- The component stylesheet uses non-standard :host-context(...) to style based on ancestor Light DOM state instead of standard inherited CSS custom properties or ::part().
- The stylesheet attempts ancestor-based theme matching via :host-context([theme="dark"]) or :host-context([dir="rtl"]) inside shadow DOM stylesheets.

**Skip / keep as-is when (`dropWhen`):**

- The selector uses standard Shadow DOM encapsulation selectors like :host, :host(...), ::part(...), ::slotted(...), or :state(...).
- The rule is inside third-party vendor code or polyfills designed specifically to emulate :host-context.
- The stylesheet uses modern container queries or CSS custom properties for cross-boundary theming.

## js

### `format-human-readable-durations/js-duration-formatter`

Guide: [`calculate-event-differentials`](../guides/js/calculate-event-differentials.md)

Custom duration formatting logic or libraries (humanizeDuration, prettyMs, moment.duration().humanize()) can be modernized with native Temporal.Duration and Intl.DurationFormat.

**Flag and modernize when (`keepWhen`):**

- Using third-party duration formatting packages (such as humanize-duration, pretty-ms, or moment-duration-format) to format time spans.
- Calling duration methods like humanizeDuration(...), prettyMs(...), moment.duration(...).humanize(), or moment.duration(...).format(...).
- Implementing custom time duration formatters that manually divide milliseconds or seconds into hours, minutes, and seconds with unit labels.

**Skip / keep as-is when (`dropWhen`):**

- Code already utilizing native Intl.DurationFormat or Temporal.Duration for formatted duration strings.
- Guarded by runtime feature detection for Intl.DurationFormat or globalThis.Temporal.
- Formatting fixed calendar dates or timestamps (such as Intl.DateTimeFormat or moment(date).format("YYYY-MM-DD")) rather than elapsed durations.

## performance

### `deliver-optimized-decorative-images`

Guide: [`deliver-optimized-decorative-images`](../guides/performance/deliver-optimized-decorative-images.md)

CSS background or mask images using -webkit-image-set() without standard image-set() should be modernized with CSS image-set() format and resolution negotiation.

**Flag and modernize when (`keepWhen`):**

- A CSS rule uses vendor-prefixed -webkit-image-set() on background, background-image, content, or mask properties without providing standard image-set().
- A CSS declaration delivers resolution-dependent background or mask images solely through -webkit-image-set(...).

**Skip / keep as-is when (`dropWhen`):**

- The rule or stylesheet already provides standard image-set() alongside or following -webkit-image-set().
- The image is responsive content markup using HTML <img> srcset/sizes or <picture> elements rather than CSS background image-set().
- The declaration is a standard single-url background-image: url(...) without resolution or format negotiation.

### `flicker-free-client-side-ab-testing`

Guide: [`flicker-free-client-side-ab-testing`](../guides/performance/flicker-free-client-side-ab-testing.md)

Replace legacy .async-hide { opacity: 0 !important } anti-flicker snippets with <script async blocking="render"> in <head>.

**Flag and modernize when (`keepWhen`):**

- A stylesheet or inline <style> defines a page-hiding anti-flicker rule (.async-hide { opacity: 0 !important } or .ab-loading { opacity: 0 }) without using blocking="render".

**Skip / keep as-is when (`dropWhen`):**

- The anti-flicker class is guarded as a fallback behind !Object.hasOwn(HTMLScriptElement.prototype, "blocking") alongside <script blocking="render">.
- Standard CSS opacity transitions, animations, or component-level loading states unrelated to full-page A/B test anti-flicker snippets.

## security

### `sanitize-untrusted-html/js-dompurify-innerhtml`

Guide: [`sanitize-untrusted-html`](../guides/security/sanitize-untrusted-html.md)

Sanitized untrusted markup assigned to DOM insertion sinks (.innerHTML = DOMPurify.sanitize(...)) can be modernized with native setHTML().

**Flag and modernize when (`keepWhen`):**

- Assigning sanitized untrusted markup to DOM insertion sinks via element.innerHTML = DOMPurify.sanitize(...) or insertAdjacentHTML.

**Skip / keep as-is when (`dropWhen`):**

- Code already utilizing native Element.prototype.setHTML() or Document.parseHTML() with Sanitizer configurations.
- Guarded by feature detection checks verifying "setHTML" in Element.prototype or typeof Sanitizer !== "undefined".
- React or JSX components using dangerouslySetInnerHTML={ { __html: ... } }, where React virtual DOM does not support native setHTML() without ref-based DOM manipulation.
- Server-side HTML sanitization pipelines in Node.js, CLI scripts, backend build tools, or SSR middleware where browser DOM Sanitizer API is not available.

### `secure-external-subresources`

Guide: [`secure-external-subresources`](../guides/security/secure-external-subresources.md)

Add Subresource Integrity (integrity="sha384-..."), crossorigin="anonymous", and referrerpolicy="no-referrer" to versioned third-party CDN <script> and <link rel="stylesheet"> elements.

**Flag and modernize when (`keepWhen`):**

- An HTML or JSX <script src="https://..."> or <link rel="stylesheet" href="https://..."> loads an immutable, version-pinned asset from a public third-party CDN (cdnjs.cloudflare.com, cdn.jsdelivr.net, unpkg.com, code.jquery.com, maxcdn.bootstrapcdn.com, stackpath.bootstrapcdn.com, ajax.googleapis.com) without an integrity attribute.
- An external cross-origin <script src="https://..."> or <link rel="stylesheet" href="https://..."> specifies integrity="sha..." but omits the required crossorigin="anonymous" attribute.

**Skip / keep as-is when (`dropWhen`):**

- The <script> or <link> element already includes both an integrity="sha256-... | sha384-... | sha512-..." attribute and a crossorigin attribute.
- The URL points to a mutable/unversioned endpoint (such as analytics tags, live widgets, or Google Fonts CSS) or a first-party same-origin asset.

## ui-atoms

### `icons`

Guide: [`icons`](../guides/ui-atoms/icons.md)

CSS rules chaining invert(), sepia(), saturate(), and hue-rotate() filters to recolor icons should be modernized with CSS mask icons (mask: url(...) and background-color: currentColor) or inline SVG fill="currentColor".

**Flag and modernize when (`keepWhen`):**

- A CSS rule chains filter: invert(...) sepia(...) saturate(...) hue-rotate(...) to approximate a specific color on an icon, button graphic, UI indicator, or SVG <img>.

**Skip / keep as-is when (`dropWhen`):**

- The filter is applied to photographs, video elements, avatars, or whole-page dark-mode inversion rather than recoloring a single-color UI icon or graphic.
- The stylesheet is a third-party userstyle or browser DevTools theme override (e.g. using :host-context(.-theme-with-dark-background), @-moz-document, or --override-color-* custom properties) where the author does not control the underlying icon DOM or image URL.
- The rule already uses CSS mask / mask-image for icon coloring.

## ui-behaviors

### `declarative-dialog-popover-control/click-listener`

Guide: [`declarative-dialog-popover-control`](../guides/ui-behaviors/declarative-dialog-popover-control.md)

Detect pure JS click event listeners that only call showModal(), close(), showPopover(), hidePopover(), or togglePopover().

**Flag and modernize when (`keepWhen`):**

- A click event listener is attached to a button solely to call 0-argument `.showModal()`, `.close()`, `.showPopover()`, `.hidePopover()`, or `.togglePopover()` on a static `<dialog>` or `[popover]` element without other side effects.

**Skip / keep as-is when (`dropWhen`):**

- The click listener performs additional logic (validation, network requests, analytics, classList or state updates) beyond opening/closing the dialog or popover.
- The click listener is attached to the dialog root, backdrop, overlay, or a non-button menu item rather than a `<button>` element, or uses `stopImmediatePropagation()` to suppress parent event delegation on a custom element.
- The listener passes a `returnValue` argument to `.close(arg)`.
- The listener calls a third-party library method like Bootstrap or jQuery `.modal("show")` or `.popover("toggle")`.

### `dynamic-sibling-animations`

Guide: [`dynamic-sibling-animations`](../guides/ui-behaviors/dynamic-sibling-animations.md)

Replace repetitive :nth-child(N) CSS rules that only set staggered animation-delay or transition-delay values with CSS sibling-index().

**Flag and modernize when (`keepWhen`):**

- A stylesheet defines 3 or more sequential :nth-child(1), :nth-child(2), :nth-child(3) rules on the same selector that only set staggered animation-delay or transition-delay values.
- The repetitive :nth-child delay rules can be collapsed into a single rule using calc(sibling-index() * <step>).

**Skip / keep as-is when (`dropWhen`):**

- The :nth-child rules set distinct per-child colors, positions, transforms, or custom properties (--i, --index) in addition to animation-delay.
- The stylesheet already uses sibling-index() or wraps the rules in an @supports fallback.

### `interest-triggered-tooltips/js-tooltip`

Guide: [`interest-triggered-tooltips`](../guides/ui-behaviors/interest-triggered-tooltips.md)

JavaScript tippy() hover tooltip calls should be modernized with declarative HTML interestfor, popover="hint", and CSS Anchor Positioning.

**Flag and modernize when (`keepWhen`):**

- JavaScript calls tippy(target, options) to attach hover/focus tooltips without interactive click menus.
- Custom mouseenter hover delay timeouts position tooltip div elements.

**Skip / keep as-is when (`dropWhen`):**

- The tippy() instance configures interactive: true or trigger: "click" for interactive menus or forms.
- The code uses native HTML title attributes, static pure-CSS [data-tooltip]::after tooltips, or is guarded by an interestfor / interesttarget check.

### `scroll-entry-exit-effects/js-scroll-reveal`

Guide: [`scroll-entry-exit-effects`](../guides/ui-behaviors/scroll-entry-exit-effects.md)

JavaScript scroll-reveal calls (AOS.init, ScrollReveal().reveal, new WOW().init) should be modernized with CSS Scroll-Driven Animations (animation-timeline: view() and animation-range: entry, exit).

**Flag and modernize when (`keepWhen`):**

- JavaScript initializes AOS.init(), calls ScrollReveal().reveal(), or invokes new WOW().init() to trigger element entry/exit animations on scroll without a CSS.supports("animation-timeline", "view()") fallback guard.
- Scroll listeners or IntersectionObserver callbacks toggle reveal classes solely to fade or slide elements entering or leaving the viewport.

**Skip / keep as-is when (`dropWhen`):**

- The JavaScript scroll-reveal logic is inside a !CSS.supports("animation-timeline", "view()") or !CSS.supports("(animation-timeline: view()) and (animation-range: entry)") fallback guard.
- The observer or listener performs lazy data fetching, infinite scrolling, or analytics impression tracking rather than visual entry/exit animations.

### `scroll-entry-exit-effects/package-scroll-reveal`

Guide: [`scroll-entry-exit-effects`](../guides/ui-behaviors/scroll-entry-exit-effects.md)

Legacy scroll-reveal packages (aos, scrollreveal, sal.js, wowjs) should be modernized with CSS Scroll-Driven Animations (animation-timeline: view() and animation-range: entry, exit).

**Flag and modernize when (`keepWhen`):**

- A project declares aos, scrollreveal, sal.js, or wowjs in package.json dependencies to animate elements as they enter or exit the viewport during scrolling.

**Skip / keep as-is when (`dropWhen`):**

- The animation is guarded by @supports ((animation-timeline: view()) and (animation-range: entry)) or CSS.supports("animation-timeline", "view()") as a progressive enhancement fallback.
- The code implements non-scroll hover, focus, or initial page-load entrance animations unrelated to scrollport entry and exit.

## ui-components

### `checkbox`

Guide: [`checkbox`](../guides/ui-components/checkbox.md)

Hiding native checkboxes with opacity: 0 or drawing replacement boxes on sibling label/span pseudo-elements should be modernized with native accent-color or appearance: none directly on <input type="checkbox">.

**Flag and modernize when (`keepWhen`):**

- The CSS rule hides or strips a checkbox input (opacity: 0 or appearance: none on input[type="checkbox"], .custom-checkbox, or .custom-control-input) to delegate box rendering to a sibling (+ label, ~ label, + span, ::before, ::after) rather than styling the <input> directly.
- The CSS rule styles custom checkbox checkmark icons on sibling pseudo-elements (:checked + label::before / :checked + span::before) without using accent-color or direct input appearance: none.

**Skip / keep as-is when (`dropWhen`):**

- Modern custom checkboxes applying appearance: none directly on input[type="checkbox"] (styling &::before / :indeterminate::before on the input itself with no fake sibling box).
- Bare utility rules setting opacity: 0 or form resets stripping appearance across inputs with no sibling custom-box visual replacement.
- Custom toggle-switch components (role="switch", .switch, .toggle), star ratings, or CSS-only accordion/tab/disclosure hacks using :checked + label.
- The stylesheet already defines standard accent-color property declarations or guards the rule inside @supports (accent-color: ...).
- The selector is an accessible screen-reader utility class (.sr-only or .visually-hidden) that preserves keyboard accessibility and element geometry.

### `dark-mode-toggle`

Guide: [`dark-mode-toggle`](../guides/ui-components/dark-mode-toggle.md)

Dark mode toggles that persist theme overrides in localStorage and toggle root .dark classes or data-theme attributes should update <meta name="color-scheme"> ("light dark", "light", "dark") paired with CSS color-scheme and light-dark().

**Flag and modernize when (`keepWhen`):**

- JavaScript implements a user-facing dark/light theme override stored in localStorage and applies it by toggling a .dark/.dark-theme class or data-theme attribute on documentElement/body without updating <meta name="color-scheme">.

**Skip / keep as-is when (`dropWhen`):**

- The code already updates <meta name="color-scheme"> content ("light dark", "light", "dark").
- The code only reads matchMedia("(prefers-color-scheme: dark)") without a user toggle or localStorage override (covered by dark-mode).
- The code switches multi-brand or syntax-editor color palettes (e.g. Monaco/Ace editor themes) rather than light/dark page color scheme.

### `dialog`

Guide: [`dialog`](../guides/ui-components/dialog.md)

Manual backdrop click listeners dismissing <dialog> should be modernized with declarative <dialog closedby="any">.

**Flag and modernize when (`keepWhen`):**

- A click event listener attached to a <dialog> or modal checks event.target === dialog, event.target === event.currentTarget, or bounding box coordinates to dismiss the dialog via .close().
- A script implements manual light-dismiss for an HTML <dialog> element when clicking outside the content area on the backdrop.

**Skip / keep as-is when (`dropWhen`):**

- The listener is guarded by "closedBy" in HTMLDialogElement.prototype for progressive enhancement.
- The click handler is attached to a dedicated close button (.btn-close, [data-dismiss]) rather than the dialog backdrop.
- The dialog is opened as a non-modal dialog with .show() rather than .showModal().
- The listener handles custom menu or popover light dismiss covered by popover attribute.

### `progress`

Guide: [`progress`](../guides/ui-components/progress.md)

Custom determinate <div role="progressbar" aria-valuenow="..."> elements can be replaced with native HTML <progress> styled with CSS accent-color or progress pseudo-elements.

**Flag and modernize when (`keepWhen`):**

- HTML or component markup defines a non-semantic container (such as <div> or <span>) with role="progressbar" and aria-valuenow to render a linear determinate progress bar.

**Skip / keep as-is when (`dropWhen`):**

- The element is already a native <progress> element.
- The element is a circular SVG progress ring using <svg>/<circle> and stroke-dasharray/stroke-dashoffset (covered by progress-ring).
- The element is an indeterminate loading spinner without aria-valuenow (covered by spinner).
- The progress bar is a multi-segment stacked bar chart with multiple distinct colored series inside a single track.

### `scrollspy`

Guide: [`scrollspy`](../guides/ui-components/scrollspy.md)

Legacy Bootstrap data-spy="scroll" or data-bs-spy="scroll" attributes should be modernized with CSS scroll-target-group: auto and :target-current.

**Flag and modernize when (`keepWhen`):**

- DOM element specifies legacy Bootstrap data-spy="scroll" or data-bs-spy="scroll" attribute (or scrollspy classes with data-target/data-bs-target) to highlight active navigation links based on scroll position.
- JavaScript initializes a scrollspy plugin via $(...).scrollspy(...) or new bootstrap.ScrollSpy(...).
- JavaScript scroll event listener measures section positions (offsetTop, getBoundingClientRect().top, scrollY, pageYOffset) to compute the active section and toggle "active" class or aria-current on navigation links.
- IntersectionObserver callback tracks section visibility to toggle active or aria-current states on navigation or TOC links.

**Skip / keep as-is when (`dropWhen`):**

- The navigation container or stylesheet already implements CSS scroll-target-group: auto and :target-current.
- The scroll event listener handles unrelated scroll behaviors such as infinite scroll loading, scroll-to-top floating button visibility, parallax canvas animations, or reading progress bars.
- IntersectionObserver is used for lazy loading images, infinite scrolling, or animation entry triggers without managing active navigation link state.
- Complex multi-container scroll coordinators or custom interactive graph navigators with non-linear section hierarchies that cannot map to fragment links.

## visual-design

### `custom-text-decorations`

Guide: [`custom-text-decorations`](../guides/visual-design/custom-text-decorations.md)

Use native CSS text-decoration shorthand, text-decoration-thickness, and text-underline-offset instead of border-bottom and padding-bottom underline hacks.

**Flag and modernize when (`keepWhen`):**

- CSS border-bottom and padding-bottom underline simulation on inline text or link selectors paired with text-decoration: none
- CSS linear-gradient underline background hacks on inline text or link elements paired with text-decoration: none

**Skip / keep as-is when (`dropWhen`):**

- Block-level container borders (cards, tables, panels, modals, headers, footers)
- Tab navigation component active state indicators (.tab, [role="tab"])
- Rule declaring display: block, flex, or grid
- Rule already declaring text-underline-offset or text-decoration-thickness

### `customize-scrollbar-color-and-thickness`

Guide: [`customize-scrollbar-color-and-thickness`](../guides/visual-design/customize-scrollbar-color-and-thickness.md)

Vendor ::-webkit-scrollbar pseudo-elements customize or hide scrollbars; use standard scrollbar-color and scrollbar-width (including scrollbar-width: none) instead.

**Flag and modernize when (`keepWhen`):**

- The CSS rule uses vendor pseudo-elements (::-webkit-scrollbar or ::-webkit-scrollbar-thumb) to customize scrollbar dimensions/thumb colors or to hide scrollbars (display: none, width: 0, height: 0).
- The custom or hidden scrollbar styling is implemented without declaring standard scrollbar-color or scrollbar-width (such as scrollbar-width: none) CSS properties.

**Skip / keep as-is when (`dropWhen`):**

- The stylesheet already defines standard scrollbar-width or scrollbar-color properties.
- The rule only resets scrollbar properties using CSS cascade keywords (auto, inherit, initial, unset, revert) or sets transparent thumb backgrounds without hiding ::-webkit-scrollbar.
- The rule sets a CSS gradient (linear-gradient, radial-gradient, -webkit-gradient), image, or box-shadow (-webkit-box-shadow) on ::-webkit-scrollbar-thumb or ::-webkit-scrollbar-track, styles visible ::-webkit-scrollbar-button arrows, or styles ::-webkit-scrollbar thickness when the accompanying ::-webkit-scrollbar-thumb uses gradients, images, box-shadow, backdrop-filter, or transparent backgrounds.
- The rule targets ::-webkit-scrollbar for non-zero sizing without custom thumb styling, or only sets border-radius without color, thickness, or hiding.
- The rule is inside a CSS reset stylesheet, targets a third-party custom JS scrollbar widget container that hides native scrollbars to render synthetic DOM scrollbars, or is inside an @supports not (scrollbar-width: ...) / @supports not (scrollbar-color: ...) fallback block.

### `dark-mode`

Guide: [`dark-mode`](../guides/visual-design/dark-mode.md)

Stylesheets overriding colors in @media (prefers-color-scheme: dark) without color-scheme should use color-scheme: light dark and light-dark().

**Flag and modernize when (`keepWhen`):**

- CSS rules duplicate theme properties inside @media (prefers-color-scheme: dark) without declaring color-scheme: light dark or using light-dark() CSS color tokens.
- Component styles override foreground, background, or border colors within prefers-color-scheme media blocks without root color-scheme enablement.

**Skip / keep as-is when (`dropWhen`):**

- The stylesheet already declares color-scheme: light dark on :root, html, or container elements.
- The stylesheet utilizes light-dark() color functions for automatic color switching.
- The media query is inside an external print stylesheet or handles high-contrast forced-colors mode overrides.

### `equal-width-text-lines/js-fittext`

Guide: [`equal-width-text-lines`](../guides/visual-design/equal-width-text-lines.md)

Imperative text-fitting script calls (fitty, fitText, $.fitText) should be modernized with native CSS text-fit: grow per-line-all.

**Flag and modernize when (`keepWhen`):**

- Imperative JavaScript invokes fitty(), fitText(), or jQuery .fitText() to scale text or heading elements to fit their container width (including calls passing compressor numbers or minFontSize/maxFontSize bounds) without a CSS.supports("text-fit", ...) guard.
- A script dynamically computes font-size scaling factors across text or heading elements using clientWidth or offsetWidth measurements.

**Skip / keep as-is when (`dropWhen`):**

- The call is guarded by CSS.supports("text-fit", ...) or a progressive enhancement fallback check.
- The call explicitly sets single-line mode (multiLine: false, singleLine: true, maxLines: 1, white-space: nowrap) or targets a Reveal.js .r-fit-text slide element.
- The script curves text along a circular path (CircleType) or measures canvas, chart, or video dimensions rather than DOM typography.
- The sizing uses pure CSS fluid viewport units (clamp, vw, cqi) without imperative JS text-fitting calls.

### `improve-text-layout-and-legibility/js-text-balance`

Guide: [`improve-text-layout-and-legibility`](../guides/visual-design/improve-text-layout-and-legibility.md)

JavaScript balanceText() calls and <Balancer> components should be modernized with native CSS text-wrap: balance and text-wrap: pretty.

**Flag and modernize when (`keepWhen`):**

- JavaScript calls balanceText(...) or renders <Balancer> from react-wrap-balancer to balance heading or text line breaks in the browser.

**Skip / keep as-is when (`dropWhen`):**

- The balanceText() call is guarded by a CSS.supports("text-wrap", "balance") fallback check.
- The code uses native CSS text-wrap: balance / pretty or performs server-side typographic preprocessing.

### `improve-text-layout-and-legibility/package-text-balance`

Guide: [`improve-text-layout-and-legibility`](../guides/visual-design/improve-text-layout-and-legibility.md)

Client-side text-balancing packages (react-wrap-balancer, balance-text) should be modernized with CSS text-wrap: balance and text-wrap: pretty.

**Flag and modernize when (`keepWhen`):**

- A project declares react-wrap-balancer, balance-text, or vue-wrap-balancer in package.json dependencies to balance heading or paragraph line lengths.

**Skip / keep as-is when (`dropWhen`):**

- The project already uses native CSS text-wrap: balance or text-wrap: pretty.
- The code performs server-side typographic preprocessing rather than client-side DOM line balancing.

### `soft-edge-content-fade`

Guide: [`soft-edge-content-fade`](../guides/visual-design/soft-edge-content-fade.md)

CSS rules with -webkit-mask-image: linear-gradient(...) without standard mask-image should include unprefixed mask-image: linear-gradient(...).

**Flag and modernize when (`keepWhen`):**

- A CSS rule declares -webkit-mask-image or -webkit-mask with linear-gradient(...) or -webkit-gradient(linear, ...) transitioning to transparent (or alpha 0) without declaring standard unprefixed mask-image or mask.
- Absolute positioned overlay divs with linear-gradient backgrounds and pointer-events: none fade out scroll container edges.

**Skip / keep as-is when (`dropWhen`):**

- The CSS rule already declares standard mask-image: linear-gradient(...) or mask alongside -webkit-mask-image.
- The gradient has uniform non-zero opacity stops (e.g. from(rgba(0,0,0,0.7)), to(rgba(0,0,0,0.7))) used for flat dark-mode image dimming rather than edge fading.
- The rule uses SVG clipping paths (clip-path) or canvas blend modes rather than gradient edge fading.
