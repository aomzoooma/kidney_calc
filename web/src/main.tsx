import { StrictMode, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { buildCalculationPayload, isCurrentRevision, nutrients, type FoodState, type Ingredient, type IngredientSource, type NutrientKey, type SavedIngredient, type SavedSeasoning } from './request'
import { ManualIngredientForm } from './ManualIngredientForm'
import { OcrPreview } from './OcrPreview'
import './style.css'

type Result = {
  experimental: boolean; clinical_use: boolean; rounding: string; portion: string;
  totals: Record<NutrientKey, { value: string | null; complete: boolean }>;
  sources?: Array<{ source_id: string; description: string; source_type: string; source_version: string | null; food_state: FoodState; energy_ambiguous: boolean }>
  saved_sources?: Array<{ version_id: number; name: string; provider: string; source_version: string; source_reference: string; provenance: string; retrieved_on: string; food_state: FoodState }>
}
type USDAFood = { fdc_id: number; description: string; source_type: string; source_version: string | null; food_state: FoodState | null }
const emptyValues = (): Ingredient['values'] => ({ energy_kcal: '', protein_g: '', sodium_mg: '', potassium_mg: '', phosphorus_mg: '' })
const newIngredient = (): Ingredient => ({ name: '', amount: '', unit: 'g', state: 'raw', reference: '100', values: emptyValues(), source: 'manual', seasoningVersionId: null, ingredientVersionId: null, fdcId: null, fdcState: null })
const stateNames: Record<FoodState, string> = { raw: 'ดิบ', cooked: 'สุก', as_sold: 'ตามสภาพที่ซื้อ' }
const foodStateLabel = (state: FoodState | null) => state ? stateNames[state] : 'ไม่ระบุสภาพ · ยังใช้คำนวณไม่ได้'
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
  const [savedQuery, setSavedQuery] = useState('')
  const [savedIngredients, setSavedIngredients] = useState<SavedIngredient[]>([])
  const [savedSearchBusy, setSavedSearchBusy] = useState(false)
  const [savedSearchError, setSavedSearchError] = useState('')
  const [seasoningsError, setSeasoningsError] = useState('')
  const [usdaQuery, setUsdaQuery] = useState('')
  const [usdaFoods, setUsdaFoods] = useState<USDAFood[]>([])
  const [usdaError, setUsdaError] = useState('')
  const [usdaBusy, setUsdaBusy] = useState(false)
  const [portion, setPortion] = useState('1')
  const [result, setResult] = useState<Result | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const invalidHandled = useRef(false)
  const revision = useRef(0)
  const savedSearchRevision = useRef(0)
  const usdaSearchRevision = useRef(0)

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
      update(index, { ...newIngredient(), amount: ingredients[index].amount, source: 'manual' })
      return
    }
    const seasoning = savedSeasonings.find(item => item.version_id === Number(versionId))
    if (!seasoning) return
    update(index, {
      name: seasoning.name, source: 'seasoning', seasoningVersionId: seasoning.version_id, unit: seasoning.basis_unit,
      ingredientVersionId: null, fdcId: null,
      state: 'as_sold', reference: String(seasoning.basis_quantity),
      values: Object.fromEntries(nutrients.map(([key]) => [key, seasoning.nutrients[key] === null ? '' : String(seasoning.nutrients[key])])) as Ingredient['values'],
    })
  }

  async function searchSavedIngredients() {
    const requestRevision = ++savedSearchRevision.current
    const query = savedQuery.trim()
    setSavedSearchBusy(true); setSavedSearchError(''); setSavedIngredients([])
    try {
      const response = await fetch(`/experimental/ingredients/search?q=${encodeURIComponent(query)}`)
      const payload = await response.json()
      if (!response.ok) throw new Error('ค้นหารายการที่บันทึกไว้ไม่สำเร็จ')
      if (requestRevision === savedSearchRevision.current && query === savedQuery.trim()) {
        setSavedIngredients(payload.items as SavedIngredient[])
      }
    } catch {
      if (requestRevision === savedSearchRevision.current) {
        setSavedSearchError('ค้นหารายการในเครื่องไม่สำเร็จ ตรวจว่า API ทำงานอยู่บนเครื่องนี้')
      }
    } finally {
      if (requestRevision === savedSearchRevision.current) setSavedSearchBusy(false)
    }
  }

  function updateSavedQuery(query: string) {
    savedSearchRevision.current++
    setSavedQuery(query)
    setSavedIngredients([])
    setSavedSearchError('')
    setSavedSearchBusy(false)
  }

  function addSavedIngredient(food: SavedIngredient) {
    revision.current++
    const index = ingredients.length
    setIngredients(current => [...current, { ...newIngredient(), name: food.name,
      source: 'saved', ingredientVersionId: food.version_id, unit: food.basis_unit,
      state: food.food_state, reference: food.basis_quantity,
      values: Object.fromEntries(nutrients.map(([key]) => [key, food.nutrients[key] ?? ''])) as Ingredient['values'] }])
    setOpenIngredient(index)
    setResult(null)
  }

  async function searchUSDA() {
    const requestRevision = ++usdaSearchRevision.current
    const query = usdaQuery.trim()
    setUsdaBusy(true); setUsdaError(''); setUsdaFoods([])
    try {
      const response = await fetch(`/experimental/usda/search?q=${encodeURIComponent(query)}`)
      const payload = await response.json()
      if (!response.ok) throw new Error(typeof payload.detail === 'string' ? payload.detail : 'ค้นหาฐานข้อมูล USDA ไม่สำเร็จ')
      if (requestRevision === usdaSearchRevision.current) setUsdaFoods(payload.items as USDAFood[])
    } catch {
      if (requestRevision === usdaSearchRevision.current) setUsdaError('ค้นหา USDA ไม่สำเร็จ ตรวจ API และ USDA_FDC_API_KEY บนเครื่องนี้')
    } finally {
      if (requestRevision === usdaSearchRevision.current) setUsdaBusy(false)
    }
  }

  function updateUSDAQuery(query: string) {
    usdaSearchRevision.current++
    setUsdaQuery(query)
    setUsdaFoods([])
    setUsdaError('')
    setUsdaBusy(false)
  }

  function selectSource(index: number, source: IngredientSource) {
    const current = ingredients[index]
    if (source === 'manual' && current.source !== 'seasoning') {
      update(index, { ...current, source, seasoningVersionId: null, ingredientVersionId: null,
        fdcId: null, fdcState: null,
        ...(current.source === 'saved' ? { reference: '100', values: emptyValues() } : {}) })
      return
    }
    if (source === 'usda' && current.source === 'manual') {
      update(index, { ...current, source, unit: 'g', seasoningVersionId: null, ingredientVersionId: null, fdcId: null, fdcState: null })
      return
    }
    update(index, { ...newIngredient(), amount: current.amount, source })
  }

  function addUSDAFood(food: USDAFood) {
    revision.current++
    const index = ingredients.length
    setIngredients(current => [...current, { ...newIngredient(), source: 'usda', name: food.description,
      fdcId: food.fdc_id, fdcState: food.food_state, state: food.food_state ?? 'raw' }])
    setOpenIngredient(index)
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
      {ingredientsVisited && <section hidden={page !== 'ingredients'} aria-labelledby="ingredients-title"><div className="page-intro"><h1 id="ingredients-title">วัตถุดิบและเครื่องปรุง</h1><p>การอ่านภาพและบันทึกยังเป็นการทดลอง ใช้ภาพทดสอบเท่านั้น</p></div><OcrPreview /><ManualIngredientForm /></section>}
      {page === 'recipes' && <section aria-labelledby="recipe-title">
        <div className="page-intro"><h1 id="recipe-title">สูตรอาหาร</h1><p>เครื่องคำนวณทดลอง ยังไม่มีระบบบันทึกสูตร · USDA เป็นข้อมูลอาหารจริงสาธารณะ</p></div>
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
          <section className="usda-search" aria-label="ค้นหาวัตถุดิบที่บันทึกไว้ในเครื่อง">
            <h2>ค้นหาวัตถุดิบที่บันทึกไว้ในเครื่อง</h2>
            <p>ค้นจากชื่อภาษาไทยหรือชื่อที่บันทึกไว้ในเครื่องนี้เท่านั้น · ไม่ส่งคำค้นออกนอกเครื่อง · แสดงเฉพาะรุ่นที่ผู้ใช้ทำเครื่องหมายว่าตรวจแล้ว ซึ่งไม่ได้ยืนยันความถูกต้องทางคลินิก</p>
            <label>ชื่อที่บันทึกไว้ <input value={savedQuery} onChange={e => updateSavedQuery(e.target.value)} maxLength={100} autoComplete="off" /></label>
            <button type="button" className="add-button" disabled={savedSearchBusy || !savedQuery.trim()} onClick={() => void searchSavedIngredients()}>{savedSearchBusy ? 'กำลังค้นหา…' : 'ค้นหารายการในเครื่อง'}</button>
            {savedSearchError && <p className="error" role="alert">{savedSearchError}</p>}
            <ul className="usda-results">{savedIngredients.map(food => <li key={food.version_id}><strong>{food.name}{food.brand ? ` · ${food.brand}` : ''}</strong><small>รุ่นที่บันทึกไว้ · {food.provider} · {food.source_version} · {food.provenance} · สภาพ {stateNames[food.food_state]} · ฐาน {food.basis_quantity} {food.basis_unit === 'g' ? 'กรัม' : 'มล.'} · บันทึก {food.retrieved_on} · {food.source_reference} · รุ่น {food.version_id}</small>
              <button type="button" className="add-button" onClick={() => addSavedIngredient(food)}>เลือกเป็นรายการใหม่</button></li>)}</ul>
          </section>
          <section className="usda-search" aria-label="แหล่งข้อมูลรอง USDA">
            <h2>แหล่งข้อมูลรอง: USDA FoodData Central</h2>
            <p>ใช้เมื่อไม่มีรายการที่บันทึกไว้เท่านั้น · เป็นข้อมูลอ้างอิง USDA ภาษาอังกฤษ (Foundation / SR Legacy) ไม่ใช่การแปลหรือเทียบอาหารไทย · คำค้นจะถูกส่งไป USDA จึงห้ามใส่ชื่อผู้ป่วยหรือข้อมูลส่วนบุคคล</p>
            <label>ชื่ออาหารภาษาอังกฤษ <input value={usdaQuery} onChange={e => updateUSDAQuery(e.target.value)} maxLength={200} autoComplete="off" /></label>
            <button type="button" className="add-button" disabled={usdaBusy || !usdaQuery.trim()} onClick={() => void searchUSDA()}>{usdaBusy ? 'กำลังค้นหา…' : 'ค้นหา USDA'}</button>
            {usdaError && <p className="error" role="alert">{usdaError}</p>}
            <ul className="usda-results">{usdaFoods.map(food => <li key={food.fdc_id}><strong>{food.description}</strong><small>USDA FDC · รายการอ้างอิงไม่ใช่สินค้าแบรนด์ · {food.source_type} · {foodStateLabel(food.food_state)} · {food.source_version ?? 'รุ่นข้อมูลไม่ระบุ'} · ID {food.fdc_id}</small>
              <button type="button" className="add-button" onClick={() => addUSDAFood(food)}>เพิ่มเป็นรายการใหม่</button></li>)}</ul>
          </section>
          <section className="section-heading"><h2>รายการวัตถุดิบ</h2><button type="button" className="add-button" onClick={addIngredient}>＋ เพิ่มวัตถุดิบ</button></section>
          {ingredients.map((item, index) => <div className="ingredient-card" key={index}>
            <details className="ingredient-details" data-ingredient-index={index} open={openIngredient === index}>
              <summary className="ingredient-summary" onClick={event => {
                event.preventDefault()
                setOpenIngredient(current => current === index ? -1 : index)
              }}><span>{item.name.trim() || `วัตถุดิบ ${index + 1}`}</span><span>{item.amount ? `${item.amount} ${item.unit === 'g' ? 'กรัม' : 'มล.'}` : 'ยังไม่ระบุปริมาณ'}</span></summary>
              <fieldset className="ingredient-fields">
            <legend className="visually-hidden">วัตถุดิบ {index + 1}</legend>
            <label>แหล่งข้อมูล <select aria-label={`แหล่งข้อมูลวัตถุดิบ ${index + 1}`} value={item.source} onChange={e => selectSource(index, e.target.value as IngredientSource)}><option value="manual">กรอกข้อมูลเอง</option><option value="usda">USDA รายการอ้างอิง · แหล่งรอง</option><option value="seasoning">เครื่องปรุงที่บันทึกไว้</option><option value="saved" disabled>วัตถุดิบที่บันทึกไว้ · รุ่นที่เลือก</option></select></label>
            {item.source === 'seasoning' && <label>เลือกเครื่องปรุงที่บันทึกไว้ <select value={item.seasoningVersionId ?? ''} onChange={e => selectSeasoning(index, e.target.value)}><option value="">เลือกเครื่องปรุง</option>{savedSeasonings.map(seasoning => <option key={seasoning.version_id} value={seasoning.version_id}>{seasoning.name}{seasoning.brand ? ` · ${seasoning.brand}` : ''} (รุ่น {seasoning.version_id})</option>)}</select></label>}
            {item.source === 'manual' && <label>ชื่อวัตถุดิบ <input value={item.name} onChange={e => update(index, { name: e.target.value })} placeholder="เช่น ข้าวสวย" autoComplete="off" /></label>}
            {item.seasoningVersionId !== null && <p className="footnote">ใช้ข้อมูลที่บันทึกไว้จากรุ่นนี้ ระบบคำนวณจะอ่านค่าจากฐานข้อมูลโดยตรง</p>}
            {item.ingredientVersionId !== null && <p className="footnote">รายการในเครื่อง · รุ่น {item.ingredientVersionId} · แหล่ง/วันที่อ้างอิงแสดงจากรายการค้นหา · คำนวณจะอ่านค่าจากรุ่นนี้ในฐานข้อมูลโดยตรง</p>}
            {item.fdcId !== null && <p className="footnote">USDA FoodData Central · รายการอ้างอิงไม่ใช่สินค้าแบรนด์ · ID {item.fdcId} · สภาพ: {foodStateLabel(item.fdcState)} · ค่ารายละเอียดจะดึงจาก USDA ฝั่งเซิร์ฟเวอร์เมื่อคำนวณ</p>}
            {item.source === 'usda' && item.fdcId === null && <p className="footnote">ค้นหาอาหารด้านบน แล้วกด “เพิ่มเป็นรายการใหม่” เพื่อเพิ่มรายการ USDA แยกต่างหาก</p>}
            <div className="field-grid">
              <label>ปริมาณที่ใช้ <span className="input-unit"><input required inputMode="decimal" type="number" min="0.00000001" step="any" value={item.amount} onChange={e => update(index, { amount: e.target.value })} placeholder="เช่น 150" /><select aria-label="หน่วยปริมาณ" value={item.unit} disabled={item.source !== 'manual'} onChange={e => update(index, { unit: e.target.value as Ingredient['unit'] })}><option value="g">กรัม</option><option value="ml">มล.</option></select></span></label>
              <label>สภาพอาหาร {item.fdcId !== null ? <span>{foodStateLabel(item.fdcState)}</span> : <select value={item.state} disabled={item.seasoningVersionId !== null || item.ingredientVersionId !== null} onChange={e => update(index, { state: e.target.value as FoodState })}>{Object.entries(stateNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>}</label>
            </div>
            {item.source !== 'usda' && <label>ข้อมูลสารอาหารต่อ <span className="inline-input"><input required inputMode="decimal" type="number" min="0.00000001" step="any" value={item.reference} readOnly={item.source === 'seasoning' || item.source === 'saved'} onChange={e => update(index, { reference: e.target.value })} /><span>{item.unit === 'g' ? 'กรัม' : 'มล.'} (หน่วยเดียวกับปริมาณที่ใช้)</span></span></label>}
            {item.source === 'manual' && <div className="nutrient-grid"><p className="subheading">สารอาหารในปริมาณอ้างอิง <span>เว้นว่างได้เมื่อไม่ทราบ</span></p>
              {nutrients.map(([key, label, unit]) => <label key={key}>{label} <span className="nutrient-unit"><input inputMode="decimal" type="number" min="0" step="any" value={item.values[key]} readOnly={item.seasoningVersionId !== null} onChange={e => update(index, { values: { ...item.values, [key]: e.target.value } })} placeholder="ไม่ทราบ" /><span>{unit}</span></span></label>)}
            </div>}
              </fieldset>
            </details>
            {ingredients.length > 1 && <button type="button" className="remove-button" aria-label={`ลบวัตถุดิบ ${index + 1}`} onClick={() => removeIngredient(index)}>ลบ</button>}
          </div>)}
          <section className="portion-card"><label htmlFor="portion">สัดส่วนที่เสิร์ฟ</label><div><input id="portion" required inputMode="decimal" type="number" min="0.00000001" max="1" step="any" value={portion} onChange={e => { revision.current++; setPortion(e.target.value); setResult(null) }} /><span>ส่วนของสูตรทั้งหมด (0–1)</span></div></section>
          <label className="attestation"><input type="checkbox" required /> ยืนยันว่ากำลังทดสอบด้วยสูตรสมมติ ไม่ใช่อาหารหรือข้อมูลผู้ป่วยจริง</label>
          <button className="submit-button" type="submit" disabled={busy}>{busy ? 'กำลังคำนวณ…' : 'คำนวณสารอาหาร'}</button>
        </form>
        {seasoningsError && <p className="error" role="status">{seasoningsError}</p>}
        {error && <p className="error" role="alert">{error}</p>}
        {result && <section className="results" aria-live="polite" aria-labelledby="results-title"><div className="result-title"><h2 id="results-title">สารอาหารโดยประมาณ · {result.portion} ส่วน</h2><span className="status-pill">ไม่ใช่คำแนะนำทางการแพทย์</span></div>
          <ul>{nutrients.map(([key, label, unit]) => { const total = result.totals[key]; return <li key={key}><span>{label}</span><strong>{total.value === null ? 'ไม่ทราบ' : `${total.value} ${unit}`}</strong><small>{total.complete ? 'ข้อมูลครบตามที่กรอก' : 'ข้อมูลไม่ครบ · มีรายการที่ไม่ทราบ'}</small></li> })}</ul>
          {result.sources?.map(source => <p className="footnote" key={source.source_id}>แหล่งข้อมูล USDA อ้างอิงไม่ใช่สินค้าแบรนด์: {source.source_id} · {source.description} · {source.source_type} · สภาพ {stateNames[source.food_state]} · รุ่น {source.source_version ?? 'ไม่ระบุ'}{source.energy_ambiguous ? ' · พลังงานมีหลายค่าขัดแย้ง จึงแสดงเป็นไม่ทราบ' : ''}</p>)}
          {result.saved_sources?.map(source => <p className="footnote" key={source.version_id}>รายการที่บันทึกในเครื่อง รุ่น {source.version_id}: {source.name} · {source.provider} · {source.source_version} · {source.provenance} · {source.source_reference} · บันทึก {source.retrieved_on} · สภาพ {stateNames[source.food_state]}</p>)}
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
