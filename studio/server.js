// noob_dev Studio — local pixel-office for the noob_dev Design team.
// Runs on your machine only. Every agent turn is a headless Claude Code CLI run
// (`claude -p --agent ...`) using your own Claude login, so no API key is needed.
// No npm dependencies: Node 18+ built-ins only.

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');

// ---------- config ----------
const PORT = Number(process.env.STUDIO_PORT || 4321);
// 127.0.0.1 = this machine only. On a server set STUDIO_HOST=0.0.0.0 and firewall the port
// so only a private network (e.g. Tailscale) can reach it — see deploy/install.sh.
const HOST = process.env.STUDIO_HOST || '127.0.0.1';
const PROJECTS_ROOT = process.env.STUDIO_PROJECTS_ROOT || 'E:\\';
const HOME_CLAUDE = path.join(os.homedir(), '.claude');
const BRAND_DIR = path.join(HOME_CLAUDE, 'noob_dev');
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

const WINDOW_MS = 5 * 60 * 60 * 1000; // Pro usage window (~5h)
const LOW_TOKENS = 200000;            // below this, every agent drops to Sonnet
const MAX_REVIEW_FIXES = 2;           // reviewer bounce-backs before it goes to the owner anyway

const PERSONAS = require('./personas');
const CHAT_MODEL = process.env.STUDIO_CHAT_MODEL || 'haiku'; // chat is small talk: cheapest model
const BANTER_DEFAULT_MS = 3 * 60 * 1000; // team chats on its own every 3 min by default
const MOODS = ['ปกติ', 'ดีใจ', 'ตื่นเต้น', 'งอน', 'น้อยใจ', 'เหนื่อย', 'หิว', 'ง่วง'];

const AGENTS = {
  ui:       { name: 'noob-ui-designer',      label: 'นักออกแบบ UI',       model: 'opus' },
  graphic:  { name: 'noob-graphic-designer', label: 'นักออกแบบกราฟิก',   model: 'opus' },
  frontend: { name: 'noob-frontend-dev',     label: 'นักพัฒนา Frontend', model: 'sonnet' },
  reviewer: { name: 'noob-brand-reviewer',   label: 'ผู้ตรวจคุณภาพ',      model: 'sonnet' },
  quant:    { name: 'noob-quant-dev',        label: 'นักพัฒนาบอทเทรด',  model: 'sonnet' },
};
const PUBLIC_PERSONAS = Object.fromEntries(Object.entries(PERSONAS).map(([k, p]) => [k, { name: p.name, emoji: p.emoji, role: p.role, color: p.color, gender: p.gender }]));

