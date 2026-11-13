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

## ไฟล์ในนี้

- `agents/` มีไฟล์บทบาทของ agent ทั้ง 4 ตัว
- `noob_dev/brand-guide.md` คือคู่มือแบรนด์ (สี ฟอนต์ ระยะห่าง ขนาดกราฟิก และรายการตรวจคุณภาพ)
