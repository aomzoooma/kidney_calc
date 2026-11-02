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
type OcrSuggestions = {
  basis_quantity: string | null
  basis_unit: 'g' | 'ml' | null
  nutrients: Record<NutrientKey, string | null>
  basis_conflict: boolean
  requires_human_review: true
}
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

function isDecimalString(value: unknown, positive = false): value is string {
  if (typeof value !== 'string' || !/^(?:\d+\.?\d*|\.\d+)$/.test(value)) return false
  const number = Number(value)
  return Number.isFinite(number) && (positive ? number > 0 : number >= 0)
}

function parseOcrSuggestions(value: unknown): OcrSuggestions | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  if (!(item.basis_quantity === null || isDecimalString(item.basis_quantity, true))
    || !(item.basis_unit === null || item.basis_unit === 'g' || item.basis_unit === 'ml')
    || typeof item.basis_conflict !== 'boolean' || item.requires_human_review !== true
    || !item.nutrients || typeof item.nutrients !== 'object' || Array.isArray(item.nutrients)) return null
  const values = item.nutrients as Record<string, unknown>
  if (!nutrients.every(([key]) => Object.hasOwn(values, key) && (values[key] === null || isDecimalString(values[key])))) return null
  return {
    basis_quantity: item.basis_quantity as string | null,
    basis_unit: item.basis_unit as 'g' | 'ml' | null,
    nutrients: values as OcrSuggestions['nutrients'],
    basis_conflict: item.basis_conflict,
    requires_human_review: true,
  }
}

