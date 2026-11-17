// Safety scan run before anything is published. Used by the studio (as the unprivileged user)
// and again by the root publisher (studio-publish), so a skipped check in the UI can't skip it here.
//
// Rules (severity depends on mode; "pages" = whole static site goes public, "branch" = code diff for review):
//   secret          tokens / keys / webhook URLs / private keys                    -> block
//   forbidden       strings that must never appear (server paths, tailscale, ...)  -> block
//   private-file    .env, databases, keys, pem                                      -> block
//   email           an e-mail address that is not on the owner's allow list         -> block (pages) / warn
//   ip              IPv4 addresses (except 127.0.0.1 / 0.0.0.0)                     -> block (pages) / warn
//   broken-link     relative href/src/action that points to a missing file          -> block (pages only)
//   fake-form       <form> without a real https:// action                           -> block (pages) / warn
//   tests           project test-suite fails                                        -> block (when asked to run)
//   external-domain domains not on the allow list (links or mentioned in text)      -> warn
//   todo            visible TODO text                                               -> warn
//   big-file        file over 5 MB                                                  -> warn
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const SKIP_DIRS = new Set(['.git', '.noob-studio', 'node_modules', '.venv', '__pycache__', '.pytest_cache', '.claude', '.idea', '.vscode']);
const TEXT_EXT = /\.(html?|css|js|mjs|json|md|txt|svg|xml|ya?ml|py|toml|ini|cfg|sh|csv|webmanifest)$/i;
const PRIVATE_FILE = /(^|\/)(\.env(\..+)?|id_(rsa|ed25519|ecdsa)|.*\.(pem|key|p12|pfx|db|sqlite3?|db-wal|db-shm))$/i;
const SECRETS = [
  ['discord-webhook', /discord(?:app)?\.com\/api\/webhooks\/\d{6,}\/[\w-]{20,}/],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ['api-key', /\bsk-[A-Za-z0-9_-]{24,}\b/],
  ['aws-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['telegram-token', /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/],
];
const DEFAULT_FORBIDDEN = ['/home/noob', '.ts.net', 'tailscale.net', 'login.tailscale.com'];
const DEFAULT_DOMAINS = ['github.com', 'github.io', 'githubusercontent.com', 'fonts.googleapis.com', 'fonts.gstatic.com', 'discord.com', 'w3.org', 'example.com'];
const IPV4 = /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\d.])/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const BARE_DOMAIN = /\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|dev|app|co|me|xyz|ai)\b/gi;

function listFiles(root) {
  const out = [];
  (function walk(rel) {
    let ents; try { ents = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isSymbolicLink()) continue;                       // never follow links out of the project
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(r); }
      else if (e.isFile()) out.push(r);
    }
  })('');
  return out.sort();
}

const hostOk = (host, allowed) => allowed.some((d) => host === d || host.endsWith('.' + d));
const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;

