/**
 * localhost browser — lists what is listening on this machine's loopback.
 *
 * One `node:http` server, no dependencies. It answers four questions a dev
 * server list usually cannot: which port, which process, which script started
 * it, and where that script lives. The last one is remembered in history, so a
 * server you stopped is still a folder you can open and a script you can read.
 *
 *   node scripts/localhost-server.js [port]        # default 4180
 *
 * It binds 127.0.0.1 only. Every /api request is checked against the Host
 * header so a page on another origin cannot rebind DNS to reach it.
 */

import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { connect as netConnect } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { homedir } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const ROOT = resolve(import.meta.dirname, '..');
const PORT = Number(process.argv[2] || process.env.PORT || 4180);

const execFileP = promisify(execFile);

/** Written as a char code so a stray escape cannot become a control character. */
const BACKSLASH = String.fromCharCode(92);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.pdf': 'application/pdf',
};

// ── Pure helpers (exported; the tests import these) ────────────────────────

const LAUNCHER_EXT = ['bat', 'cmd', 'ps1', 'sh', 'py', 'js', 'mjs', 'cjs', 'ts', 'rb', 'go'];
const LAUNCHER_TEST = /\.(bat|cmd|ps1|sh|py|js|mjs|cjs|ts|rb|go)$/i;
const ABSOLUTE_TEST = /^(?:[A-Za-z]:[\\/]|[\\/])/;

/** True for `C:\x`, `C:/x`, `\\server\share`, `/x`. Platform-independent. */
export function isAbsolutePath(value) {
  return typeof value === 'string' && ABSOLUTE_TEST.test(value);
}

/**
 * Split a command line into tokens, Windows rules: double quotes group, and a
 * run of backslashes is literal unless it precedes a quote (then half of them
 * survive and an odd trailing one escapes the quote).
 */
export function splitCommandLine(input) {
  const text = typeof input === 'string' ? input : '';
  const out = [];
  let current = '';
  let quoted = false;
  let touched = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (ch === BACKSLASH) {
      let run = 0;
      while (text[i] === BACKSLASH) { run += 1; i += 1; }
      if (text[i] === '"') {
        current += BACKSLASH.repeat(Math.floor(run / 2));
        if (run % 2 === 1) { current += '"'; i += 1; }
        // even run: leave the quote for the normal path so it toggles quoting
      } else {
        current += BACKSLASH.repeat(run);
      }
      touched = true;
      continue;
    }

    if (ch === '"') {
      quoted = !quoted;
      touched = true;
      i += 1;
      continue;
    }

    if (!quoted && (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n')) {
      if (touched || current) out.push(current);
      current = '';
      touched = false;
      i += 1;
      continue;
    }

    current += ch;
    touched = true;
    i += 1;
  }

  if (touched || current) out.push(current);
  return out;
}

/** Directory part of a path, for both separator styles, without the platform. */
export function dirName(value) {
  const text = String(value || '');
  const cut = Math.max(text.lastIndexOf('/'), text.lastIndexOf(BACKSLASH));
  if (cut < 0) return '.';
  if (cut === 0) return text.slice(0, 1);
  const head = text.slice(0, cut);
  if (/^[A-Za-z]:$/.test(head)) return head + BACKSLASH;
  return head;
}

function joinPath(dir, name) {
  const base = String(dir || '');
  const sepChar = base.includes(BACKSLASH) && !base.includes('/') ? BACKSLASH : '/';
  return /[\\/]$/.test(base) ? base + name : base + sepChar + name;
}

const isShim = (p) => /node_modules[\\/]\.bin[\\/]/i.test(p);

/**
 * Best guess at the script that started a process.
 *
 * @param {Array<{pid:number,name:string,commandLine:string}>} chain process, then ancestors
 * @param {(p:string)=>boolean} exists injected so this stays pure
 * @returns {{path:string,kind:string,from:string}|null}
 */