// ---------- claude binary ----------
function findClaude() {
  if (process.env.CLAUDE_BIN) return { cmd: process.env.CLAUDE_BIN, shell: false };
  const appdata = process.env.APPDATA || '';
  const exe = path.join(appdata, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  if (appdata && fs.existsSync(exe)) return { cmd: exe, shell: false };
  const local = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
  if (fs.existsSync(local)) return { cmd: local, shell: false };
  return { cmd: 'claude', shell: process.platform === 'win32' };
}
const CLAUDE = findClaude();

// ---------- state ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
let state = {
  usage: { windowStart: null, used: 0 },
  budget: { value: null, source: null }, // source: 'learned' | 'manual'
  jobs: [],
  chat: [],      // { t, who, to, text }  who/to: 'owner' | agent key | 'all'
  banter: true,  // agents chat on their own (uses a little quota)
  banterEvery: BANTER_DEFAULT_MS,
  moods: {},     // key -> { mood, toward, reason, since }
};
try {
  const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  if (saved.banterEvery == null) { delete saved.banter; } // older state: switch auto-chat on once
  state = { ...state, ...saved };
} catch {}
for (const k of Object.keys(PERSONAS)) if (!state.moods[k]) state.moods[k] = { mood: 'ปกติ', toward: null, reason: '', since: Date.now() };
let lastBanterAt = 0;
for (const j of state.jobs) {
  if (j.status === 'running') { j.status = 'failed'; j.error = 'เซิร์ฟเวอร์ถูกปิดระหว่างทำงาน'; }
}
function save() { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }

const agentStatus = {};
for (const k of Object.keys(AGENTS)) agentStatus[k] = { state: 'idle', bubble: '' };

// ---------- SSE ----------
const clients = new Set();
function broadcast(evt) {
  const data = `data: ${JSON.stringify(evt)}\n\n`;
  for (const res of clients) res.write(data);
}
function setAgent(key, st, bubble) {
  agentStatus[key] = { state: st, bubble: bubble ?? agentStatus[key].bubble };
  broadcast({ type: 'agent', key, ...agentStatus[key] });
}
function publicJob(j) { return j && { ...j, history: j.history.slice(-40) }; }
function pushJob(j) { save(); broadcast({ type: 'job', job: publicJob(j) }); }
function log(j, who, text) {
  j.history.push({ t: Date.now(), who, text });
  broadcast({ type: 'log', jobId: j.id, who, text });
}

// ---------- team chat ----------
function postChat(who, to, text) {
  text = String(text || '').trim().slice(0, 600);
  if (!text) return;
  const msg = { t: Date.now(), who, to: to || 'all', text };
  state.chat.push(msg); state.chat = state.chat.slice(-200);
  save(); broadcast({ type: 'chat', msg });
}
function chatName(k) { return k === 'owner' ? 'เจ้าของ' : k === 'all' ? 'ทุกคน' : (PERSONAS[k] ? PERSONAS[k].name : k); }
function recentChat(n = 12) {
  return state.chat.slice(-n).map((m) => `[${chatName(m.who)} → ${chatName(m.to)}] ${m.text}`).join('\n') || '(ยังไม่มีข้อความ)';
}
function castSheet() {
  return Object.entries(PERSONAS).map(([k, p]) =>
    `- ${k}: ${p.name} ${p.emoji} ${p.role} · เพศ ${p.gender}\n  วิธีพูด: ${p.speech}\n  นิสัย: ${p.persona.join(' ')}`).join('\n');
}
function moodSheet() {
  return Object.entries(state.moods).map(([k, m]) => {
    const mins = Math.round((Date.now() - m.since) / 60000);
    return `- ${chatName(k)}: ${m.mood}${m.toward ? ' ใส่ ' + chatName(m.toward) : ''}${m.reason ? ' (เพราะ ' + m.reason + ')' : ''} — เป็นมา ${mins} นาที`;
  }).join('\n');
}
const SULK = ['งอน', 'น้อยใจ'];
const SULK_COOLDOWN_MS = 20 * 60 * 1000; // after making up, no new sulk for this person for 20 min
let plot = { sulker: null };             // who the server allowed to start sulking this round

function applyMoods(list) {
  if (!Array.isArray(list)) return;
  let changed = false;
  for (const u of list.slice(0, 4)) {
    if (!PERSONAS[u.who] || !MOODS.includes(u.mood)) continue;
    const cur = state.moods[u.who];
    const wasSulking = cur && SULK.includes(cur.mood);
    // Only the sulker the server picked may start sulking; the model can't add more on its own.
    if (SULK.includes(u.mood) && !wasSulking && u.who !== plot.sulker) continue;
    const toward = PERSONAS[u.toward] && u.toward !== u.who ? u.toward : null;
    if (cur && cur.mood === u.mood && cur.toward === toward) continue;
    state.moods[u.who] = {
      mood: u.mood, toward, reason: short(u.reason || '', 80), since: Date.now(),
      calmUntil: wasSulking && !SULK.includes(u.mood) ? Date.now() + SULK_COOLDOWN_MS : (cur && cur.calmUntil) || 0,
    };
    changed = true;
  }
  plot.sulker = null;
  if (changed) { save(); broadcast({ type: 'moods', moods: state.moods }); }
}

// ---------- usage / budget ----------
function rollWindow() {
  const now = Date.now();
  if (!state.usage.windowStart || now - state.usage.windowStart > WINDOW_MS) {
    state.usage = { windowStart: now, used: 0 };
  }
}
function quota() {
  rollWindow();
  const { value, source } = state.budget;
  const remaining = value == null ? null : Math.max(0, value - state.usage.used);
  return {
    used: state.usage.used,
    windowStart: state.usage.windowStart,
    windowEnds: state.usage.windowStart + WINDOW_MS,
    budget: value, source, remaining,
    low: remaining != null && remaining < LOW_TOKENS,
  };
}
function addUsage(u) {
  if (!u) return;
  rollWindow();
  // cache reads are far cheaper against limits, so they count at 10%
  const t = (u.input_tokens || 0) + (u.output_tokens || 0) +
    (u.cache_creation_input_tokens || 0) + Math.round((u.cache_read_input_tokens || 0) * 0.1);
  state.usage.used += t;
  save();
  broadcast({ type: 'quota', quota: quota() });
}
function modelFor(key) {
  if (key === 'chat') return CHAT_MODEL;
  return quota().low ? 'sonnet' : AGENTS[key].model;
}

// ---------- running an agent ----------
class LimitError extends Error {}
const LIMIT_RE = /usage limit|rate limit|limit reached|limit will reset|hit your limit|5-hour limit/i;

function short(s, n = 90) { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

function describeTool(c) {
  const i = c.input || {};
  const f = i.file_path || i.path || i.pattern || '';
  const base = f ? path.basename(String(f)) : '';
  const verb = { Read: 'อ่าน', Write: 'เขียน', Edit: 'แก้', Glob: 'ค้นไฟล์', Grep: 'ค้นข้อความ', Bash: 'รันคำสั่ง' }[c.name] || c.name;
  return `${verb} ${base || short(i.command, 40) || ''}`.trim();
}

function runAgent(job, key, prompt) {
  return new Promise((resolve, reject) => {
    const model = modelFor(key);
    const args = ['-p', '--agent', AGENTS[key].name, '--model', model,
      '--output-format', 'stream-json', '--verbose',
      '--permission-mode', 'acceptEdits',
      '--add-dir', BRAND_DIR, '--add-dir', job.workDir];
    // code jobs: allow running Python/tests and read-only git, nothing else from the shell
    if (key === 'quant') args.push('--allowedTools',
      'Bash(.venv/bin/python:*)', 'Bash(.venv\\Scripts\\python:*)', 'Bash(python3:*)', 'Bash(python:*)',
      'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(ls:*)');
    setAgent(key, 'working', `เริ่มงาน (${model})`);
    log(job, key, `เริ่มทำงานด้วยโมเดล ${model}`);

    const child = spawn(CLAUDE.cmd, args, { cwd: job.projectPath, shell: CLAUDE.shell, windowsHide: true, env: process.env });
    job.pid = child.pid;
    let buf = '', result = null, lastText = '', stderr = '';

    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
        if (!line) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
          for (const c of ev.message.content) {
            if (c.type === 'text' && c.text.trim()) { lastText = c.text; setAgent(key, 'working', short(c.text)); }
            if (c.type === 'tool_use') { const d2 = describeTool(c); setAgent(key, 'working', '🔧 ' + d2); log(job, key, d2); }
          }
        } else if (ev.type === 'result') {
          result = ev;
        }
      }
    });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    child.on('error', (e) => { setAgent(key, 'idle', ''); reject(new Error('เรียก Claude CLI ไม่ได้: ' + e.message)); });
    child.on('close', (code) => {
      job.pid = null;
      if (result) addUsage(result.usage);
      const text = (result && result.result) || lastText || '';
      const errText = `${result && result.is_error ? text : ''} ${stderr}`;
      if (LIMIT_RE.test(errText) || (result && result.is_error && LIMIT_RE.test(text))) {
        setAgent(key, 'idle', 'โควตาหมด 😴');
        return reject(new LimitError(short(text || stderr, 200)));
      }
      if (!result || result.is_error || code !== 0) {
        setAgent(key, 'idle', '');
        return reject(new Error(short(text || stderr || `CLI จบด้วยรหัส ${code}`, 300)));
      }
      setAgent(key, 'idle', 'เสร็จแล้ว ✓');
      log(job, key, short(text, 400));
      resolve(text);
    });
    child.stdin.write(prompt, 'utf8');
    child.stdin.end();
  });
}