function runTests(dir, asUser) {
  return new Promise((resolve) => {
    const py = path.join(dir, '.venv', 'bin', 'python');
    if (!fs.existsSync(py) || !fs.existsSync(path.join(dir, 'tests'))) return resolve({ skipped: true });
    const args = ['-m', 'pytest', '-q', '-x', '-p', 'no:warnings'];
    // as root we must never run project code: drop to the owner first
    const [cmd, cargs] = asUser ? ['runuser', ['-u', asUser, '--', py, ...args]] : [py, args];
    const child = spawn(cmd, cargs, { cwd: dir, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    let out = ''; const t = setTimeout(() => { child.kill(); out += '\n[timeout after 300s]'; }, 300000);
    child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
    child.on('error', (e) => { clearTimeout(t); resolve({ ok: false, out: String(e) }); });
    child.on('close', (code) => { clearTimeout(t); resolve({ ok: code === 0, out: out.trim().split('\n').slice(-3).join(' | ') }); });
  });
}

/** opts: { dir, files?, mode: 'pages'|'branch', allowedEmails, allowedDomains, forbidden, runTests, asUser } */
async function runChecks(opts) {
  const root = opts.dir, mode = opts.mode || 'pages', pages = mode === 'pages';
  const allowedEmails = (opts.allowedEmails || []).map((e) => e.toLowerCase());
  const allowedDomains = [...DEFAULT_DOMAINS, ...(opts.allowedDomains || []), ...allowedEmails.map((e) => e.split('@')[1])];
  const forbidden = [...DEFAULT_FORBIDDEN, ...(opts.forbidden || [])];
  const files = opts.files || listFiles(root);
  const findings = []; const add = (rule, severity, file, line, msg) => findings.push({ rule, severity, file, line, msg });
  const stats = { files: files.length, htmlPages: 0, links: 0 };

  for (const rel of files) {
    const full = path.join(root, rel);
    let st; try { st = fs.lstatSync(full); } catch { continue; }
    if (!st.isFile()) continue;
    if (PRIVATE_FILE.test(rel) && !/\.env\.example$/i.test(rel)) { add('private-file', 'block', rel, 0, 'file type that must never be published'); continue; }
    if (st.size > 5 * 1024 * 1024) add('big-file', 'warn', rel, 0, `${(st.size / 1048576).toFixed(1)} MB`);
    if (!TEXT_EXT.test(rel) || st.size > 2 * 1024 * 1024) continue;
    let text; try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
    if (text.includes('\0')) continue;
    const isHtml = /\.html?$/i.test(rel);

    for (const [name, re] of SECRETS) { const m = re.exec(text); if (m) add('secret', 'block', rel, lineOf(text, m.index), `looks like a ${name}`); }
    for (const f of forbidden) { const i = text.indexOf(f); if (i >= 0) add('forbidden', 'block', rel, lineOf(text, i), `contains "${f}"`); }

    const decoded = text.replace(/&#0*64;|&#x0*40;|&commat;|%40/gi, '@');
    for (const m of decoded.matchAll(EMAIL)) {
      const e = m[0].toLowerCase();
      if (allowedEmails.includes(e) || /@users\.noreply\.github\.com$|@example\.(com|org)$|^noreply@/.test(e)) continue;
      add('email', pages ? 'block' : 'warn', rel, lineOf(decoded, m.index), `e-mail not on the allow list: ${m[0]}`);
    }
    for (const m of text.matchAll(IPV4)) {
      if (m[0] === '127.0.0.1' || m[0] === '0.0.0.0') continue;
      add('ip', pages ? 'block' : 'warn', rel, lineOf(text, m.index), `IP address ${m[0]}`);
    }

    if (isHtml) {
      stats.htmlPages++;
      const noComments = text.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' '));
      const visible = noComments.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/g, ' ');
      if (/\bTODO\b/.test(visible)) add('todo', 'warn', rel, 0, 'visible TODO text');
      const hosts = new Set();
      for (const tag of noComments.matchAll(/<(a|link|script|img|source|iframe|form|video|audio)\b([^>]*)>/gi)) {
        const name = tag[1].toLowerCase(), attrs = tag[2];
        if (name === 'form') {
          const act = /\saction\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
          if (!act || !/^https:\/\//i.test(act[1] || act[2] || '')) add('fake-form', pages ? 'block' : 'warn', rel, lineOf(text, tag.index), 'form without a real https:// action (it would pretend to send data)');
        }
        for (const a of attrs.matchAll(/\s(?:href|src|action)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
          const v = (a[1] ?? a[2] ?? '').trim(); if (!v) continue;
          if (/^(mailto:|tel:|data:|javascript:|#)/i.test(v)) continue;
          if (/^https?:\/\//i.test(v)) { try { hosts.add(new URL(v).hostname.toLowerCase()); } catch {} continue; }
          if (!pages || /^\/\//.test(v)) continue;
          stats.links++;
          let target = decodeURIComponent(v.split('#')[0].split('?')[0]);
          const abs = target.startsWith('/') ? path.join(root, target) : path.join(path.dirname(full), target);
          const rootN = path.resolve(root) + path.sep, absN = path.resolve(abs);
          if (!(absN + path.sep).startsWith(rootN) && absN !== path.resolve(root)) { add('broken-link', 'block', rel, lineOf(text, tag.index), `link leaves the project: ${v}`); continue; }
          let ok = fs.existsSync(absN);
          if (ok && fs.statSync(absN).isDirectory()) ok = fs.existsSync(path.join(absN, 'index.html'));
          if (!ok) add('broken-link', 'block', rel, lineOf(text, tag.index), `missing target: ${v}`);
        }
      }
      for (const m of visible.matchAll(BARE_DOMAIN)) hosts.add(m[0].toLowerCase());
      for (const h of hosts) if (!hostOk(h, allowedDomains)) add('external-domain', 'warn', rel, 0, `domain not on the allow list: ${h}`);
    }
  }

  if (opts.runTests) {
    const t = await runTests(root, opts.asUser);
    stats.tests = t.skipped ? 'skipped (no .venv or tests)' : t.ok ? 'passed' : 'FAILED';
    if (!t.skipped && !t.ok) add('tests', 'block', '', 0, 'test suite failed: ' + t.out.slice(0, 300));
  }
  const seen = new Set(); const uniq = findings.filter((f) => { const k = [f.rule, f.file, f.msg].join('|'); if (seen.has(k)) return false; seen.add(k); return true; });
  const blocking = uniq.filter((f) => f.severity === 'block'), warnings = uniq.filter((f) => f.severity === 'warn');
  return { ok: blocking.length === 0, blocking, warnings, stats };
}

module.exports = { runChecks, listFiles, SKIP_DIRS };
