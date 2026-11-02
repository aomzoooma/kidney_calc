import { StrictMode, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { buildCalculationPayload, isCurrentRevision, nutrients, type FoodState, type Ingredient, type NutrientKey, type SavedSeasoning } from './request'
import { OcrPreview } from './OcrPreview'
import './style.css'

type Result = {
  experimental: boolean; clinical_use: boolean; rounding: string; portion: string;
  totals: Record<NutrientKey, { value: string | null; complete: boolean }>
}
const emptyValues = (): Ingredient['values'] => ({ energy_kcal: '', protein_g: '', sodium_mg: '', potassium_mg: '', phosphorus_mg: '' })
const newIngredient = (): Ingredient => ({ name: '', amount: '', unit: 'g', state: 'raw', reference: '100', values: emptyValues(), seasoningVersionId: null })
const stateNames: Record<FoodState, string> = { raw: 'ดิบ', cooked: 'สุก', as_sold: 'ตามสภาพที่ซื้อ' }
const pages = [
  { id: 'home', label: 'หน้าหลัก', compact: 'หน้าแรก' },
  { id: 'patients', label: 'ผู้ป่วย', compact: 'ผู้ป่วย' },
  { id: 'ingredients', label: 'วัตถุดิบและเครื่องปรุง', compact: 'วัตถุดิบ' },
  { id: 'recipes', label: 'สูตรอาหาร', compact: 'สูตรอาหาร' },
  { id: 'meals', label: 'บันทึกอาหาร', compact: 'บันทึก' },
] as const
type PageId = typeof pages[number]['id']

function readPage(fallback: PageId = 'home'): PageId {
  const page = window.location.hash.slice(1)
  return pages.some(item => item.id === page) ? page as PageId : fallback
}

export function App() {
  const [page, setPage] = useState<PageId>(readPage)
  const [ingredientsVisited, setIngredientsVisited] = useState(() => readPage() === 'ingredients')
  const [ingredients, setIngredients] = useState([newIngredient()])
  const [openIngredient, setOpenIngredient] = useState(0)
  const [savedSeasonings, setSavedSeasonings] = useState<SavedSeasoning[]>([])
  const [seasoningsError, setSeasoningsError] = useState('')
  const [portion, setPortion] = useState('1')
  const [result, setResult] = useState<Result | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const invalidHandled = useRef(false)
  const revision = useRef(0)

  useEffect(() => {
    const syncPage = () => {
      const nextPage = readPage(page)
      setPage(nextPage)
      if (nextPage === 'ingredients') setIngredientsVisited(true)
    }
    window.addEventListener('hashchange', syncPage)
    window.addEventListener('popstate', syncPage)
    return () => {
      window.removeEventListener('hashchange', syncPage)
      window.removeEventListener('popstate', syncPage)
    }
  }, [page])

  useEffect(() => {
    if (page !== 'recipes') return
    fetch('/experimental/seasonings').then(async response => {
      const payload = await response.json()
      if (!response.ok) throw new Error('โหลดเครื่องปรุงที่บันทึกไว้ไม่ได้')
      setSavedSeasonings((payload.items as SavedSeasoning[]).filter(item => item.reviewed))
      setSeasoningsError('')
    }).catch(() => setSeasoningsError('โหลดเครื่องปรุงที่บันทึกไว้ไม่ได้ ตรวจว่า API ทำงานอยู่บนเครื่องนี้'))
  }, [page])

  function navigate(event: React.MouseEvent<HTMLAnchorElement>, nextPage: PageId) {
    event.preventDefault()
    window.history.pushState(null, '', `#${nextPage}`)
    setPage(nextPage)
    if (nextPage === 'ingredients') setIngredientsVisited(true)
  }

  function update(index: number, changes: Partial<Ingredient>) {
    revision.current++
    setIngredients(current => current.map((item, i) => i === index ? { ...item, ...changes } : item))
    setResult(null)
  }

  function addIngredient() {
    revision.current++
    setOpenIngredient(ingredients.length)
    setIngredients(items => [...items, newIngredient()])
    setResult(null)
  }

  function removeIngredient(index: number) {
    revision.current++
    const remaining = ingredients.filter((_, i) => i !== index)
    setIngredients(remaining)
    setOpenIngredient(current => current === index ? Math.min(index, remaining.length - 1)
      : current > index ? current - 1 : current)
    setResult(null)
  }

  function selectSeasoning(index: number, versionId: string) {
    if (!versionId) {
      update(index, { ...newIngredient(), amount: ingredients[index].amount })
      return
    }
    const seasoning = savedSeasonings.find(item => item.version_id === Number(versionId))
    if (!seasoning) return
    update(index, {
      name: seasoning.name, seasoningVersionId: seasoning.version_id, unit: seasoning.basis_unit,
      state: 'as_sold', reference: String(seasoning.basis_quantity),
      values: Object.fromEntries(nutrients.map(([key]) => [key, seasoning.nutrients[key] === null ? '' : String(seasoning.nutrients[key])])) as Ingredient['values'],
    })
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
    <a className="skip-link" href="#main-content">ข้ามเมนูไปเนื้อหา</a>
    <header className="topbar"><a className="brand" href="#home" onClick={event => navigate(event, 'home')}>ครัวอุ่นใจ <span>เครื่องมือทดลองสำหรับผู้ดูแล</span></a></header>
    <nav className="primary-nav" aria-label="เมนูหลัก">
      {pages.map(item => <a key={item.id} href={`#${item.id}`} aria-label={item.label} aria-current={page === item.id ? 'page' : undefined} onClick={event => navigate(event, item.id)}>
        <span className="nav-label-desktop">{item.label}</span><span className="nav-label-mobile" aria-hidden="true">{item.compact}</span>
      </a>)}
    </nav>
    <main id="main-content" tabIndex={-1}>
      {page === 'home' && <section className="home-view" aria-labelledby="home-title">
        <div className="intro"><h1 id="home-title">วางแผนอาหาร<br />ทีละขั้น</h1><p>จัดเก็บข้อมูลเครื่องปรุงที่ตรวจเอง และทดลองคำนวณสูตรอาหาร</p></div>
        <aside className="notice" role="note"><span className="notice-mark" aria-hidden="true">!</span><div><h2>ต้นแบบทดลอง</h2><p>ยังไม่พร้อมใช้กับข้อมูลผู้ป่วยหรือฉลากจริง · ไม่มีการตรวจสอบทางคลินิก</p></div></aside>
        <h2>เริ่มจากเครื่องปรุง</h2>
        <p>ถ่ายหรือเลือกภาพทดสอบ ตรวจค่าที่อ่านได้ แล้วบันทึกเฉพาะหลังตรวจสอบ</p>
        <a className="home-action" href="#ingredients" onClick={event => navigate(event, 'ingredients')}>วัตถุดิบและเครื่องปรุง <span>เพิ่มจากภาพทดสอบ</span></a>
        <a className="home-action" href="#recipes" onClick={event => navigate(event, 'recipes')}>สูตรอาหาร <span>เปิดเครื่องคำนวณทดลอง</span></a>
        <h2 className="home-subheading">ส่วนที่กำลังพัฒนา</h2>
        <p>ข้อมูลผู้ป่วยและบันทึกอาหารยังไม่มีระบบบันทึก</p>
      </section>}
      {page === 'patients' && <section className="placeholder-page" aria-labelledby="patients-title"><h1 id="patients-title">ผู้ป่วย</h1><p className="status-line">กำลังพัฒนา</p><p>ส่วนนี้ยังไม่มีระบบสร้างหรือบันทึกโปรไฟล์ผู้ป่วย โปรดอย่ากรอกข้อมูลจริงในต้นแบบนี้</p></section>}
      {ingredientsVisited && <section hidden={page !== 'ingredients'} aria-labelledby="ingredients-title"><div className="page-intro"><h1 id="ingredients-title">วัตถุดิบและเครื่องปรุง</h1><p>การอ่านภาพและบันทึกยังเป็นการทดลอง ใช้ภาพทดสอบเท่านั้น</p></div><OcrPreview /></section>}
      {page === 'recipes' && <section aria-labelledby="recipe-title">
        <div className="page-intro"><h1 id="recipe-title">สูตรอาหาร</h1><p>เครื่องคำนวณทดลองจากตัวเลขสมมติ ยังไม่มีระบบบันทึกสูตร</p></div>
        <aside className="notice" role="note"><span className="notice-mark" aria-hidden="true">!</span><div><h2>ใช้ตัวเลขสมมติเท่านั้น</h2><p>ห้ามใช้ค่าจากฉลากอาหารจริงหรือข้อมูลผู้ป่วย ผลนี้ใช้ตัดสินใจด้านอาหารหรือการรักษาไม่ได้</p></div></aside>
        <form onSubmit={calculate} onInvalidCapture={event => {
          if (invalidHandled.current) return
          invalidHandled.current = true
          const target = event.target as HTMLElement
          const card = target.closest<HTMLElement>('[data-ingredient-index]')
          if (!card) {
            queueMicrotask(() => { invalidHandled.current = false })
            return
          }
          setOpenIngredient(Number(card.dataset.ingredientIndex))
          queueMicrotask(() => {
            target.focus()
            invalidHandled.current = false
          })
        }}>
          <section className="section-heading"><h2>รายการวัตถุดิบ</h2><button type="button" className="add-button" onClick={addIngredient}>＋ เพิ่มวัตถุดิบ</button></section>
          {ingredients.map((item, index) => <div className="ingredient-card" key={index}>
            <details className="ingredient-details" data-ingredient-index={index} open={openIngredient === index}>
              <summary className="ingredient-summary" onClick={event => {
                event.preventDefault()
                setOpenIngredient(current => current === index ? -1 : index)
              }}><span>{item.name.trim() || `วัตถุดิบ ${index + 1}`}</span><span>{item.amount ? `${item.amount} ${item.unit === 'g' ? 'กรัม' : 'มล.'}` : 'ยังไม่ระบุปริมาณ'}</span></summary>
              <fieldset className="ingredient-fields">
            <legend className="visually-hidden">วัตถุดิบ {index + 1}</legend>
            <label>เลือกเครื่องปรุงที่บันทึกไว้ <select value={item.seasoningVersionId ?? ''} onChange={e => selectSeasoning(index, e.target.value)}><option value="">กรอกวัตถุดิบสมมติเอง</option>{savedSeasonings.map(seasoning => <option key={seasoning.version_id} value={seasoning.version_id}>{seasoning.name}{seasoning.brand ? ` · ${seasoning.brand}` : ''} (รุ่น {seasoning.version_id})</option>)}</select></label>
            {item.seasoningVersionId === null && <label>ชื่อวัตถุดิบ <input value={item.name} onChange={e => update(index, { name: e.target.value })} placeholder="เช่น ข้าวสวย" autoComplete="off" /></label>}
            {item.seasoningVersionId !== null && <p className="footnote">ใช้ข้อมูลที่บันทึกไว้จากรุ่นนี้ ระบบคำนวณจะอ่านค่าจากฐานข้อมูลโดยตรง</p>}
            <div className="field-grid">
              <label>ปริมาณที่ใช้ <span className="input-unit"><input required inputMode="decimal" type="number" min="0.00000001" step="any" value={item.amount} onChange={e => update(index, { amount: e.target.value })} placeholder="เช่น 150" /><select aria-label="หน่วยปริมาณ" value={item.unit} disabled={item.seasoningVersionId !== null} onChange={e => update(index, { unit: e.target.value as Ingredient['unit'] })}><option value="g">กรัม</option><option value="ml">มล.</option></select></span></label>
              <label>สภาพอาหาร <select value={item.state} disabled={item.seasoningVersionId !== null} onChange={e => update(index, { state: e.target.value as FoodState })}>{Object.entries(stateNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            </div>
            <label>ข้อมูลสารอาหารต่อ <span className="inline-input"><input required inputMode="decimal" type="number" min="0.00000001" step="any" value={item.reference} readOnly={item.seasoningVersionId !== null} onChange={e => update(index, { reference: e.target.value })} /><span>{item.unit === 'g' ? 'กรัม' : 'มล.'} (หน่วยเดียวกับปริมาณที่ใช้)</span></span></label>
            <div className="nutrient-grid"><p className="subheading">สารอาหารในปริมาณอ้างอิง <span>เว้นว่างได้เมื่อไม่ทราบ</span></p>
              {nutrients.map(([key, label, unit]) => <label key={key}>{label} <span className="nutrient-unit"><input inputMode="decimal" type="number" min="0" step="any" value={item.values[key]} readOnly={item.seasoningVersionId !== null} onChange={e => update(index, { values: { ...item.values, [key]: e.target.value } })} placeholder="ไม่ทราบ" /><span>{unit}</span></span></label>)}
            </div>
              </fieldset>
            </details>
            {ingredients.length > 1 && <button type="button" className="remove-button" aria-label={`ลบวัตถุดิบ ${index + 1}`} onClick={() => removeIngredient(index)}>ลบ</button>}
          </div>)}
          <section className="portion-card"><label htmlFor="portion">สัดส่วนที่เสิร์ฟ</label><div><input id="portion" required inputMode="decimal" type="number" min="0.00000001" max="1" step="any" value={portion} onChange={e => { revision.current++; setPortion(e.target.value); setResult(null) }} /><span>ส่วนของสูตรทั้งหมด (0–1)</span></div></section>
          <label className="attestation"><input type="checkbox" required /> ยืนยันว่าข้อมูลทั้งหมดเป็นตัวเลขสมมติ ไม่ได้ใช้ค่าจากฉลากอาหารจริงหรือข้อมูลผู้ป่วย</label>
          <button className="submit-button" type="submit" disabled={busy}>{busy ? 'กำลังคำนวณ…' : 'คำนวณสารอาหาร'}</button>
        </form>
        {seasoningsError && <p className="error" role="status">{seasoningsError}</p>}
        {error && <p className="error" role="alert">{error}</p>}
        {result && <section className="results" aria-live="polite" aria-labelledby="results-title"><div className="result-title"><h2 id="results-title">สารอาหารโดยประมาณ · {result.portion} ส่วน</h2><span className="status-pill">ไม่ใช่คำแนะนำทางการแพทย์</span></div>
          <ul>{nutrients.map(([key, label, unit]) => { const total = result.totals[key]; return <li key={key}><span>{label}</span><strong>{total.value === null ? 'ไม่ทราบ' : `${total.value} ${unit}`}</strong><small>{total.complete ? 'ข้อมูลครบตามที่กรอก' : 'ข้อมูลไม่ครบ · มีรายการที่ไม่ทราบ'}</small></li> })}</ul>
          <p className="footnote">ค่าที่ทราบรวมตามสูตรและสัดส่วนเสิร์ฟ ค่าที่เว้นว่างยังคงเป็น “ไม่ทราบ” ไม่ได้ถือเป็นศูนย์</p>
        </section>}
      </section>}
      {page === 'meals' && <section className="placeholder-page" aria-labelledby="meals-title"><h1 id="meals-title">บันทึกอาหาร</h1><p className="status-line">กำลังพัฒนา</p><p>ยังไม่มีระบบบันทึกมื้ออาหารหรือประวัติการรับประทาน ส่วนนี้ยังไม่เก็บข้อมูล</p></section>}
    </main>
    <footer><p>ข้อมูลทดสอบเท่านั้น · ยังไม่มีการตรวจสอบทางคลินิก · ห้ามใช้ตัดสินใจด้านการรักษา</p></footer>
  </div>
}

const rootElement = document.getElementById('root')
if (rootElement) createRoot(rootElement).render(<StrictMode><App /></StrictMode>)