export function findLauncher(chain, exists = existsSync) {
  const list = Array.isArray(chain) ? chain : [];
  const safeExists = (p) => {
    try { return exists(p) === true; } catch { return false; }
  };
  const candidates = [];
  const absoluteTokens = [];

  for (const proc of list) {
    const name = proc && typeof proc.name === 'string' ? proc.name : '';
    const tokens = splitCommandLine(proc && proc.commandLine);
    for (const token of tokens) {
      if (!isAbsolutePath(token)) continue;
      absoluteTokens.push({ token, name });
      if (!LAUNCHER_TEST.test(token) || !safeExists(token)) continue;
      const kind = token.slice(token.lastIndexOf('.') + 1).toLowerCase();
      candidates.push({ path: token, kind, from: name });
      break; // first match per process; chain order decides the winner
    }
  }

  const preferred = candidates.find((c) => !isShim(c.path));
  if (preferred) return preferred;
  if (candidates.length) return candidates[0];

  // Nothing runnable: the project a command mentions is still a useful answer.
  for (const { token, name } of absoluteTokens) {
    let dir = dirName(token);
    for (let hop = 0; hop < 5 && dir && dir !== '.'; hop += 1) {
      const pkg = joinPath(dir, 'package.json');
      if (safeExists(pkg)) return { path: pkg, kind: 'npm', from: name };
      const up = dirName(dir);
      if (!up || up === dir) break;
      dir = up;
    }
  }

  return null;
}

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, name) => {
    const key = name.toLowerCase();
    if (key.startsWith('#')) {
      const code = key[1] === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
      if (Number.isFinite(code) && code > 0 && code < 0x110000) {
        try { return String.fromCodePoint(code); } catch { return whole; }
      }
      return whole;
    }
    const named = ENTITIES[key];
    return named === undefined ? whole : named;
  });
}

/** The page title, whitespace-collapsed, capped so a hostile page cannot bloat JSON. */
export function extractTitle(html) {
  if (typeof html !== 'string') return '';
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return '';
  return decodeEntities(match[1]).replace(/\s+/g, ' ').trim().slice(0, 200);
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Only the three loopback spellings, http/https, nothing else. `file:` is out. */
export function isLocalUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  let url;
  try { url = new URL(value.trim()); } catch { return false; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return LOCAL_HOSTS.has(url.hostname.toLowerCase());
}

/** Trim the listener address to the four bind shapes we care about. */
function normalizeBind(address) {
  const raw = String(address || '').trim();
  if (!raw || raw === '*') return '0.0.0.0';
  return raw.replace(/^\[/, '').replace(/\]$/, '').split('%')[0];
}

const BIND_ALLOWED = new Set(['127.0.0.1', '::1', '0.0.0.0', '::']);
const isLoopbackBind = (a) => a === '127.0.0.1' || a === '::1';

export function isAllowedBind(address) {
  return BIND_ALLOWED.has(normalizeBind(address));
}

/** `[::1]:3000`, `*:3000`, `127.0.0.1:3000` → { address, port }. */
function parseHostPort(value) {
  const text = String(value || '').trim();
  const cut = text.lastIndexOf(':');
  if (cut < 0) return null;
  const port = Number(text.slice(cut + 1));
  if (!Number.isInteger(port) || port <= 0) return null;
  return { address: normalizeBind(text.slice(0, cut)), port };
}

// ── Scanning ───────────────────────────────────────────────────────────────

const PROBE_TIMEOUT_MS = 1200;
const PROBE_BYTES = 64 * 1024;
const STOP_NAMES = new Set(['explorer.exe', 'services.exe', 'wininit', 'wininit.exe', 'system', 'system idle process', 'launchd', 'init', 'systemd']);
const CHAIN_MAX = 7; // the process plus up to six ancestors

const PS_SCRIPT = [
  '$ProgressPreference = "SilentlyContinue"',
  '$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  '$conns = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Select-Object LocalAddress,LocalPort,OwningProcess)',
  '$procs = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Select-Object ProcessId,ParentProcessId,Name,CommandLine,ExecutablePath)',
  '[pscustomobject]@{ conns = $conns; procs = $procs } | ConvertTo-Json -Depth 3 -Compress',
].join('; ');

