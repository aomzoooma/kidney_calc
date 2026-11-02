import { useState, type FormEvent } from 'react'
import { nutrients, type FoodState, type NutrientKey } from './request'

const blankNutrients = () => Object.fromEntries(nutrients.map(([key]) => [key, ''])) as Record<NutrientKey, string>
const stateNames: Record<FoodState, string> = { raw: 'ดิบ', cooked: 'สุก', as_sold: 'ตามสภาพที่ซื้อ' }

export function ManualIngredientForm() {
  const [name, setName] = useState('')
  const [provider, setProvider] = useState('')
  const [sourceVersion, setSourceVersion] = useState('')
  const [sourceDate, setSourceDate] = useState('')
  const [sourceReference, setSourceReference] = useState('')
  const [provenance, setProvenance] = useState('')
  const [basisQuantity, setBasisQuantity] = useState('')
  const [basisUnit, setBasisUnit] = useState<'g' | 'ml' | ''>('')
  const [foodState, setFoodState] = useState<FoodState | ''>('')
  const [values, setValues] = useState(blankNutrients)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [savedVersion, setSavedVersion] = useState<number | null>(null)
  const [reviewed, setReviewed] = useState(false)

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true); setError(''); setSavedVersion(null)
    try {
      const response = await fetch('/experimental/ingredients', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          synthetic_only: true, reviewed: true, name, provider, source_version: sourceVersion,
          source_date: sourceDate || null, source_reference: sourceReference, provenance,
          basis_quantity: basisQuantity, basis_unit: basisUnit, food_state: foodState,
          nutrients: Object.fromEntries(nutrients.map(([key]) => [key, values[key].trim() || null])),
        }),
      })
      const payload = await response.json()
      if (!response.ok) throw new Error('บันทึกไม่ได้ ตรวจข้อมูลแล้วลองอีกครั้ง')
      setSavedVersion(payload.version_id as number)
      setReviewed(false)
    } catch {
      setError('บันทึกวัตถุดิบในเครื่องนี้ไม่ได้ ตรวจว่า API ทำงานอยู่และใช้ข้อมูลสมมติเท่านั้น')
    } finally { setBusy(false) }
  }

  return <section className="seasoning-flow manual-ingredient" aria-labelledby="manual-ingredient-title">
    <div className="page-intro"><h2 id="manual-ingredient-title">บันทึกวัตถุดิบจากข้อมูลสมมติ</h2>
      <p>บันทึกในเครื่องนี้เท่านั้น · ห้ามใช้ฉลากจริง ข้อมูลผู้ป่วย หรือค่าที่คาดเดา · ค่าที่เว้นว่างจะยังเป็น “ไม่ทราบ”</p></div>
    <form onSubmit={save} onChange={event => {
      setSavedVersion(null)
      if ((event.target as HTMLInputElement).type !== 'checkbox') setReviewed(false)
    }}>
      <fieldset className="manual-ingredient-fields" disabled={busy}>
      <label>ชื่อวัตถุดิบ <input required maxLength={150} value={name} onChange={event => setName(event.target.value)} autoComplete="off" /></label>
      <div className="field-grid">
        <label>แหล่งข้อมูล / ผู้เผยแพร่ <input required maxLength={150} value={provider} onChange={event => setProvider(event.target.value)} /></label>
        <label>รุ่นหรือฉบับของแหล่งข้อมูล <input required maxLength={200} value={sourceVersion} onChange={event => setSourceVersion(event.target.value)} /></label>
      </div>
      <label>วันที่ของแหล่งข้อมูล (ถ้าระบุ) <input type="date" value={sourceDate} onChange={event => setSourceDate(event.target.value)} /></label>
      <label>ตำแหน่งอ้างอิง เช่น หน้าเอกสารหรือ URL <input required maxLength={500} value={sourceReference} onChange={event => setSourceReference(event.target.value)} /></label>
      <label>วิธีได้มาของข้อมูล <input required maxLength={500} value={provenance} onChange={event => setProvenance(event.target.value)} placeholder="เช่น คัดลอกจากตัวอย่างเอกสารสมมติ" /></label>
      <div className="field-grid">
        <label>ข้อมูลสารอาหารต่อปริมาณ <input required inputMode="decimal" type="number" min="0.00000001" step="any" value={basisQuantity} onChange={event => setBasisQuantity(event.target.value)} /></label>
        <label>หน่วยฐาน <select required value={basisUnit} onChange={event => setBasisUnit(event.target.value as 'g' | 'ml' | '')}>
          <option value="">เลือกหน่วย</option><option value="g">กรัม</option><option value="ml">มล.</option>
        </select></label>
      </div>
      <label>สภาพอาหาร <select required value={foodState} onChange={event => setFoodState(event.target.value as FoodState | '')}>
        <option value="">เลือกสภาพ</option>{Object.entries(stateNames).map(([state, label]) => <option key={state} value={state}>{label}</option>)}
      </select></label>
      <div className="nutrient-grid"><p className="subheading">สารอาหารต่อปริมาณฐาน <span>เว้นว่างเมื่อไม่ทราบ · ห้ามใส่ 0 แทนข้อมูลที่ขาด</span></p>
        {nutrients.map(([key, label, unit]) => <label key={key}>{label}<span className="nutrient-unit">
          <input inputMode="decimal" type="number" min="0" step="any" value={values[key]} onChange={event => setValues(current => ({ ...current, [key]: event.target.value }))} placeholder="ไม่ทราบ" />
          <span>{unit}</span></span></label>)}
      </div>
      <label className="attestation"><input required type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} /> ยืนยันว่าเป็นข้อมูลสมมติ และตรวจทานกับแหล่งที่ระบุแล้ว</label>
      <button className="submit-button" type="submit" disabled={busy}>{busy ? 'กำลังบันทึก…' : 'บันทึกตัวอย่างวัตถุดิบ'}</button>
      </fieldset>
    </form>
    {savedVersion !== null && <p className="success" role="status">บันทึกแล้ว · รุ่น {savedVersion} · ค้นหาชื่อรายการนี้ได้ในหน้า “สูตรอาหาร”</p>}
    {error && <p className="error" role="alert">{error}</p>}
  </section>
}