function extractJson(text) {
  const blocks = [...String(text).matchAll(/```json\s*([\s\S]*?)```/g)].map((m) => m[1]);
  const s = String(text);
  const cands = [...blocks.reverse(), s.trim(), s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)];
  // also try every '{' from the end, so trailing prose or several objects still parse
  for (let i = s.lastIndexOf('{'); i >= 0; i = s.lastIndexOf('{', i - 1)) {
    if (cands.length > 40) break;
    cands.push(s.slice(i, s.lastIndexOf('}') + 1));
  }
  for (const c of cands) { if (!c) continue; try { const v = JSON.parse(c.trim()); if (v && typeof v === 'object') return v; } catch {} }
  return null;
}

// ---------- quick (chat) runs: cheap model, no tools ----------
function runQuick(prompt) {
  return new Promise((resolve, reject) => {
    // lean run: own short system prompt, no tools, no MCP servers, no skills (~1k tokens instead of ~28k)
    const args = ['-p', '--model', modelFor('chat'), '--output-format', 'json',
      '--system-prompt', 'You write short in-character team chat lines for a pixel-office app. Reply with JSON only.',
      '--tools', '', '--strict-mcp-config', '--disable-slash-commands'];
    const child = spawn(CLAUDE.cmd, args, { cwd: DATA_DIR, shell: CLAUDE.shell, windowsHide: true, env: process.env });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', (e) => reject(e));
    child.on('close', () => {
      let r = null; try { r = JSON.parse(out.trim().split('\n').pop()); } catch {}
      if (r) addUsage(r.usage);
      const text = (r && r.result) || '';
      if (LIMIT_RE.test(text + err)) return reject(new LimitError(short(text || err, 200)));
      if (!r || r.is_error) return reject(new Error(short(text || err || 'แชทไม่ตอบ', 200)));
      resolve(text);
    });
    child.stdin.write(prompt, 'utf8'); child.stdin.end();
  });
}

function jobLine() {
  const j = activeJob();
  if (!j) return 'ตอนนี้ทีมว่าง ไม่มีงาน';
  return `งานปัจจุบัน: "${j.brief}" (โปรเจกต์ ${path.basename(j.projectPath)}, ขั้น ${j.stage}, สถานะ ${j.status})`;
}

// The server steers the drama so it reliably happens: who starts sulking, and when they make up.
function plotHint() {
  plot.sulker = null;
  const keys = Object.keys(PERSONAS);
  const sulking = keys.filter((k) => SULK.includes(state.moods[k].mood));
  if (sulking.length) {
    const oldest = Math.min(...sulking.map((k) => state.moods[k].since));
    const mins = (Date.now() - oldest) / 60000;
    const list = sulking.map((k) => `${chatName(k)} (${state.moods[k].mood}${state.moods[k].toward ? 'ใส่' + chatName(state.moods[k].toward) : ''})`).join(', ');
    if (mins >= 6 && Math.random() < 0.5) {
      return `\nบทรอบนี้: คืนดีกันให้ครบทุกคนที่งอนอยู่: ${list} — มีคนง้อหรือขอโทษตามนิสัย แล้วอัปเดตอารมณ์ของ ${sulking.join(', ')} เป็น ดีใจ (toward null) ห้ามมีใครงอนเพิ่ม`;
    }
    return `\nบทรอบนี้: ${list} ยังงอนอยู่ คนอื่นสังเกตหรือแซว แต่ยังไม่หาย ห้ามมีใครงอนเพิ่ม (ไม่ต้องอัปเดตอารมณ์ของคนที่งอนอยู่)`;
  }
  // Start a new sulk? Pick by personality: higher sulkiness = more likely. Recently-made-up people are skipped.
  const now = Date.now();
  const cands = keys.filter((k) => !(state.moods[k].calmUntil > now));
  for (const k of cands.sort(() => Math.random() - 0.5)) {
    if (Math.random() >= PERSONAS[k].sulkiness * 0.5) continue; // ~40% chance per round that someone starts
    const others = keys.filter((x) => x !== k);
    const b = others[Math.floor(Math.random() * others.length)];
    const mood = PERSONAS[k].sulkMood || 'งอน';
    plot.sulker = k;
    return `\nบทรอบนี้: เกิดเรื่องเล็กๆ ที่ทำให้${chatName(k)}${mood}${chatName(b)} (คิดเหตุผลขำๆ ให้เข้ากับนิสัยทั้งสองคน) แล้วอัปเดตอารมณ์ ${k} เป็น ${mood} toward ${b} — คนอื่นห้ามงอน`;
  }
  return '\nบทรอบนี้: ไม่มีใครงอน ห้ามใครงอนหรือน้อยใจในรอบนี้';
}

