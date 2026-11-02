import { useEffect, useRef, useState } from 'react'
import { nutrients, type NutrientKey } from './request'

type SavedSeasoning = {
  ingredient_id: number
  version_id: number
  name: string
  brand: string | null
  basis_quantity: string
  basis_unit: 'g' | 'ml'
  nutrients: Record<NutrientKey, string | null>
}

type SavedSeasoningResponse = { items: SavedSeasoning[] }
type SeasoningForm = {
  name: string
  brand: string
  basisQuantity: string
  basisUnit: '' | 'g' | 'ml'
  values: Record<NutrientKey, string>
}

const emptyForm = (): SeasoningForm => ({
  name: '', brand: '', basisQuantity: '', basisUnit: '',
  values: { energy_kcal: '', protein_g: '', sodium_mg: '', potassium_mg: '', phosphorus_mg: '' },
})
const uncertainSave = 'ยืนยันผลบันทึกไม่ได้ ตรวจรายการก่อนบันทึกซ้ำ'

function isSavedSeasoning(value: unknown): value is SavedSeasoning {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  const values = item.nutrients as Record<string, unknown> | undefined
  return Number.isInteger(item.ingredient_id) && Number(item.ingredient_id) > 0
    && Number.isInteger(item.version_id) && Number(item.version_id) > 0
    && typeof item.name === 'string' && (item.brand === null || typeof item.brand === 'string')
    && typeof item.basis_quantity === 'string' && ['g', 'ml'].includes(String(item.basis_unit))
    && !!values && nutrients.every(([key]) => values[key] === null || typeof values[key] === 'string')
}

function isSavedSeasoningResponse(value: unknown): value is SavedSeasoningResponse {
  return !!value && typeof value === 'object' && Array.isArray((value as { items?: unknown }).items)
    && (value as { items: unknown[] }).items.every(isSavedSeasoning)
}

