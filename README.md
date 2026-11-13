# noob_dev Design — ทีม AI สำหรับ Claude Code

ทีม AI 4 ตำแหน่งที่ช่วยให้งานของ **noob_dev** ดูโปร และใช้แบรนด์เดียวกันทุกโปรเจกต์ ทั้งเว็บ บอท Discord และกราฟิกโปรโมต

## ทีม

| Agent | หน้าที่ |
|---|---|
| `noob-ui-designer` | ออกแบบหน้าเว็บและ Discord embed ทำแบบร่าง 2–3 แบบให้เลือก |
| `noob-frontend-dev` | นำแบบที่เลือกไปเขียนเป็นโค้ด HTML/CSS/JS จริง |
| `noob-graphic-designer` | ทำกราฟิกสำหรับ Discord และ GitHub/พอร์ตโฟลิโอ |
| `noob-brand-reviewer` | ดูแลคู่มือแบรนด์และตรวจงานทุกชิ้นก่อนส่งถึงเจ้าของ |

## ขั้นตอนการทำงาน

```
สั่งงาน → นักออกแบบ UI / นักออกแบบกราฟิก ทำแบบร่าง
       → ✋ เจ้าของเลือกแบบ
       → นักพัฒนา Frontend เขียนโค้ด
       → ผู้ตรวจคุณภาพตรวจ (ไม่ผ่าน = ตีกลับไปแก้)
       → ✋ เจ้าของดูผลลัพธ์สุดท้าย
```

## ติดตั้ง

ทีมนี้อ่านคู่มือแบรนด์จาก `~/.claude/noob_dev/brand-guide.md` ให้คัดลอกไฟล์ไปไว้ในโฟลเดอร์ `~/.claude` ของเครื่อง

**macOS / Linux / Git Bash**
```bash
git clone https://github.com/coolboy450/claude-agent.git
mkdir -p ~/.claude/agents ~/.claude/noob_dev
cp claude-agent/agents/*.md ~/.claude/agents/
cp claude-agent/noob_dev/brand-guide.md ~/.claude/noob_dev/
```

**Windows PowerShell**
```powershell
git clone https://github.com/coolboy450/claude-agent.git
New-Item -ItemType Directory -Force "$HOME\.claude\agents","$HOME\.claude\noob_dev" | Out-Null
Copy-Item claude-agent\agents\*.md "$HOME\.claude\agents\"
Copy-Item claude-agent\noob_dev\brand-guide.md "$HOME\.claude\noob_dev\"
```

ติดตั้งเสร็จแล้ว ให้เปิดเซสชันใหม่ของ Claude Code จากนั้นสั่งงานได้เลย เช่น "ให้ noob-ui-designer ออกแบบหน้า about"

## noob_dev Studio (ออฟฟิศพิกเซลบนเครื่อง)

`studio/` คือหน้าเว็บออฟฟิศพิกเซลที่ใช้สั่งงานทีมได้ จะเห็นตัวละครทั้ง 4 ตัวทำงานแบบสด เบื้องหลังสตูดิโอเรียก **Claude Code CLI** บนเครื่องคุณ (`claude -p --agent ...`) จึงใช้บัญชี Claude ที่ล็อกอินไว้ ไม่ต้องมี API key

**ต้องมีก่อน:** Node.js 18 ขึ้นไป และติดตั้ง/ล็อกอิน Claude Code CLI แล้ว

```bash
npm install -g @anthropic-ai/claude-code
claude auth login
```

**เปิดสตูดิโอ**

```bash
node studio/server.js
```

จากนั้นเปิด http://localhost:4321 (เปิดได้จากเครื่องนี้เท่านั้น)

**การทำงาน:** สั่งงาน → นักออกแบบทำแบบร่าง → ✋ คุณกดเลือกแบบ → Frontend หรือนักออกแบบกราฟิกลงมือ → ผู้ตรวจตรวจ (ตีกลับได้ 2 รอบ) → ✋ คุณกดอนุมัติหรือขอแก้

- **โปรเจกต์:** เลือกจากโฟลเดอร์ใน `E:\` (เปลี่ยนได้ด้วย env `STUDIO_PROJECTS_ROOT`) ไฟล์แบบร่างจะอยู่ที่ `<โปรเจกต์>\.noob-studio\<รหัสงาน>\`
- **โมเดล:** นักออกแบบใช้ Opus ส่วน Frontend กับผู้ตรวจใช้ Sonnet ถ้างบเหลือต่ำกว่า 200,000 โทเค็น ทุกตำแหน่งจะเปลี่ยนเป็น Sonnet
- **โควตา:** สตูดิโอนับโทเค็นที่ใช้ในแต่ละรอบ 5 ชั่วโมง เมื่อชนลิมิตครั้งแรกจะจำตัวเลขนั้นไว้เป็นงบ คุณแก้ตัวเลขเองได้ที่ "ตั้งค่า"
- **ความปลอดภัย:** ทีมแก้ไฟล์ได้เฉพาะในโปรเจกต์ที่เลือก ไม่ commit หรือ push เอง และเซิร์ฟเวอร์รับคำสั่งจาก localhost เท่านั้น

**ห้องแชททีม**
- ทีมมีชื่อและนิสัยของตัวเอง: **มินท์** 🎨 (UI) · **บิต** 🎧 (Frontend) · **ป๊อป** 🖍️ (กราฟิก) · **ครูแว่น** 👓 (ผู้ตรวจ) แก้ได้ที่ `studio/personas.js` แล้วรัน `node studio/apply-personas.js` เพื่อเขียนนิสัยลงไฟล์ agent
- พิมพ์ถึงทุกคน หรือคลิกตัวละครเพื่อคุยเฉพาะคน แชทใช้ Haiku แบบ lean (ประมาณ 1k โทเค็นต่อข้อความ)
- ข้อความในแชทจะส่งต่อให้ทีมใช้ในขั้นถัดไปของงาน และทุกตำแหน่งจะพูดถึงกันตอนส่งต่องาน
- เปิด "คุยเล่นตอนว่าง" ได้ ทีมจะคุยกันเองทุก 10 นาที เฉพาะตอนที่เปิดหน้าเว็บไว้และไม่มีงานค้าง

## ไฟล์ในนี้

- `agents/` มีไฟล์บทบาทของ agent ทั้ง 4 ตัว
- `noob_dev/brand-guide.md` คือคู่มือแบรนด์ (สี ฟอนต์ ระยะห่าง ขนาดกราฟิก และรายการตรวจคุณภาพ)
- `studio/` คือเว็บออฟฟิศพิกเซล (`server.js` + `public/`)