function chatPrompt(kind, target) {
  if (kind !== 'banter') plot.sulker = null; // replies to the owner never start a new sulk
  const who = kind === 'banter'
    ? `ไม่มีใครทักมา ให้ทีมคุยกันเองต่อจากแชทล่าสุด 2–4 ข้อความ (2–3 คน) ${activeJob() ? 'เรื่องงานที่ทำอยู่ บ่น แซว ให้กำลังใจกัน' : 'เรื่องชีวิตในออฟฟิศ กาแฟ ชานม แมวนูบ มีม ดีไซน์ ฯลฯ'}
ดำเนินเรื่องต่อเนื่องเหมือนละครออฟฟิศสั้นๆ:
- ถ้ามีคนงอน/น้อยใจอยู่ คนอื่นควรสังเกต แซว หรือง้อ และคนที่งอนตอบตามนิสัย (งอนต่อ หรือใจอ่อน)
- งอนนานพอแล้ว (ประมาณ 6–15 นาที) ให้คืนดีกันอย่างน่ารัก แล้วเปลี่ยนอารมณ์เป็น ดีใจ หรือ ปกติ
- อย่าให้งอนพร้อมกันเกิน 1 คน${plotHint()}`
    : target === 'all'
      ? 'เจ้าของเพิ่งพิมพ์ถึงทุกคน ให้ 1–3 คนที่เกี่ยวข้องที่สุดตอบ'
      : `เจ้าของเพิ่งพิมพ์ถึง ${chatName(target)} ให้ ${chatName(target)} ตอบเป็นหลัก และอาจมีอีก 1 คนแซวหรือเสริมสั้นๆ ถ้าเข้ากับบทสนทนา`;
  return `คุณคือผู้เขียนบทสนทนาในห้องแชทของทีม noob_dev Design (ออฟฟิศพิกเซล)
ตัวละคร (key: ชื่อ — นิสัย):
${castSheet()}

${jobLine()}
อารมณ์ตอนนี้:
${moodSheet()}

แชทล่าสุด:
${recentChat(16)}

${who}
กติกา:
- ภาษาไทย แต่ละข้อความ 1–2 ประโยค พูดตามนิสัยและ "วิธีพูด" ของแต่ละคนให้ชัด (คำลงท้ายต้องตรงตัวละคร) และสะท้อนอารมณ์ปัจจุบัน
- ตัวละครคุยกันเองได้ (ตอบกัน แซวกัน งอน ง้อ) แต่ห้ามแต่งว่าทำงานเสร็จแล้วถ้ายังไม่ได้ทำจริง
- งอนแบบน่ารัก ขำๆ เท่านั้น ห้ามด่าหยาบ ห้ามดูถูกจริงจัง ห้ามเล่นมุกเรื่องเพศหรือรูปร่าง ห้ามพูดถึงเจ้าของในแง่ลบ
- ถ้าเจ้าของสั่งงานหรือขอแก้ ให้รับทราบว่าจะเอาไปใช้ในขั้นถัดไปของงาน หรือถ้ายังไม่มีงาน ให้แนะนำให้กด "สั่งงาน"
- อัปเดตอารมณ์เฉพาะคนที่อารมณ์เปลี่ยนจริงในรอบนี้ (mood ต้องเป็นหนึ่งใน: ${MOODS.join(', ')}; toward คือคนที่งอน/น้อยใจใส่ ไม่มีให้ใส่ null)
- ตอบเป็น JSON เท่านั้น ไม่มีข้อความอื่น:
{"replies":[{"who":"${Object.keys(PERSONAS).join('|')}","to":"owner|all|${Object.keys(PERSONAS).join('|')}","text":"..."}],"moods":[{"who":"...","mood":"...","toward":"... หรือ null","reason":"สั้นๆ"}]}`;
}

let chatBusy = false, chatAgain = null;
async function runChat(kind, target) {
  if (chatBusy) { chatAgain = chatAgain || { kind, target }; return; }
  chatBusy = true;
  const speakers = target && target !== 'all' ? [target] : Object.keys(PERSONAS);
  broadcast({ type: 'typing', who: kind === 'banter' ? [] : speakers });
  try {
    const text = await runQuick(chatPrompt(kind, target));
    const j = extractJson(text);
    const replies = (j && Array.isArray(j.replies)) ? j.replies.slice(0, 4) : [];
    if (kind === 'banter') lastBanterAt = Date.now();
    let moodsApplied = false;
    for (const r of replies) {
      // apply mood changes right after the first line, so faces change while they talk
      if (!moodsApplied && j) { applyMoods(j.moods); moodsApplied = true; }
      if (!PERSONAS[r.who]) continue;
      broadcast({ type: 'typing', who: [r.who] });
      await new Promise((ok) => setTimeout(ok, 700 + Math.min(2000, String(r.text).length * 25)));
      postChat(r.who, r.to || 'owner', r.text);
    }
    if (!replies.length && kind !== 'banter') postChat('reviewer', 'owner', 'ขอโทษนะ ครูแว่นหลุดไปแป๊บ ลองพิมพ์ใหม่อีกทีได้ไหม');
  } catch (e) {
    if (kind !== 'banter') postChat('reviewer', 'owner', e instanceof LimitError ? 'โควตารอบนี้หมดแล้ว ทุกคนขอพักแป๊บนะ 😴' : 'แชทขัดข้อง: ' + e.message);
  } finally {
    broadcast({ type: 'typing', who: [] });
    chatBusy = false;
    if (chatAgain) { const n = chatAgain; chatAgain = null; runChat(n.kind, n.target); }
  }
}

