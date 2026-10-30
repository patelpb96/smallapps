/**
 * localhost — the page.
 *
 * Everything here talks to the server in scripts/localhost-server.js: it lists
 * what is listening, previews a port in an iframe, and remembers each place
 * along with the script that started it. No framework, no build step.
 */

const LIVE_REFRESH_MS = 10_000;
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

const $ = (sel) => document.querySelector(sel);

const ui = {
  address: $('#address'),
  form: $('#address-form'),
  notice: $('#notice'),
  back: $('#btn-back'),
  forward: $('#btn-forward'),
  rescan: $('#btn-rescan'),
  newtab: $('#btn-newtab'),
  save: $('#btn-save'),
  hintNewtab: $('#btn-hint-newtab'),
  tabLive: $('#tab-live'),
  tabPlaces: $('#tab-places'),
  liveCount: $('#live-count'),
  placesCount: $('#places-count'),
  panelLive: $('#panel-live'),
  panelPlaces: $('#panel-places'),
  liveHint: $('#live-hint'),
  liveList: $('#live-list'),
  groupSaved: $('#group-saved'),
  groupRecent: $('#group-recent'),
  placesSaved: $('#places-saved'),
  placesRecent: $('#places-recent'),
  placesHint: $('#places-hint'),
  viewerUrl: $('#viewer-url'),
  viewerMeta: $('#viewer-meta'),
  frame: $('#frame'),
  frameEmpty: $('#frame-empty'),
  drawer: $('#drawer'),
  drawerTitle: $('#drawer-title'),
  drawerMeta: $('#drawer-meta'),
  drawerClose: $('#drawer-close'),
  drawerFolder: $('#drawer-folder'),
  drawerNote: $('#drawer-note'),
  drawerChain: $('#drawer-chain'),
  drawerChainTitle: $('#drawer-chain-title'),
  drawerText: $('#drawer-text'),
  drawerTextTitle: $('#drawer-text-title'),
};

const state = {
  ports: [],
  scannedAt: null,
  scanning: false,
  history: [],
  tab: 'live',
  stack: [],
  index: -1,
  url: null,
  drawer: null,
};

// ── Tiny DOM helper ────────────────────────────────────────────────────────

function h(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

let noticeTimer = null;

function notice(message, bad = false) {
  ui.notice.textContent = message;
  ui.notice.classList.toggle('bad', bad);
  ui.notice.hidden = false;
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { ui.notice.hidden = true; }, 6000);
}

const baseName = (path) => {
  const text = String(path || '');
  const cut = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
  return cut < 0 ? text : text.slice(cut + 1);
};

const folderOf = (path) => {
  const text = String(path || '');
  const cut = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
  return cut <= 0 ? text.slice(0, Math.max(cut, 0)) : text.slice(0, cut);
};

// ── Addresses ──────────────────────────────────────────────────────────────

function buildUrl(portText, path) {
  if (!portText) return { error: 'Add a port, like :3000.' };
  const port = Number(portText);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return { error: 'That port is out of range.' };
  const tail = path || '/';
  return { url: `http://localhost:${port}${tail.startsWith('/') ? tail : '/' + tail}`, port };
}

/** 3000 · :3000/path · localhost:3000/x · a full url → one canonical url. */
function normalizeAddress(input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return { error: 'Type a port, like 3000.' };

  let match = raw.match(/^(\d{1,5})$/);
  if (match) return buildUrl(match[1], '/');

  match = raw.match(/^:(\d{1,5})(\/\S*)?$/);
  if (match) return buildUrl(match[1], match[2] || '/');

  let candidate = raw;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) candidate = 'http://' + candidate.replace(/^\/+/, '');

  let parsed;
  try { parsed = new URL(candidate); } catch { return { error: 'That is not a url I can read.' }; }
  if (!LOCAL_HOSTNAMES.has(parsed.hostname.toLowerCase())) {
    return { error: 'Only localhost, 127.0.0.1 and [::1] can be opened here.' };
  }
  return buildUrl(parsed.port, `${parsed.pathname || '/'}${parsed.search}${parsed.hash}`);
}

function portOfUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.port) return Number(parsed.port);
    return parsed.protocol === 'https:' ? 443 : 80;
  } catch {
    return 0;
  }
}

const liveFor = (port) => state.ports.find((entry) => entry.port === port) || null;

const historyFor = (url) => state.history.find((entry) => entry.url === url) || null;

