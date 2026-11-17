#!/usr/bin/env node
// studio-publish: the ONLY thing that can push to GitHub for the studio. Runs as root through a single
// sudo rule, reads /etc/studio/publish.json (root-owned) and deploy keys that the team's user cannot read.
//
//   studio-publish --project NAME --job ID --message "text"   publish (pages: push site; branch: push studio/<job>)
//   studio-publish --project NAME --dry-run                   show what would change, change nothing
//   studio-publish --project NAME --pull                      replace the project folder with GitHub's latest
//   --first   allow the very first publish even if files differ from GitHub
//
// Always prints one JSON line. Safe by construction: re-runs the safety checks itself, never follows symlinks,
// never runs project code as root, refuses to overwrite commits that were made somewhere else (drift).
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { runChecks, listFiles } = require('./checks.js');

const CONFIG = process.env.STUDIO_PUBLISH_CONFIG || '/etc/studio/publish.json';
const out = (o) => { process.stdout.write(JSON.stringify(o) + '\n'); process.exit(0); };
const fail = (stage, message, extra) => out({ ok: false, stage, message, ...(extra || {}) });

const args = {}; const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (!a.startsWith('--')) continue; const k = a.slice(2); args[k] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true; }

let cfg; try { cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch (e) { fail('config', `cannot read ${CONFIG}: ${e.message}`); }
const name = String(args.project || ''); const p = (cfg.projects || {})[name];
if (!p) fail('config', `unknown project "${name}"`);
const job = String(args.job || 'manual'); if (!/^[\w-]{1,40}$/.test(job)) fail('input', 'bad job id');
const message = String(args.message === true ? '' : args.message || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'update';
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const owner = p.owner || 'noob';
const workdir = cfg.workdir || '/var/lib/studio-publish';
const branch = p.branch || 'main';
const mode = p.mode === 'branch' ? 'branch' : 'pages';
const author = cfg.author || { name: 'noob_dev Studio', email: 'noreply@users.noreply.github.com' };
const repoWeb = (p.repo.match(/github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?$/) || [])[1];

fs.mkdirSync(path.join(workdir, 'state'), { recursive: true });
const repoDir = path.join(workdir, name, 'repo'); const stateFile = path.join(workdir, 'state', name + '.json');
const lock = path.join(workdir, 'state', name + '.lock');
try { const age = Date.now() - fs.statSync(lock).mtimeMs; if (age < 10 * 60 * 1000) fail('busy', 'another publish is running for this project'); } catch {}
fs.writeFileSync(lock, String(process.pid)); process.on('exit', () => { try { fs.unlinkSync(lock); } catch {} });

const keyOk = p.key && fs.existsSync(p.key);
const env = {
  ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email,
  ...(keyOk ? { GIT_SSH_COMMAND: `ssh -i ${p.key} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${path.join(workdir, 'known_hosts')}` } : {}),
};
const git = (a, cwd) => cp.spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'safe.directory=*', ...a], { cwd: cwd || repoDir, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const must = (r, stage) => { if (r.status !== 0) fail(stage, ((r.stderr || r.stdout || '') + '').trim().split('\n').slice(-3).join(' | ').slice(0, 400)); return (r.stdout || '').trim(); };
const readState = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return null; } };

function ensureClone() {
  if (!fs.existsSync(path.join(repoDir, '.git'))) { fs.mkdirSync(path.dirname(repoDir), { recursive: true }); must(git(['clone', '--branch', branch, '--single-branch', p.repo, repoDir], workdir), 'clone'); }
  else must(git(['fetch', '--prune', 'origin', branch]), 'fetch');
  must(git(['checkout', '-f', '-B', branch, 'origin/' + branch]), 'checkout'); must(git(['reset', '--hard', 'origin/' + branch]), 'reset'); must(git(['clean', '-fdx']), 'clean');
  return must(git(['rev-parse', 'HEAD']), 'rev-parse');
}
const stage = () => { must(git(['read-tree', 'HEAD']), 'read-tree'); must(git(['add', '-A']), 'add'); };
const clearTree = (dir, keep) => { for (const e of fs.readdirSync(dir)) if (!keep.includes(e)) fs.rmSync(path.join(dir, e), { recursive: true, force: true }); };
const copyFiles = (srcRoot, dstRoot, files) => {
  for (const rel of files) {
    const s = path.join(srcRoot, rel), d = path.join(dstRoot, rel); const st = fs.lstatSync(s);
    if (!st.isFile() || st.size > 20 * 1024 * 1024) continue;
    fs.mkdirSync(path.dirname(d), { recursive: true }); fs.copyFileSync(s, d);
  }
};
const counts = (porcelain) => { const c = { added: 0, modified: 0, deleted: 0 }; const files = []; for (const l of porcelain.split('\n').filter(Boolean)) { const k = l.slice(0, 2).trim()[0]; if (k === 'D') c.deleted++; else if (k === 'M') c.modified++; else c.added++; files.push(l.trim()); } return { ...c, files }; };
const checkOpts = { dir: p.dir, mode, allowedEmails: [...((cfg.checks || {}).allowedEmails || []), ...(p.allowedEmails || [])], allowedDomains: [...((cfg.checks || {}).allowedDomains || []), ...(p.allowedDomains || [])], forbidden: [...((cfg.checks || {}).forbidden || []), ...(p.forbidden || [])] };

