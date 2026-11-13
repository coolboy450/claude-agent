// Writes each persona into its agent file (repo agents/ and ~/.claude/agents/).
// Re-run after editing personas.js:  node studio/apply-personas.js
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const P = require('./personas');

const START = '<!-- persona:start -->', END = '<!-- persona:end -->';
const dirs = [path.join(__dirname, '..', 'agents'), path.join(os.homedir(), '.claude', 'agents')];

for (const p of Object.values(P)) {
  const block = [
    START,
    '## ตัวตนและนิสัย',
    `- ชื่อในทีม: **${p.name}** ${p.emoji} (${p.role})`,
    ...p.persona.map((l) => '- ' + l),
    '- เวลาคุยกับทีมหรือเจ้าของ พูดเป็นกันเองตามนิสัยนี้ แต่ตัวงานต้องเนี้ยบตามคู่มือแบรนด์เสมอ',
    END,
  ].join('\n');
  for (const d of dirs) {
    const f = path.join(d, p.agent + '.md');
    if (!fs.existsSync(f)) { console.log('ข้าม (ไม่พบ):', f); continue; }
    let s = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
    const re = new RegExp(`\\n*${START}[\\s\\S]*?${END}\\n*`);
    s = re.test(s) ? s.replace(re, '\n\n' + block + '\n') : s.trimEnd() + '\n\n' + block + '\n';
    fs.writeFileSync(f, s);
    console.log('อัปเดต:', f);
  }
}