const asArray = (value) => (Array.isArray(value) ? value : value == null ? [] : [value]);

async function runCapture(file, args, maxBuffer = 48 * 1024 * 1024) {
  try {
    const { stdout } = await execFileP(file, args, { maxBuffer, windowsHide: true, encoding: 'utf8' });
    return stdout || '';
  } catch (err) {
    if (err && typeof err.stdout === 'string' && err.stdout) return err.stdout;
    return '';
  }
}

async function collectWindows() {
  const read = async () => {
    const out = await runCapture('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_SCRIPT]);
    let data = {};
    try { data = JSON.parse(out.trim() || '{}') || {}; } catch { data = {}; }
    return { conns: asArray(data.conns), procs: asArray(data.procs) };
  };

  let snapshot = await read();
  // A completely empty answer means the query failed, not that nothing is
  // listening on this machine — Windows PowerShell does that now and then.
  if (!snapshot.conns.length && !snapshot.procs.length) snapshot = await read();

  const listeners = [];
  for (const conn of snapshot.conns) {
    const port = Number(conn && conn.LocalPort);
    if (!Number.isInteger(port) || port <= 0) continue;
    listeners.push({ port, address: normalizeBind(conn.LocalAddress), pid: Number(conn.OwningProcess) || 0 });
  }

  const processes = new Map();
  for (const proc of snapshot.procs) {
    const pid = Number(proc && proc.ProcessId);
    if (!Number.isInteger(pid) || pid < 0) continue;
    processes.set(pid, {
      pid,
      ppid: Number(proc.ParentProcessId) || 0,
      name: proc.Name || '',
      commandLine: proc.CommandLine || '',
      exe: proc.ExecutablePath || '',
    });
  }

  return { listeners, processes };
}

async function collectPosix() {
  const listeners = [];

  const lsof = await runCapture('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn']);
  let pid = 0;
  for (const line of lsof.split('\n')) {
    if (!line) continue;
    const tag = line[0];
    const value = line.slice(1);
    if (tag === 'p') pid = Number(value) || 0;
    else if (tag === 'n') {
      const parsed = parseHostPort(value);
      if (parsed && pid) listeners.push({ ...parsed, pid });
    }
  }

  const processes = new Map();
  const ps = await runCapture('ps', ['-eo', 'pid=,ppid=,comm=,args=']);
  for (const line of ps.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
    if (!match) continue;
    const id = Number(match[1]);
    processes.set(id, {
      pid: id,
      ppid: Number(match[2]) || 0,
      name: match[3] || '',
      commandLine: match[4] || '',
      exe: '',
    });
  }

  return { listeners, processes };
}

async function collect() {
  try {
    return process.platform === 'win32' ? await collectWindows() : await collectPosix();
  } catch {
    return { listeners: [], processes: new Map() };
  }
}

/** The process, then its ancestors, stopping at the shell's owner. */
export function buildChain(pid, processes, max = CHAIN_MAX) {
  const chain = [];
  const seen = new Set();
  // Windows reports OwningProcess 0 for ports it cannot attribute to a process.
  if (!Number(pid)) return chain;
  let current = processes instanceof Map ? processes.get(Number(pid)) : null;

  while (current && chain.length < max && !seen.has(current.pid)) {
    chain.push({ pid: current.pid, name: current.name || '', commandLine: current.commandLine || '' });
    seen.add(current.pid);
    const parent = Number(current.ppid) || 0;
    if (!parent) break;
    const next = processes.get(parent);
    if (!next) break;
    if (STOP_NAMES.has(String(next.name || '').toLowerCase())) break;
    current = next;
  }

  return chain;
}

