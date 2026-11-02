import { StrictMode, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { buildCalculationPayload, isCurrentRevision, nutrients, type FoodState, type Ingredient, type NutrientKey } from './request'
import { OcrPreview } from './OcrPreview'
import './style.css'

type Result = {
  experimental: boolean; clinical_use: boolean; rounding: string; portion: string;
  totals: Record<NutrientKey, { value: string | null; complete: boolean }>
}
const emptyValues = (): Ingredient['values'] => ({ energy_kcal: '', protein_g: '', sodium_mg: '', potassium_mg: '', phosphorus_mg: '' })
const newIngredient = (): Ingredient => ({ name: '', amount: '', unit: 'g', state: 'raw', reference: '100', values: emptyValues() })
const stateNames: Record<FoodState, string> = { raw: 'ดิบ', cooked: 'สุก', as_sold: 'ตามสภาพที่ซื้อ' }

export function App() {
  const [ingredients, setIngredients] = useState([newIngredient()])
  const [portion, setPortion] = useState('1')
  const [result, setResult] = useState<Result | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const revision = useRef(0)

  function update(index: number, changes: Partial<Ingredient>) {
    revision.current++
    setIngredients(current => current.map((item, i) => i === index ? { ...item, ...changes } : item))
    setResult(null)
  }

  async function calculate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true); setError(''); setResult(null)
    const submittedRevision = ++revision.current
    try {
      const response = await fetch('/experimental/recipes/calculate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildCalculationPayload(ingredients, portion)),
      })
      const payload = await response.json()
      if (!response.ok) throw new Error(typeof payload.detail === 'string' ? payload.detail : 'ตรวจข้อมูลแล้วลองอีกครั้ง')
      if (!isCurrentRevision(submittedRevision, revision.current)) return
      setResult(payload as Result)
    } catch (cause) {
      if (isCurrentRevision(submittedRevision, revision.current)) {
        setError(cause instanceof Error && cause.message === 'Failed to fetch'
          ? 'เชื่อมต่อเครื่องคำนวณไม่ได้ ตรวจว่า API ทำงานอยู่บนเครื่องนี้'
          : cause instanceof Error ? cause.message : 'เกิดข้อผิดพลาด')
      }
    } finally { setBusy(false) }
  }

  return <div className="app-shell">
    <header className="topbar"><a className="brand" href="#top">ครัวอุ่นใจ <span>เครื่องมือทดลองสำหรับผู้ดูแล</span></a></header>
    <main id="top">
      <section className="intro">
        <h1>ถ่ายฉลาก<br />ตรวจ แล้วบันทึก</h1>
        <p>ภาพทดสอบเท่านั้น · ตรวจข้อมูลก่อนบันทึก และนำไปใช้ในสูตรยังไม่เปิด</p>
      </section>
      <aside className="notice" role="note">
        <span className="notice-mark" aria-hidden="true">!</span>
        <div><h2>ใช้ตัวเลขสมมติเท่านั้น</h2><p>ห้ามใช้ค่าจากฉลากอาหารจริงหรือข้อมูลผู้ป่วย ระบบไม่มีฐานข้อมูลอาหาร ไม่บันทึกสูตร และผลนี้ใช้ตัดสินใจด้านอาหารหรือการรักษาไม่ได้</p></div>
      </aside>
      <OcrPreview />
      <section aria-labelledby="recipe-title">
      <div className="section-heading"><h2 id="recipe-title">คำนวณสูตรอาหาร</h2></div>
      <form onSubmit={calculate}>
        <section className="section-heading"><h2>รายการวัตถุดิบ</h2><button type="button" className="add-button" onClick={() => { revision.current++; setIngredients(items => [...items, newIngredient()]); setResult(null) }}>＋ เพิ่มวัตถุดิบ</button></section>
        {ingredients.map((item, index) => <fieldset className="ingredient-card" key={index}>
          <legend>วัตถุดิบ {index + 1}</legend>
          {ingredients.length > 1 && <button type="button" className="remove-button" aria-label={`ลบวัตถุดิบ ${index + 1}`} onClick={() => { revision.current++; setIngredients(items => items.filter((_, i) => i !== index)); setResult(null) }}>ลบ</button>}
          <label>ชื่อวัตถุดิบ <input value={item.name} onChange={e => update(index, { name: e.target.value })} placeholder="เช่น ข้าวสวย" autoComplete="off" /></label>
          <div className="field-grid">
            <label>ปริมาณที่ใช้ <span className="input-unit"><input required inputMode="decimal" type="number" min="0.00000001" step="any" value={item.amount} onChange={e => update(index, { amount: e.target.value })} placeholder="เช่น 150" /><select aria-label="หน่วยปริมาณ" value={item.unit} onChange={e => update(index, { unit: e.target.value as Ingredient['unit'] })}><option value="g">กรัม</option><option value="ml">มล.</option></select></span></label>
            <label>สภาพอาหาร <select value={item.state} onChange={e => update(index, { state: e.target.value as FoodState })}>{Object.entries(stateNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          </div>
          <label>ข้อมูลสารอาหารต่อ <span className="inline-input"><input required inputMode="decimal" type="number" min="0.00000001" step="any" value={item.reference} onChange={e => update(index, { reference: e.target.value })} /><span>{item.unit === 'g' ? 'กรัม' : 'มล.'} (หน่วยเดียวกับปริมาณที่ใช้)</span></span></label>
          <div className="nutrient-grid"><p className="subheading">สารอาหารในปริมาณอ้างอิง <span>เว้นว่างได้เมื่อไม่ทราบ</span></p>
            {nutrients.map(([key, label, unit]) => <label key={key}>{label} <span className="nutrient-unit"><input inputMode="decimal" type="number" min="0" step="any" value={item.values[key]} onChange={e => update(index, { values: { ...item.values, [key]: e.target.value } })} placeholder="ไม่ทราบ" /><span>{unit}</span></span></label>)}
          </div>
        </fieldset>)}
        <section className="portion-card"><label htmlFor="portion">สัดส่วนที่เสิร์ฟ</label><div><input id="portion" required inputMode="decimal" type="number" min="0.00000001" max="1" step="any" value={portion} onChange={e => { revision.current++; setPortion(e.target.value); setResult(null) }} /><span>ส่วนของสูตรทั้งหมด (0–1)</span></div></section>
        <label className="attestation"><input type="checkbox" required /> ยืนยันว่าข้อมูลทั้งหมดเป็นตัวเลขสมมติ ไม่ได้ใช้ค่าจากฉลากอาหารจริงหรือข้อมูลผู้ป่วย</label>
        <button className="submit-button" type="submit" disabled={busy}>{busy ? 'กำลังคำนวณ…' : 'คำนวณสารอาหาร'}</button>
      </form>
      {error && <p className="error" role="alert">{error}</p>}
      {result && <section className="results" aria-live="polite" aria-labelledby="results-title"><div className="result-title"><div><h2 id="results-title">สารอาหารโดยประมาณ · {result.portion} ส่วน</h2></div><span className="status-pill">ไม่ใช่คำแนะนำทางการแพทย์</span></div>
        <ul>{nutrients.map(([key, label, unit]) => { const total = result.totals[key]; return <li key={key}><span>{label}</span><strong>{total.value === null ? 'ไม่ทราบ' : `${total.value} ${unit}`}</strong><small>{total.complete ? 'ข้อมูลครบตามที่กรอก' : 'ข้อมูลไม่ครบ · มีรายการที่ไม่ทราบ'}</small></li> })}</ul>
        <p className="footnote">ค่าที่ทราบรวมตามสูตรและสัดส่วนเสิร์ฟ ค่าที่เว้นว่างยังคงเป็น “ไม่ทราบ” ไม่ได้ถือเป็นศูนย์</p>
      </section>}
      </section>
    </main>
    <footer><p>ข้อมูลทดสอบเท่านั้น · ยังไม่มีการตรวจสอบทางคลินิก · ห้ามใช้ตัดสินใจด้านการรักษา</p></footer>
  </div>
}

const rootElement = document.getElementById('root')
if (rootElement) createRoot(rootElement).render(<StrictMode><App /></StrictMode>)