// ── Server calls ───────────────────────────────────────────────────────────

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error || ''; } catch { /* not json */ }
    const error = new Error(detail || `${res.status} ${res.statusText}`);
    error.status = res.status;
    throw error;
  }
  return res.json();
}

async function loadPorts() {
  if (state.scanning) return;
  state.scanning = true;
  if (!state.ports.length) {
    ui.liveHint.hidden = false;
    ui.liveHint.textContent = 'Scanning…';
  }
  try {
    const data = await api('/api/ports');
    state.ports = Array.isArray(data.ports) ? data.ports : [];
    state.scannedAt = data.scannedAt || null;
    ui.liveHint.textContent = state.ports.length
      ? ''
      : 'Nothing is listening on localhost right now.';
    ui.liveHint.hidden = state.ports.length > 0;
  } catch (err) {
    state.ports = [];
    ui.liveHint.hidden = false;
    ui.liveHint.textContent = 'The scanner is not answering — is scripts/localhost-server.js still running?';
    notice(`Scan failed: ${err.message}`, true);
  } finally {
    state.scanning = false;
    renderLive();
    renderPlaces();
    renderChrome();
  }
}

async function loadHistory() {
  try {
    const data = await api('/api/history');
    state.history = Array.isArray(data.entries) ? data.entries : [];
  } catch {
    state.history = [];
  }
  renderPlaces();
  renderChrome();
}

async function postHistory(body) {
  try {
    const data = await api('/api/history', { method: 'POST', body: JSON.stringify(body) });
    state.history = Array.isArray(data.entries) ? data.entries : [];
  } catch (err) {
    notice(`Could not save history: ${err.message}`, true);
  }
  renderPlaces();
  renderChrome();
}

async function recordVisit(url) {
  const port = portOfUrl(url);
  const live = liveFor(port);
  const body = { url, port };
  if (live) {
    if (live.http && live.http.title) body.title = live.http.title;
    body.process = live.process || '';
    body.folder = live.folder || '';
    if (live.launcher && live.launcher.path) body.launcher = live.launcher.path;
  }
  await postHistory(body);
}

async function removePlace(url) {
  try {
    const data = await api(`/api/history?url=${encodeURIComponent(url)}`, { method: 'DELETE' });
    state.history = Array.isArray(data.entries) ? data.entries : [];
    renderPlaces();
    renderChrome();
  } catch (err) {
    notice(`Could not remove: ${err.message}`, true);
  }
}

async function openFolder(path) {
  try {
    await api('/api/open-folder', { method: 'POST', body: JSON.stringify({ path }) });
  } catch (err) {
    notice(err.status === 403
      ? 'That folder is not in the current scan or in history.'
      : `Could not open the folder: ${err.message}`, true);
  }
}

// ── Viewer ─────────────────────────────────────────────────────────────────

async function go(input, { record = true, push = true } = {}) {
  const result = normalizeAddress(input);
  if (result.error) {
    ui.address.classList.add('bad');
    notice(result.error, true);
    ui.address.focus();
    return;
  }
  ui.address.classList.remove('bad');
  ui.address.value = result.url;

  if (push) {
    state.stack = state.stack.slice(0, state.index + 1);
    if (state.stack[state.index] !== result.url) state.stack.push(result.url);
    state.index = state.stack.length - 1;
  }
  state.url = result.url;
  renderViewer();
  renderChrome();
  if (record) await recordVisit(result.url);
}

function step(delta) {
  const next = state.index + delta;
  if (next < 0 || next >= state.stack.length) return;
  state.index = next;
  state.url = state.stack[next];
  ui.address.value = state.url;
  renderViewer();
  renderChrome();
  recordVisit(state.url);
}

function renderViewer() {
  const url = state.url;
  ui.viewerUrl.textContent = url || 'No page open';
  ui.frameEmpty.hidden = Boolean(url);

  if (url) {
    if (ui.frame.getAttribute('src') !== url) ui.frame.setAttribute('src', url);
    ui.frame.hidden = false;
  } else {
    ui.frame.removeAttribute('src');
    ui.frame.hidden = true;
  }

  const live = url ? liveFor(portOfUrl(url)) : null;
  if (!url) {
    ui.viewerMeta.textContent = '';
  } else if (live) {
    const title = live.http && live.http.title ? live.http.title : '';
    ui.viewerMeta.textContent = title ? `live · ${title}` : 'live';
  } else {
    ui.viewerMeta.textContent = 'not listening right now';
  }
}

