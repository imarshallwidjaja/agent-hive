/**
 * The exploration tab's document. The host sends the record only through `postMessage`, so no recorded text is ever
 * part of this HTML, and the script builds every element with `textContent`. The policy allows only this document's
 * nonce-tagged style and script: no network, images, frames, forms or other sources.
 */
export function renderExplorationHtml(nonce: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Exploration</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<main id="app" aria-busy="true"><p class="loading">Reading the exploration record...</p></main>
<div id="announcer" class="visually-hidden" aria-live="polite"></div>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
}

const STYLE = `
body.vscode-light, body.vscode-high-contrast-light { color-scheme: light; }
body.vscode-dark, body.vscode-high-contrast:not(.vscode-high-contrast-light) { color-scheme: dark; }
body {
  margin: 0;
  padding: 0 1.25rem 2rem;
  font-family: var(--vscode-font-family, system-ui, sans-serif);
  font-size: var(--vscode-font-size, 13px);
  line-height: 1.5;
  color: var(--vscode-foreground, CanvasText);
  background: var(--vscode-editor-background, Canvas);
  overflow-wrap: anywhere;
}
::selection { background: var(--vscode-editor-selectionBackground, Highlight); }
code { font-family: var(--vscode-editor-font-family, ui-monospace, monospace); font-size: 0.92em; overflow-wrap: anywhere; }
:focus-visible { outline: 2px solid var(--vscode-focusBorder, Highlight); outline-offset: 2px; }
.visually-hidden { position: absolute; inline-size: 1px; block-size: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.loading, .muted, .frame-note, .untrusted, .hint, .chain-hint { color: var(--vscode-descriptionForeground, GrayText); }
h1.goal { font-size: 1.4em; font-weight: 600; line-height: 1.3; margin: 1.25rem 0 0.75rem; max-inline-size: 72ch; text-wrap: balance; }
.facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 0.1rem 1rem; margin: 0 0 0.75rem; }
.facts dt { color: var(--vscode-descriptionForeground, GrayText); }
.facts dd { margin: 0; min-inline-size: 0; }
.live { margin: 0 0 0.25rem; max-inline-size: 80ch; }
.live strong { font-weight: 600; }
.changes { margin: 0 0 0.25rem; color: var(--vscode-textLink-foreground, LinkText); }
.closure { margin: 1rem 0; max-inline-size: 76ch; }
.closure h2 { font-size: 1em; font-weight: 600; margin: 0 0 0.25rem; }
.prose { white-space: pre-wrap; margin: 0; max-inline-size: 76ch; }
.actions { display: flex; flex-wrap: wrap; gap: 0.5rem; margin: 0.75rem 0; }
button { font: inherit; }
button.action {
  color: var(--vscode-button-secondaryForeground, ButtonText);
  background: var(--vscode-button-secondaryBackground, ButtonFace);
  border: 1px solid var(--vscode-button-border, var(--vscode-contrastBorder, transparent));
  border-radius: 2px;
  padding: 0.25rem 0.75rem;
  min-block-size: 26px;
  max-inline-size: 100%;
  text-align: start;
  cursor: pointer;
}
button.action:hover { background: var(--vscode-button-secondaryHoverBackground, ButtonFace); }
.notice {
  margin: 0 0 0.75rem;
  padding: 0.4rem 0.75rem;
  color: var(--vscode-inputValidation-warningForeground, inherit);
  background: var(--vscode-inputValidation-warningBackground, transparent);
  border: 1px solid var(--vscode-inputValidation-warningBorder, CanvasText);
  max-inline-size: 76ch;
}
.untrusted { margin: 0 0 1.25rem; font-size: 0.92em; max-inline-size: 80ch; }
.layout { display: grid; grid-template-columns: minmax(0, 1fr) clamp(15em, 32%, 24em); gap: 1.5rem; align-items: start; }
.map { min-inline-size: 0; }
.frame { border: 1px solid var(--vscode-panel-border, GrayText); padding: 0.75rem 1rem 1rem; margin: 0 0 1.25rem; min-inline-size: 0; }
.frame-title { font-size: 1.05em; font-weight: 600; margin: 0; }
.frame-note { margin: 0.15rem 0 0.75rem; max-inline-size: 76ch; }
.subhead { font-size: 1em; font-weight: 600; margin: 1rem 0 0.5rem; }
.empty { margin: 0; color: var(--vscode-descriptionForeground, GrayText); }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(14em, 100%), 1fr)); gap: 0.5rem; }
button.node {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 0.15rem 0.5rem;
  align-content: start;
  min-inline-size: 0;
  text-align: start;
  color: var(--vscode-editorWidget-foreground, var(--vscode-foreground, CanvasText));
  background: var(--vscode-editorWidget-background, Canvas);
  border: 1px solid var(--vscode-widget-border, var(--vscode-contrastBorder, var(--vscode-panel-border, GrayText)));
  border-radius: 3px;
  padding: 0.45rem 0.6rem;
  min-block-size: 2.75rem;
  cursor: pointer;
}
button.node:hover {
  color: var(--vscode-list-hoverForeground, var(--vscode-editorWidget-foreground, var(--vscode-foreground, CanvasText)));
  background: var(--vscode-list-hoverBackground, Canvas);
}
button.node[aria-pressed="true"] {
  color: var(--vscode-list-activeSelectionForeground, var(--vscode-foreground, CanvasText));
  background: var(--vscode-list-activeSelectionBackground, Canvas);
  border-color: var(--vscode-list-activeSelectionForeground, var(--vscode-contrastActiveBorder, CanvasText));
}
button.node[aria-pressed="true"] .node-meta, button.node[aria-pressed="true"] .changed-tag { color: inherit; }
button.node.changed { border-style: dashed; border-color: var(--vscode-charts-blue, LinkText); }
.node-label { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.node-meta { grid-column: 2; display: flex; flex-wrap: wrap; gap: 0.1rem 0.6rem; font-size: 0.92em; color: var(--vscode-descriptionForeground, GrayText); }
.changed-tag { color: var(--vscode-textLink-foreground, LinkText); font-weight: 600; }
.selected-tag { font-weight: 600; }
.marker { inline-size: 0.7rem; block-size: 0.7rem; margin-block-start: 0.3em; box-sizing: border-box; border: 2px solid currentColor; }
.state-open .marker { border-radius: 50%; color: var(--vscode-charts-yellow, CanvasText); }
.state-covered .marker { border-radius: 50%; color: var(--vscode-charts-green, CanvasText); background: currentColor; }
.state-blocked .marker { color: var(--vscode-charts-red, CanvasText); background: currentColor; }
.state-dropped .marker { color: var(--vscode-disabledForeground, GrayText); }
.state-dropped .node-label { opacity: 0.85; }
.status-confirmed .marker, .status-hypothesis .marker, .status-refuted .marker { transform: rotate(45deg) scale(0.85); }
.status-confirmed .marker { color: var(--vscode-charts-green, CanvasText); background: currentColor; }
.status-hypothesis .marker { color: var(--vscode-charts-yellow, CanvasText); }
.status-refuted .marker { color: var(--vscode-charts-red, CanvasText); }
.chain-scroll { overflow-x: auto; margin: 0 -6px 0.25rem; padding: 6px; }
.chain-scroll.overflowing { border-inline: 1px dashed var(--vscode-descriptionForeground, GrayText); }
.chain { position: relative; display: grid; gap: 0.5rem 3em; align-items: center; min-inline-size: min-content; }
.chain-hint { margin: 0 0 0.75rem; font-size: 0.92em; }
.chain-hint[hidden] { display: none; }
.edges { position: absolute; inset: 0; inline-size: 100%; block-size: 100%; overflow: visible; pointer-events: none; color: var(--vscode-descriptionForeground, GrayText); }
.edges path.edge { fill: none; stroke: currentColor; stroke-width: 1.5; }
.edges path.head { fill: currentColor; }
.detail {
  position: sticky;
  inset-block-start: 0.75rem;
  max-block-size: calc(100vh - 1.5rem);
  overflow: auto;
  color: var(--vscode-editorWidget-foreground, var(--vscode-foreground, CanvasText));
  background: var(--vscode-editorWidget-background, transparent);
  border: 1px solid var(--vscode-widget-border, var(--vscode-contrastBorder, var(--vscode-panel-border, GrayText)));
  padding: 0.75rem 1rem;
}
.detail h2 { font-size: 1em; font-weight: 600; margin: 0 0 0.5rem; }
.detail h3 { font-size: 1em; font-weight: 600; margin: 1rem 0 0.25rem; }
.detail-title { font-weight: 600; margin: 0 0 0.75rem; }
.detail dl { margin: 0; }
.detail dt { color: var(--vscode-descriptionForeground, GrayText); margin-block-start: 0.5rem; }
.detail dd { margin: 0; }
.relation { display: flex; flex-wrap: wrap; gap: 0.35rem; padding: 2px; }
.refs { margin: 0.25rem 0 0; padding-inline-start: 1.25rem; }
.refs li { margin: 0.15rem 0; }
.hint { margin: 0; font-size: 0.92em; }
@media (max-width: 640px) {
  .layout { grid-template-columns: minmax(0, 1fr); }
  .detail { position: static; max-block-size: none; }
}
@media (max-width: 420px) {
  body { padding: 0 0.6rem 1.5rem; }
  .frame { padding: 0.5rem 0.6rem 0.75rem; }
  .facts { grid-template-columns: minmax(0, 1fr); }
  .facts dd { margin-block-end: 0.25rem; }
}
@media (forced-colors: active) {
  :focus-visible { outline-color: CanvasText; }
  button.node[aria-pressed="true"] { forced-color-adjust: none; color: HighlightText; background: Highlight; border-color: HighlightText; }
  .marker { forced-color-adjust: none; color: CanvasText; }
  button.node[aria-pressed="true"] .marker { color: HighlightText; }
  .edges { color: CanvasText; }
}
`;