// Auto-chat: the team talks on its own while the studio page is open.
setInterval(() => {
  if (!state.banter || chatBusy || clients.size === 0 || quota().low) return;
  const lastOwner = [...state.chat].reverse().find((m) => m.who === 'owner');
  if (lastOwner && Date.now() - lastOwner.t < 60 * 1000) return; // owner is talking: let them lead
  if (Date.now() - lastBanterAt < state.banterEvery) return;
  lastBanterAt = Date.now();
  runChat('banter', 'all');
}, 15 * 1000);

// ---------- prompts ----------
const COMMON = (job) =>
  `งานจากเจ้าของ: ${job.brief}\nโปรเจกต์: ${job.projectPath}\nโฟลเดอร์งานนี้ของสตูดิโอ: ${job.workDir}\nคู่มือแบรนด์: ${path.join(BRAND_DIR, 'brand-guide.md')}\nตอบเป็นภาษาไทย สั้น กระชับ\n` +
  `\nแชทล่าสุดในห้องทีม (ถ้าเจ้าของสั่งหรือขอเพิ่มอะไรไว้ ให้ทำตามด้วย):\n${recentChat(12)}\n`;
const SAY = (to) => `"say":"ข้อความสั้น 1 ประโยคตามนิสัยของคุณ ถึง${to}"`;

const CODE_RULES = 'กฎ: Paper trading เท่านั้น ห้ามเปิดเงินจริง ห้ามแตะ .env/ความลับ ห้ามใช้บริการที่เสียเงิน ห้าม commit/push';

function draftPrompt(job) {
  if (job.kind === 'code') {
    return `${COMMON(job)}
อ่านโค้ดที่เกี่ยวข้องในโปรเจกต์ก่อน แล้วเสนอแผนทำงานนี้ 2 แนวทาง (เช่น แบบเร็ว/เล็ก กับ แบบครบ/ใหญ่) พร้อมข้อดีข้อเสีย ไฟล์ที่จะแตะ และความเสี่ยง
บันทึกเป็นหน้า HTML อ่านง่ายไฟล์เดียว: ${path.join(job.workDir, 'drafts.html')} (หัวข้อ "แบบ A", "แบบ B")
ยังห้ามแก้ไฟล์ในโปรเจกต์ ${CODE_RULES}
จบคำตอบด้วยบล็อกนี้ (ห้ามมีข้อความหลังบล็อก):
\`\`\`json
{"options":[{"id":"A","title":"ชื่อสั้น","summary":"1–2 บรรทัด"}],${SAY('เจ้าของ ชวนให้มาเลือกแผน')}}
\`\`\``;
  }
  const what = job.kind === 'graphic' ? 'กราฟิก (แสดงแต่ละแบบในขนาดจริงตามคู่มือหมวด 7)' : 'หน้าเว็บ/embed';
  return `${COMMON(job)}
ทำแบบร่าง${what} 2–3 ทิศทางตามบทบาทของคุณ
บันทึกทุกแบบไว้ในไฟล์เดียว: ${path.join(job.workDir, 'drafts.html')} (เปิดดูได้ทันที มีหัวข้อ "แบบ A", "แบบ B", ...)
ห้ามแก้ไฟล์อื่นในโปรเจกต์
จบคำตอบด้วยบล็อกนี้ (ห้ามมีข้อความหลังบล็อก):
\`\`\`json
{"options":[{"id":"A","title":"ชื่อสั้น","summary":"1–2 บรรทัด"}],${SAY('เจ้าของ ชวนให้มาเลือกแบบ')}}
\`\`\``;
}

