import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Temporal } from '@js-temporal/polyfill'
import { nutrients, type NutrientKey } from './request'

const zone = 'Asia/Bangkok'
const attemptStorageKey = 'synthetic-meal-write-pending'
type Recipe = { id: number; name: string }
type NutrientTotal = { value: string | null; complete: boolean }
type Totals = Record<NutrientKey, NutrientTotal>
type Meal = {
  id: number; profile_id: number; recipe_id: number; recipe_name: string
  consumed_at_utc: string; local_date: string; portion: string
  ingredients: Array<Record<string, unknown>>
  goals: Array<Record<string, unknown>>; totals: Totals
  adjustment: null | Record<string, unknown>; synthetic_only: true; clinical_use: false
}
type Summary = {
  profile_id: number; start_date: string; end_date: string; entry_count: number
  totals: Totals; synthetic_only: true; clinical_use: false
}
type MealsResponse = { items: Meal[]; profile_id: number; day: string; synthetic_only: true; clinical_use: false }
type PendingAttempt = { profileId: number; recipeId: number; portion: string; consumedAt: string; day: string }

function isTotals(value: unknown): value is Totals {
  if (!value || typeof value !== 'object') return false
  return nutrients.every(([key]) => {
    const item = (value as Record<string, unknown>)[key]
      if (!item || typeof item !== 'object') return false
      const total = item as Record<string, unknown>
      return (total.value === null || (typeof total.value === 'string'
        && /^[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(total.value)
        && Number.isFinite(Number(total.value)) && Number(total.value) >= 0))
        && typeof total.complete === 'boolean' && (total.value !== null || !total.complete)
  })
}

function isMeal(value: unknown): value is Meal {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return Number.isInteger(item.id) && Number(item.id) > 0
    && Number.isInteger(item.profile_id) && Number.isInteger(item.recipe_id)
    && typeof item.recipe_name === 'string' && typeof item.consumed_at_utc === 'string'
    && typeof item.local_date === 'string' && typeof item.portion === 'string'
    && Array.isArray(item.ingredients) && Array.isArray(item.goals)
    && (item.adjustment === null || (typeof item.adjustment === 'object' && item.adjustment !== null))
    && item.synthetic_only === true && item.clinical_use === false
    && isTotals(item.totals)
}

function isSaveAcknowledgement(value: unknown, profileId: number, recipeId: number): boolean {
  if (!value || typeof value !== 'object') return false
  const ack = value as Record<string, unknown>
  return Number.isInteger(ack.id) && Number(ack.id) > 0 && ack.profile_id === profileId
    && ack.recipe_id === recipeId && ack.saved === true && ack.synthetic_only === true && ack.clinical_use === false
}

function isPendingAttempt(value: unknown): value is PendingAttempt {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return Number.isInteger(item.profileId) && Number.isInteger(item.recipeId)
    && typeof item.portion === 'string' && typeof item.consumedAt === 'string' && typeof item.day === 'string'
}

function readPendingAttempt(): PendingAttempt | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(attemptStorageKey) ?? 'null')
    return isPendingAttempt(value) ? value : null
  } catch { return null }
}

function writePendingAttempt(attempt: PendingAttempt | null) {
  try {
    if (attempt) sessionStorage.setItem(attemptStorageKey, JSON.stringify(attempt))
    else sessionStorage.removeItem(attemptStorageKey)
    return true
  } catch { return false }
}

function dateTimeNow() {
  return Temporal.Now.zonedDateTimeISO(zone).toPlainDateTime().toString({ smallestUnit: 'minute' })
}

function initialAttemptDateTime() {
  try {
    const attempt = readPendingAttempt()
    return attempt ? Temporal.Instant.from(attempt.consumedAt).toZonedDateTimeISO(zone).toPlainDateTime().toString({ smallestUnit: 'minute' }) : dateTimeNow()
  } catch { return dateTimeNow() }
}