function renderChrome() {
  ui.back.disabled = state.index <= 0;
  ui.forward.disabled = state.index >= state.stack.length - 1;
  ui.newtab.disabled = !state.url;
  const saved = state.url ? historyFor(state.url) : null;
  ui.save.textContent = saved && saved.saved ? '★ Saved' : '★ Save';
  ui.save.classList.toggle('on', Boolean(saved && saved.saved));
  ui.liveCount.textContent = state.ports.length ? String(state.ports.length) : '';
  ui.placesCount.textContent = state.history.length ? String(state.history.length) : '';
}

// ── Live list ──────────────────────────────────────────────────────────────

function portRow(entry) {
  const title = entry.http && entry.http.title ? entry.http.title : '';
  const launcher = entry.launcher || null;
  const active = state.url && portOfUrl(state.url) === entry.port;

  const folder = entry.folder || (launcher ? folderOf(launcher.path) : '');
  const scriptPath = launcher ? launcher.path : folder;

  return h('div', {
    class: `row${active ? ' active' : ''}`,
    role: 'button',
    tabindex: '0',
    onclick: (event) => {
      if (event.target.closest('button')) return;
      go(`http://localhost:${entry.port}/`);
    },
    onkeydown: (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        go(`http://localhost:${entry.port}/`);
      }
    },
  },
    h('div', { class: 'row-top' },
      h('span', { class: 'port', text: `:${entry.port}` }),
      h('span', {
        class: title ? 'row-title' : 'row-title dim',
        text: title || 'no HTTP',
        title: entry.http ? `HTTP ${entry.http.status}${entry.http.server ? ' · ' + entry.http.server : ''}` : 'No HTTP response',
      }),
    ),
    h('div', { class: 'row-sub' },
      h('span', {
        class: 'mono',
        text: `${entry.process || 'owner hidden'} · ${entry.pid ? (entry.pidGuessed ? '≈' : '') + entry.pid : '?'}`,
        title: entry.pidGuessed ? 'The OS did not report an owner; guessed from the port in its command line.' : '',
      }),
      h('span', { class: 'sep', text: '·' }),
      h('span', {
        class: 'mono',
        text: launcher ? `${baseName(launcher.path)}${launcher.kind === 'npm' ? ' (npm)' : ''}` : 'no script found',
        title: launcher ? launcher.path : entry.commandLine || entry.exe || '',
      }),
    ),
    h('div', { class: 'row-actions' },
      h('button', {
        type: 'button',
        text: 'Open',
        onclick: () => go(`http://localhost:${entry.port}/`),
      }),
      h('button', {
        type: 'button',
        text: 'Folder',
        disabled: !folder,
        title: folder || 'No folder known',
        onclick: () => openFolder(folder),
      }),
      h('button', {
        type: 'button',
        text: 'Script',
        disabled: !scriptPath,
        title: scriptPath || 'No script known',
        onclick: () => openDrawer({ path: scriptPath, kind: launcher ? launcher.kind : 'folder', entry }),
      }),
    ),
  );
}

function renderLive() {
  ui.liveList.replaceChildren();
  if (!state.ports.length) return;
  const rows = state.ports.map(portRow);
  ui.liveList.append(...rows);
}

// ── Places list ────────────────────────────────────────────────────────────

