import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { AUTH_REQUIRED_EVENT, setAuthEnabled } from './authClient'

type AuthMode = 'checking' | 'demo' | 'login' | 'authenticated' | 'error' | 'recovery'
type AuthReply = {
  auth_enabled?: boolean; synthetic_only?: boolean; clinical_use?: boolean;
  authenticated?: boolean; csrf_token?: string; login_ticket?: string;
}

async function readJson(response: Response): Promise<AuthReply> {
  try {
    return await response.json() as AuthReply
  } catch {
    return {}
  }
}

async function checkSession(): Promise<'demo' | 'login' | 'authenticated' | 'error'> {
  try {
    const statusResponse = await fetch('/auth/status', {
      credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' },
    })
    if (!statusResponse.ok) return 'error'
    const status = await readJson(statusResponse)
    if (typeof status.auth_enabled !== 'boolean'
        || status.synthetic_only !== true || status.clinical_use !== false) return 'error'
    if (status.auth_enabled === false) return 'demo'

    const response = await fetch('/auth/me', {
      credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' },
    })
    if (response.status === 401) return 'login'
    if (!response.ok) return 'error'
    const payload = await readJson(response)
    return payload.authenticated === true ? 'authenticated' : 'error'
  } catch {
    return 'error'
  }
}