function initialDay() {
  try { return Temporal.PlainDate.from(readPendingAttempt()?.day ?? Temporal.Now.zonedDateTimeISO(zone).toPlainDate().toString()).toString() }
  catch { return Temporal.Now.zonedDateTimeISO(zone).toPlainDate().toString() }
}

function formatInstant(value: string) {
  return Temporal.Instant.from(value).toZonedDateTimeISO(zone).toLocaleString('th-TH', {
    dateStyle: 'medium', timeStyle: 'short',
  })
}

function normalizeDecimal(value: string) {
  const [whole, fraction = ''] = value.split('.')
  return `${whole}.${fraction}`.replace(/\.0*$/, '').replace(/(\.\d*?)0+$/, '$1')
}

function matchesAttempt(meal: Meal, attempt: PendingAttempt) {
  try {
    return meal.profile_id === attempt.profileId && meal.recipe_id === attempt.recipeId
      && normalizeDecimal(meal.portion) === normalizeDecimal(attempt.portion)
      && Temporal.Instant.compare(Temporal.Instant.from(meal.consumed_at_utc), Temporal.Instant.from(attempt.consumedAt)) === 0
  } catch { return false }
}

function adjustmentMessage(adjustment: Meal['adjustment']) {
  if (!adjustment) return ''
  if (adjustment.action === 'void') return 'ยกเลิกรายการนี้แล้ว · ไม่รวมในยอดรวม'
  if (adjustment.action === 'correct' && Number.isInteger(adjustment.replacement_entry_id))
    return `รายการนี้ถูกแทนที่ด้วย #${adjustment.replacement_entry_id} · ไม่รวมในยอดรวม`
  return 'รายการนี้มีสถานะปรับปรุง · ไม่รวมในยอดรวม · รายละเอียดไม่พร้อมแสดง'
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url)
  const payload: unknown = await response.json()
  if (!response.ok) throw new Error('โหลดข้อมูลไม่ได้')
  return payload as T
}

function TotalsList({ totals }: { totals: Totals }) {
  return <ul className="meal-totals">{nutrients.map(([key, label, unit]) => {
    const total = totals[key]
    return <li key={key}><span>{label}</span><strong>{total.value === null ? 'ไม่ทราบ' : `${total.value} ${unit}`}</strong>
      <small>{total.complete ? 'ข้อมูลครบ' : 'ข้อมูลไม่ครบ · บางรายการยังไม่ทราบ'}</small></li>
  })}</ul>
}