function relativeTime(iso) {
  const then = Date.parse(iso || '');
  if (!Number.isFinite(then)) return '';
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} d ago`;
  return new Date(then).toLocaleDateString();
}

function noteField(entry) {
  const body = h('span', {
    class: entry.note ? 'note' : 'note empty',
    text: entry.note || 'add a note',
    title: 'Click to edit the note',
    role: 'textbox',
    tabindex: '0',
    onclick: () => startNoteEdit(entry, body),
    onkeydown: (event) => {
      if (event.key === 'Enter') { event.preventDefault(); startNoteEdit(entry, body); }
    },
  });
  return body;
}

function startNoteEdit(entry, body) {
  const input = h('input', {
    class: 'note-input',
    type: 'text',
    value: entry.note || '',
    placeholder: 'Why did you keep this?',
    'aria-label': 'Note',
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      input.disabled = true;
      input.blur();
      renderPlaces();
      return;
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const note = input.value.trim();
    input.disabled = true;
    input.blur();
    postHistory({ url: entry.url, note, ...launcherFields(entry) });
  });
  input.addEventListener('blur', () => { if (!input.disabled) renderPlaces(); });
  body.replaceWith(input);
  input.focus();
  input.select();
}

/** What a place remembers about how it was started. */
function launcherFields(entry) {
  const fields = {};
  if (entry.launcher) fields.launcher = entry.launcher;
  if (entry.folder) fields.folder = entry.folder;
  if (entry.process) fields.process = entry.process;
  return fields;
}

function placeRow(entry) {
  const live = liveFor(entry.port);
  const scriptPath = entry.launcher || entry.folder || (live && live.launcher ? live.launcher.path : '');
  const folder = entry.folder || (entry.launcher ? folderOf(entry.launcher) : '');
  const title = entry.title || entry.url;
  const active = state.url === entry.url;

  return h('div', { class: `row${entry.saved ? ' saved' : ''}${active ? ' active' : ''}` },
    h('div', { class: 'row-top' },
      h('span', { class: `dot${live ? ' live' : ''}`, title: live ? 'listening now' : 'not listening' }),
      h('span', { class: 'row-title', text: title, title }),
      h('button', {
        class: `star${entry.saved ? ' on' : ''}`,
        type: 'button',
        title: entry.saved ? 'Unsave' : 'Save',
        text: entry.saved ? '★' : '☆',
        onclick: () => postHistory({ url: entry.url, saved: !entry.saved }),
      }),
      h('button', {
        class: 'remove',
        type: 'button',
        title: 'Remove from history',
        text: '×',
        onclick: () => removePlace(entry.url),
      }),
    ),
    h('button', {
      class: 'url',
      type: 'button',
      text: entry.url,
      title: entry.url,
      onclick: () => go(entry.url),
    }),
    h('div', { class: 'row-sub' },
      h('span', { text: `${entry.visits || 1} ${entry.visits === 1 ? 'visit' : 'visits'}` }),
      h('span', { class: 'sep', text: '·' }),
      h('span', { text: relativeTime(entry.lastVisited) }),
      entry.process ? h('span', { class: 'sep', text: '·' }) : null,
      entry.process ? h('span', { class: 'mono', text: entry.process }) : null,
    ),
    noteField(entry),
    (scriptPath || folder)
      ? h('div', { class: 'row-actions' },
        folder ? h('button', { type: 'button', text: 'Folder', onclick: () => openFolder(folder) }) : null,
        scriptPath
          ? h('button', {
            type: 'button',
            text: 'Script',
            onclick: () => openDrawer({ path: scriptPath, kind: entry.launcher ? 'file' : 'folder', entry: null }),
          })
          : null,
      )
      : null,
  );
}

function renderPlaces() {
  // A 10-second refresh must not pull the ground out from under a note being typed.
  const focused = document.activeElement;
  if (focused && focused.classList && focused.classList.contains('note-input')) return;

  ui.placesSaved.replaceChildren();
  ui.placesRecent.replaceChildren();
  ui.groupSaved.hidden = true;
  ui.groupRecent.hidden = true;
  ui.placesHint.hidden = state.history.length > 0;

  if (!state.history.length) return;

  const saved = state.history.filter((entry) => entry.saved);
  const recent = state.history.filter((entry) => !entry.saved);

  if (saved.length) {
    ui.groupSaved.hidden = false;
    ui.placesSaved.append(...saved.map(placeRow));
  }
  if (recent.length) {
    ui.groupRecent.hidden = false;
    ui.placesRecent.append(...recent.map(placeRow));
  }
}

// ── Script drawer ──────────────────────────────────────────────────────────

function chainList(entry) {
  ui.drawerChain.replaceChildren();
  const chain = entry && Array.isArray(entry.chain) ? entry.chain : [];
  ui.drawerChainTitle.hidden = chain.length === 0;
  for (const proc of chain) {
    ui.drawerChain.append(h('li', {},
      h('span', { class: 'name', text: proc.name || 'unknown' }),
      ' ',
      h('span', { class: 'pid', text: `pid ${proc.pid}` }),
      h('span', { class: 'cmd', text: proc.commandLine || '' }),
    ));
  }
}

function metaRow(term, value) {
  const dd = h('dd', { text: value });
  if (value) dd.title = value;
  ui.drawerMeta.append(h('dt', { text: term }), dd);
}

async function openDrawer({ path, kind, entry }) {
  state.drawer = { path, kind, entry };
  ui.drawer.hidden = false;
  document.querySelector('.app').classList.add('drawer-open');
  // Asking for a script means wanting to see it, even if the panel was minimized.
  setPanel('drawer', { collapsed: false });
  ui.drawerTitle.textContent = baseName(path) || (kind === 'folder' ? 'Folder' : 'Script');
  ui.drawerMeta.replaceChildren();
  ui.drawerText.textContent = 'Reading…';
  ui.drawerTextTitle.hidden = false;
  ui.drawerNote.textContent = '';
  const folder = entry && entry.folder ? entry.folder : (kind === 'folder' ? path : folderOf(path));
  ui.drawerFolder.hidden = !folder;

  metaRow('path', path);
  if (entry) {
    metaRow('process', `${entry.process || 'unknown'} · pid ${entry.pid || '?'}`);
    metaRow('port', `:${entry.port}`);
  }
  chainList(entry);

  try {
    const info = await api(`/api/script?path=${encodeURIComponent(path)}`);
    ui.drawerText.textContent = info.text || '(empty)';
    metaRow('size', `${Math.round((info.size || 0) / 102.4) / 10} KB${info.truncated ? ' (truncated at 200 KB)' : ''}`);
    ui.drawerNote.textContent = info.kind === 'folder' ? 'directory listing' : '';
  } catch (err) {
    ui.drawerText.textContent = err.status === 403
      ? 'This path is not in the current scan or in history, so it is not readable here.'
      : `Could not read it: ${err.message}`;
  }
}

function closeDrawer() {
  state.drawer = null;
  ui.drawer.hidden = true;
  document.querySelector('.app').classList.remove('drawer-open');
  applyLayout();
}

// ── Panel layout: drag to resize, minimize to a rail, remembered ───────────

const LAYOUT_KEY = 'localhost-browser.layout';
const RAIL_PX = 28;
const SNAP_PX = 120; // dragged narrower than this, a panel minimizes
const PANELS = {
  side: { el: () => $('#side'), splitter: () => $('#split-side'), min: 180, max: 640, width: 320, edge: 'left' },
  drawer: { el: () => ui.drawer, splitter: () => $('#split-drawer'), min: 240, max: 900, width: 380, edge: 'right' },
};

const layout = (() => {
  const fallback = { side: { width: 320, collapsed: false }, drawer: { width: 380, collapsed: false } };
  try {
    const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null');
    if (saved && saved.side && saved.drawer) return { ...fallback, ...saved };
  } catch { /* storage blocked or corrupt: defaults */ }
  return fallback;
})();

const clampWidth = (name, px) => Math.round(Math.min(PANELS[name].max, Math.max(PANELS[name].min, px)));

function applyLayout() {
  const app = $('.app');
  for (const [name, panel] of Object.entries(PANELS)) {
    const { width, collapsed } = layout[name];
    app.style.setProperty(`--${name}-col`, collapsed ? `${RAIL_PX}px` : `${clampWidth(name, width)}px`);
    panel.el().classList.toggle('collapsed', collapsed);
    const splitter = panel.splitter();
    splitter.setAttribute('aria-valuenow', String(collapsed ? 0 : clampWidth(name, width)));
  }
  $('#split-drawer').hidden = ui.drawer.hidden;
}

function setPanel(name, changes) {
  Object.assign(layout[name], changes);
  if (changes.width != null) layout[name].width = clampWidth(name, changes.width);
  applyLayout();
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch { /* not remembered, still works */ }
}

const togglePanel = (name) => setPanel(name, { collapsed: !layout[name].collapsed });

function wireSplitter(name) {
  const panel = PANELS[name];
  const splitter = panel.splitter();
  const app = $('.app');

  splitter.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    splitter.setPointerCapture(event.pointerId);
    app.classList.add('dragging');
    splitter.classList.add('active');
    const box = app.getBoundingClientRect();
    // A drag that ends minimized must not leave behind the narrow widths it
    // passed through on the way, or restoring would come back tiny.
    const startWidth = layout[name].width;

    const move = (e) => {
      // Width is the distance from the app's edge on the panel's side to the pointer.
      const px = panel.edge === 'left' ? e.clientX - box.left : box.right - e.clientX;
      if (px < SNAP_PX) setPanel(name, { collapsed: true, width: startWidth });
      else setPanel(name, { collapsed: false, width: px });
    };
    const end = () => {
      app.classList.remove('dragging');
      splitter.classList.remove('active');
      splitter.removeEventListener('pointermove', move);
      splitter.removeEventListener('pointerup', end);
      splitter.removeEventListener('pointercancel', end);
    };
    splitter.addEventListener('pointermove', move);
    splitter.addEventListener('pointerup', end);
    splitter.addEventListener('pointercancel', end);
  });

  splitter.addEventListener('dblclick', () => togglePanel(name));

  splitter.addEventListener('keydown', (event) => {
    // Arrow keys move the splitter itself, so "grow" depends on which side the panel is.
    const grow = panel.edge === 'left' ? 'ArrowRight' : 'ArrowLeft';
    const shrink = panel.edge === 'left' ? 'ArrowLeft' : 'ArrowRight';
    const stepPx = event.shiftKey ? 64 : 16;
    if (event.key === grow || event.key === shrink) {
      event.preventDefault();
      const delta = event.key === grow ? stepPx : -stepPx;
      setPanel(name, { collapsed: false, width: (layout[name].collapsed ? panel.min : layout[name].width) + delta });
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      togglePanel(name);
    }
  });

  splitter.setAttribute('aria-valuemin', String(panel.min));
  splitter.setAttribute('aria-valuemax', String(panel.max));
}

// ── Tabs and wiring ────────────────────────────────────────────────────────

function setTab(tab) {
  state.tab = tab;
  const live = tab === 'live';
  ui.panelLive.hidden = !live;
  ui.panelPlaces.hidden = live;
  ui.tabLive.classList.toggle('on', live);
  ui.tabPlaces.classList.toggle('on', !live);
  ui.tabLive.setAttribute('aria-selected', String(live));
  ui.tabPlaces.setAttribute('aria-selected', String(!live));
}

ui.form.addEventListener('submit', (event) => {
  event.preventDefault();
  go(ui.address.value);
});

ui.address.addEventListener('input', () => ui.address.classList.remove('bad'));

ui.back.addEventListener('click', () => step(-1));
ui.forward.addEventListener('click', () => step(1));

ui.rescan.addEventListener('click', async () => {
  await loadPorts();
  await loadHistory();
});

const newTab = () => {
  if (!state.url) return;
  window.open(state.url, '_blank', 'noopener');
  recordVisit(state.url);
};
ui.newtab.addEventListener('click', newTab);
ui.hintNewtab.addEventListener('click', newTab);

ui.save.addEventListener('click', () => {
  if (!state.url) return;
  const existing = historyFor(state.url);
  const live = liveFor(portOfUrl(state.url));
  const body = { url: state.url, saved: !(existing && existing.saved) };
  if (live) {
    body.process = live.process || '';
    body.folder = live.folder || '';
    if (live.launcher && live.launcher.path) body.launcher = live.launcher.path;
    if (live.http && live.http.title) body.title = live.http.title;
  }
  postHistory(body);
});

ui.tabLive.addEventListener('click', () => setTab('live'));
ui.tabPlaces.addEventListener('click', () => setTab('places'));
ui.drawerClose.addEventListener('click', closeDrawer);
ui.drawerFolder.addEventListener('click', () => {
  const path = state.drawer && state.drawer.path;
  if (!path) return;
  openFolder(state.drawer.entry && state.drawer.entry.folder ? state.drawer.entry.folder : folderOf(path));
});

$('#side-collapse').addEventListener('click', () => setPanel('side', { collapsed: true }));
$('#side-expand').addEventListener('click', () => setPanel('side', { collapsed: false }));
$('#drawer-collapse').addEventListener('click', () => setPanel('drawer', { collapsed: true }));
$('#drawer-expand').addEventListener('click', () => setPanel('drawer', { collapsed: false }));
wireSplitter('side');
wireSplitter('drawer');

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.drawer) closeDrawer();
  // [ and ] toggle the panels, unless the key is being typed into something.
  const typing = event.target.closest && event.target.closest('input, textarea, select, [contenteditable]');
  if (typing || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key === '[') togglePanel('side');
  if (event.key === ']' && state.drawer) togglePanel('drawer');
});

// ── Boot ───────────────────────────────────────────────────────────────────

setTab('live');
applyLayout();
renderViewer();
renderChrome();
loadPorts().then(loadHistory);

setInterval(() => {
  if (document.hidden) return;
  loadPorts();
}, LIVE_REFRESH_MS);