function buildPrompt(job, fixNote) {
  const opt = (job.options || []).find((o) => o.id === job.chosen) || { id: job.chosen, title: '' };
  const fix = fixNote ? `\n\nรอบแก้ไข — แก้ตามนี้:\n${fixNote}` : '';
  if (job.kind === 'code') {
    return `${COMMON(job)}
เจ้าของเลือก "แบบ ${opt.id} ${opt.title}" จาก ${path.join(job.workDir, 'drafts.html')}
ลงมือทำตามแผนนี้ในโปรเจกต์ ${job.projectPath} แล้วรัน python -m pytest -q ด้วย Python ใน .venv ของโปรเจกต์ (ถ้ามี)
${CODE_RULES}
สรุปท้ายคำตอบ: ไฟล์ที่แก้ + ผลเทส (ผ่าน/ตกกี่ข้อ ตามจริง) + สิ่งที่ยังไม่ได้ทำ${fix}
แล้วปิดท้ายด้วยบล็อก \`\`\`json {${SAY('ทีม ตอนทำเสร็จ')}} \`\`\``;
  }
  if (job.kind === 'graphic') {
    return `${COMMON(job)}
เจ้าของเลือก "แบบ ${opt.id} ${opt.title}" จาก ${path.join(job.workDir, 'drafts.html')}
ทำไฟล์จริงทุกขนาดที่ต้องใช้ (SVG และ PNG ถ้าทำได้) ไว้ใน ${path.join(job.workDir, 'final')}
สรุปท้ายคำตอบ: รายการไฟล์ + ใช้ที่ไหน${fix}
แล้วปิดท้ายด้วยบล็อก \`\`\`json {${SAY('ครูแว่น (ผู้ตรวจ) ตอนส่งงานให้ตรวจ')}} \`\`\``;
  }
  return `${COMMON(job)}
เจ้าของเลือก "แบบ ${opt.id} ${opt.title}" จาก ${path.join(job.workDir, 'drafts.html')}
นำแบบนี้ไปเขียนเป็นโค้ดจริงในโปรเจกต์ ${job.projectPath} (ถ้าเป็นโปรเจกต์ใหม่หรือไม่มีหน้าที่เกี่ยวข้อง ให้สร้างไฟล์ใหม่ในโปรเจกต์)
ห้าม commit/push
สรุปท้ายคำตอบ: รายการไฟล์ที่สร้าง/แก้ + วิธีเปิดดู${fix}
แล้วปิดท้ายด้วยบล็อก \`\`\`json {${SAY('ครูแว่น (ผู้ตรวจ) ตอนส่งงานให้ตรวจ')}} \`\`\``;
}

function reviewPrompt(job, makerSummary) {
  if (job.kind === 'code') {
    return `${COMMON(job)}
ตรวจงานโค้ดชิ้นนี้อีกรอบแบบละเอียด:
1) รัน python -m pytest -q ใหม่ด้วย Python ใน .venv ของโปรเจกต์ แล้วรายงานผลตามจริง
2) ดู git diff ว่าเปลี่ยนตรงกับแผนที่เจ้าของเลือก ไม่มีของเกิน
3) เช็กกฎ: ไม่มีการเปิดเงินจริง ไม่มีความลับ/คีย์ในโค้ด ไม่มีบริการเสียเงิน
สรุปจากรอบที่แล้ว:
${makerSummary}
ห้ามแก้ไฟล์ในรอบนี้
จบคำตอบด้วยบล็อกนี้ (ห้ามมีข้อความหลังบล็อก):
\`\`\`json
{"verdict":"pass หรือ fail","issues":["ไฟล์:บรรทัด → ผิดอะไร → ควรเป็นอะไร"],${SAY('ทีม')}}
\`\`\``;
  }
  return `${COMMON(job)}
ตรวจงานชิ้นนี้ตาม Checklist หมวด 8 ทุกข้อ
สรุปจากผู้ทำงาน:
${makerSummary}
ไฟล์งานอยู่ใน ${job.kind === 'graphic' ? path.join(job.workDir, 'final') : job.projectPath + ' (ดูเฉพาะไฟล์ที่ระบุในสรุป)'}
ห้ามแก้ไฟล์
จบคำตอบด้วยบล็อกนี้ (ห้ามมีข้อความหลังบล็อก):
\`\`\`json
{"verdict":"pass หรือ fail","issues":["ไฟล์:บรรทัด → ผิดอะไร → ควรเป็นอะไร"],${SAY('คนทำงาน (ชม หรือบอกให้แก้แบบใจดี)')}}
\`\`\``;
}

// ---------- pipeline ----------
let busy = false;
function makerKey(job) { return job.kind === 'code' ? 'quant' : job.kind === 'graphic' ? 'graphic' : 'frontend'; }
function designerKey(job) { return job.kind === 'code' ? 'quant' : job.kind === 'graphic' ? 'graphic' : 'ui'; }
function reviewerKey(job) { return job.kind === 'code' ? 'quant' : 'reviewer'; } // code is re-checked by the quant dev with tests

async function stage(job, fn) {
  busy = true; job.status = 'running'; job.error = null; pushJob(job);
  try { await fn(); }
  catch (e) {
    if (e instanceof LimitError) {
      if (state.budget.source !== 'manual') {
        state.budget = { value: state.usage.used, source: 'learned' };
        broadcast({ type: 'quota', quota: quota() });
      }
      job.status = 'paused_limit';
      job.error = 'โควตา Pro รอบนี้หมดแล้ว สตูดิโอจำตัวเลขไว้เป็นงบรอบหน้า กด "ทำต่อ" หลังโควตารีเซ็ต';
    } else {
      job.status = 'failed'; job.error = e.message;
    }
    log(job, 'studio', job.error);
  } finally {
    busy = false; pushJob(job);
    for (const k of Object.keys(AGENTS)) if (agentStatus[k].state === 'working') setAgent(k, 'idle', '');
  }
}

function runDrafts(job) {
  return stage(job, async () => {
    job.stage = 'draft';
    const text = await runAgent(job, designerKey(job), draftPrompt(job));
    const j = extractJson(text);
    job.options = (j && Array.isArray(j.options) && j.options.length) ? j.options
      : [{ id: 'A', title: 'แบบ A', summary: '' }, { id: 'B', title: 'แบบ B', summary: '' }];
    if (j && j.say) postChat(designerKey(job), 'owner', j.say);
    job.stage = 'choose'; job.status = 'waiting_choice';
    setAgent(designerKey(job), 'waiting', 'รอเจ้าของเลือกแบบ ✋');
  });
}