function suggestionBlockReason(form: SeasoningForm, suggestions: OcrSuggestions): string | null {
  if (suggestions.basis_conflict) return 'ฉลากมีค่าที่อ้างอิงคนละฐาน จึงไม่นำค่าจาก OCR มาเติม'
  if (!suggestions.basis_quantity || !suggestions.basis_unit) return 'OCR จับคู่ปริมาณและหน่วยฐานไม่ครบ จึงยังเติมค่าไม่ได้'
  const quantity = form.basisQuantity.trim()
  const unit = form.basisUnit
  if ((!quantity || !unit) && Object.values(form.values).some(value => value.trim() !== '')) {
    return 'กรุณาระบุฐานของค่าที่กรอกไว้ก่อน จึงจะเติมค่าจาก OCR ได้'
  }
  if ((quantity || unit) && (!quantity || !unit || quantity !== suggestions.basis_quantity || unit !== suggestions.basis_unit)) {
    return 'ฐานที่กรอกไม่ตรงกับฐานจาก OCR จึงไม่นำค่ามาผสมกัน'
  }
  return null
}

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
  const [ocrSuggestions, setOcrSuggestions] = useState<OcrSuggestions | null>(null)
  const [ocrSuggestionRevision, setOcrSuggestionRevision] = useState<number | null>(null)
  const [suggestionStatus, setSuggestionStatus] = useState('')
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
    if (ocrSuggestions) {
      setOcrSuggestionRevision(null)
      setSuggestionStatus('มีการแก้ไขข้อมูลแล้ว ให้นำค่าจากภาพมาตรวจและกรอกเอง')
    }
  }

  function updateNutrient(key: NutrientKey, value: string) {
    formRevision.current++
    setForm(current => ({ ...current, values: { ...current.values, [key]: value } }))
    setReviewed(false)
    if (ocrSuggestions) {
      setOcrSuggestionRevision(null)
      setSuggestionStatus('มีการแก้ไขข้อมูลแล้ว ให้นำค่าจากภาพมาตรวจและกรอกเอง')
    }
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
    const startingFormRevision = formRevision.current
    setText(''); setError(''); setSaveMessage(''); setBusy(true)
    setOcrSuggestions(null); setOcrSuggestionRevision(null); setSuggestionStatus('')
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
      if (ocrRevision.current === current) {
        const payload = result as { text: string; requires_human_review?: unknown; suggestions?: unknown }
        const parsedSuggestions = payload.requires_human_review === true ? parseOcrSuggestions(payload.suggestions) : null
        setText(payload.text)
        setOcrSuggestions(parsedSuggestions)
        setOcrSuggestionRevision(startingFormRevision)
        setSuggestionStatus(!parsedSuggestions ? 'OCR ยังไม่มีข้อเสนอที่ตรวจสอบได้ ต้องกรอกเทียบภาพเอง'
          : formRevision.current !== startingFormRevision ? 'มีการแก้ไขระหว่าง OCR จึงไม่นำข้อเสนอมาเติม'
            : suggestionBlockReason(form, parsedSuggestions) ?? 'ตรวจข้อเสนอและกดเติมช่องว่าง หากตรงกับฉลาก')
      }
    } catch (cause) {
      if (ocrRevision.current === current && !(cause instanceof DOMException && cause.name === 'AbortError')) setError(cause instanceof Error && cause.message === 'Failed to fetch'
        ? 'เชื่อมต่อ OCR ไม่ได้ ตรวจว่า API และ Ollama ทำงานอยู่' : cause instanceof Error ? cause.message : 'อ่านภาพไม่ได้')
    } finally {
      if (pending.current === controller) pending.current = null
      if (ocrRevision.current === current) setBusy(false)
    }
  }

  const suggestionReason = ocrSuggestions ? suggestionBlockReason(form, ocrSuggestions) : null
  const canApplySuggestions = !!ocrSuggestions && !suggestionReason
    && ocrSuggestionRevision !== null && ocrSuggestionRevision === formRevision.current

  function applyOcrSuggestions() {
    if (!ocrSuggestions || !canApplySuggestions) return
    const next: SeasoningForm = { ...form, values: { ...form.values } }
    let filled = 0
    if (!next.basisQuantity.trim() && ocrSuggestions.basis_quantity) { next.basisQuantity = ocrSuggestions.basis_quantity; filled++ }
    if (!next.basisUnit && ocrSuggestions.basis_unit) { next.basisUnit = ocrSuggestions.basis_unit; filled++ }
    for (const [key] of nutrients) {
      const suggestion = ocrSuggestions.nutrients[key]
      if (!next.values[key].trim() && suggestion !== null) { next.values[key] = suggestion; filled++ }
    }
    formRevision.current++
    setForm(next)
    setReviewed(false)
    setOcrSuggestionRevision(null)
    setSuggestionStatus(filled ? 'เติมเฉพาะช่องว่างแล้ว กรุณาตรวจทุกค่ากับภาพอีกครั้ง' : 'ไม่มีช่องว่างให้เติม')
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
          ocrRevision.current++; formRevision.current++; pending.current?.abort(); setBusy(false); setConfirmed(false); setFile(event.target.files?.[0] ?? null); setText(''); setForm(emptyForm()); setReviewed(false); setOcrSuggestions(null); setOcrSuggestionRevision(null); setSuggestionStatus(''); setSaveMessage(''); setError('')
        }} />
      </label>
      <label className="attestation"><input type="checkbox" required checked={confirmed} disabled={saving} onChange={event => setConfirmed(event.target.checked)} /> ยืนยันว่าเป็นภาพทดสอบ ไม่มีข้อมูลผู้ป่วยหรือข้อมูลส่วนบุคคล</label>
      <button className="submit-button" type="submit" disabled={busy || saving || !file || !confirmed}>{busy ? 'กำลังอ่านข้อความ…' : 'อ่านข้อความจากภาพ'}</button>
    </form>
    {preview && <div className="label-review">
      <figure><img src={preview} alt="ภาพฉลากทดสอบที่เลือก" /><figcaption>เทียบข้อมูลกับภาพนี้ก่อนบันทึกทุกครั้ง</figcaption></figure>
      <div className="ocr-text" aria-live="polite"><h3>ข้อความจาก OCR</h3><p>OCR อาจอ่านผิดหรือสร้างข้อความเพิ่ม ตรวจภาพก่อนใช้ข้อเสนอทุกครั้ง</p>{text ? <pre>{text}</pre> : <p className="muted">ผลอ่านข้อความจะแสดงตรงนี้</p>}
        {ocrSuggestions && <button type="button" className="add-button" disabled={busy || saving || !canApplySuggestions} onClick={applyOcrSuggestions}>เติมช่องว่างจาก OCR</button>}
        {suggestionStatus && <p className={ocrSuggestions?.basis_conflict ? 'error' : 'muted'} role="status">{suggestionStatus}</p>}
      </div>
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
