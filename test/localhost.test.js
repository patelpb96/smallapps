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
  portsInCommandLine, guessOwner, parseNetstat,
  procAddress, parseProcNetTcp, parseProcStat, procCommandLine, collectLinux, parseLsof, parsePs,
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

test('netstat listeners are read by foreign port 0, not by the state word', () => {
  const text = [
    'Active Connections',
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    127.0.0.1:8765         0.0.0.0:0              LISTENING       27500',
    '  TCP    0.0.0.0:5173           0.0.0.0:0              ABHÖREN         412',
    '  TCP    127.0.0.1:50000        127.0.0.1:8765         ESTABLISHED     99',
    '  TCP    [::1]:4321             [::]:0                 LISTENING       0',
  ].join('\r\n');
  assert.deepEqual(parseNetstat(text), [
    { LocalAddress: '127.0.0.1', LocalPort: 8765, OwningProcess: 27500 },
    { LocalAddress: '0.0.0.0', LocalPort: 5173, OwningProcess: 412 },
    { LocalAddress: '::1', LocalPort: 4321, OwningProcess: 0 },
  ]);
  assert.deepEqual(parseNetstat(''), []);
});

// ── Linux /proc and macOS lsof/ps ──────────────────────────────────────────

test('/proc addresses decode for IPv4, IPv6 loopback, wildcard and v4-mapped', () => {
  assert.equal(procAddress('0100007F'), '127.0.0.1');
  assert.equal(procAddress('00000000'), '0.0.0.0');
  assert.equal(procAddress('00000000000000000000000001000000'), '::1');
  assert.equal(procAddress('00000000000000000000000000000000'), '::');
  assert.equal(procAddress('0000000000000000FFFF00000100007F'), '127.0.0.1');
});

test('/proc/net/tcp keeps only listening rows, with port and inode', () => {
  const text = [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 17410 1 0 100 0 0 10 0',
    '   1: 0100007F:10CB 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 19513 1 0 100 0 0 10 0',
    '   2: 0100007F:10CB 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1000        0 19600 1 0 100 0 0 10 0',
  ].join('\n');
  assert.deepEqual(parseProcNetTcp(text), [
    { address: '0.0.0.0', port: 8080, inode: '17410' },
    { address: '127.0.0.1', port: 4299, inode: '19513' },
  ]);
});

test('/proc/<pid>/stat names may contain spaces and parentheses', () => {
  assert.deepEqual(parseProcStat('812 (tmux: server) S 1 812 812 0 -1'), { name: 'tmux: server', ppid: 1 });
  assert.deepEqual(parseProcStat('9 (a) b) R 4 9 9'), { name: 'a) b', ppid: 4 });
  assert.equal(parseProcStat(''), null);
});

test('/proc cmdline arguments with spaces survive the round trip', () => {
  const line = procCommandLine('python3\0/srv/my app/run.py\0--port\x003000\0');
  assert.equal(line, 'python3 "/srv/my app/run.py" --port 3000');
  assert.deepEqual(splitCommandLine(line), ['python3', '/srv/my app/run.py', '--port', '3000']);
});

test('collectLinux finds a socket owner through /proc/<pid>/fd', async () => {
  const files = {
    '/proc/net/tcp': 'header\n   0: 0100007F:0BB8 00000000:0000 0A 0:0 0:0 0 1000 0 555 1\n',
    '/proc/10/stat': '10 (bash) S 1 10',
    '/proc/10/cmdline': 'bash\0',
    '/proc/11/stat': '11 (node) S 10 11',
    '/proc/11/cmdline': 'node\0/srv/app/server.js\0',
  };
  const dirs = { '/proc': ['10', '11', 'net', 'self'], '/proc/10/fd': ['0'], '/proc/11/fd': ['0', '7'] };
  const links = { '/proc/10/fd/0': '/dev/pts/0', '/proc/11/fd/0': '/dev/null', '/proc/11/fd/7': 'socket:[555]', '/proc/11/exe': '/usr/bin/node' };
  const miss = () => Promise.reject(new Error('ENOENT'));
  const fsx = {
    read: (p) => (p in files ? Promise.resolve(files[p]) : miss()),
    list: (p) => (p in dirs ? Promise.resolve(dirs[p]) : miss()),
    link: (p) => (p in links ? Promise.resolve(links[p]) : miss()),
  };
  const { listeners, processes } = await collectLinux(fsx);
  assert.deepEqual(listeners, [{ address: '127.0.0.1', port: 3000, pid: 11 }]);
  assert.deepEqual(processes.get(11), { pid: 11, ppid: 10, name: 'node', commandLine: 'node /srv/app/server.js', exe: '/usr/bin/node' });
});

test('lsof -F output: wildcard and bracketed IPv6 binds', () => {
  assert.deepEqual(parseLsof('p501\ncnode\nn*:5173\nn[::1]:3000\np77\ncPython\nn127.0.0.1:8000\n'), [
    { address: '0.0.0.0', port: 5173, pid: 501 },
    { address: '::1', port: 3000, pid: 501 },
    { address: '127.0.0.1', port: 8000, pid: 77 },
  ]);
});

test('macOS ps: comm is a full path that can contain spaces', () => {
  const comm = '  501     1 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome\n  612   501 node\n';
  const args = '  501 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --flag\n  612 node vite --port 5173\n';
  const procs = parsePs(comm, args);
  assert.equal(procs.get(501).name, 'Google Chrome');
  assert.equal(procs.get(501).exe, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  assert.deepEqual(procs.get(612), { pid: 612, ppid: 501, name: 'node', commandLine: 'node vite --port 5173', exe: '' });
});