function runBuildAndReview(job, fixNote) {
  return stage(job, async () => {
    let note = fixNote || null;
    for (let round = 0; ; round++) {
      job.stage = 'build';
      job.makerSummary = await runAgent(job, makerKey(job), buildPrompt(job, note));
      const ms = extractJson(job.makerSummary);
      if (ms && ms.say) postChat(makerKey(job), 'reviewer', ms.say);
      job.stage = 'review';
      const rtext = await runAgent(job, reviewerKey(job), reviewPrompt(job, job.makerSummary));
      const r = extractJson(rtext) || { verdict: 'fail', issues: ['ผู้ตรวจไม่ได้ส่งผลในรูปแบบที่อ่านได้'] };
      if (r.say) postChat(reviewerKey(job), reviewerKey(job) === makerKey(job) ? 'all' : makerKey(job), r.say);
      job.review = { verdict: String(r.verdict).includes('pass') ? 'pass' : 'fail', issues: r.issues || [], text: rtext };
      if (job.review.verdict === 'pass') { setAgent(reviewerKey(job), 'idle', 'ผ่าน ✅'); break; }
      setAgent(reviewerKey(job), 'idle', `ตีกลับ ❌ ${job.review.issues.length} ข้อ`);
      if (round >= MAX_REVIEW_FIXES) { log(job, 'studio', 'แก้ครบรอบแล้วยังไม่ผ่าน ส่งให้เจ้าของตัดสิน'); break; }
      note = job.review.issues.join('\n');
    }
    job.stage = 'approve'; job.status = 'waiting_approval';
    setAgent(reviewerKey(job), 'waiting', 'รอเจ้าของอนุมัติ ✋');
  });
}

// ---------- helpers ----------
function listProjects() {
  try {
    return fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !/^[$.]/.test(d.name) && !/^(System Volume Information|RECYCLER|Recovery)$/i.test(d.name))
      .map((d) => ({ name: d.name, path: path.join(PROJECTS_ROOT, d.name) }));
  } catch { return []; }
}
function finalFiles(job) {
  const dir = path.join(job.workDir, 'final');
  try { return fs.readdirSync(dir).filter((f) => !fs.statSync(path.join(dir, f)).isDirectory()).map((f) => 'final/' + f); } catch { return []; }
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = ''; req.on('data', (d) => { b += d; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); }
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.json': 'application/json', '.woff2': 'font/woff2' };
function sendFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}
function safeJoin(base, rel) {
  const p = path.resolve(base, '.' + path.sep + rel);
  return p === base || p.startsWith(base + path.sep) ? p : null;
}
function findJob(id) { return state.jobs.find((j) => j.id === id); }
function activeJob() { return [...state.jobs].reverse().find((j) => !['done', 'cancelled'].includes(j.status)) || null; }

