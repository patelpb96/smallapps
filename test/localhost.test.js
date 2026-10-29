/**
 * The parts of the localhost browser that decide something.
 *
 * The scan itself needs a live machine; these are the four decisions worth
 * pinning down: how a command line is tokenized, which token is the launcher,
 * what a page's title is, and which urls this thing is allowed to remember.
 *
 * Fake paths only — this repository is public and has no home directory.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  splitCommandLine, findLauncher, extractTitle, isLocalUrl, isAbsolutePath, dirName,
  portsInCommandLine, guessOwner,
} from '../scripts/localhost-server.js';

const existsIn = (paths) => {
  const set = new Set(paths);
  return (p) => set.has(p);
};

// ── splitCommandLine ───────────────────────────────────────────────────────

test('splits a plain command line on whitespace', () => {
  assert.deepEqual(splitCommandLine('node index.js --port 3000'), ['node', 'index.js', '--port', '3000']);
});

test('keeps a quoted Windows path with spaces as one token', () => {
  const line = String.raw`"C:\Program Files\nodejs\node.exe" "C:\a b\serve.js" --port 3000`;
  assert.deepEqual(splitCommandLine(line), [
    String.raw`C:\Program Files\nodejs\node.exe`,
    String.raw`C:\a b\serve.js`,
    '--port',
    '3000',
  ]);
});

test('a shell wrapper keeps its quoted payload intact', () => {
  const line = String.raw`cmd /c "C:\a b\run.bat" --quiet`;
  assert.deepEqual(splitCommandLine(line), ['cmd', '/c', String.raw`C:\a b\run.bat`, '--quiet']);
});

test('backslashes survive unquoted', () => {
  const single = String.raw`C:\proj\run.bat`;
  assert.deepEqual(splitCommandLine(single), [single]);
});

test('an escaped quote is a quote, not a delimiter', () => {
  const line = String.raw`node "C:\a b\say \"hi\".js"`;
  assert.deepEqual(splitCommandLine(line), ['node', String.raw`C:\a b\say "hi".js`]);
});

test('empty and whitespace-only command lines have no tokens', () => {
  assert.deepEqual(splitCommandLine(''), []);
  assert.deepEqual(splitCommandLine('   \t  '), []);
  assert.deepEqual(splitCommandLine(null), []);
});

test('an empty quoted argument is still an argument', () => {
  assert.deepEqual(splitCommandLine('node "" --x'), ['node', '', '--x']);
});

// ── Absolute paths and dirname ─────────────────────────────────────────────

test('absolute means absolute on both platforms', () => {
  assert.equal(isAbsolutePath(String.raw`C:\proj\run.bat`), true);
  assert.equal(isAbsolutePath('C:/proj/run.bat'), true);
  assert.equal(isAbsolutePath('/srv/app/run.sh'), true);
  assert.equal(isAbsolutePath(String.raw`\\server\share\run.ps1`), true);
  assert.equal(isAbsolutePath('scripts/serve.js'), false);
  assert.equal(isAbsolutePath('run.bat'), false);
});

test('dirname works without the platform deciding for us', () => {
  assert.equal(dirName(String.raw`C:\proj\run.bat`), String.raw`C:\proj`);
  assert.equal(dirName(String.raw`C:\proj\tools\task`), String.raw`C:\proj\tools`);
  assert.equal(dirName('/srv/app/run.sh'), '/srv/app');
  assert.equal(dirName('run.bat'), '.');
});

// ── findLauncher ───────────────────────────────────────────────────────────

test('the process itself wins over its parent', () => {
  const chain = [
    { pid: 10, name: 'node.exe', commandLine: String.raw`node "C:\proj\run.bat"` },
    { pid: 4, name: 'cmd.exe', commandLine: String.raw`cmd /c "C:\proj\parent.cmd"` },
  ];
  const launcher = findLauncher(chain, existsIn([String.raw`C:\proj\run.bat`, String.raw`C:\proj\parent.cmd`]));
  assert.deepEqual(launcher, { path: String.raw`C:\proj\run.bat`, kind: 'bat', from: 'node.exe' });
});

test('a candidate that is not on disk is skipped for the parent', () => {
  const chain = [
    { pid: 10, name: 'node.exe', commandLine: String.raw`node "C:\gone\run.bat"` },
    { pid: 4, name: 'cmd.exe', commandLine: String.raw`cmd /c "C:\proj\real.cmd"` },
  ];
  const launcher = findLauncher(chain, existsIn([String.raw`C:\proj\real.cmd`]));
  assert.equal(launcher.path, String.raw`C:\proj\real.cmd`);
  assert.equal(launcher.kind, 'cmd');
  assert.equal(launcher.from, 'cmd.exe');
});

test('a node_modules shim loses to the user script further up the chain', () => {
  const shim = String.raw`C:\proj\node_modules\.bin\vite.cmd`;
  const script = String.raw`C:\proj\scripts\dev.js`;
  const chain = [
    { pid: 30, name: 'vite.cmd', commandLine: String.raw`cmd /c "C:\proj\node_modules\.bin\vite.cmd"` },
    { pid: 20, name: 'npm.cmd', commandLine: String.raw`node "C:\proj\scripts\dev.js"` },
  ];
  const launcher = findLauncher(chain, existsIn([shim, script]));
  assert.deepEqual(launcher, { path: script, kind: 'js', from: 'npm.cmd' });
});

test('a shim is still better than nothing', () => {
  const shim = String.raw`C:\proj\node_modules\.bin\vite.cmd`;
  const chain = [{ pid: 30, name: 'cmd.exe', commandLine: `cmd /c "${shim}" --host` }];
  const launcher = findLauncher(chain, existsIn([shim]));
  assert.equal(launcher.path, shim);
  assert.equal(launcher.kind, 'cmd');
});

test('no runnable token falls back to the nearest package.json as npm', () => {
  const chain = [
    { pid: 10, name: 'node.exe', commandLine: String.raw`"C:\Program Files\nodejs\node.exe" "C:\proj\tools\task" --watch` },
  ];
  const launcher = findLauncher(chain, existsIn([String.raw`C:\proj\package.json`]));
  assert.deepEqual(launcher, { path: String.raw`C:\proj\package.json`, kind: 'npm', from: 'node.exe' });
});

test('the package.json fallback does not walk past four directories', () => {
  const chain = [{ pid: 10, name: 'node.exe', commandLine: String.raw`node C:\a\b\c\d\e\f\task` }];
  const launcher = findLauncher(chain, existsIn([String.raw`C:\package.json`]));
  assert.equal(launcher, null);
});

test('relative and extension-less tokens are not launchers', () => {
  const chain = [
    { pid: 10, name: 'node.exe', commandLine: 'node scripts/serve.js --port 4173' },
    { pid: 9, name: 'bash', commandLine: 'bash -lc node scripts/serve.js' },
  ];
  assert.equal(findLauncher(chain, () => true), null);
});

test('a launcher extension that is not on disk is not a launcher', () => {
  const chain = [{ pid: 10, name: 'node.exe', commandLine: String.raw`node C:\proj\missing.js` }];
  assert.equal(findLauncher(chain, () => false), null);
});

test('empty chains and missing command lines are handled', () => {
  assert.equal(findLauncher([], () => true), null);
  assert.equal(findLauncher([{ pid: 1, name: 'x', commandLine: '' }], () => true), null);
  assert.equal(findLauncher(null, () => true), null);
});

// ── extractTitle ───────────────────────────────────────────────────────────

test('reads the title out of a page', () => {
  assert.equal(extractTitle('<html><head><title>My App</title></head></html>'), 'My App');
});

test('title matching is case-insensitive and collapses whitespace', () => {
  assert.equal(extractTitle('<TITLE>\n  Vite   +   React\n</TITLE>'), 'Vite + React');
});

test('entities in a title are decoded', () => {
  assert.equal(extractTitle("<title>Tom &amp; Jerry &lt;3 &#39;dev&#39;</title>"), "Tom & Jerry <3 'dev'");
});

test('a page without a title has an empty one', () => {
  assert.equal(extractTitle('<html><body>hi</body></html>'), '');
  assert.equal(extractTitle(''), '');
  assert.equal(extractTitle(null), '');
});

test('a title is capped so a hostile page cannot bloat the response', () => {
  assert.equal(extractTitle(`<title>${'a'.repeat(500)}</title>`).length, 200);
});

// ── isLocalUrl ─────────────────────────────────────────────────────────────

test('the three loopback spellings are accepted', () => {
  assert.equal(isLocalUrl('http://localhost:3000/'), true);
  assert.equal(isLocalUrl('http://127.0.0.1:8080/x?y=1'), true);
  assert.equal(isLocalUrl('http://[::1]:3000/'), true);
  assert.equal(isLocalUrl('https://localhost/'), true);
});

test('everything that is not loopback is rejected', () => {
  assert.equal(isLocalUrl('http://evil.com/'), false);
  assert.equal(isLocalUrl('http://localhost.evil.com/'), false);
  assert.equal(isLocalUrl('http://127.0.0.1.evil.com/'), false);
  assert.equal(isLocalUrl('file:///C:/proj/index.html'), false);
  assert.equal(isLocalUrl('javascript:alert(1)'), false);
  assert.equal(isLocalUrl('not a url'), false);
  assert.equal(isLocalUrl(''), false);
  assert.equal(isLocalUrl(null), false);
});

test('ports are read out of the common command-line spellings', () => {
  const ports = (s) => [...portsInCommandLine(s)].sort();
  assert.deepEqual(ports('python -m http.server 4199 --bind 127.0.0.1'), [4199]);
  assert.deepEqual(ports('vite --port 5179 --strictPort'), [5179]);
  assert.deepEqual(ports('cmd /c set AGENT_DASH_PORT=8766&& python server.py'), [8766]);
  assert.deepEqual(ports('serve -p=3000 http://localhost:3001/'), [3000, 3001]);
  assert.deepEqual(ports('node server.js 80'), []);
});

test('a shell that names the port hands ownership to its child', () => {
  const procs = new Map([
    [10, { pid: 10, ppid: 1, name: 'cmd.exe', commandLine: 'cmd /c set PORT=8766&& python server.py' }],
    [11, { pid: 11, ppid: 10, name: 'python.exe', commandLine: 'python server.py' }],
    [12, { pid: 12, ppid: 1, name: 'node.exe', commandLine: 'node other.js 5173' }],
  ]);
  assert.equal(guessOwner(8766, procs), 11);
  assert.equal(guessOwner(5173, procs), 12);
  assert.equal(guessOwner(9999, procs), 0);
});