(async () => {
  if (args.pull) {                                          // GitHub -> project folder
    const sha = ensureClone();
    clearTree(p.dir, ['.noob-studio']);
    copyFiles(repoDir, p.dir, must(git(['ls-files', '-z']), 'ls-files').split('\0').filter(Boolean));
    if (isRoot) { const uid = Number(cp.execSync(`id -u ${owner}`)), gid = Number(cp.execSync(`id -g ${owner}`)); (function chown(d) { fs.chownSync(d, uid, gid); for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isSymbolicLink()) continue; if (e.isDirectory()) chown(f); else fs.chownSync(f, uid, gid); } })(p.dir); }
    fs.writeFileSync(stateFile, JSON.stringify({ lastSha: sha, at: new Date().toISOString() }));
    return out({ ok: true, pulled: true, commit: sha.slice(0, 7), files: listFiles(p.dir).length });
  }

  if (mode === 'pages') {
    const files = listFiles(p.dir);
    const chk = await runChecks({ ...checkOpts, files });
    if (!chk.ok) return fail('checks', `${chk.blocking.length} blocking problem(s)`, { blocking: chk.blocking.slice(0, 20), warnings: chk.warnings.length });
    const base = ensureClone(); const st = readState();
    if (st && st.lastSha !== base) return fail('drift', 'GitHub has commits that were not published from the studio. Pull first (studio-publish --pull) so nothing is overwritten.', { remote: base.slice(0, 7), lastPublished: String(st.lastSha).slice(0, 7) });
    clearTree(repoDir, ['.git']); copyFiles(p.dir, repoDir, files);
    stage(); const status = must(git(['status', '--porcelain']), 'status'); const ch = counts(status);
    if (!status) { fs.writeFileSync(stateFile, JSON.stringify({ lastSha: base, at: new Date().toISOString() })); return out({ ok: true, changed: false, url: p.url, commit: base.slice(0, 7), warnings: chk.warnings.length, message: 'nothing to publish: GitHub already matches' }); }
    if (!st && !args.first) { must(git(['reset', '--hard']), 'reset'); return fail('baseline', 'first publish: the project differs from what is on GitHub. Review with --dry-run, then publish with --first.', { changes: { added: ch.added, modified: ch.modified, deleted: ch.deleted }, sample: ch.files.slice(0, 15) }); }
    if (args['dry-run']) { must(git(['reset', '--hard']), 'reset'); must(git(['clean', '-fd']), 'clean'); return out({ ok: true, dryRun: true, changes: { added: ch.added, modified: ch.modified, deleted: ch.deleted }, sample: ch.files.slice(0, 15), warnings: chk.warnings.length }); }
    must(git(['commit', '-q', '-m', `Publish from noob_dev Studio: ${message}`, '-m', `Studio job: ${job}`]), 'commit');
    must(git(['push', 'origin', 'HEAD:' + branch]), 'push'); const sha = must(git(['rev-parse', 'HEAD']), 'rev-parse');
    fs.writeFileSync(stateFile, JSON.stringify({ lastSha: sha, at: new Date().toISOString() }));
    return out({ ok: true, changed: true, url: p.url, commit: sha.slice(0, 7), commitUrl: repoWeb && `https://github.com/${repoWeb}/commit/${sha}`, changes: { added: ch.added, modified: ch.modified, deleted: ch.deleted }, warnings: chk.warnings.length });
  }

  // mode "branch": push the project's changed files to studio/<job> for review (never touches main)
  const lsArgs = (extra) => ['-C', p.dir, '-c', 'safe.directory=*', 'ls-files', ...extra, '-z'];
  const lsRun = (extra) => { const r = isRoot ? cp.spawnSync('runuser', ['-u', owner, '--', 'git', ...lsArgs(extra)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }) : cp.spawnSync('git', lsArgs(extra), { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); if (r.status !== 0) fail('ls-files', (r.stderr || 'git failed').slice(0, 300)); return r.stdout.split('\0').filter(Boolean); };
  const deleted = new Set(lsRun(['-d'])); const changed = [...new Set(lsRun(['-m', '-o', '--exclude-standard']))].filter((f) => !deleted.has(f) && !/^(\.noob-studio|data|logs)\//.test(f));
  if (!changed.length && !deleted.size) return out({ ok: true, changed: false, message: 'no changes in the project folder' });
  const chk = await runChecks({ ...checkOpts, files: changed.filter((f) => fs.existsSync(path.join(p.dir, f))), runTests: true, asUser: isRoot ? owner : null });
  if (!chk.ok) return fail('checks', `${chk.blocking.length} blocking problem(s)`, { blocking: chk.blocking.slice(0, 20), warnings: chk.warnings.length });
  ensureClone(); const br = 'studio/' + job;
  must(git(['checkout', '-f', '-B', br, 'origin/' + branch]), 'checkout');
  copyFiles(p.dir, repoDir, changed); for (const f of deleted) fs.rmSync(path.join(repoDir, f), { force: true });
  stage(); const status = must(git(['status', '--porcelain']), 'status'); const ch = counts(status);
  if (!status) return out({ ok: true, changed: false, message: 'GitHub already has these changes' });
  if (args['dry-run']) return out({ ok: true, dryRun: true, changes: { added: ch.added, modified: ch.modified, deleted: ch.deleted }, sample: ch.files.slice(0, 15), tests: chk.stats.tests, warnings: chk.warnings.length });
  must(git(['commit', '-q', '-m', `${message}`, '-m', `Proposed by the noob_dev Studio team (job ${job}). Review before merging.`]), 'commit');
  must(git(['push', '--force', 'origin', br]), 'push'); const sha = must(git(['rev-parse', 'HEAD']), 'rev-parse');
  out({ ok: true, changed: true, branch: br, commit: sha.slice(0, 7), url: repoWeb && `https://github.com/${repoWeb}/compare/${branch}...${br}?expand=1`, changes: { added: ch.added, modified: ch.modified, deleted: ch.deleted }, tests: chk.stats.tests, warnings: chk.warnings.length });
})().catch((e) => fail('crash', String(e && e.message || e).slice(0, 300)));