/** GET / against a port. Never throws: a dead or silent port is just null. */
export function probeHttp(port, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((finish) => {
    let settled = false;
    let timer = null;
    const done = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      finish(value);
    };

    let req;
    try {
      req = httpRequest({
        host: '127.0.0.1',
        port,
        path: '/',
        method: 'GET',
        agent: false,
        headers: {
          accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
          'user-agent': 'localhost-browser/1.0',
          connection: 'close',
        },
      }, (res) => {
        const status = res.statusCode || 0;
        const server = String(res.headers.server || '');
        const type = String(res.headers['content-type'] || '');
        let chunks = '';
        let bytes = 0;

        const collect = () => {
          const body = type && !/text\/html|application\/xhtml/i.test(type) ? '' : chunks;
          done({ status, title: extractTitle(body), server });
        };

        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes <= PROBE_BYTES) chunks += chunk;
          if (bytes >= PROBE_BYTES) {
            res.destroy();
            collect();
          }
        });
        res.on('end', collect);
        res.on('error', collect);
        res.on('aborted', collect);
      });
    } catch {
      done(null);
      return;
    }

    timer = setTimeout(() => {
      try { req.destroy(); } catch { /* already gone */ }
      done(null);
    }, timeoutMs);
    timer.unref?.();

    req.on('error', () => done(null));
    req.end();
  });
}

// The OS socket table is not always the truth: some Windows machines hand back a
// filtered table (missing ports) with every owner as PID 0. So the scan also
// connects to ports it has reason to expect, and attributes owners by reading
// the port number out of command lines.

/** Dev-server ports worth a connect even when nothing names them. */
export const COMMON_PORTS = [
  3000, 3001, 3002, 4000, 4173, 4200, 4321, 5000, 5001, 5173, 5174, 5175,
  5500, 6006, 7860, 8000, 8001, 8008, 8080, 8081, 8443, 8501, 8765, 8766,
  8787, 8790, 8888, 9000, 9090, 11434,
];

const INTERPRETER_TEST = /^(python\d*(\.\d+)?|pythonw|py|node|deno|bun|ruby|php|perl)(\.exe)?$/i;

const SHELL_NAMES = new Set(['cmd.exe', 'powershell.exe', 'pwsh.exe', 'bash.exe', 'sh', 'bash', 'zsh', 'conhost.exe', 'wsl.exe']);