// ---------- http ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  // Same-origin guard for state-changing requests (blocks other websites from driving the studio)
  if (req.method === 'POST') {
    const origin = req.headers.origin;
    if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) return json(res, 403, { error: 'forbidden' });
  }

  if (p === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ type: 'hello', agents: agentStatus, quota: quota(), job: publicJob(activeJob()), personas: PUBLIC_PERSONAS, chat: state.chat.slice(-80), banter: state.banter, banterEvery: state.banterEvery, moods: state.moods })}\n\n`);
    clients.add(res); req.on('close', () => clients.delete(res));
    return;
  }
  if (p === '/api/projects') return json(res, 200, { root: PROJECTS_ROOT, projects: listProjects() });
  if (p === '/api/state') return json(res, 200, { agents: agentStatus, quota: quota(), job: publicJob(activeJob()), busy });

  if (p === '/api/jobs' && req.method === 'POST') {
    if (busy) return json(res, 409, { error: 'ทีมกำลังทำงานอยู่' });
    const b = await readBody(req);
    const brief = String(b.brief || '').trim();
    const kind = ['graphic', 'code'].includes(b.kind) ? b.kind : 'web';
    let projectPath = String(b.project || '');
    if (b.newProject) {
      const name = String(b.newProject).trim().replace(/[^\w\-ก-๙ .]/g, '').slice(0, 60);
      if (!name) return json(res, 400, { error: 'ตั้งชื่อโปรเจกต์ใหม่ก่อน' });
      projectPath = path.join(PROJECTS_ROOT, name);
      fs.mkdirSync(projectPath, { recursive: true });
    }
    if (!brief) return json(res, 400, { error: 'พิมพ์งานที่ต้องการก่อน' });
    if (!listProjects().some((x) => x.path === projectPath)) return json(res, 400, { error: 'ไม่พบโปรเจกต์นี้' });
    const old = activeJob(); if (old) { old.status = 'cancelled'; }
    const id = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '-' + crypto.randomBytes(2).toString('hex');
    const workDir = path.join(projectPath, '.noob-studio', id);
    fs.mkdirSync(workDir, { recursive: true });
    const job = { id, kind, brief, projectPath, workDir, status: 'running', stage: 'draft', options: [], chosen: null, review: null, makerSummary: '', history: [], createdAt: Date.now() };
    state.jobs.push(job); state.jobs = state.jobs.slice(-30);
    log(job, 'studio', `รับงานใหม่: ${brief}`);
    runDrafts(job);
    return json(res, 200, { job: publicJob(job) });
  }

  const m = p.match(/^\/api\/jobs\/([\w-]+)\/(choose|approve|resume|cancel)$/);
  if (m && req.method === 'POST') {
    const job = findJob(m[1]); if (!job) return json(res, 404, { error: 'ไม่พบงาน' });
    if (busy && m[2] !== 'cancel') return json(res, 409, { error: 'ทีมกำลังทำงานอยู่' });
    const b = await readBody(req);
    if (m[2] === 'choose') {
      if (job.status !== 'waiting_choice') return json(res, 400, { error: 'ยังไม่ถึงขั้นเลือกแบบ' });
      job.chosen = String(b.option || '');
      if (!job.options.some((o) => o.id === job.chosen)) return json(res, 400, { error: 'ไม่มีแบบนี้' });
      log(job, 'owner', `เลือกแบบ ${job.chosen}${b.note ? ' — ' + b.note : ''}`);
      postChat('owner', 'all', `เลือกแบบ ${job.chosen} นะ${b.note ? ' — ' + b.note : ''}`);
      setAgent(designerKey(job), 'idle', '');
      runBuildAndReview(job, b.note ? `ความเห็นเพิ่มเติมจากเจ้าของ: ${b.note}` : null);
    } else if (m[2] === 'approve') {
      if (job.status !== 'waiting_approval') return json(res, 400, { error: 'ยังไม่ถึงขั้นอนุมัติ' });
      setAgent(reviewerKey(job), 'idle', '');
      if (b.approved) {
        job.status = 'done'; job.stage = 'done'; log(job, 'owner', 'อนุมัติแล้ว 🎉'); pushJob(job);
        postChat('owner', 'all', 'อนุมัติแล้ว เก่งมากทุกคน 🎉');
        for (const k of Object.keys(AGENTS)) setAgent(k, 'idle', '🎉');
      } else {
        const note = String(b.note || '').trim() || 'เจ้าของยังไม่พอใจ ลองปรับให้ดีขึ้น';
        log(job, 'owner', `ขอแก้: ${note}`);
        postChat('owner', makerKey(job), `ขอแก้: ${note}`);
        runBuildAndReview(job, `เจ้าของขอแก้: ${note}`);
      }
    } else if (m[2] === 'resume') {
      if (!['paused_limit', 'failed'].includes(job.status)) return json(res, 400, { error: 'งานนี้ไม่ได้หยุดค้าง' });
      if (!job.chosen) runDrafts(job); else runBuildAndReview(job, job.review && job.review.verdict === 'fail' ? job.review.issues.join('\n') : null);
    } else if (m[2] === 'cancel') {
      if (job.pid) { try { process.kill(job.pid); } catch {} }
      job.status = 'cancelled'; log(job, 'owner', 'ยกเลิกงาน'); pushJob(job);
      for (const k of Object.keys(AGENTS)) setAgent(k, 'idle', '');
    }
    return json(res, 200, { job: publicJob(job) });
  }

  const f = p.match(/^\/api\/jobs\/([\w-]+)\/files$/);
  if (f) { const job = findJob(f[1]); return json(res, job ? 200 : 404, { files: job ? finalFiles(job) : [] }); }

  if (p === '/api/chat' && req.method === 'POST') {
    const b = await readBody(req);
    const to = b.to === 'all' || PERSONAS[b.to] ? b.to : 'all';
    const text = String(b.text || '').trim();
    if (!text) return json(res, 400, { error: 'พิมพ์ข้อความก่อน' });
    postChat('owner', to, text);
    runChat('reply', to);
    return json(res, 200, { ok: true });
  }

  if (p === '/api/settings' && req.method === 'POST') {
    const b = await readBody(req);
    if (typeof b.banter === 'boolean') state.banter = b.banter;
    if (Number(b.banterEvery) >= 30000) state.banterEvery = Math.min(3600000, Math.round(Number(b.banterEvery)));
    if (typeof b.banter === 'boolean' || b.banterEvery) { lastBanterAt = Date.now() - state.banterEvery + 5000; broadcast({ type: 'banter', on: state.banter, every: state.banterEvery }); }
    if (b.budget === null || b.budget === '') state.budget = { value: null, source: null };
    else if (Number(b.budget) > 0) state.budget = { value: Math.round(Number(b.budget)), source: 'manual' };
    if (b.resetUsage) state.usage = { windowStart: Date.now(), used: 0 };
    save(); broadcast({ type: 'quota', quota: quota() });
    return json(res, 200, { quota: quota() });
  }

  const w = p.match(/^\/work\/([\w-]+)\/(.+)$/);
  if (w) {
    const job = findJob(w[1]); if (!job) { res.writeHead(404); return res.end(); }
    const file = safeJoin(job.workDir, decodeURIComponent(w[2]));
    if (!file) { res.writeHead(403); return res.end(); }
    return sendFile(res, file);
  }

  const file = safeJoin(PUBLIC_DIR, p === '/' ? 'index.html' : decodeURIComponent(p.slice(1)));
  if (!file) { res.writeHead(403); return res.end(); }
  return sendFile(res, file);
});

server.listen(PORT, HOST, () => {
  const v = spawnSync(CLAUDE.cmd, ['--version'], { shell: CLAUDE.shell, encoding: 'utf8' });
  console.log(`\n  noob_dev Studio → http://localhost:${PORT}`);
  console.log(`  Claude CLI: ${v.status === 0 ? v.stdout.trim() : 'ไม่พบ! ติดตั้ง: npm install -g @anthropic-ai/claude-code'}`);
  console.log(`  โปรเจกต์จาก: ${PROJECTS_ROOT}\n`);
});