export function OcrPreview() {
  const [file, setFile] = useState<File | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [reviewed, setReviewed] = useState(false)
  const [preview, setPreview] = useState('')
  const [form, setForm] = useState<SeasoningForm>(emptyForm)
  const [saved, setSaved] = useState<SavedSeasoning[]>([])
  const [listState, setListState] = useState<'loading' | 'ready' | 'unavailable'>('loading')
  const [saveMessage, setSaveMessage] = useState('')
  const ocrRevision = useRef(0)
  const formRevision = useRef(0)
  const pending = useRef<AbortController | null>(null)

  function updateForm(changes: Partial<SeasoningForm>) {
    formRevision.current++
    setForm(current => ({ ...current, ...changes }))
    setReviewed(false)
  }

  function updateNutrient(key: NutrientKey, value: string) {
    formRevision.current++
    setForm(current => ({ ...current, values: { ...current.values, [key]: value } }))
    setReviewed(false)
  }

  async function loadSaved(signal?: AbortSignal) {
    try {
      const response = await fetch('/experimental/seasonings', { signal })
      const result: unknown = await response.json().catch(() => null)
      if (!response.ok || !isSavedSeasoningResponse(result)) throw new Error('saved seasonings unavailable')
      setSaved(result.items)
      setListState('ready')
    } catch {
      if (!signal?.aborted) setListState('unavailable')
    }
  }

  useEffect(() => {
    const controller = new AbortController()
    void loadSaved(controller.signal)
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (!file) { setPreview(''); return }
    const url = URL.createObjectURL(file)
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!file || !confirmed) return
    const current = ++ocrRevision.current
    setText(''); setError(''); setSaveMessage(''); setBusy(true)
    let controller: AbortController | null = null
    try {
      if (file.size > 8 * 1024 * 1024 || !['image/png', 'image/jpeg'].includes(file.type)) throw new Error('เลือกภาพ PNG หรือ JPEG ขนาดไม่เกิน 8 MB')
      const bytes = new Uint8Array(await file.arrayBuffer())
      if (ocrRevision.current !== current) return
      let binary = ''
      for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
      controller = new AbortController()
      pending.current = controller
      const response = await fetch('/experimental/ocr', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ synthetic_only: true, content_type: file.type, image_base64: btoa(binary) }),
        signal: controller.signal,
      })
      const result: unknown = await response.json().catch(() => null)
      if (!response.ok || !result || typeof result !== 'object' || typeof (result as { text?: unknown }).text !== 'string') throw new Error('อ่านภาพไม่ได้ ตรวจว่า Ollama และโมเดลทำงานอยู่')
      if (ocrRevision.current === current) setText((result as { text: string }).text)
    } catch (cause) {
      if (ocrRevision.current === current && !(cause instanceof DOMException && cause.name === 'AbortError')) setError(cause instanceof Error && cause.message === 'Failed to fetch'
        ? 'เชื่อมต่อ OCR ไม่ได้ ตรวจว่า API และ Ollama ทำงานอยู่' : cause instanceof Error ? cause.message : 'อ่านภาพไม่ได้')
    } finally {
      if (pending.current === controller) pending.current = null
      if (ocrRevision.current === current) setBusy(false)
    }
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving || busy || !confirmed || !reviewed || !form.name.trim() || !form.basisQuantity || !form.basisUnit) return
    const current = ++formRevision.current
    const submitted = { ...form, values: { ...form.values } }
    setError(''); setSaveMessage(''); setSaving(true)
    try {
      const response = await fetch('/experimental/seasonings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          synthetic_only: true,
          name: submitted.name.trim(),
          brand: submitted.brand.trim() || null,
          basis_quantity: submitted.basisQuantity,
          basis_unit: submitted.basisUnit,
          nutrients: Object.fromEntries(nutrients.map(([key]) => [key, submitted.values[key].trim() || null])),
          reviewed: true,
        }),
      })
      if (!response.ok) {
        if (response.status >= 500) {
          setError(uncertainSave)
          setListState('loading')
          await loadSaved()
        } else setError('เซิร์ฟเวอร์ปฏิเสธการบันทึก ตรวจข้อมูลแล้วลองอีกครั้ง')
        return
      }
      const result: unknown = await response.json().catch(() => null)
      if (!result || typeof result !== 'object'
        || !Number.isInteger((result as { ingredient_id?: unknown }).ingredient_id)
        || !Number.isInteger((result as { version_id?: unknown }).version_id)) {
        setError(uncertainSave)
        setListState('loading')
        await loadSaved()
        return
      }
      if (formRevision.current !== current) return
      const ids = result as { ingredient_id: number; version_id: number }
      setSaveMessage(`บันทึกข้อมูลทดลองแล้ว · รุ่น ${ids.version_id}`)
      setForm(emptyForm())
      setReviewed(false)
      setConfirmed(false)
      setFile(null)
      setText('')
      await loadSaved()
    } catch {
      setError(uncertainSave)
      setListState('loading')
      await loadSaved()
    } finally { setSaving(false) }
  }

  return <section className="seasoning-flow" aria-labelledby="ocr-title">
    <div className="seasoning-heading">
      <h2 id="ocr-title">เพิ่มเครื่องปรุงจากฉลาก</h2>
      <span className="status-pill">รุ่นทดลอง</span>
    </div>
    <aside className="notice notice-compact" role="note">
      <span className="notice-mark" aria-hidden="true">!</span>
      <div><h3>ยังใช้ได้เฉพาะภาพทดสอบ</h3><p>ห้ามใช้ฉลากจริงหรือข้อมูลผู้ป่วย จนกว่าจะผ่านตรวจสิทธิ์โมเดล ความปลอดภัย การยืนยันตัวตน และสำรองข้อมูล การเชื่อมต่อ OCR จากโทรศัพท์ยังไม่ผ่านการทดสอบ</p></div>
    </aside>
    <form className="capture-form" onSubmit={submit}>
      <label>ถ่ายหรือเลือกภาพฉลากทดสอบ
        <input type="file" accept="image/png,image/jpeg" capture="environment" required disabled={saving} onChange={event => {
          ocrRevision.current++; formRevision.current++; pending.current?.abort(); setBusy(false); setConfirmed(false); setFile(event.target.files?.[0] ?? null); setText(''); setForm(emptyForm()); setReviewed(false); setSaveMessage(''); setError('')
        }} />
      </label>
      <label className="attestation"><input type="checkbox" required checked={confirmed} disabled={saving} onChange={event => setConfirmed(event.target.checked)} /> ยืนยันว่าเป็นภาพทดสอบ ไม่มีข้อมูลผู้ป่วยหรือข้อมูลส่วนบุคคล</label>
      <button className="submit-button" type="submit" disabled={busy || saving || !file || !confirmed}>{busy ? 'กำลังอ่านข้อความ…' : 'อ่านข้อความจากภาพ'}</button>
    </form>
    {preview && <div className="label-review">
      <figure><img src={preview} alt="ภาพฉลากทดสอบที่เลือก" /><figcaption>เทียบข้อมูลกับภาพนี้ก่อนบันทึกทุกครั้ง</figcaption></figure>
      <div className="ocr-text" aria-live="polite"><h3>ข้อความจาก OCR</h3><p>OCR อาจอ่านผิดหรือสร้างข้อความเพิ่ม ระบบยังไม่เติมค่าลงช่องอัตโนมัติระหว่างตรวจสอบการจับคู่ข้อมูล</p>{text ? <pre>{text}</pre> : <p className="muted">ผลอ่านข้อความจะแสดงตรงนี้</p>}</div>
    </div>}
    {file && <form className="seasoning-review" onSubmit={save}>
      <h3>กรอกค่าที่ตรวจเทียบแล้ว</h3>
      <p className="muted">กรอกตามภาพเท่านั้น · ใช้กรอกเองได้เมื่อ OCR ไม่สำเร็จ · ช่องว่างหมายถึง “ไม่ทราบ” ไม่ใช่ศูนย์</p>
      <label>ชื่อเครื่องปรุง<input required disabled={saving} value={form.name} onChange={event => updateForm({ name: event.target.value })} autoComplete="off" /></label>
      <label>ยี่ห้อ (ถ้ามี)<input disabled={saving} value={form.brand} onChange={event => updateForm({ brand: event.target.value })} autoComplete="off" /></label>
      <div className="field-grid">
        <label>ข้อมูลต่อปริมาณ<input required disabled={saving} inputMode="decimal" type="number" min="0.00000001" step="any" value={form.basisQuantity} onChange={event => updateForm({ basisQuantity: event.target.value })} placeholder="เช่น 100" /></label>
        <label>หน่วยฐาน<select required disabled={saving} value={form.basisUnit} onChange={event => updateForm({ basisUnit: event.target.value as SeasoningForm['basisUnit'] })}><option value="">เลือกหน่วย</option><option value="g">กรัม</option><option value="ml">มล.</option></select></label>
      </div>
      <div className="nutrient-grid"><p className="subheading">สารอาหารต่อปริมาณฐาน <span>ตัวเลขตามฉลาก · เว้นว่างเมื่อไม่มีหรือไม่ทราบ</span></p>
        {nutrients.map(([key, label, unit]) => <label key={key}>{label}<span className="nutrient-unit"><input disabled={saving} inputMode="decimal" type="number" min="0" step="any" value={form.values[key]} onChange={event => updateNutrient(key, event.target.value)} placeholder="ไม่ทราบ" /><span>{unit}</span></span></label>)}
      </div>
      <label className="attestation"><input type="checkbox" required checked={reviewed} disabled={saving || !confirmed} onChange={event => setReviewed(event.target.checked)} /> ยืนยันว่าตรวจชื่อ ปริมาณฐาน และทุกค่าที่กรอกเทียบกับภาพแล้ว</label>
      <button className="submit-button" type="submit" disabled={saving || busy || !confirmed || !reviewed}>{saving ? 'กำลังบันทึก…' : busy ? 'รอ OCR เสร็จก่อนบันทึก…' : 'บันทึกเครื่องปรุงทดลอง'}</button>
    </form>}
    {error && <p className="error" role="alert">{error}</p>}
    {saveMessage && <p className="success" role="status">{saveMessage} · การนำไปใช้ในสูตรยังรอ API ที่รองรับ version ID</p>}
    <div className="saved-seasonings">
      <h3>เครื่องปรุงที่บันทึกไว้</h3>
      {listState === 'loading' && <p className="muted">กำลังตรวจรายการ…</p>}
      {listState === 'unavailable' && <p className="muted">ยังเชื่อมต่อรายการที่บันทึกไม่ได้ รายการทดลองนี้ยังไม่พร้อมใช้งาน</p>}
      {listState === 'ready' && saved.length === 0 && <p className="muted">ยังไม่มีรายการทดลองที่บันทึก</p>}
      {saved.length > 0 && <ul>{saved.map(item => <li key={item.version_id}><strong>{item.name}</strong>{item.brand && <span>{item.brand}</span>}<small>ข้อมูลต่อ {item.basis_quantity} {item.basis_unit === 'g' ? 'กรัม' : 'มล.'} · รุ่น {item.version_id}</small></li>)}</ul>}
      <p className="muted">การเลือกเครื่องปรุงในสูตรยังไม่เปิด จนกว่าตัวคำนวณจะรองรับรุ่นข้อมูลที่บันทึก</p>
    </div>
  </section>
}