function csrfFailure(status: number, purpose: 'login' | 'write' | 'logout'): string {
  if (status === 429) {
    return purpose === 'login'
      ? 'ระบบจำกัดการเริ่มเข้าสู่ระบบชั่วคราว · รอสักครู่แล้วลองใหม่ หากเพิ่งยืนยันแล้วหน้าเว็บขาดการตอบรับ ให้รีสตาร์ต backend ก่อนลองอีกครั้ง'
      : 'ขอรหัสยืนยันไม่ได้ · โหลดหน้าใหม่แล้วลองอีกครั้ง'
  }
  return 'ตรวจสอบต้นทางของคำขอไม่ได้ · เปิดเว็บจากเครื่องและที่อยู่เดิม แล้วลองอีกครั้ง'
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<AuthMode>('checking')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    setAuthEnabled(false)
    let active = true
    void checkSession().then(result => {
      if (active) {
        setAuthEnabled(result === 'authenticated')
        setMode(result)
      }
    })
    const sessionExpired = () => {
      setAuthEnabled(false)
      setError('เซสชันหมดอายุหรือถูกยกเลิก · เข้าสู่ระบบใหม่เพื่อทำงานต่อ')
      setMode('login')
    }
    window.addEventListener(AUTH_REQUIRED_EVENT, sessionExpired)
    return () => {
      active = false
      setAuthEnabled(false)
      window.removeEventListener(AUTH_REQUIRED_EVENT, sessionExpired)
    }
  }, [])

  async function retryStatus() {
    setMode('checking')
    setError('')
    const result = await checkSession()
    setAuthEnabled(result === 'authenticated')
    setMode(result)
  }

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const form = event.currentTarget
    const formData = new FormData(form)
    const username = String(formData.get('username') ?? '')
    const password = String(formData.get('password') ?? '')
    form.reset()
    setBusy(true)
    setError('')

    try {
      const csrfResponse = await fetch('/auth/csrf?purpose=login', {
        credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' },
      })
      if (!csrfResponse.ok) {
        setError(csrfResponse.status === 429
          ? csrfFailure(429, 'login')
          : csrfFailure(csrfResponse.status, 'login'))
        return
      }
      const csrf = await readJson(csrfResponse)
      if (typeof csrf.csrf_token !== 'string') {
        setError('เซิร์ฟเวอร์ส่งรหัสยืนยันไม่ครบ · ลองใหม่')
        return
      }

      const loginResponse = await fetch('/auth/login', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf.csrf_token },
        body: JSON.stringify({ username, password }),
      })
      if (loginResponse.status === 401) {
        setError('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง')
        return
      }
      if (loginResponse.status === 429) {
        setError('ลองเข้าสู่ระบบผิดหลายครั้ง · รอ 15 นาทีแล้วลองใหม่')
        return
      }
      if (!loginResponse.ok) {
        setError('เริ่มเข้าสู่ระบบไม่ได้ · ตรวจการตั้งค่า backend แล้วลองใหม่')
        return
      }
      const login = await readJson(loginResponse)
      if (typeof login.login_ticket !== 'string') {
        setError('เซิร์ฟเวอร์ส่งข้อมูลเข้าสู่ระบบไม่ครบ · เริ่มใหม่')
        return
      }

      let confirmResponse: Response
      try {
        confirmResponse = await fetch('/auth/confirm', {
          method: 'POST', credentials: 'same-origin', cache: 'no-store',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf.csrf_token },
          body: JSON.stringify({ login_ticket: login.login_ticket }),
        })
      } catch {
        setMode('recovery')
        setError('การยืนยันอาจถึง backend แล้ว แต่เว็บไม่ได้รับคำตอบ · รีสตาร์ต backend แล้วเปิดเว็บใหม่ก่อนลองเข้าสู่ระบบอีกครั้ง')
        return
      }
      if (!confirmResponse.ok) {
        setMode('recovery')
        setError('ยืนยันเซสชันไม่สำเร็จ · เพื่อปลดสถานะค้าง ให้รีสตาร์ต backend แล้วเปิดเว็บใหม่')
        return
      }
      const confirmed = await readJson(confirmResponse)
      if (typeof confirmed.csrf_token !== 'string') {
        setMode('recovery')
        setError('เว็บได้รับ cookie แต่ไม่ได้รับรหัสตอบรับ · รีสตาร์ต backend แล้วเปิดเว็บใหม่')
        return
      }

      try {
        const ackResponse = await fetch('/auth/ack', {
          method: 'POST', credentials: 'same-origin', cache: 'no-store',
          headers: { 'X-CSRF-Token': confirmed.csrf_token },
        })
        if (ackResponse.ok) {
          setAuthEnabled(true)
          setMode('authenticated')
          return
        }
      } catch {
        // Verify below: the server may have accepted ack before the connection failed.
      }
      const session = await checkSession()
      if (session === 'authenticated') {
        setAuthEnabled(true)
        setMode('authenticated')
      } else {
        setAuthEnabled(false)
        setMode('recovery')
        setError('เซิร์ฟเวอร์ยังยืนยัน cookie ไม่สำเร็จ · รีสตาร์ต backend แล้วเปิดเว็บใหม่')
      }
    } catch {
      setError('เชื่อมต่อ backend ไม่ได้ · ตรวจว่า backend ทำงาน แล้วลองใหม่')
    } finally {
      setBusy(false)
    }
  }

  async function signOut() {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const csrfResponse = await fetch('/auth/csrf?purpose=logout', {
        credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' },
      })
      if (!csrfResponse.ok) {
        setError(csrfFailure(csrfResponse.status, 'logout'))
        return
      }
      const csrf = await readJson(csrfResponse)
      if (typeof csrf.csrf_token !== 'string') {
        setError('เซิร์ฟเวอร์ส่งรหัสออกจากระบบไม่ครบ · ลองใหม่')
        return
      }
      const response = await fetch('/auth/logout', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'X-CSRF-Token': csrf.csrf_token },
      })
      if (response.status === 204 || response.status === 401) {
        setAuthEnabled(false)
        setMode('login')
        return
      }
      setError('ออกจากระบบไม่ได้ · ตรวจการเชื่อมต่อแล้วลองใหม่')
    } catch {
      setError('เชื่อมต่อ backend ไม่ได้ · ตรวจการเชื่อมต่อแล้วลองใหม่')
    } finally {
      setBusy(false)
    }
  }

  if (mode === 'checking') {
    return <main className="auth-screen" aria-live="polite"><p>กำลังตรวจการเข้าสู่ระบบ…</p></main>
  }

  if (mode === 'error') {
    return <main className="auth-screen">
      <section className="auth-panel" aria-labelledby="auth-unavailable-title">
        <h1 id="auth-unavailable-title">เชื่อมต่อระบบไม่ได้</h1>
        <p role="alert">ตรวจว่า backend ทำงานอยู่บนเครื่อง แล้วลองตรวจอีกครั้ง</p>
        <button className="submit-button" type="button" onClick={() => void retryStatus()}>ลองตรวจอีกครั้ง</button>
      </section>
    </main>
  }

  if (mode === 'login' || mode === 'recovery') {
    return <main className="auth-screen">
      <section className="auth-panel" aria-labelledby="auth-login-title">
        <h1 id="auth-login-title">เข้าสู่ระบบ</h1>
        <p>ลงชื่อเข้าใช้บัญชีผู้ดูแลบนเครื่องที่ตั้งค่า backend ไว้</p>
        {error && <p className="error" role="alert">{error}</p>}
        {mode === 'recovery' && <p className="auth-recovery">เซสชันที่ยังยืนยันไม่ครบใช้ต่อไม่ได้ · รีสตาร์ต backend แล้วค่อยเริ่มใหม่</p>}
        {mode === 'login' && <form aria-label="เข้าสู่ระบบผู้ดูแล" onSubmit={event => void signIn(event)}>
          <label>ชื่อผู้ใช้<input name="username" required autoComplete="username" maxLength={128} /></label>
          <label>รหัสผ่าน<input name="password" type="password" required autoComplete="current-password" maxLength={1024} /></label>
          <button className="submit-button" type="submit" disabled={busy}>{busy ? 'กำลังตรวจสอบ…' : 'เข้าสู่ระบบ'}</button>
        </form>}
        <details className="auth-setup">
          <summary>ตั้งค่าครั้งแรกบนเครื่อง backend</summary>
          <p>เว็บนี้ไม่มีหน้าสร้างบัญชี · ผู้ดูแลเครื่องต้องตั้งค่า <code>ADMIN_AUTH_ENABLED</code>, ชื่อผู้ใช้, รหัสผ่านแบบ hash, session secret และ origin ใน environment ของ backend แล้วรีสตาร์ตบริการ</p>
          <p>อย่าวางรหัสผ่านหรือ secret ใน repo, แชต หรือแบบฟอร์มนี้ · หน้านี้ไม่เก็บรหัสผ่านใน browser storage</p>
          <p>ขั้นตอน PowerShell อยู่ใน <code>docs/ADMIN_AUTH.md</code></p>
        </details>
        {mode === 'recovery' && <button className="auth-retry-button" type="button" onClick={() => void retryStatus()}>ตรวจอีกครั้งหลังรีสตาร์ต backend</button>}
      </section>
    </main>
  }

  if (mode === 'demo') {
    return <>
      <p className="demo-mode-banner" role="note">โหมดทดลองไม่มีล็อกอิน · ใช้ข้อมูลสมมติเท่านั้น · ห้ามกรอกข้อมูลผู้ป่วยจริง</p>
      {children}
    </>
  }

  return <>
    <div className="auth-session-bar"><span>เข้าสู่ระบบแล้ว</span><button type="button" onClick={() => void signOut()} disabled={busy}>{busy ? 'กำลังออก…' : 'ออกจากระบบ'}</button></div>
    {error && <p className="auth-session-error" role="alert">{error}</p>}
    {children}
  </>
}
