// Release helpers for the studio: preview of the real result, safety checks, publish call, Discord notices.
// Nothing here can push to GitHub by itself: publishing goes through the root-owned `studio-publish` helper
// (see deploy/), which re-runs the checks on its own.
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn, spawnSync } = require('child_process');
const { runChecks } = require('./checks');

const CONFIG_PATH = process.env.STUDIO_PUBLISH_CONFIG || '/etc/studio/publish.json';
const PUBLISH_CMD = process.env.STUDIO_PUBLISH_CMD || '/usr/local/bin/studio-publish';
const USE_SUDO = process.env.STUDIO_PUBLISH_SUDO !== '0';
const BASE_URL = (process.env.STUDIO_BASE_URL || '').replace(/\/+$/, '');
const WEBHOOK = () => process.env.STUDIO_DISCORD_WEBHOOK || '';

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return { projects: {}, checks: {} }; }
}
const norm = (p) => path.resolve(String(p || '')).replace(/[\\/]+$/, '');

/** Which configured publish target (if any) belongs to this job's project folder. */
function targetFor(job) {
  const cfg = loadConfig();
  for (const [name, p] of Object.entries(cfg.projects || {})) {
    if (norm(p.dir) === norm(job.projectPath)) return { name, ...p };
  }
  return null;
}

// ---------- preview ----------
const PREVIEW_SKIP = /(^|\/)(\.[^/]+|node_modules|__pycache__|\.venv|venv)(\/|$)|\.(db|sqlite3?|pem|key|env|log|py|pyc)$/i;
const MIME = { '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.webmanifest': 'application/manifest+json' };

/** Serve a static file of the project at /preview/<jobId>/<rel>. Returns false if the path can't be served. */
function servePreview(res, job, rel) {
  rel = rel.replace(/^\/+/, '');
  let decoded; try { decoded = decodeURIComponent(rel); } catch { return false; }
  if (decoded.includes('\0')) return false;
  const root = fs.realpathSync(job.projectPath);
  let file = path.resolve(root, decoded);
  if (file !== root && !file.startsWith(root + path.sep)) return false;
  try {
    if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    const real = fs.realpathSync(file);                       // a symlink must not lead out of the project
    if (!real.startsWith(root + path.sep)) return false;
    const relOut = path.relative(root, real).split(path.sep).join('/');
    if (PREVIEW_SKIP.test(relOut)) return false;
    const data = fs.readFileSync(real);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(real).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(data);
    return true;
  } catch { return false; }
}

function previewLink(job) {
  if (job.kind !== 'web' && job.kind !== 'team') return null;
  const rel = `/preview/${job.id}/`;
  return { path: rel, url: BASE_URL ? BASE_URL + rel : null };
}

// ---------- checks ----------
async function checksFor(job) {
  const cfg = loadConfig();
  const t = targetFor(job);
  const mode = t ? t.mode : (job.kind === 'code' ? 'branch' : 'pages');
  const c = cfg.checks || {};
  const p = t || {};
  // same lists as the root publisher: global + per-project
  const merged = (k) => [...(c[k] || []), ...(p[k] || [])];
  // branch mode publishes only what git sees as changed, so only those files are checked (like studio-publish)
  let files;
  if (mode === 'branch') {
    try { files = changedFiles(job.projectPath); }
    catch (e) { return { ok: false, blocking: [{ rule: 'git', severity: 'block', file: '', line: 0, msg: e.message }], warnings: [], stats: {}, mode, target: t ? t.name : null, publishable: !!t, at: Date.now() }; }
  }
  const r = await runChecks({
    dir: job.projectPath, mode, files,
    allowedEmails: merged('allowedEmails'), allowedDomains: merged('allowedDomains'), forbidden: merged('forbidden'),
    runTests: mode === 'branch',
  });
  return { ...r, mode, target: t ? t.name : null, publishable: !!t, at: Date.now() };
}

/** Files git sees as modified or new (ignored files such as .env and databases are never included). */
function changedFiles(dir) {
  const ls = (extra) => {
    const r = spawnSync('git', ['-C', dir, 'ls-files', ...extra, '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) throw new Error('git ls-files failed: ' + String(r.stderr || '').trim().slice(0, 200));
    return r.stdout.split('\0').filter(Boolean);
  };
  const deleted = new Set(ls(['-d']));
  return [...new Set(ls(['-m', '-o', '--exclude-standard']))].filter((f) => !deleted.has(f) && !/^(\.noob-studio|data|logs)\//.test(f));
}

// ---------- Discord ----------
function notify(text) {
  const hook = WEBHOOK();
  if (!hook) return;
  try {
    const u = new URL(hook);
    if (u.protocol !== 'https:' || !/(^|\.)discord(app)?\.com$/.test(u.hostname)) return;
    const body = JSON.stringify({ username: 'noob_dev Studio', content: String(text).slice(0, 1800), allowed_mentions: { parse: [] } });
    const req = https.request(u, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 8000 }, (r) => r.resume());
    req.on('error', () => {}); req.on('timeout', () => req.destroy());
    req.end(body);
  } catch { /* notifications are best effort */ }
}
const studioLink = () => (BASE_URL ? `\n${BASE_URL}` : '');

// ---------- publish ----------
function publish(job, message) {
  return new Promise((resolve) => {
    const t = targetFor(job);
    if (!t) return resolve({ ok: false, stage: 'config', message: 'โปรเจกต์นี้ยังไม่ได้ตั้งค่าให้เผยแพร่' });
    const args = ['--project', t.name, '--job', job.id, '--message', String(message || job.brief).replace(/\s+/g, ' ').slice(0, 120)];
    const [cmd, cargs] = USE_SUDO ? ['sudo', ['-n', PUBLISH_CMD, ...args]] : [process.execPath, [PUBLISH_CMD, ...args]];
    const child = spawn(cmd, cargs, { env: process.env });
    let out = '', err = '';
    const timer = setTimeout(() => child.kill(), 10 * 60 * 1000);
    child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, stage: 'spawn', message: String(e.message) }); });
    child.on('close', () => {
      clearTimeout(timer);
      const line = out.trim().split('\n').filter(Boolean).pop() || '';
      try { resolve(JSON.parse(line)); } catch { resolve({ ok: false, stage: 'helper', message: (err || out || 'ตัวเผยแพร่ไม่ตอบ').trim().slice(0, 300) }); }
    });
  });
}

module.exports = { targetFor, servePreview, previewLink, checksFor, notify, studioLink, publish, loadConfig };
