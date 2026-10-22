/**
 * Personal-data check.
 *
 * This repository is public. Paths, hostnames and addresses that identify the
 * machine it was authored on are not content, they are leakage — and they leak
 * silently, because an absolute path in a document looks exactly like a path.
 *
 * Only text files are scanned. The PDFs under docs/papers are third-party papers
 * whose own example paths are not ours to police.
 */

import { readFile, readdir } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';

/** A backslash without writing one, which has been a source of bugs here. */
const BACKSLASH = String.fromCharCode(92);

const TEXT_EXT = /\.(js|mjs|cjs|ts|md|html|css|json|txt|yml|yaml|toml|sh|ps1)$/;

const SCAN_DIRS = ['src', 'apps', 'scripts', 'test', 'docs', 'bin'];
const SCAN_ROOT_FILES = ['README.md', 'AGENTS.md', 'index.html', 'package.json'];
const SKIP_DIRS = new Set(['node_modules', '.git', '.scratch', 'papers']);

/** Placeholders that are nobody's home directory. */
const GENERIC_USERS = new Set([
  'user', 'users', 'example', 'you', 'yourname', 'runner', 'ubuntu', 'root', 'me', 'home',
]);

/** Addresses that are intentionally generic in documentation and tooling. */
const OK_EMAIL = /@(users\.noreply\.github\.com|noreply\.github\.com|example\.(com|org|net)|github\.com|localhost)$/i;

async function walk(root, dir, out = []) {
  let entries;
  try {
    entries = await readdir(join(root, dir), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(root, rel, out);
    } else if (TEXT_EXT.test(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

/**
 * @param {string} root absolute repo root
 * @param {string[]} problems array to append findings to
 * @returns {Promise<number>} number of findings
 */
export async function checkPersonalData(root, problems) {
  const host = (hostname?.() || '').toLowerCase();
  const checkHost = host.length >= 4 && !GENERIC_USERS.has(host);

  const files = [...SCAN_ROOT_FILES];
  for (const dir of SCAN_DIRS) files.push(...await walk(root, dir));

  let findings = 0;
  for (const rel of [...new Set(files)]) {
    // This module necessarily contains the patterns it looks for.
    if (rel.split(BACKSLASH).join('/').endsWith('scripts/checks/personal-data.js')) continue;

    let text;
    try {
      text = await readFile(join(root, rel), 'utf8');
    } catch {
      continue;
    }
    // Normalise separators so one set of patterns covers both platforms.
    const flat = text.split(BACKSLASH).join('/');
    const lines = flat.split('\n');
    const seen = new Set();
    const report = (lineNo, what, value) => {
      // One leak, one line: "C:/Users/x" also matches the "/Users/x" pattern.
      if ([...seen].some((prior) => prior.includes(value) || value.includes(prior.split(':').pop()))) return;
      seen.add(`${lineNo}:${what}:${value}`);
      findings += 1;
      problems.push(`${rel}:${lineNo} contains ${what} "${value}" — this repository is public`);
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNo = i + 1;

      // C:/Users/<name>
      for (const m of line.matchAll(/(?:^|[^A-Za-z0-9])[A-Za-z]:\/Users\/([^/\s"'`]+)/g)) {
        if (!GENERIC_USERS.has(m[1].toLowerCase())) report(lineNo, 'absolute home path', m[0].trim());
      }
      // /c/Users/<name>
      for (const m of line.matchAll(/\/c\/Users\/([^/\s"'`]+)/g)) {
        if (!GENERIC_USERS.has(m[1].toLowerCase())) report(lineNo, 'absolute home path', m[0]);
      }
      // /home/<name> and /Users/<name>
      for (const m of line.matchAll(/\/(?:home|Users)\/([^/\s"'`]+)/g)) {
        if (!GENERIC_USERS.has(m[1].toLowerCase())) report(lineNo, 'absolute home path', m[0]);
      }
      // Addresses that are not the sanctioned generic ones.
      for (const m of line.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
        if (!OK_EMAIL.test(m[0])) report(lineNo, 'email address', m[0]);
      }
      if (checkHost && line.toLowerCase().includes(host)) {
        report(lineNo, 'machine hostname', host);
      }
    }
  }

  return findings;
}

/**
 * Identity check for the commit author.
 *
 * Reported as a warning rather than a failure: the address is per-machine git
 * config, not repository content, and failing here would block contributors who
 * have their own policy. It still prints on every run, which is the point.
 */
export function checkCommitIdentity(root, notes) {
  return import('node:child_process').then(({ execFileSync }) => {
    let email = '';
    try {
      email = execFileSync('git', ['config', '--local', 'user.email'], { cwd: root, encoding: 'utf8' }).trim();
    } catch {
      return false;
    }
    if (!email) {
      notes.push('no local user.email set — commits will use the global identity');
      return false;
    }
    if (!OK_EMAIL.test(`@${email.split('@')[1] || ''}`)) {
      notes.push(`commit identity is "${email}", which is not a noreply address — see AGENTS.md`);
      return false;
    }
    return true;
  });
}
