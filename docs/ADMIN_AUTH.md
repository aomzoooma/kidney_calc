# ตั้งค่าและใช้งานล็อกอินผู้ดูแล

คู่มือนี้ตั้งค่า backend สำหรับการทดลองบนเครื่องเดียวเท่านั้น · ยังไม่ผ่านการทดสอบ HTTPS, โทรศัพท์, เครือข่ายส่วนตัว หรือใช้งานกับข้อมูลผู้ป่วยจริง

## ขอบเขตข้อมูล

- `ADMIN_AUTH_ENABLED=false` เป็นโหมดไม่มีล็อกอิน · ทุกคนที่เปิดแอปบนเครื่องนั้นเข้าถึง API ทดลองได้
- ใช้ข้อมูลสมมติเท่านั้นทั้งโหมดล็อกอินและไม่ล็อกอิน · ห้ามใส่ชื่อจริง เลขประจำตัว รูปฉลากจริง หรือข้อมูลผู้ป่วย
- การเปิด auth ใน backend โดยไม่มี UI/build รุ่นนี้ทำให้ผู้ใช้เข้า API ไม่ได้ · ให้ใช้ backend และเว็บรุ่นเดียวกัน
- หน้าเว็บไม่สร้างบัญชีและไม่บันทึกรหัสผ่านลง `localStorage` หรือ `sessionStorage`

## ตั้งค่าครั้งแรก (PowerShell)

ทำใน PowerShell บนเครื่องที่รัน backend · คำสั่งเหล่านี้ใช้ได้กับ process ที่เริ่มจากหน้าต่างนี้เท่านั้น · หากรันเป็น Windows service ให้ตั้ง environment ในตัวจัดการ service ที่องค์กรอนุมัติ แล้ว restart service · อย่าใส่ค่าเหล่านี้ใน repo หรือ commit ไฟล์ `.env`

จาก root repo สร้าง environment และติดตั้ง backend dependency ก่อน หากยังไม่ได้ทำ:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

```powershell
$env:ADMIN_AUTH_ENABLED = "true"
$env:ADMIN_USERNAME = "admin"
$env:ADMIN_PASSWORD_HASH = python -c "from getpass import getpass; from pwdlib import PasswordHash; print(PasswordHash.recommended().hash(getpass()))"
$env:SESSION_SECRET = python -c "import secrets; print(secrets.token_urlsafe(48))"
$env:AUTH_ORIGIN = "http://127.0.0.1:8000"
$env:AUTH_COOKIE_SECURE = "false"
```

คำสั่ง hash ขอรหัสผ่านผ่าน prompt ที่ซ่อนตัวอักษร · ค่าที่บันทึกเป็น Argon2id hash ไม่ใช่รหัสผ่านต้นฉบับ · session secret สุ่มใหม่ทุกชุดการตั้งค่า · ห้ามส่ง hash หรือ secret ให้หน้าเว็บ

เริ่ม backend ใน PowerShell เดียวกัน:

```powershell
uvicorn api.main:app --host 127.0.0.1 --port 8000
```

สำหรับเว็บ dev ให้เปิดอีกหน้าต่างแล้วรัน:

```powershell
cd web
npm ci
npm run dev -- --host 127.0.0.1
```

เปิด URL ที่ Vite แสดง · proxy ส่ง `/auth/*` ไป `127.0.0.1:8000` พร้อม `Origin` ที่ตรงกับ `AUTH_ORIGIN` · อย่าเปลี่ยน origin, host หรือ port เองโดยไม่ตั้งทั้งสองส่วนให้ตรงกัน

## เข้าสู่ระบบและออกจากระบบ

1. เปิดเว็บจากเครื่อง backend · เมื่อ auth ทำงาน หน้าเว็บจะแสดงแบบฟอร์มชื่อผู้ใช้และรหัสผ่าน
2. กดเข้าสู่ระบบ · หน้าเว็บขอ one-time CSRF token, ส่ง credential ให้ backend, รับ session cookie แบบ `HttpOnly`, แล้วส่ง ack เพื่อยืนยันว่า browser รับ cookie แล้ว
3. เมื่อ ack ผ่านจึงแสดง planner · session ใช้งานได้ 8 ชั่วโมง และมีผู้ดูแลที่ active ได้ครั้งละหนึ่ง browser
4. กด “ออกจากระบบ” เพื่อลบสิทธิ์ session บน backend · หากย้ายเครื่อง ต้องออกจากระบบที่เครื่องเดิมก่อน

รหัสผ่านอยู่ใน input/request ระหว่างล็อกอินเท่านั้น · หน้าเว็บไม่เขียน credential, token หรือ cookie ลง Web Storage · cookie เป็น `SameSite=Strict` และ `HttpOnly` · การเขียนข้อมูลใช้ one-time CSRF token purpose `write`; logout ใช้ token แยก purpose `logout` เพื่อให้ยังออกจากระบบได้เมื่อ token สำหรับเขียนหมดโควตาหรือค้างอยู่ · การขอ logout token ใหม่จะแทนที่ token เก่าที่ยังไม่ใช้ใน session/client เดียวกัน · token เก่าใช้ซ้ำไม่ได้ · ทั้งคู่ตรวจ exact Origin/Host

## กู้คืนเมื่อยืนยันค้าง

Backend เก็บ session และ CSRF state ใน memory ของ process เดียว · ถ้าคำตอบ `/auth/confirm` หาย หรือ ack ไม่สำเร็จ หน้าเว็บจะไม่เปิด planner และแนะนำให้ restart backend · restart ทำให้ session ทุกตัวถูกยกเลิก จากนั้น reload เว็บและล็อกอินใหม่

อย่ากด login ซ้ำถ้าหน้าแจ้งว่า confirm อาจถึง backend แล้ว · รอ restart ก่อน · response เก่าที่ค้างข้าม restart อาจเขียน cookie เก่าทับ cookie ใหม่ใน browser แต่ cookie เก่าจะไม่ตรงกับ session ใน process ใหม่และใช้เข้าถึงไม่ได้

## ข้อจำกัด

- ใช้ process/worker เดียว · ห้ามเปิดหลาย worker หรือวางหลัง reverse proxy
- Throttle อยู่ใน memory และไม่แชร์ระหว่าง process
- HTTP cookie ใช้ `AUTH_COOKIE_SECURE=false` ได้เฉพาะ local loopback สำหรับ dev · ค่านี้ไม่ทำให้ข้อมูลปลอดภัยบน network
- UI และ backend นี้ยังไม่พร้อมใช้จากโทรศัพท์, remote access, HTTPS deployment, หรือข้อมูลผู้ป่วยจริง