/** Port numbers a command line names: `--port 3000`, `-p=3000`, `:3000`, `PORT=3000`, or a bare `3000`. */
export function portsInCommandLine(input) {
  const text = typeof input === 'string' ? input : '';
  const found = new Set();
  const add = (value) => {
    const n = Number(value);
    if (Number.isInteger(n) && n >= 1024 && n <= 65535) found.add(n);
  };
  for (const m of text.matchAll(/(?:port|-p)["']?\s*[=:\s]\s*["']?(\d{2,5})(?!\d)/gi)) add(m[1]);
  for (const m of text.matchAll(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\]):(\d{2,5})(?!\d)/gi)) add(m[1]);
  for (const token of splitCommandLine(text)) if (/^\d{4,5}$/.test(token)) add(token);
  return found;
}

/**
 * Best guess at the process that owns `port` when the OS will not say. A shell
 * that names the port (`set PORT=8766&& python server.py`) hands it to its child.
 */
export function guessOwner(port, processes) {
  const named = [...processes.values()].filter((p) => portsInCommandLine(p.commandLine).has(port));
  if (!named.length) return 0;
  const leaf = named.find((p) => !SHELL_NAMES.has(String(p.name).toLowerCase()));
  if (leaf) return leaf.pid;
  const shell = named[0];
  const child = [...processes.values()].find((p) => p.ppid === shell.pid && !SHELL_NAMES.has(String(p.name).toLowerCase()));
  return child ? child.pid : shell.pid;
}

/** True if something accepts a TCP connection on 127.0.0.1:port. */
export function tcpOpen(port, timeoutMs = 400) {
  return new Promise((finish) => {
    const socket = netConnect({ host: '127.0.0.1', port });
    const done = (open) => { socket.destroy(); finish(open); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** One entry per listening port, loopback or wildcard, minus our own port. */
export async function scanPorts({ selfPort = 0, probe = true, extraPorts = [] } = {}) {
  const scannedAt = new Date().toISOString();
  const { listeners, processes } = await collect();

  // Connect to every port we have a reason to expect but the table did not list.
  const listed = new Set(listeners.map((l) => l.port));
  const candidates = new Set([...COMMON_PORTS, ...extraPorts]);
  for (const proc of processes.values()) for (const p of portsInCommandLine(proc.commandLine)) candidates.add(p);
  const unlisted = [...candidates].filter((p) => p !== selfPort && !listed.has(p));
  const open = await Promise.all(unlisted.map(async (p) => ((await tcpOpen(p)) ? p : 0)));
  for (const p of open) if (p) listeners.push({ port: p, address: '127.0.0.1', pid: 0, found: 'connect' });

  const byPort = new Map();
  for (const listener of listeners) {
    const address = normalizeBind(listener.address);
    if (!BIND_ALLOWED.has(address)) continue;
    if (!listener.port || listener.port === selfPort) continue;
    const seen = byPort.get(listener.port);
    // One port can show several sockets, some owned by PID 0 (left behind by exited
    // processes). Prefer a socket with a real owner, then a loopback bind.
    const better = !seen
      || (listener.pid && !seen.pid)
      || (!!listener.pid === !!seen.pid && isLoopbackBind(address) && !isLoopbackBind(seen.address));
    if (better) {
      byPort.set(listener.port, { port: listener.port, address, pid: listener.pid, found: listener.found || 'table' });
    }
  }

  for (const entry of byPort.values()) {
    if (entry.pid) continue;
    entry.pid = guessOwner(entry.port, processes);
    entry.pidGuessed = !!entry.pid;
  }

  // Still unowned: the port is probably hard-coded in a script. Read the script of
  // each interpreter process that owns nothing yet, and look for the number.
  const unowned = [...byPort.values()].filter((e) => !e.pid);
  if (unowned.length) {
    const owners = new Set([...byPort.values()].map((e) => e.pid).filter(Boolean));
    const sources = [];
    for (const proc of processes.values()) {
      // Skip ourselves: COMMON_PORTS puts every common port number in this file.
      if (proc.pid === process.pid || owners.has(proc.pid) || !INTERPRETER_TEST.test(proc.name)) continue;
      const launcher = findLauncher([{ name: proc.name, commandLine: proc.commandLine }], existsSync);
      if (!launcher || launcher.kind === 'npm') continue;
      try {
        sources.push({ pid: proc.pid, ppid: proc.ppid, text:(await readFile(launcher.path, 'utf8')).slice(0, 65536) });
      } catch { /* unreadable script: skip */ }
    }
    for (const entry of unowned) {
      let hits = sources.filter((s) => new RegExp(`(?<![\\d.])${entry.port}(?!\\d)`).test(s.text));
      // `py.exe script.py` spawns `python.exe script.py`: keep the child, drop the launcher.
      hits = hits.filter((h) => !hits.some((other) => other.ppid === h.pid));
      if (hits.length === 1) {
        entry.pid = hits[0].pid;
        entry.pidGuessed = true;
      }
    }
  }

  const ports = [...byPort.values()].sort((a, b) => a.port - b.port).map((entry) => {
    const proc = entry.pid ? processes.get(entry.pid) || null : null;
    const chain = buildChain(entry.pid, processes);
    const launcher = findLauncher(chain, existsSync);
    const exe = (proc && proc.exe) || '';
    const folder = launcher ? dirName(launcher.path) : exe ? dirName(exe) : null;
    return {
      port: entry.port,
      address: entry.address,
      pid: entry.pid,
      pidGuessed: !!entry.pidGuessed,
      found: entry.found,
      process: (proc && proc.name) || (chain[0] && chain[0].name) || '',
      commandLine: (proc && proc.commandLine) || (chain[0] && chain[0].commandLine) || '',
      exe,
      chain,
      launcher,
      folder,
      http: null,
    };
  });

  if (probe) {
    await Promise.all(ports.map(async (entry) => {
      entry.http = await probeHttp(entry.port);
    }));
  }

  return { ports, scannedAt };
}

// ── History ────────────────────────────────────────────────────────────────

const HISTORY_LIMIT = 500;
const SCRIPT_LIMIT = 200 * 1024;

export function historyPath() {
  return join(homedir(), '.localhost-browser', 'history.json');
}

let historyCache = null;

async function readHistory() {
  try {
    const text = await readFile(historyPath(), 'utf8');
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.filter((e) => e && typeof e.url === 'string') : [];
  } catch {
    return [];
  }
}

async function writeHistory(entries) {
  const file = historyPath();
  await mkdir(dirName(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, JSON.stringify(entries, null, 2), 'utf8');
  await rename(temp, file);
}

export async function loadHistory() {
  if (historyCache === null) historyCache = await readHistory();
  return historyCache;
}

const byLastVisited = (a, b) => String(b.lastVisited || '').localeCompare(String(a.lastVisited || ''));

/** Upsert one visit. `saved` and `note` only change when the caller sends them. */
export function upsertHistory(entries, input, now = new Date().toISOString()) {
  const url = String(input.url);
  const list = entries.slice();
  const at = list.findIndex((e) => e.url === url);

  if (at < 0) {
    list.push({
      url,
      port: Number(input.port) || portOf(url),
      title: typeof input.title === 'string' ? input.title : '',
      visits: 1,
      firstVisited: now,
      lastVisited: now,
      saved: input.saved === true,
      note: typeof input.note === 'string' ? input.note : '',
      launcher: typeof input.launcher === 'string' ? input.launcher : '',
      folder: typeof input.folder === 'string' ? input.folder : '',
      process: typeof input.process === 'string' ? input.process : '',
    });
  } else {
    const prev = list[at];
    list[at] = {
      ...prev,
      port: Number(input.port) || prev.port,
      title: typeof input.title === 'string' && input.title ? input.title : prev.title,
      visits: (Number(prev.visits) || 0) + 1,
      lastVisited: now,
      saved: typeof input.saved === 'boolean' ? input.saved : prev.saved === true,
      note: typeof input.note === 'string' ? input.note : prev.note || '',
      launcher: typeof input.launcher === 'string' && input.launcher ? input.launcher : prev.launcher || '',
      folder: typeof input.folder === 'string' && input.folder ? input.folder : prev.folder || '',
      process: typeof input.process === 'string' && input.process ? input.process : prev.process || '',
    };
  }

  return trimHistory(list);
}

function trimHistory(list) {
  if (list.length <= HISTORY_LIMIT) return list;
  const kept = list.slice();
  const oldest = (arr) => {
    let best = 0;
    for (let i = 1; i < arr.length; i += 1) {
      if (String(arr[i].lastVisited || '') < String(arr[best].lastVisited || '')) best = i;
    }
    return best;
  };
  while (kept.length > HISTORY_LIMIT) {
    const unsaved = kept.filter((e) => !e.saved);
    if (unsaved.length) {
      const victim = unsaved[oldest(unsaved)];
      kept.splice(kept.indexOf(victim), 1);
    } else {
      kept.splice(oldest(kept), 1);
    }
  }
  return kept;
}

function portOf(url) {
  try {
    const parsed = new URL(url);
    if (parsed.port) return Number(parsed.port);
    return parsed.protocol === 'https:' ? 443 : 80;
  } catch {
    return 0;
  }
}

// ── Allowlisted paths ──────────────────────────────────────────────────────

const samePath = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const left = resolve(a);
  const right = resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
};

/**
 * The only paths this server will open or read: what the latest scan saw, or
 * what history remembered. Everything else is a 403, which is what keeps this
 * from being a general file reader.
 */
export function allowedPaths(scan, history) {
  const set = new Set();
  const add = (p) => { if (typeof p === 'string' && p) set.add(resolve(p)); };
  for (const entry of (scan && scan.ports) || []) {
    add(entry.launcher && entry.launcher.path);
    add(entry.folder);
    add(entry.exe);
  }
  for (const entry of Array.isArray(history) ? history : []) {
    add(entry.launcher);
    add(entry.folder);
  }
  return set;
}

function isAllowedPath(candidate, allowed) {
  if (typeof candidate !== 'string' || !candidate.trim()) return false;
  for (const known of allowed) {
    if (samePath(known, candidate)) return true;
  }
  return false;
}

// ── HTTP plumbing ──────────────────────────────────────────────────────────

const MAX_BODY = 256 * 1024;

function send(res, code, body, type = 'application/json; charset=utf-8') {
  const payload = typeof body === 'string' ? body : JSON.stringify(body ?? null);
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(payload);
}

const sendJson = (res, code, body) => send(res, code, body);

function readBody(req) {
  return new Promise((done, fail) => {
    let data = '';
    let size = 0;
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) { fail(new Error('body too large')); req.destroy(); return; }
      data += chunk;
    });
    req.on('end', () => done(data));
    req.on('error', fail);
  });
}

const localPort = (req) => {
  try { return req.socket.localPort || 0; } catch { return 0; }
};

/** DNS-rebinding guard: the Host header must name this machine's loopback. */
export function hostAllowed(hostHeader, port) {
  const host = String(hostHeader || '').toLowerCase();
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

/** CSRF guard for writes: an Origin, when present, must be our own. */
export function originAllowed(originHeader, port) {
  if (!originHeader) return true;
  const origin = String(originHeader).toLowerCase();
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

function launchExplorer(target) {
  const options = { windowsHide: true };
  if (process.platform === 'win32') return execFileP('explorer.exe', ['/select,' + target], options).catch(() => {});
  if (process.platform === 'darwin') return execFileP('open', ['-R', target], options).catch(() => {});
  return execFileP('xdg-open', [dirName(target)], options).catch(() => {});
}

async function describePath(target) {
  let info;
  try { info = await stat(target); } catch { return null; }

  if (info.isDirectory()) {
    let text;
    try {
      const pkg = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'));
      text = JSON.stringify({ name: pkg.name, version: pkg.version, scripts: pkg.scripts || {} }, null, 2);
    } catch {
      try {
        const names = (await readdir(target, { withFileTypes: true }))
          .map((entry) => (entry.isDirectory() ? entry.name + '/' : entry.name))
          .sort();
        text = names.join('\n');
      } catch {
        return null;
      }
    }
    return { path: target, kind: 'folder', size: text.length, text, truncated: false };
  }

  if (!info.isFile()) return null;
  const raw = await readFile(target);
  const capped = raw.subarray(0, SCRIPT_LIMIT);
  let text = capped.toString('utf8');
  if (/[\\/]package\.json$/.test(target)) {
    try {
      const pkg = JSON.parse(text);
      text = JSON.stringify({ name: pkg.name, version: pkg.version, scripts: pkg.scripts || {} }, null, 2);
    } catch { /* not our JSON; show it as it is */ }
  }
  return {
    path: target,
    kind: 'file',
    size: info.size,
    text,
    truncated: raw.length > SCRIPT_LIMIT,
  };
}

// ── Server ─────────────────────────────────────────────────────────────────

export function createLocalhostServer() {
  let lastScan = null;
  let scanning = null;
  let boundPort = 0;

  // /api/open-folder and /api/script need an allowlist even if the page has not
  // asked for a scan yet — so scan once, without probes, and cache it.
  const ensureScan = async () => {
    if (lastScan) return lastScan;
    if (!scanning) {
      scanning = scanPorts({ selfPort: boundPort, probe: false })
        .then((result) => { lastScan = result; return result; })
        .finally(() => { scanning = null; });
    }
    return scanning;
  };

  const server = createServer(async (req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    } catch {
      return send(res, 400, 'bad path', 'text/plain; charset=utf-8');
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    const port = localPort(req) || boundPort;

    if (pathname.startsWith('/api/')) {
      if (!hostAllowed(req.headers.host, port)) {
        return sendJson(res, 403, { error: 'bad host' });
      }
      if (req.method !== 'GET' && !originAllowed(req.headers.origin, port)) {
        return sendJson(res, 403, { error: 'bad origin' });
      }

      try {
        if (pathname === '/api/ports' && req.method === 'GET') {
          const extraPorts = (await loadHistory()).map((e) => Number(e.port)).filter(Boolean);
          const result = await scanPorts({ selfPort: port, extraPorts });
          lastScan = result;
          return sendJson(res, 200, result);
        }

        if (pathname === '/api/history' && req.method === 'GET') {
          const list = await loadHistory();
          return sendJson(res, 200, { entries: list.slice().sort(byLastVisited) });
        }

        if (pathname === '/api/history' && req.method === 'POST') {
          let body;
          try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return sendJson(res, 400, { error: 'bad json' }); }
          if (!isLocalUrl(body.url)) return sendJson(res, 400, { error: 'only localhost urls are accepted' });
          const next = upsertHistory(await loadHistory(), body);
          historyCache = next;
          await writeHistory(next);
          return sendJson(res, 200, { entries: next.slice().sort(byLastVisited) });
        }

        if (pathname === '/api/history' && req.method === 'DELETE') {
          const target = url.searchParams.get('url') || '';
          const list = await loadHistory();
          const next = list.filter((entry) => entry.url !== target);
          historyCache = next;
          await writeHistory(next);
          return sendJson(res, 200, { entries: next.slice().sort(byLastVisited) });
        }

        if (pathname === '/api/open-folder' && req.method === 'POST') {
          let body;
          try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return sendJson(res, 400, { error: 'bad json' }); }
          const scan = await ensureScan();
          const allowed = allowedPaths(scan, await loadHistory());
          if (!isAllowedPath(body.path, allowed)) return sendJson(res, 403, { error: 'path not in the scan' });
          await launchExplorer(resolve(body.path));
          return sendJson(res, 200, { opened: resolve(body.path) });
        }

        if (pathname === '/api/script' && req.method === 'GET') {
          const target = url.searchParams.get('path') || '';
          const scan = await ensureScan();
          const allowed = allowedPaths(scan, await loadHistory());
          if (!isAllowedPath(target, allowed)) return sendJson(res, 403, { error: 'path not in the scan' });
          const described = await describePath(resolve(target));
          if (!described) return sendJson(res, 404, { error: 'not readable' });
          return sendJson(res, 200, described);
        }

        return sendJson(res, 404, { error: 'no such endpoint' });
      } catch (err) {
        return sendJson(res, 500, { error: String((err && err.message) || err) });
      }
    }

    // ── Static files ──────────────────────────────────────────────────────
    try {
      let requestPath = pathname;
      // Redirect rather than rewrite: the page loads ./app.css and ./main.js relative to its URL.
      if (requestPath === '/' || requestPath === '') {
        res.writeHead(302, { location: '/apps/localhost/' }).end();
        return;
      }
      if (requestPath.endsWith('/')) requestPath += 'index.html';

      const target = normalize(join(ROOT, requestPath));
      if (!target.startsWith(ROOT + sep) && target !== ROOT) {
        return send(res, 403, 'forbidden', 'text/plain; charset=utf-8');
      }

      // `/apps/localhost` and `/apps/localhost/` both mean the page.
      let file = target;
      try {
        if ((await stat(target)).isDirectory()) file = join(target, 'index.html');
      } catch {
        return send(res, 404, 'not found', 'text/plain; charset=utf-8');
      }

      const body = await readFile(file);
      res.writeHead(200, {
        'content-type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
        'cache-control': 'no-store',
      }).end(body);
    } catch (err) {
      if (err && err.code === 'ENOENT') return send(res, 404, 'not found', 'text/plain; charset=utf-8');
      return send(res, 500, 'server error', 'text/plain; charset=utf-8');
    }
  });

  server.on('listening', () => {
    try { boundPort = server.address().port; } catch { boundPort = 0; }
  });

  return server;
}

function runDirectly() {
  const arg = process.argv[1];
  if (!arg) return false;
  try { return import.meta.url === pathToFileURL(resolve(arg)).href; } catch { return false; }
}

if (runDirectly()) {
  const server = createLocalhostServer();
  server.listen(PORT, '127.0.0.1', () => {
    process.stdout.write(`localhost browser → http://localhost:${server.address().port}/\n`);
  });
}
