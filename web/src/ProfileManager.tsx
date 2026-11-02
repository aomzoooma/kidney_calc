import { useEffect, useRef, useState, type FormEvent } from 'react'

type Profile = {
  id: number
  name: string
  dry_weights: Array<{ measured_on: string; kilograms: number }>
  goals: Array<{ nutrient: string; amount: number; unit: string; effective_on: string }>
}
type ProfileSummary = Pick<Profile, 'id' | 'name'>
const emptyGoal = () => ({ nutrient: '', amount: '', unit: '', effective_on: '' })
const emptyWeight = () => ({ measured_on: '', kilograms: '' })

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options)
  const payload = await response.json()
  if (!response.ok) throw new Error('บันทึกหรือโหลดข้อมูลไม่ได้ ตรวจว่า API ทำงานอยู่แล้วลองอีกครั้ง')
  return payload as T
}

const json = (body: object): RequestInit => ({
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})

export function ProfileManager() {
  const [profiles, setProfiles] = useState<ProfileSummary[]>([])
  const [profile, setProfile] = useState<Profile | null>(null)
  const [name, setName] = useState('')
  const [goal, setGoal] = useState(emptyGoal)
  const [weight, setWeight] = useState(emptyWeight)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const selectedProfileId = useRef<number | null>(null)
  const profileRequestRevision = useRef(0)

  async function loadProfiles(selectId?: number) {
    const revision = ++profileRequestRevision.current
    setLoading(true)
    try {
      const result = await request<{ items: ProfileSummary[] }>('/experimental/profiles')
      if (revision !== profileRequestRevision.current) return
      setProfiles(result.items)
      const nextId = selectId ?? selectedProfileId.current ?? profile?.id ?? result.items[0]?.id
      selectedProfileId.current = nextId ?? null
      if (nextId) {
        const next = await request<Profile>(`/experimental/profiles/${nextId}`)
        if (revision === profileRequestRevision.current && selectedProfileId.current === nextId) setProfile(next)
      } else setProfile(null)
    } finally { if (revision === profileRequestRevision.current) setLoading(false) }
  }

  async function loadProfile(id: number) {
    const revision = ++profileRequestRevision.current
    selectedProfileId.current = id
    setLoading(true)
    try {
      const next = await request<Profile>(`/experimental/profiles/${id}`)
      if (revision === profileRequestRevision.current && selectedProfileId.current === id) setProfile(next)
    } catch (cause) {
      if (revision === profileRequestRevision.current && selectedProfileId.current === id) throw cause
    } finally { if (revision === profileRequestRevision.current) setLoading(false) }
  }

  useEffect(() => {
    loadProfiles().catch(() => setError('โหลดโปรไฟล์ไม่ได้ ตรวจว่า API ทดลองทำงานอยู่บนเครื่องนี้'))
  }, [])

  async function submit(event: FormEvent<HTMLFormElement>, action: () => Promise<void>, success: string) {
    event.preventDefault(); setBusy(true); setError(''); setStatus('')
    try { await action(); setStatus(success) }
    catch { setError('บันทึกหรือโหลดข้อมูลไม่ได้ ตรวจว่า API ทำงานอยู่แล้วลองอีกครั้ง') }
    finally { setBusy(false) }
  }

  return <section className="profile-page" aria-labelledby="patients-title">
    <div className="page-intro"><h1 id="patients-title">โปรไฟล์ข้อมูลสมมติ</h1>
      <p>ใช้ข้อมูลสมมติเท่านั้น ห้ามกรอกชื่อจริง เลขประจำตัว หรือข้อมูลผู้ป่วยจริง · บันทึกในฐานข้อมูลทดลองบนเครื่องนี้</p></div>
    <aside className="notice" role="note"><span className="notice-mark" aria-hidden="true">!</span><div>
      <h2>เป้าหมายต้องมาจากผู้ดูแล</h2><p>กรอกเป้าหมายที่ได้รับจากบุคลากรทางการแพทย์ด้วยตนเอง ระบบไม่กำหนดหรือคำนวณเป้าหมาย และใช้ข้อมูลนี้ตัดสินใจรักษาไม่ได้</p>
    </div></aside>

    <section className="profile-section" aria-labelledby="profile-create-title">
      <h2 id="profile-create-title">สร้างโปรไฟล์สมมติ</h2>
      <form onSubmit={event => void submit(event, async () => {
        const created = await request<ProfileSummary>('/experimental/profiles', json({ synthetic_only: true, name }))
        profileRequestRevision.current++
        selectedProfileId.current = created.id
        setProfiles(current => [created, ...current.filter(item => item.id !== created.id)])
        setProfile({ ...created, dry_weights: [], goals: [] })
        setLoading(false); setName(''); setGoal(emptyGoal()); setWeight(emptyWeight())
      }, 'สร้างโปรไฟล์แล้ว')}>
        <label>ชื่อเรียกข้อมูลสมมติ <input required maxLength={80} value={name} onChange={event => setName(event.target.value)} autoComplete="off" /></label>
        <button className="submit-button" disabled={busy}>{busy ? 'กำลังบันทึก…' : 'สร้างโปรไฟล์สมมติ'}</button>
      </form>
    </section>

    <section className="profile-section" aria-labelledby="profile-list-title">
      <h2 id="profile-list-title">โปรไฟล์ที่บันทึกในเครื่องนี้</h2>
      {profiles.length === 0 ? loading
        ? <p className="profile-empty" role="status">กำลังโหลดโปรไฟล์…</p>
        : <p className="profile-empty">ยังไม่มีโปรไฟล์สมมติ · สร้างโปรไฟล์ด้านบนเพื่อเริ่มบันทึก</p> : <>
        <label>เลือกโปรไฟล์ <select disabled={busy || loading} value={profile?.id ?? selectedProfileId.current ?? ''} onChange={event => {
          const id = Number(event.target.value); setError(''); setStatus(''); setProfile(null)
          setGoal(emptyGoal()); setWeight(emptyWeight())
          loadProfile(id).catch(() => setError('เปิดโปรไฟล์ไม่ได้ ลองเลือกอีกครั้ง'))
        }}>
          {profiles.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>
        {loading && <p className="profile-empty" role="status">กำลังโหลดโปรไฟล์…</p>}
      </>}
    </section>

    {profile && <>
      <section className="profile-section" aria-labelledby="goals-title">
        <h2 id="goals-title">เป้าหมายจากบุคลากรทางการแพทย์</h2>
        {profile.goals.length ? <ul className="profile-records">{profile.goals.map((item, index) => <li key={`${item.effective_on}-${index}`}>
          <strong>{item.nutrient}: {item.amount} {item.unit}</strong><span>เริ่มใช้ {item.effective_on}</span>
        </li>)}</ul> : <p className="profile-empty">ยังไม่มีเป้าหมายที่บันทึก · ระบบไม่เติมค่าแทน</p>}
        <form onSubmit={event => void submit(event, async () => {
          await request<{ saved: true }>(`/experimental/profiles/${profile.id}/goals`, json({
            synthetic_only: true, clinician_set: true, ...goal,
          }))
          if (selectedProfileId.current === profile.id) setProfile(current => current?.id === profile.id ? {
            ...current, goals: [...current.goals, {
              nutrient: goal.nutrient, amount: Number(goal.amount), unit: goal.unit, effective_on: goal.effective_on,
            }],
          } : current)
          setGoal(emptyGoal())
        }, 'บันทึกเป้าหมายแล้ว')}>
          <label>สารอาหารตามเอกสารที่ได้รับ <input required maxLength={80} value={goal.nutrient} onChange={event => setGoal({ ...goal, nutrient: event.target.value })} /></label>
          <div className="field-grid">
            <label>ค่าเป้าหมาย <input required type="number" min="0" step="any" inputMode="decimal" value={goal.amount} onChange={event => setGoal({ ...goal, amount: event.target.value })} /></label>
            <label>หน่วยตามเอกสาร <input required maxLength={32} value={goal.unit} onChange={event => setGoal({ ...goal, unit: event.target.value })} /></label>
          </div>
          <label>วันที่เริ่มใช้ <input required type="date" value={goal.effective_on} onChange={event => setGoal({ ...goal, effective_on: event.target.value })} /></label>
          <button className="submit-button" disabled={busy}>บันทึกเป้าหมายที่ได้รับ</button>
        </form>
      </section>

      <section className="profile-section" aria-labelledby="weight-title">
        <h2 id="weight-title">น้ำหนักแห้งที่ผู้ใช้บันทึก</h2>
        {profile.dry_weights.length ? <ul className="profile-records">{profile.dry_weights.map((item, index) => <li key={`${item.measured_on}-${index}`}>
          <strong>{item.kilograms} กก.</strong><span>วัดเมื่อ {item.measured_on}</span>
        </li>)}</ul> : <p className="profile-empty">ยังไม่มีข้อมูลน้ำหนักแห้ง</p>}
        <form onSubmit={event => void submit(event, async () => {
          await request<{ saved: true }>(`/experimental/profiles/${profile.id}/dry-weights`, json({
            synthetic_only: true, ...weight,
          }))
          if (selectedProfileId.current === profile.id) setProfile(current => current?.id === profile.id ? {
            ...current, dry_weights: [...current.dry_weights, {
              measured_on: weight.measured_on, kilograms: Number(weight.kilograms),
            }],
          } : current)
          setWeight(emptyWeight())
        }, 'บันทึกน้ำหนักแล้ว')}>
          <div className="field-grid">
            <label>น้ำหนักแห้ง (กก.) <input required type="number" min="0.01" step="any" inputMode="decimal" value={weight.kilograms} onChange={event => setWeight({ ...weight, kilograms: event.target.value })} /></label>
            <label>วันที่วัด <input required type="date" value={weight.measured_on} onChange={event => setWeight({ ...weight, measured_on: event.target.value })} /></label>
          </div>
          <button className="submit-button" disabled={busy}>บันทึกน้ำหนักแห้ง</button>
        </form>
      </section>
    </>}
    {busy && <p role="status">กำลังบันทึกข้อมูล…</p>}
    {status && <p className="success" role="status">{status}</p>}
    {error && <p className="error" role="alert">{error}</p>}
  </section>
}