export function MealTracking({ profileId, active = true }: { profileId: number | null; active?: boolean }) {
  const [recipes, setRecipes] = useState<Recipe[]>([])
  const [recipesBusy, setRecipesBusy] = useState(false)
  const [recipesError, setRecipesError] = useState('')
  const [day, setDay] = useState(initialDay)
  const [consumedAt, setConsumedAt] = useState(initialAttemptDateTime)
  const [recipeId, setRecipeId] = useState(() => String(readPendingAttempt()?.recipeId ?? ''))
  const [portion, setPortion] = useState(() => readPendingAttempt()?.portion ?? '1')
  const [meals, setMeals] = useState<Meal[]>([])
  const [daily, setDaily] = useState<Summary | null>(null)
  const [weekly, setWeekly] = useState<Summary | null>(null)
  const [loading, setLoading] = useState(false)
  const [pendingAttempt, setPendingAttempt] = useState<PendingAttempt | null>(readPendingAttempt)
  const [writeState, setWriteState] = useState<'idle' | 'saving' | 'confirmed' | 'uncertain'>(() => readPendingAttempt() ? 'uncertain' : 'idle')
  const [historyLoadedForAttempt, setHistoryLoadedForAttempt] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const requestRevision = useRef(0)
  const recipeRevision = useRef(0)
  const activeScope = useRef({ profileId, day })
  activeScope.current = { profileId, day }
  const loadedScope = useRef(`${profileId ?? ''}:${day}`)
  const consumedAtEdited = useRef(Boolean(readPendingAttempt()))
  const wasActive = useRef(false)
  const validPortion = /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(portion)
    && Number.isFinite(Number(portion)) && Number(portion) > 0 && Number(portion) <= 1

  async function loadRecipes() {
    const revision = ++recipeRevision.current
    setRecipesBusy(true)
    try {
      const result = await getJson<{ items: unknown }>('/experimental/recipes')
      if (!Array.isArray(result.items)) throw new Error('invalid recipe list')
      const items = result.items.filter((item): item is Recipe => !!item && typeof item === 'object'
        && Number.isInteger((item as Recipe).id) && Number((item as Recipe).id) > 0
        && typeof (item as Recipe).name === 'string')
      if (revision !== recipeRevision.current) return
      setRecipes(items); setRecipesError('')
    } catch { if (revision === recipeRevision.current) setRecipesError('โหลดสูตรที่บันทึกไว้ไม่ได้ · ตรวจว่า API ทดลองทำงานอยู่ แล้วโหลดใหม่') }
    finally { if (revision === recipeRevision.current) setRecipesBusy(false) }
  }

  useEffect(() => { if (active) void loadRecipes() }, [active])

  useEffect(() => {
    if (active && !wasActive.current && !consumedAtEdited.current) setConsumedAt(dateTimeNow())
    wasActive.current = active
  }, [active])

  useEffect(() => {
    const nextScope = `${profileId ?? ''}:${day}`
    if (loadedScope.current === nextScope) return
    loadedScope.current = nextScope
    setMeals([]); setDaily(null); setWeekly(null); setError(''); setStatus(''); setHistoryLoadedForAttempt(false)
  }, [profileId, day])

  async function refresh(writeConfirmed = writeState === 'confirmed') {
    if (!profileId) return
    let parsedDay: string
    try { parsedDay = Temporal.PlainDate.from(day).toString() }
    catch { setError('เลือกวันที่ให้ถูกต้อง'); return }
    const revision = ++requestRevision.current
    setLoading(true); setError('')
    try {
      const [list, today, week] = await Promise.all([
        getJson<MealsResponse>(`/experimental/profiles/${profileId}/meals?day=${parsedDay}&limit=100`),
        getJson<Summary>(`/experimental/profiles/${profileId}/meals/daily?day=${parsedDay}`),
        getJson<Summary>(`/experimental/profiles/${profileId}/meals/weekly?day=${parsedDay}`),
      ])
      if (revision !== requestRevision.current) return
      if (list.profile_id !== profileId || list.day !== parsedDay || list.synthetic_only !== true
          || list.clinical_use !== false || !Array.isArray(list.items)
          || !list.items.every(meal => isMeal(meal) && meal.profile_id === profileId && meal.local_date === parsedDay)
          || today.profile_id !== profileId || today.synthetic_only !== true || today.clinical_use !== false
          || !Number.isInteger(today.entry_count) || !isTotals(today.totals)
          || week.profile_id !== profileId || week.synthetic_only !== true || week.clinical_use !== false
          || !Number.isInteger(week.entry_count) || !isTotals(week.totals)) throw new Error('invalid meal response')
      setMeals(list.items); setDaily(today); setWeekly(week)
      if (pendingAttempt && pendingAttempt.profileId === profileId && pendingAttempt.day === parsedDay) {
        setHistoryLoadedForAttempt(true)
      }
    } catch {
      if (revision === requestRevision.current) setError(writeConfirmed
        ? 'บันทึกยืนยันแล้ว แต่โหลดประวัติหรือยอดรวมไม่ได้ · กดโหลดประวัติใหม่เพื่อตรวจ snapshot'
        : 'โหลดประวัติหรือยอดรวมไม่ได้ · ลองโหลดใหม่')
    } finally { if (revision === requestRevision.current) setLoading(false) }
  }

  useEffect(() => {
    if (active) void refresh()
    return () => { requestRevision.current++ }
  }, [profileId, day, active])

  async function recordMeal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!profileId || !recipeId || !validPortion || writeState === 'saving' || pendingAttempt) return
    let timestamp: string
    let localDate: string
    try {
      const local = Temporal.PlainDateTime.from(consumedAt)
      timestamp = local.toZonedDateTime(zone).toString({ timeZoneName: 'never' })
      localDate = local.toPlainDate().toString()
    } catch { setError('เลือกวันและเวลาที่รับประทานให้ถูกต้อง'); return }
    const attempt: PendingAttempt = { profileId, recipeId: Number(recipeId), portion, consumedAt: timestamp, day: localDate }
    const submittedScope = activeScope.current
    if (!writePendingAttempt(attempt)) {
      setError('เริ่มบันทึกไม่ได้ · พื้นที่เก็บสถานะค้างไม่พร้อม · เปิด sessionStorage ก่อนเพื่อป้องกันการส่งซ้ำหลังโหลดหน้าใหม่')
      return
    }
    setError(''); setStatus(''); setWriteState('saving')
    setPendingAttempt(attempt); setHistoryLoadedForAttempt(false)
    try {
      const response = await fetch(`/experimental/profiles/${profileId}/meals`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ synthetic_only: true, recipe_id: attempt.recipeId, consumed_at: timestamp, portion }),
      })
      const payload: unknown = await response.json()
      if (!response.ok) {
        writePendingAttempt(null); setPendingAttempt(null); setWriteState('idle')
        setError(response.status >= 500
          ? 'เซิร์ฟเวอร์ไม่ยืนยันผล · อาจบันทึกแล้ว · ห้ามกดซ้ำ · โหลดประวัติเพื่อตรวจสอบ'
          : 'ระบบปฏิเสธรายการ · ยังไม่บันทึก · ตรวจสูตรและข้อมูล แล้วลองใหม่')
        if (response.status >= 500) { setPendingAttempt(attempt); writePendingAttempt(attempt); setWriteState('uncertain') }
        return
      }
      if (!isSaveAcknowledgement(payload, profileId, attempt.recipeId)) {
        setWriteState('uncertain')
        setError('ผลตอบกลับไม่ครบ · อาจบันทึกแล้ว · ห้ามกดซ้ำ · โหลดประวัติเพื่อตรวจสอบ')
        return
      }
      writePendingAttempt(null); setPendingAttempt(null); setWriteState('confirmed')
      if (activeScope.current.profileId === submittedScope.profileId && activeScope.current.day === submittedScope.day) {
        setStatus(`บันทึกมื้อที่รับประทานแล้วในโปรไฟล์ #${profileId} · รายการเก็บ snapshot ณ เวลาบันทึก`)
        setRecipeId(''); setPortion('1'); setConsumedAt(dateTimeNow()); consumedAtEdited.current = false
        if (submittedScope.day === localDate) await refresh(true)
        else setDay(localDate)
      } else {
        setStatus(`บันทึกสำเร็จในโปรไฟล์ #${profileId} · วันที่ ${localDate} · ประวัติที่กำลังดูไม่เปลี่ยน`)
      }
    } catch {
      setWriteState('uncertain')
      setError('ไม่ทราบว่าบันทึกสำเร็จหรือไม่ · ห้ามส่งซ้ำ · โหลดประวัติเพื่อตรวจสอบ')
    }
  }

  function checkPending() {
    if (!pendingAttempt || profileId !== pendingAttempt.profileId) return
    setError(''); setStatus('เปิดประวัติวันที่ของรายการค้างไว้ให้ตรวจเอง · ระบบจะไม่ยืนยันหรือส่งซ้ำให้อัตโนมัติ')
    if (day === pendingAttempt.day) void refresh()
    else setDay(pendingAttempt.day)
  }

  function releasePendingAfterReview() {
    if (!pendingAttempt || !historyLoadedForAttempt || profileId !== pendingAttempt.profileId || day !== pendingAttempt.day) return
    writePendingAttempt(null); setPendingAttempt(null); setHistoryLoadedForAttempt(false); setWriteState('idle')
    setStatus('ปลดล็อกตามที่คุณเลือก · ระบบพิสูจน์ไม่ได้ว่า request เดิมบันทึกแล้วหรือไม่ · บันทึกสูตรและเวลาเดิมอีกครั้งอาจสร้างรายการซ้ำ · แบบร่างยังอยู่')
  }

  return <section className="meal-page" aria-labelledby="meals-title">
    <div className="page-intro"><h1 id="meals-title">บันทึกอาหาร</h1>
      <p>เลือกสูตรที่รับประทานจริง แล้วกดยืนยันเพื่อบันทึก · ใช้ข้อมูลสมมติเท่านั้น</p></div>
    <aside className="notice" role="note"><span className="notice-mark" aria-hidden="true">!</span><div>
      <h2>บันทึกการรับประทาน ไม่ใช่ประวัติเปิดเมนู</h2>
      <p>การเปิดสูตรล่าสุดไม่บันทึกว่ารับประทาน · หน้านี้เพิ่มรายการเฉพาะเมื่อกดยืนยัน · เป้าหมายและค่าที่ไม่ทราบไม่ถูกเติมเอง</p>
    </div></aside>
    {!profileId ? <div className="meal-empty"><p>เลือกโปรไฟล์สมมติในหน้า “ผู้ป่วย” ก่อน เพื่อดูและบันทึกมื้ออาหาร</p><a className="submit-button meal-link" href="#patients">ไปเลือกโปรไฟล์</a></div> : <>
      <section className="meal-card" aria-labelledby="record-meal-title">
        <h2 id="record-meal-title">บันทึกมื้อที่รับประทานแล้ว</h2>
        <form onSubmit={event => void recordMeal(event)}>
          <label>สูตรอาหารที่รับประทาน <select required disabled={writeState === 'saving' || Boolean(pendingAttempt)} value={recipeId} onChange={event => setRecipeId(event.target.value)}>
            <option value="">เลือกสูตรที่บันทึกไว้</option>{recipes.map(recipe => <option key={recipe.id} value={recipe.id}>{recipe.name}</option>)}
          </select></label>
          <label>วันและเวลาที่รับประทาน <input required disabled={writeState === 'saving' || Boolean(pendingAttempt)} type="datetime-local" value={consumedAt} onChange={event => { setConsumedAt(event.target.value); consumedAtEdited.current = true }} />
            <span className="field-hint">ใช้เวลาไทย · {zone}</span></label>
          <label>สัดส่วนของสูตรที่รับประทาน <span className="meal-portion"><input required disabled={writeState === 'saving' || Boolean(pendingAttempt)} type="number" inputMode="decimal" min="0.00000001" max="1" step="any" value={portion} onChange={event => setPortion(event.target.value)} /><span>0.5 = ครึ่งสูตร · 1 = ทั้งสูตร</span></span></label>
          {!validPortion && <p className="error" role="alert">ใส่สัดส่วนมากกว่า 0 และไม่เกิน 1</p>}
          {pendingAttempt && <p className="error" role="alert">มีรายการที่ผลยังไม่ชัดเจน · ห้ามบันทึกซ้ำจนกว่าจะตรวจประวัติ{profileId !== pendingAttempt.profileId ? ` · กลับไปเลือกโปรไฟล์เดิม #${pendingAttempt.profileId}` : ''}</p>}
          <button className="submit-button" type="submit" disabled={!recipes.length || !recipeId || !validPortion || !profileId || writeState === 'saving' || Boolean(pendingAttempt)}>
            {writeState === 'saving' ? 'กำลังบันทึก…' : 'ยืนยันและบันทึกมื้ออาหาร'}
          </button>
          {pendingAttempt && profileId === pendingAttempt.profileId && <button className="add-button meal-refresh" type="button" onClick={checkPending}>เปิดประวัติวันที่ค้างไว้เพื่อตรวจเอง</button>}
        </form>
        <div className="meal-recipe-refresh"><button className="add-button" type="button" disabled={recipesBusy} onClick={() => void loadRecipes()}>{recipesBusy ? 'กำลังโหลดสูตร…' : 'โหลดสูตรที่บันทึกไว้อีกครั้ง'}</button></div>
        {recipesError && <p className="error" role="alert">{recipesError}</p>}
      </section>
      {status && <p className="success" role="status" aria-live="polite">{status}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <section className="meal-card" aria-labelledby="meal-history-title">
        <div className="meal-heading"><h2 id="meal-history-title">ประวัติวันที่เลือก</h2><button className="add-button" type="button" disabled={loading} onClick={() => void refresh()}>{loading ? 'กำลังโหลด…' : 'โหลดประวัติใหม่'}</button></div>
        <label>วันที่ในประเทศไทย <input type="date" value={day} onChange={event => setDay(event.target.value)} /></label>
        {meals.length === 0 ? <p className="meal-empty">{loading ? 'กำลังโหลดประวัติ…' : 'ยังไม่มีมื้อที่บันทึกในวันนี้'}</p> : <ol className="meal-history">{meals.map(meal => <li key={meal.id}>
          <h3>{meal.recipe_name}</h3><p>รายการ #{meal.id} · {formatInstant(meal.consumed_at_utc)} · {meal.portion} ของสูตร</p>
          {pendingAttempt && matchesAttempt(meal, pendingAttempt) && <p className="meal-match-note" role="note">ตรงกับสูตร เวลา และสัดส่วนที่ส่งค้าง · อาจเป็นรายการเดิมที่มีอยู่ก่อนส่ง · ระบบยืนยันไม่ได้ว่า request ค้างนี้เป็นผู้สร้าง</p>}
          {meal.adjustment && <p className="meal-adjustment" role="note">{adjustmentMessage(meal.adjustment)}</p>}
          <details><summary>ดูสารอาหารจาก snapshot</summary><TotalsList totals={meal.totals} /><p className="footnote">ค่าที่ไม่ทราบแสดงเป็น “ไม่ทราบ” · คำนวณจากสูตรที่บันทึกไว้ ณ เวลารับประทาน</p></details>
        </li>)}</ol>}
        {pendingAttempt && profileId === pendingAttempt.profileId && day === pendingAttempt.day && historyLoadedForAttempt && <section className="meal-recovery" aria-label="จัดการผลบันทึกที่ไม่ชัดเจน">
          <h3>ผลบันทึกยังไม่ชัดเจน</h3>
          <p>ตรวจรายการด้านบนด้วยตนเอง · แสดงได้สูงสุด 100 รายการ · การพบรายการตรงกันไม่พิสูจน์ว่าเป็น request นี้ และการไม่พบก็ไม่พิสูจน์ว่าไม่ได้บันทึก</p>
          <button className="add-button" type="button" onClick={() => setStatus('ยังคงล็อกไว้ · ระบบจะไม่ส่งรายการซ้ำ')}>คงล็อกไว้</button>
          <button className="meal-risk-button" type="button" onClick={releasePendingAfterReview}>ฉันตรวจประวัติแล้ว · ปลดล็อกและยอมรับความเสี่ยงรายการซ้ำ</button>
        </section>}
      </section>
      <section className="meal-card" aria-labelledby="daily-summary-title"><h2 id="daily-summary-title">รวมของวัน</h2>
        {daily ? <><p>{daily.entry_count} มื้อ · {daily.start_date}</p><TotalsList totals={daily.totals} /></> : <p>ยังโหลดสรุปไม่ได้</p>}
      </section>
      <section className="meal-card" aria-labelledby="weekly-summary-title"><h2 id="weekly-summary-title">รวมทั้งสัปดาห์ (จันทร์–อาทิตย์)</h2>
        {weekly ? <><p>{weekly.entry_count} มื้อ · {weekly.start_date} ถึง {weekly.end_date}</p><TotalsList totals={weekly.totals} /></> : <p>ยังโหลดสรุปไม่ได้</p>}
      </section>
    </>}
  </section>
}