const SCRIPT = `
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  const announcer = document.getElementById('announcer');
  const TARGET_STATES = { open: 'Open', covered: 'Covered', blocked: 'Blocked', dropped: 'Dropped' };
  const OBSERVATION_STATUSES = { confirmed: 'Confirmed', hypothesis: 'Hypothesis', refuted: 'Refuted' };
  const EXPLORATION_STATUSES = { active: 'Active', concluded: 'Concluded', abandoned: 'Abandoned' };
  const NAVIGATION_KEYS = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'];

  // What the tab restores after an update, and after VS Code discards the hidden webview and loads it again.
  const saved = vscode.getState() || {};
  const view = {
    selected: typeof saved.selected === 'string' ? saved.selected : null,
    focus: typeof saved.focus === 'string' ? saved.focus : null,
    scroll: readScroll(saved.scroll),
  };
  let model = null;
  let nodes = new Map();
  let edgeSets = [];
  let firstRender = true;
  let markerCount = 0;

  /** Chain scroll positions keyed by the chain's root observation key, which may be any recorded text. */
  function chainMap() { return Object.create(null); }

  function readScroll(value) {
    const scroll = { page: 0, detail: 0, chains: chainMap() };
    if (!value || typeof value !== 'object') return scroll;
    if (typeof value.page === 'number') scroll.page = value.page;
    if (typeof value.detail === 'number') scroll.detail = value.detail;
    if (value.chains && typeof value.chains === 'object') {
      for (const key of Object.keys(value.chains)) if (typeof value.chains[key] === 'number') scroll.chains[key] = value.chains[key];
    }
    return scroll;
  }

  function el(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined && text !== null) element.textContent = String(text);
    return element;
  }

  function byFocusKey(key) {
    return Array.from(app.querySelectorAll('[data-focus-key]')).find(function (e) { return e.dataset.focusKey === key; });
  }

  function focusInside() {
    const active = document.activeElement;
    return !!active && active !== app && app.contains(active);
  }

  function focusedKey() {
    return focusInside() && document.activeElement.dataset ? document.activeElement.dataset.focusKey || null : null;
  }

  function currentScroll() {
    const scroll = { page: window.scrollY, detail: 0, chains: chainMap() };
    const detail = document.getElementById('detail');
    if (detail) scroll.detail = detail.scrollTop;
    for (const chain of Array.from(app.querySelectorAll('.chain-scroll'))) scroll.chains[chain.dataset.chain] = chain.scrollLeft;
    return scroll;
  }

  function persist() {
    // Before the first render the document holds nothing to read, so the saved place is kept as it was.
    if (!firstRender) {
      if (model) view.scroll = currentScroll();
      view.focus = focusedKey();
    }
    vscode.setState({ selected: view.selected, focus: view.focus, scroll: view.scroll });
  }

  let persistQueued = false;
  function schedulePersist() {
    if (persistQueued) return;
    persistQueued = true;
    requestAnimationFrame(function () { persistQueued = false; persist(); });
  }
  // Scroll events do not bubble, so one capturing listener sees the page, the details pane and every chain.
  document.addEventListener('scroll', schedulePersist, { capture: true, passive: true });
  document.addEventListener('focusin', persist);
  // VS Code discards a hidden tab's webview; save its place before it goes.
  document.addEventListener('visibilitychange', persist);
  window.addEventListener('pagehide', persist);

  function announce(text) {
    announcer.textContent = '';
    requestAnimationFrame(function () { announcer.textContent = text; });
  }

  function actionButton(label, focusKey, onClick) {
    const button = el('button', 'action', label);
    button.type = 'button';
    button.dataset.focusKey = focusKey;
    button.addEventListener('click', onClick);
    return button;
  }

  function refreshButton() {
    return actionButton('Refresh', 'refresh', function () { vscode.postMessage({ type: 'refresh' }); });
  }

  function fact(list, term, value, asCode) {
    list.append(el('dt', '', term));
    const dd = el('dd');
    dd.append(asCode ? el('code', '', value) : document.createTextNode(value));
    list.append(dd);
  }

  function nodeKey(kind, key) { return kind + ':' + key; }

  function settledCount(counts) { return counts.covered + counts.blocked + counts.dropped; }

  function header(m) {
    const head = el('header', 'head');
    head.append(el('h1', 'goal', m.goal));
    const facts = el('dl', 'facts');
    fact(facts, 'Exploration', m.id, true);
    if (m.subject) fact(facts, 'Subject', m.subject);
    fact(facts, 'Status', EXPLORATION_STATUSES[m.status] || m.status);
    fact(facts, 'Revision', String(m.revision));
    fact(facts, 'Last update', m.updatedAt + ' by ' + m.updatedBy);
    fact(facts, 'Created', m.createdAt);
    if (m.closure) fact(facts, 'Closed', m.closure.closedAt);
    let progress = settledCount(m.counts) + ' of ' + m.counts.frontierTotal + ' targets settled; ' + m.counts.observationsTotal + ' observations';
    if (m.status === 'active' && m.stagnantRevisions > 0) progress += '; ' + m.stagnantRevisions + ' revisions since recorded progress';
    fact(facts, 'Progress', progress);
    head.append(facts);

    const live = el('p', 'live');
    if (m.status === 'active') {
      live.append(el('strong', '', 'Live. '), document.createTextNode('This tab reads the record again when its file changes and when you return to it. It shows what agents recorded, not whether an agent is still working.'));
    } else {
      live.append(el('strong', '', 'Closed. '), document.createTextNode('This exploration is final and its record no longer changes. A follow-up is a new exploration that names it as prior.'));
    }
    head.append(live);
    if (m.changedSince !== null) {
      const changed = m.targets.filter(function (t) { return t.changed; }).length + m.observations.filter(function (o) { return o.changed; }).length;
      head.append(el('p', 'changes', changed > 0
        ? 'Dashed outlines mark ' + changed + (changed === 1 ? ' item' : ' items') + ' changed after revision ' + m.changedSince + '.'
        : 'Revision ' + m.revision + ' recorded no target or observation change since revision ' + m.changedSince + '.'));
    }
    if (m.closure) {
      const closure = el('section', 'closure');
      closure.append(el('h2', '', m.closure.label), el('p', 'prose', m.closure.text));
      head.append(closure);
    }
    const actions = el('div', 'actions');
    actions.append(refreshButton());
    if (m.priorExplorationId) {
      const prior = actionButton('', 'prior', function () { vscode.postMessage({ type: 'openPrior' }); });
      prior.append(document.createTextNode('Open prior exploration '), el('code', '', m.priorExplorationId));
      actions.append(prior);
    }
    head.append(actions);
    const notice = el('p', 'notice');
    notice.hidden = true;
    head.append(notice, el('p', 'untrusted', m.untrustedNotice));
    return head;
  }

  function nodeButton(kind, key, classes, label, meta, changedRevision) {
    const button = el('button', 'node ' + classes);
    button.type = 'button';
    button.tabIndex = -1;
    button.dataset.focusKey = nodeKey(kind, key);
    button.setAttribute('aria-pressed', 'false');
    const marker = el('span', 'marker');
    marker.setAttribute('aria-hidden', 'true');
    const metaRow = el('span', 'node-meta');
    for (const part of meta) metaRow.append(part);
    if (changedRevision !== null) metaRow.append(el('span', 'changed-tag', 'Changed in revision ' + changedRevision));
    // A visible word, so selection never depends on colour and stays distinct from the focus outline.
    const selectedTag = el('span', 'selected-tag', 'Selected');
    selectedTag.setAttribute('aria-hidden', 'true');
    selectedTag.hidden = true;
    metaRow.append(selectedTag);
    button.append(marker, el('span', 'node-label', label), metaRow);
    button.addEventListener('click', function () { select(button.dataset.focusKey, false); });
    return button;
  }

  function targetButton(t) {
    const state = TARGET_STATES[t.state] ? t.state : 'unknown';
    return nodeButton('t', t.key, 'target state-' + state + (t.changed ? ' changed' : ''), t.target,
      [el('span', '', TARGET_STATES[t.state] || t.state), el('code', '', t.key)], t.changed ? t.updatedRevision : null);
  }

  function observationButton(o) {
    const status = OBSERVATION_STATUSES[o.status] ? o.status : 'unknown';
    const meta = [el('span', '', OBSERVATION_STATUSES[o.status] || o.status), el('code', '', o.key)];
    if (o.supersedes !== null) meta.push(el('span', '', 'Supersedes ' + o.supersedes));
    if (o.supersededBy.length) meta.push(el('span', '', 'Superseded by ' + o.supersededBy.join(', ')));
    return nodeButton('o', o.key, 'observation status-' + status + (o.changed ? ' changed' : ''), o.summary, meta, o.changed ? o.updatedRevision : null);
  }

  function nodeGroup(label, focusKey, className) {
    const group = el('div', className || '');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', label);
    group.dataset.group = focusKey;
    group.addEventListener('keydown', function (event) {
      // Modified keys stay with the editor and the browser, for their own shortcuts.
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (!NAVIGATION_KEYS.includes(event.key)) return;
      const buttons = Array.from(group.querySelectorAll('button.node'));
      const index = buttons.indexOf(document.activeElement);
      if (index < 0) return;
      event.preventDefault();
      let next = index;
      if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = buttons.length - 1;
      else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = Math.min(buttons.length - 1, index + 1);
      else next = Math.max(0, index - 1);
      select(buttons[next].dataset.focusKey, true);
    });
    return group;
  }

  /**
   * Observations joined by supersedes links. Each supersedes at most one other and the host's record has no cycles, so
   * the links form a forest: one memoized walk gives every observation its tree root and its depth below it.
   */
  function supersedesForest(observations) {
    const byKey = new Map(observations.map(function (o) { return [o.key, o]; }));
    const placed = new Map();
    function walk(o) {
      let place = placed.get(o.key);
      if (place) return place;
      const target = o.supersedes !== null ? byKey.get(o.supersedes) : undefined;
      if (target) {
        const above = walk(target);
        place = { root: above.root, depth: above.depth + 1 };
      } else {
        place = { root: o.key, depth: 0 };
      }
      placed.set(o.key, place);
      return place;
    }
    const trees = new Map();
    for (const o of observations) {
      const place = walk(o);
      if (!trees.has(place.root)) trees.set(place.root, []);
      trees.get(place.root).push({ item: o, depth: place.depth });
    }
    const linked = [];
    const unlinked = [];
    for (const [root, members] of trees) {
      if (members.length === 1) unlinked.push(members[0].item);
      else linked.push({ root: root, members: members });
    }
    return { linked: linked, unlinked: unlinked };
  }

  function svgElement(name) { return document.createElementNS('http://www.w3.org/2000/svg', name); }

  function chainView(tree) {
    const scroll = el('div', 'chain-scroll');
    scroll.dataset.chain = tree.root;
    const chain = el('div', 'chain');
    const columns = Math.max.apply(null, tree.members.map(function (m) { return m.depth; })) + 1;
    chain.style.gridTemplateColumns = 'repeat(' + columns + ', minmax(min(13em, 70vw), 18em))';
    const svg = svgElement('svg');
    svg.setAttribute('class', 'edges');
    svg.setAttribute('aria-hidden', 'true');
    const markerId = 'supersedes-head-' + (++markerCount);
    const defs = svgElement('defs');
    const marker = svgElement('marker');
    marker.setAttribute('id', markerId);
    marker.setAttribute('viewBox', '0 0 10 10');
    marker.setAttribute('refX', '9');
    marker.setAttribute('refY', '5');
    marker.setAttribute('markerWidth', '7');
    marker.setAttribute('markerHeight', '7');
    marker.setAttribute('orient', 'auto');
    const head = svgElement('path');
    head.setAttribute('class', 'head');
    head.setAttribute('d', 'M0,0 L10,5 L0,10 z');
    marker.append(head);
    defs.append(marker);
    svg.append(defs);
    const rows = new Map();
    const buttons = new Map();
    const ordered = tree.members.slice().sort(function (a, b) { return a.depth - b.depth; });
    for (const member of ordered) {
      const button = observationButton(member.item);
      const row = (rows.get(member.depth) || 0) + 1;
      rows.set(member.depth, row);
      button.style.gridColumn = String(member.depth + 1);
      button.style.gridRow = String(row);
      buttons.set(member.item.key, button);
      chain.append(button);
    }
    // One path per link, made once; layout changes only move it.
    const edges = [];
    for (const member of tree.members) {
      const to = member.item.supersedes !== null ? buttons.get(member.item.supersedes) : undefined;
      if (!to) continue;
      const path = svgElement('path');
      path.setAttribute('class', 'edge');
      path.setAttribute('marker-end', 'url(#' + markerId + ')');
      svg.append(path);
      edges.push({ from: buttons.get(member.item.key), to: to, path: path });
    }
    chain.append(svg);
    scroll.append(chain);
    const hint = el('p', 'chain-hint', 'This chain is wider than the tab. Scroll it sideways, or move through its observations with the arrow keys.');
    hint.hidden = true;
    edgeSets.push({ scroll: scroll, chain: chain, edges: edges, hint: hint });
    const wrapper = el('div', 'chain-wrap');
    wrapper.append(scroll, hint);
    return wrapper;
  }

  /** Moves every link to its nodes' current boxes and marks chains wider than the tab. */
  function layoutChains() {
    for (const set of edgeSets) {
      const box = set.chain.getBoundingClientRect();
      for (const edge of set.edges) {
        const a = edge.from.getBoundingClientRect();
        const b = edge.to.getBoundingClientRect();
        const x1 = a.left - box.left;
        const y1 = a.top + a.height / 2 - box.top;
        const x2 = b.right - box.left;
        const y2 = b.top + b.height / 2 - box.top;
        const bend = Math.max(16, (x1 - x2) / 2);
        edge.path.setAttribute('d', 'M' + x1 + ',' + y1 + ' C' + (x1 - bend) + ',' + y1 + ' ' + (x2 + bend) + ',' + y2 + ' ' + (x2 + 1) + ',' + y2);
      }
      const overflowing = set.scroll.scrollWidth > set.scroll.clientWidth + 1;
      // A chain can take focus only while it scrolls; if it held focus when it stops scrolling, one of its nodes does.
      const heldFocus = document.activeElement === set.scroll;
      set.scroll.classList.toggle('overflowing', overflowing);
      set.hint.hidden = !overflowing;
      if (overflowing) {
        set.scroll.tabIndex = 0;
        set.scroll.dataset.focusKey = 'chain:' + set.scroll.dataset.chain;
        set.scroll.setAttribute('role', 'region');
        set.scroll.setAttribute('aria-label', 'Supersedes chain from ' + set.scroll.dataset.chain + ', scrolls sideways');
      } else {
        set.scroll.removeAttribute('tabindex');
        set.scroll.removeAttribute('role');
        set.scroll.removeAttribute('aria-label');
        delete set.scroll.dataset.focusKey;
        if (heldFocus) chainNode(set.scroll.dataset.chain).focus({ preventScroll: true });
      }
    }
  }
  new ResizeObserver(function () { layoutChains(); }).observe(app);

  function mapView(m) {
    const map = el('section', 'map');
    map.setAttribute('aria-label', 'Exploration map');
    const frontier = el('div', 'frame');
    frontier.append(el('h2', 'frame-title', 'Frontier'),
      el('p', 'frame-note', 'The targets this goal must settle, in recorded order. Targets carry no recorded links to each other, so none are drawn.'));
    if (m.targets.length) {
      const group = nodeGroup('Frontier targets', 'targets', 'grid');
      for (const t of m.targets) group.append(targetButton(t));
      frontier.append(group);
    } else {
      frontier.append(el('p', 'empty', 'No frontier targets recorded yet.'));
    }
    const observations = el('div', 'frame');
    observations.append(el('h2', 'frame-title', 'Observations'),
      el('p', 'frame-note', 'An arrow points from an observation to the one it supersedes. Each keeps the status it was recorded with.'));
    if (m.observations.length) {
      const group = nodeGroup('Observations', 'observations');
      const forest = supersedesForest(m.observations);
      if (forest.linked.length) {
        group.append(el('h3', 'subhead', 'Linked by supersedes'));
        for (const tree of forest.linked) group.append(chainView(tree));
      }
      if (forest.unlinked.length) {
        group.append(el('h3', 'subhead', 'Not linked'));
        const grid = el('div', 'grid');
        for (const o of forest.unlinked) grid.append(observationButton(o));
        group.append(grid);
      }
      observations.append(group);
    } else {
      observations.append(el('p', 'empty', 'No observations recorded yet.'));
    }
    map.append(frontier, observations);
    return map;
  }

  function references(container, refs) {
    container.append(el('h3', '', 'References'));
    if (!refs.length) {
      container.append(el('p', 'muted', 'None recorded.'));
      return;
    }
    container.append(el('p', 'hint', 'Shown as recorded text. The viewer does not open them.'));
    const list = el('ul', 'refs');
    for (const ref of refs) {
      const item = el('li');
      item.append(el('code', '', ref));
      list.append(item);
    }
    container.append(list);
  }

  function detailRow(list, term, value, prose) {
    if (value === null || value === undefined) return;
    list.append(el('dt', '', term));
    const dd = el('dd');
    if (typeof value === 'string') dd.append(prose ? el('p', 'prose', value) : document.createTextNode(value));
    else dd.append(value);
    list.append(dd);
  }

  function changedText(item) {
    let text = 'Revision ' + item.updatedRevision;
    if (item.changed && model.changedSince !== null) text += ', newer than revision ' + model.changedSince + ' shown before';
    return text;
  }

  function relationButton(key) {
    const button = actionButton('', 'relation:' + key, function () { select(nodeKey('o', key), true); });
    button.setAttribute('aria-label', 'Go to observation ' + key);
    button.append(el('code', '', key));
    return button;
  }

  function renderDetail() {
    const detail = document.getElementById('detail');
    if (!detail) return;
    const content = [];
    const selected = view.selected ? nodes.get(view.selected) : undefined;
    if (!selected) {
      content.push(el('h2', '', 'Details'), el('p', 'muted', 'Select a target or observation to read its question, evidence, reason and references.'));
    } else if (selected.kind === 'target') {
      const t = selected.item;
      const heading = el('h2', '', 'Target ');
      heading.append(el('code', '', t.key));
      const list = el('dl');
      detailRow(list, 'State', TARGET_STATES[t.state] || t.state);
      detailRow(list, 'Question', t.question, true);
      detailRow(list, 'Evidence', t.evidence, true);
      detailRow(list, 'Reason', t.reason, true);
      detailRow(list, 'Last changed', changedText(t));
      content.push(heading, el('p', 'detail-title', t.target), list);
    } else {
      const o = selected.item;
      const heading = el('h2', '', 'Observation ');
      heading.append(el('code', '', o.key));
      const list = el('dl');
      detailRow(list, 'Recorded status', OBSERVATION_STATUSES[o.status] || o.status);
      if (o.supersedes !== null) {
        const relation = el('div', 'relation');
        relation.append(relationButton(o.supersedes));
        detailRow(list, 'Supersedes', relation);
      }
      if (o.supersededBy.length) {
        const relation = el('div', 'relation');
        for (const key of o.supersededBy) relation.append(relationButton(key));
        detailRow(list, 'Superseded by', relation);
      }
      detailRow(list, 'Last changed', changedText(o));
      content.push(heading, el('p', 'detail-title prose', o.summary), list);
    }
    detail.replaceChildren.apply(detail, content);
    if (selected) references(detail, selected.item.refs);
  }

  function updateTabStops() {
    for (const group of Array.from(app.querySelectorAll('[role="group"]'))) {
      const buttons = Array.from(group.querySelectorAll('button.node'));
      const stop = buttons.find(function (b) { return b.dataset.focusKey === view.selected; }) || buttons[0];
      for (const button of buttons) {
        const selected = button.dataset.focusKey === view.selected;
        button.tabIndex = button === stop ? 0 : -1;
        button.setAttribute('aria-pressed', String(selected));
        button.querySelector('.selected-tag').hidden = !selected;
      }
    }
  }

  function select(key, focus) {
    if (!nodes.has(key)) return;
    view.selected = key;
    updateTabStops();
    renderDetail();
    const detail = document.getElementById('detail');
    if (detail) detail.scrollTop = 0;
    if (focus) {
      const button = byFocusKey(key);
      if (button) {
        button.focus();
        button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    }
    persist();
  }

  /** The first node of the chain rooted at an observation, which is the superseded end of the chain. */
  function chainNode(root) {
    const scroll = Array.from(app.querySelectorAll('.chain-scroll')).find(function (s) { return s.dataset.chain === root; });
    return scroll ? scroll.querySelector('button.node') : null;
  }

  /**
   * Where focus goes when the control it was on is gone: a chain's own first node, its group's tab stop, then the
   * details pane, then Refresh.
   */
  function focusFallback(key) {
    if (key && key.indexOf('chain:') === 0) {
      const node = chainNode(key.slice('chain:'.length));
      if (node) return node;
    }
    const group = key && key.indexOf('t:') === 0 ? 'targets' : key && (key.indexOf('o:') === 0 || key.indexOf('chain:') === 0) ? 'observations' : null;
    if (group) {
      const container = Array.from(app.querySelectorAll('[role="group"]')).find(function (g) { return g.dataset.group === group; });
      const stop = container && container.querySelector('button.node[tabindex="0"]');
      if (stop) return stop;
    }
    return document.getElementById('detail') || byFocusKey('refresh');
  }

  function restoreFocus(key, wasInside) {
    const target = key ? byFocusKey(key) : undefined;
    const next = target || (wasInside ? focusFallback(key) : undefined);
    if (next) next.focus({ preventScroll: true });
  }

  function restoreScroll(scroll) {
    for (const chain of Array.from(app.querySelectorAll('.chain-scroll'))) {
      const left = scroll.chains[chain.dataset.chain];
      if (typeof left === 'number') chain.scrollLeft = left;
    }
    const detail = document.getElementById('detail');
    if (detail) detail.scrollTop = scroll.detail;
    window.scrollTo(0, scroll.page);
  }

  function render(next, announcement) {
    // A tab loaded again after being hidden had focus inside it when it saved a focus key.
    const wasInside = focusInside() || (firstRender && view.focus !== null);
    const focus = firstRender ? view.focus : focusedKey();
    const scroll = firstRender || !model ? view.scroll : currentScroll();
    model = next;
    nodes = new Map();
    for (const t of next.targets) nodes.set(nodeKey('t', t.key), { kind: 'target', item: t });
    for (const o of next.observations) nodes.set(nodeKey('o', o.key), { kind: 'observation', item: o });
    if (view.selected && !nodes.has(view.selected)) view.selected = null;
    edgeSets = [];
    const layout = el('div', 'layout');
    const detail = el('aside', 'detail');
    detail.id = 'detail';
    detail.tabIndex = 0;
    detail.dataset.focusKey = 'detail';
    detail.setAttribute('aria-label', 'Selected item details');
    layout.append(mapView(next), detail);
    app.replaceChildren(header(next), layout);
    app.removeAttribute('aria-busy');
    document.title = 'Exploration ' + next.id;
    updateTabStops();
    renderDetail();
    layoutChains();
    restoreFocus(focus, wasInside);
    restoreScroll(scroll);
    firstRender = false;
    persist();
    if (announcement) announce(announcement);
  }

  function renderUnavailable(id, reason, message) {
    const wasInside = focusInside() || (firstRender && view.focus !== null);
    if (model) view.scroll = currentScroll();
    model = null;
    nodes = new Map();
    edgeSets = [];
    const missing = reason === 'not_found';
    const head = el('header', 'head');
    head.append(el('h1', 'goal', missing ? 'Exploration ' + id + ' is not in this project' : 'Exploration ' + id + ' cannot be read'));
    head.append(el('p', 'prose', missing
      ? 'No stored record has this ID under .hive/explorations. It may have been removed, or it belongs to another project.'
      : 'The stored record could not be read (' + reason + '). The viewer changed nothing. Repair or inspect the file outside the viewer, then refresh.'));
    if (!missing && message) head.append(el('p', 'prose muted', message));
    const actions = el('div', 'actions');
    actions.append(refreshButton());
    head.append(actions);
    app.replaceChildren(head);
    app.removeAttribute('aria-busy');
    document.title = 'Exploration ' + id;
    firstRender = false;
    if (wasInside) byFocusKey('refresh').focus({ preventScroll: true });
    persist();
    announce(missing ? 'Exploration ' + id + ' is not in this project.' : 'Exploration ' + id + ' cannot be read.');
  }

  function showNotice(text) {
    const notice = app.querySelector('.notice');
    if (notice) {
      notice.textContent = text;
      notice.hidden = false;
    }
    announce(text);
  }

  window.addEventListener('message', function (event) {
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'render' && message.model && typeof message.model === 'object') {
      render(message.model, typeof message.announcement === 'string' ? message.announcement : '');
    } else if (message.type === 'unavailable') {
      renderUnavailable(String(message.id), String(message.reason), typeof message.message === 'string' ? message.message : '');
    } else if (message.type === 'notice' && typeof message.text === 'string') {
      showNotice(message.text);
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
`;
