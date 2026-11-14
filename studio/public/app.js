(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const NAMES = { ui: 'นักออกแบบ UI', graphic: 'นักออกแบบกราฟิก', frontend: 'นักพัฒนา Frontend', reviewer: 'ผู้ตรวจคุณภาพ', owner: 'คุณ', studio: 'สตูดิโอ' };
  const STATUS = {
    running: 'ทีมกำลังทำงาน…', waiting_choice: 'รอคุณเลือกแบบร่าง', waiting_approval: 'รอคุณอนุมัติ',
    done: 'เสร็จแล้ว 🎉', failed: 'เกิดข้อผิดพลาด', paused_limit: 'หยุดชั่วคราว: โควตาหมด', cancelled: 'ยกเลิกแล้ว',
  };
  const STAGES = ['draft', 'choose', 'build', 'review', 'approve'];
  let job = null, picked = null;

  async function api(path, body) {
    const r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'เกิดข้อผิดพลาด');
    return data;
  }
  const fmt = (n) => n == null ? '—' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n);
  const time = (ms) => new Date(ms).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });

  // ---------- quota ----------
  function renderQuota(q) {
    if (!q) return;
    const pct = q.budget ? Math.min(100, Math.round(q.used / q.budget * 100)) : 0;
    $('q-fill').style.width = pct + '%';
    $('q-bar').setAttribute('aria-valuenow', pct);
    $('q-bar').classList.toggle('low', !!q.low);
    $('q-low').hidden = !q.low;
    const src = q.source === 'manual' ? 'ตั้งเอง' : q.source === 'learned' ? 'เรียนรู้จากรอบก่อน' : 'ยังไม่รู้ จะเรียนรู้เมื่อชนลิมิตครั้งแรก';
    $('q-text').textContent = `ใช้ไป ${fmt(q.used)} / งบ ${fmt(q.budget)} (${src}) · รอบนี้หมด ${time(q.windowEnds)}`;
    if (q.source === 'manual' && document.activeElement !== $('q-budget')) $('q-budget').value = q.budget;
  }
  $('q-settings-btn').onclick = () => {
    const open = $('q-settings').hidden;
    $('q-settings').hidden = !open; $('q-settings-btn').setAttribute('aria-expanded', open);
  };
  $('q-settings').onsubmit = async (e) => {
    e.preventDefault();
    const v = $('q-budget').value.trim();
    renderQuota((await api('/api/settings', { budget: v === '' ? null : Number(v) })).quota);
  };
  $('q-reset').onclick = async () => renderQuota((await api('/api/settings', { resetUsage: true })).quota);

  // ---------- projects ----------
  async function loadProjects() {
    const { projects } = await api('/api/projects');
    const sel = $('project');
    sel.innerHTML = '';
    projects.forEach((p) => sel.add(new Option(p.name, p.path)));
    sel.add(new Option('+ โปรเจกต์ใหม่…', '__new'));
  }
  $('project').onchange = () => { $('new-project').hidden = $('project').value !== '__new'; };

  $('new-job').onsubmit = async (e) => {
    e.preventDefault();
    $('new-error').textContent = '';
    const isNew = $('project').value === '__new';
    try {
      $('submit').disabled = true;
      const { job: j } = await api('/api/jobs', {
        project: isNew ? '' : $('project').value,
        newProject: isNew ? $('new-project').value : '',
        kind: document.querySelector('input[name=kind]:checked').value,
        brief: $('brief').value,
      });
      $('brief').value = ''; setJob(j);
      if (isNew) loadProjects();
    } catch (err) { $('new-error').textContent = err.message; }
    finally { $('submit').disabled = false; }
  };

  // ---------- job ----------
  function setJob(j) {
    job = j && !['done', 'cancelled'].includes(j.status) ? j : (j && j.status === 'done' ? j : null);
    const active = job && !['done', 'cancelled'].includes(job.status);
    $('job-card').hidden = !job;
    $('new-card').hidden = !!active;
    $('cancel').hidden = !active;
    renderStepper();
    if (!job) return;
    $('job-brief').textContent = job.brief;
    $('job-meta').textContent = `${{ graphic: 'กราฟิก', code: 'โค้ด / บอท', team: 'ทั้งทีม 👥' }[job.kind] || 'เว็บ / embed'} · ${job.projectPath}`;
    $('job-status').textContent = STATUS[job.status] || job.status;
    $('job-error-wrap').hidden = !job.error;
    $('job-error').textContent = job.error || '';
    $('resume').hidden = !['paused_limit', 'failed'].includes(job.status);

    // choose
    const choosing = job.status === 'waiting_choice';
    $('choose').hidden = !choosing;
    if (choosing) {
      const src = `/work/${job.id}/drafts.html`;
      if ($('draft-frame').dataset.src !== src) { $('draft-frame').src = src; $('draft-frame').dataset.src = src; }
      $('draft-open').href = src;
      const box = $('options'); box.innerHTML = ''; picked = null; $('choose-btn').disabled = true;
      job.options.forEach((o) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'opt'; b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', 'false');
        b.innerHTML = `<strong></strong><b></b><span></span>`;
        b.querySelector('strong').textContent = o.id; b.querySelector('b').textContent = o.title || ''; b.querySelector('span').textContent = o.summary || '';
        b.onclick = () => { picked = o.id; box.querySelectorAll('.opt').forEach((x) => x.setAttribute('aria-checked', x === b)); $('choose-btn').disabled = false; };
        box.append(b);
      });
    }
    // approve
    const approving = job.status === 'waiting_approval';
    $('approve').hidden = !approving;
    if (approving) {
      const rv = job.review || {};
      $('review-verdict').textContent = rv.verdict === 'pass' ? 'ผู้ตรวจ: ผ่าน ✅' : 'ผู้ตรวจ: ยังไม่ผ่าน ⚠️ (แก้ครบรอบแล้ว ให้คุณตัดสิน)';
      $('review-verdict').className = 'verdict ' + (rv.verdict === 'pass' ? 'pass' : 'fail');
      $('review-issues').innerHTML = '';
      (rv.issues || []).forEach((i) => { const li = document.createElement('li'); li.textContent = i; $('review-issues').append(li); });
      $('maker-summary').textContent = job.makerSummary || '';
      $('gallery').innerHTML = '';
      if (job.kind === 'graphic') api(`/api/jobs/${job.id}/files`).then(({ files }) => {
        files.filter((f) => /\.(png|svg|jpe?g|webp|gif)$/i.test(f)).forEach((f) => {
          const a = document.createElement('a'); a.href = `/work/${job.id}/${f}`; a.target = '_blank'; a.rel = 'noopener';
          const img = document.createElement('img'); img.src = a.href; img.alt = f.split('/').pop(); a.append(img); $('gallery').append(a);
        });
      });
    }
  }
  function renderStepper() {
    const cur = job ? job.stage : null;
    const idx = STAGES.indexOf(cur);
    document.querySelectorAll('#stepper li').forEach((li, i) => {
      li.classList.toggle('now', i === idx && job && job.status !== 'done');
      li.classList.toggle('done', job && (i < idx || job.status === 'done'));
    });
  }
  $('choose-btn').onclick = async () => {
    if (!picked) return;
    try { setJob((await api(`/api/jobs/${job.id}/choose`, { option: picked, note: $('choose-note').value })).job); $('choose-note').value = ''; }
    catch (e) { alert(e.message); }
  };
  $('approve-yes').onclick = async () => { try { setJob((await api(`/api/jobs/${job.id}/approve`, { approved: true })).job); } catch (e) { alert(e.message); } };
  $('approve-no').onclick = async () => {
    const note = $('approve-note').value.trim();
    if (!note) { $('approve-note').focus(); return; }
    try { setJob((await api(`/api/jobs/${job.id}/approve`, { approved: false, note })).job); $('approve-note').value = ''; } catch (e) { alert(e.message); }
  };
  $('resume').onclick = async () => { try { setJob((await api(`/api/jobs/${job.id}/resume`, {})).job); } catch (e) { alert(e.message); } };
  $('cancel').onclick = async () => {
    if (!confirm('ยกเลิกงานนี้? ไฟล์ที่ทีมทำไปแล้วจะยังอยู่')) return;
    try { await api(`/api/jobs/${job.id}/cancel`, {}); setJob(null); } catch (e) { alert(e.message); }
  };

  // ---------- log ----------
  function addLog(who, text) {
    const li = document.createElement('li'); li.className = who;
    const b = document.createElement('b'); b.textContent = (NAMES[who] || who) + ': ';
    li.append(b, document.createTextNode(text));
    $('log').prepend(li);
    while ($('log').children.length > 200) $('log').lastChild.remove();
  }

  // ---------- team chat ----------
  let personas = {};
  function setPersonas(p) {
    personas = p || {};
    const sel = $('chat-to'), cur = sel.value;
    sel.innerHTML = '<option value="all">ทุกคน</option>';
    for (const k in personas) {
      sel.add(new Option(`${personas[k].emoji} ${personas[k].name}`, k));
      NAMES[k] = `${personas[k].name}`;
    }
    sel.value = cur && sel.querySelector(`option[value="${cur}"]`) ? cur : 'all';
  }
  const pname = (k) => k === 'owner' ? 'คุณ' : k === 'all' ? 'ทุกคน' : (personas[k] ? personas[k].name : k);
  function addChat(m, animate) {
    const li = document.createElement('li');
    const p = personas[m.who];
    li.className = 'msg ' + (m.who === 'owner' ? 'owner' : '');
    if (p) li.style.setProperty('--c', p.color);
    const av = document.createElement('span'); av.className = 'av'; av.textContent = p ? p.emoji : '🙂'; av.setAttribute('aria-hidden', 'true');
    const body = document.createElement('div');
    const who = document.createElement('div'); who.className = 'who';
    const b = document.createElement('b'); b.textContent = pname(m.who);
    who.append(b, document.createTextNode(m.to && m.to !== 'all' && m.to !== 'owner' ? ` → ${pname(m.to)}` : m.who === 'owner' && m.to === 'all' ? ' → ทุกคน' : ''));
    const txt = document.createElement('div'); txt.className = 'txt'; txt.textContent = m.text;
    body.append(who, txt); li.append(av, body);
    const box = $('chat');
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    box.append(li);
    while (box.children.length > 150) box.firstChild.remove();
    if (atBottom || m.who === 'owner') box.scrollTop = box.scrollHeight;
    if (animate && personas[m.who]) Office.say(m.who, m.text);
  }
  $('chat-form').onsubmit = async (e) => {
    e.preventDefault();
    const text = $('chat-text').value.trim(); if (!text) return;
    $('chat-text').value = '';
    try { await api('/api/chat', { to: $('chat-to').value, text }); }
    catch (err) { $('chat-text').value = text; alert(err.message); }
  };
  Office.onPick((k) => { $('chat-to').value = k; $('chat-text').focus(); });
  let banterNow = { on: true, every: 180000 };
  const minsLabel = (ms) => { const m = ms / 60000; return `ทุก ${Number.isInteger(m) ? m : m.toFixed(1)} นาที`; };
  function setBanter(on, every) {
    banterNow = { on, every };
    const v = on ? String(every) : '0';
    const sel = $('banter-every');
    sel.querySelectorAll('option[data-custom]').forEach((o) => { if (o.value !== v) o.remove(); });
    if (![...sel.options].some((o) => o.value === v)) {
      const o = new Option(minsLabel(every), v); o.dataset.custom = '1';
      sel.insertBefore(o, sel.querySelector('option[value="custom"]'));
    }
    sel.value = v;
  }
  $('banter-every').onchange = () => {
    const raw = $('banter-every').value;
    if (raw === 'custom') {
      $('custom-every').hidden = false;
      $('custom-min').value = (banterNow.every / 60000) || 3;
      $('custom-min').focus();
      return;
    }
    $('custom-every').hidden = true;
    const v = Number(raw);
    api('/api/settings', v ? { banter: true, banterEvery: v } : { banter: false }).catch((e) => alert(e.message));
  };
  $('custom-every').onsubmit = (e) => {
    e.preventDefault();
    const m = Math.min(60, Math.max(0.5, Number($('custom-min').value) || 3));
    $('custom-every').hidden = true;
    api('/api/settings', { banter: true, banterEvery: Math.round(m * 60000) }).catch((err) => alert(err.message));
  };
  $('custom-cancel').onclick = () => { $('custom-every').hidden = true; setBanter(banterNow.on, banterNow.every); };

  // ---------- moods ----------
  const MOOD_EMOJI = { 'ปกติ': '', 'ดีใจ': '😊', 'ตื่นเต้น': '✨', 'งอน': '💢', 'น้อยใจ': '🥺', 'เหนื่อย': '😮‍💨', 'หิว': '🍜', 'ง่วง': '💤' };
  function renderMoods(moods) {
    const ul = $('moods'); ul.innerHTML = '';
    for (const k in moods) {
      const m = moods[k], p = personas[k]; if (!p) continue;
      const label = m.mood === 'ปกติ' ? 'ปกติ' : `${m.mood}${m.toward ? ' ' + pname(m.toward) : ''}${m.reason ? ' — ' + m.reason : ''}`;
      Office.mood(k, m.mood, MOOD_EMOJI[m.mood], `${p.name}: ${label}`);
      const li = document.createElement('li'); li.style.setProperty('--c', p.color);
      if (m.mood === 'งอน' || m.mood === 'น้อยใจ') li.className = 'hot';
      const b = document.createElement('b'); b.textContent = p.name;
      li.append(b, document.createTextNode(` ${MOOD_EMOJI[m.mood] || '🙂'} ${label}`));
      ul.append(li);
    }
  }

  // ---------- tabs: office / stock-bot monitor ----------
  // The studio server proxies the bot dashboard's /monitor, so it loads same-origin (unless the server overrides).
  let monitorUrl = '/monitor';
  function showTab(name) {
    const bot = name === 'bot';
    $('tab-office').setAttribute('aria-selected', !bot);
    $('tab-bot').setAttribute('aria-selected', bot);
    $('view-office').hidden = bot;
    $('view-bot').hidden = !bot;
    if (bot && $('bot-frame').dataset.src !== monitorUrl) {
      $('bot-frame').dataset.src = monitorUrl;
      $('bot-frame').src = monitorUrl;
      $('bot-fail').hidden = true;
      // frames give no error event; check the dashboard answers at all
      const sameOrigin = monitorUrl.startsWith('/');
      fetch(monitorUrl, sameOrigin ? {} : { mode: 'no-cors' })
        .then((r) => { if (sameOrigin && !r.ok) $('bot-fail').hidden = false; })
        .catch(() => { $('bot-fail').hidden = false; });
    }
    $('bot-open').href = $('bot-fail-open').href = monitorUrl;
    try { localStorage.setItem('studio-tab', name); } catch {}
  }
  $('tab-office').onclick = () => showTab('office');
  $('tab-bot').onclick = () => showTab('bot');
  document.querySelector('.tabs').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const next = $('tab-office').getAttribute('aria-selected') === 'true' ? 'bot' : 'office';
      showTab(next); $(next === 'bot' ? 'tab-bot' : 'tab-office').focus();
    }
  });
  let savedTab = 'office';
  try { savedTab = localStorage.getItem('studio-tab') || 'office'; } catch {}
  showTab(savedTab);

  // ---------- live events ----------
  function connect() {
    const es = new EventSource('/api/events');
    es.onopen = () => { $('conn').textContent = 'เชื่อมต่อแล้ว'; $('conn').className = 'conn ok'; };
    es.onerror = () => { $('conn').textContent = 'ขาดการเชื่อมต่อ — เซิร์ฟเวอร์ยังเปิดอยู่ไหม?'; $('conn').className = 'conn bad'; };
    es.onmessage = (m) => {
      const e = JSON.parse(m.data);
      if (e.type === 'hello') {
        if (e.monitorUrl && e.monitorUrl !== monitorUrl) {
          monitorUrl = e.monitorUrl;
          if (!$('view-bot').hidden) { $('bot-frame').dataset.src = ''; showTab('bot'); }
          $('bot-open').href = $('bot-fail-open').href = monitorUrl;
        }
        setPersonas(e.personas);
        setBanter(e.banter, e.banterEvery);
        renderMoods(e.moods || {});
        $('chat').innerHTML = ''; (e.chat || []).forEach((m) => addChat(m, false));
        $('chat').scrollTop = $('chat').scrollHeight;
        for (const k in e.agents) Office.set(k, e.agents[k].state, e.agents[k].bubble);
        renderQuota(e.quota);
        $('log').innerHTML = '';
        if (e.job) { e.job.history.forEach((h) => addLog(h.who, h.text)); setJob(e.job); } else setJob(null);
      }
      if (e.type === 'agent') Office.set(e.key, e.state, e.bubble);
      if (e.type === 'quota') renderQuota(e.quota);
      if (e.type === 'job') setJob(e.job);
      if (e.type === 'log' && (!job || e.jobId === job.id)) addLog(e.who, e.text);
      if (e.type === 'chat') addChat(e.msg, true);
      if (e.type === 'banter') setBanter(e.on, e.every);
      if (e.type === 'moods') renderMoods(e.moods);
      if (e.type === 'typing') $('typing').textContent = e.who.length ? e.who.map(pname).join(', ') + ' กำลังพิมพ์…' : '';
    };
  }

  loadProjects().catch((e) => { $('new-error').textContent = e.message; });
  connect();
})();
