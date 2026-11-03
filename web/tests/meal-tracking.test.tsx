import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Temporal } from '@js-temporal/polyfill'
import { MealTracking } from '../src/MealTracking'

const totals = {
  energy_kcal: { value: '210', complete: true },
  protein_g: { value: '12', complete: true },
  sodium_mg: { value: null, complete: false },
  potassium_mg: { value: '88', complete: true },
  phosphorus_mg: { value: null, complete: false },
}
const summary = { profile_id: 4, start_date: '2026-11-03', end_date: '2026-11-03', entry_count: 0, totals, synthetic_only: true, clinical_use: false }
const meal = {
  id: 19, profile_id: 4, recipe_id: 8, recipe_name: 'ข้าวต้มสมมติ',
  consumed_at_utc: '2026-11-03T05:00:00Z', local_date: '2026-11-03', portion: '0.5',
  ingredients: [], goals: [], totals, adjustment: null, synthetic_only: true, clinical_use: false,
}

afterEach(() => {
  cleanup()
  sessionStorage.clear()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('records only after explicit confirmation and reloads immutable history with unknown values intact', async () => {
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  let history: typeof meal[] = []
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
    if (url === '/experimental/recipes') return { ok: true, json: async () => ({ items: [{ id: 8, name: 'ข้าวต้มสมมติ' }] }) }
    if (url === '/experimental/profiles/4/meals' && options?.method === 'POST') {
      history = [meal]
      return { ok: true, json: async () => ({ id: meal.id, profile_id: 4, recipe_id: 8, saved: true, synthetic_only: true, clinical_use: false }) }
    }
    if (url.startsWith('/experimental/profiles/4/meals?day=')) return { ok: true, json: async () => ({ items: history, profile_id: 4, day: '2026-11-03', synthetic_only: true, clinical_use: false }) }
    if (url.includes('/meals/daily?')) return { ok: true, json: async () => summary }
    if (url.includes('/meals/weekly?')) return { ok: true, json: async () => ({ ...summary, start_date: '2026-10-28', end_date: '2026-11-03' }) }
    throw new Error(`Unexpected request ${url}`)
  })
  render(<MealTracking profileId={4} />)
  await screen.findByRole('option', { name: 'ข้าวต้มสมมติ' })
  fireEvent.change(screen.getByLabelText('วันที่ในประเทศไทย'), { target: { value: '2026-11-03' } })
  fireEvent.change(screen.getByLabelText('สูตรอาหารที่รับประทาน'), { target: { value: '8' } })
  fireEvent.change(screen.getByLabelText(/วันและเวลาที่รับประทาน/), { target: { value: '2026-11-03T12:00' } })
  fireEvent.change(screen.getByLabelText(/สัดส่วนของสูตรที่รับประทาน/), { target: { value: '0.5' } })
  fireEvent.click(screen.getByRole('button', { name: 'ยืนยันและบันทึกมื้ออาหาร' }))

  await screen.findByText(/บันทึกมื้อที่รับประทานแล้วในโปรไฟล์/)
  await screen.findByRole('heading', { name: 'ข้าวต้มสมมติ' })
  expect(JSON.parse(String(fetchMock.mock.calls.find(([url, options]) => url.endsWith('/meals') && options?.method === 'POST')?.[1]?.body))).toEqual({
    synthetic_only: true, recipe_id: 8, consumed_at: '2026-11-03T12:00:00+07:00', portion: '0.5',
  })
  expect(screen.getAllByText('ไม่ทราบ').length).toBeGreaterThan(0)
  expect(screen.getAllByText(/ข้อมูลไม่ครบ/).length).toBeGreaterThan(0)
})

it('locks writes after an uncertain network failure, including after page reload', async () => {
  const fetchMock = vi.fn()
  let history: typeof meal[] = []
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
    if (url === '/experimental/recipes') return { ok: true, json: async () => ({ items: [{ id: 8, name: 'ข้าวต้มสมมติ' }] }) }
    if (url === '/experimental/profiles/4/meals' && options?.method === 'POST') throw new TypeError('network lost')
    if (url.startsWith('/experimental/profiles/4/meals?day=')) return { ok: true, json: async () => ({ items: history, profile_id: 4, day: new URL(`http://local${url}`).searchParams.get('day'), synthetic_only: true, clinical_use: false }) }
    if (url.includes('/meals/daily?')) return { ok: true, json: async () => summary }
    if (url.includes('/meals/weekly?')) return { ok: true, json: async () => ({ ...summary, start_date: '2026-10-28', end_date: '2026-11-03' }) }
    throw new Error(`Unexpected request ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  const first = render(<MealTracking profileId={4} />)
  await screen.findByRole('option', { name: 'ข้าวต้มสมมติ' })
  fireEvent.change(screen.getByLabelText('วันที่ในประเทศไทย'), { target: { value: '2026-11-03' } })
  fireEvent.change(screen.getByLabelText('สูตรอาหารที่รับประทาน'), { target: { value: '8' } })
  fireEvent.change(screen.getByLabelText(/วันและเวลาที่รับประทาน/), { target: { value: '2026-11-03T12:00' } })
  fireEvent.change(screen.getByLabelText(/สัดส่วนของสูตรที่รับประทาน/), { target: { value: '0.5' } })
  fireEvent.click(screen.getByRole('button', { name: 'ยืนยันและบันทึกมื้ออาหาร' }))
  expect(await screen.findByText(/ห้ามส่งซ้ำ/)).toBeTruthy()
  expect(screen.getByRole('button', { name: 'ยืนยันและบันทึกมื้ออาหาร' }).hasAttribute('disabled')).toBe(true)
  first.unmount()
  render(<MealTracking profileId={4} />)
  expect(await screen.findByRole('button', { name: 'เปิดประวัติวันที่ค้างไว้เพื่อตรวจเอง' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'ยืนยันและบันทึกมื้ออาหาร' }).hasAttribute('disabled')).toBe(true)
  history = [meal]
  fireEvent.click(screen.getByRole('button', { name: 'เปิดประวัติวันที่ค้างไว้เพื่อตรวจเอง' }))
  expect(await screen.findByRole('region', { name: 'จัดการผลบันทึกที่ไม่ชัดเจน' })).toBeTruthy()
  expect(screen.getByText(/ระบบยืนยันไม่ได้ว่า request ค้างนี้เป็นผู้สร้าง/)).toBeTruthy()
  expect(screen.getByRole('button', { name: 'ยืนยันและบันทึกมื้ออาหาร' }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: /ฉันตรวจประวัติแล้ว/ }))
  expect(await screen.findByText(/ระบบพิสูจน์ไม่ได้ว่า request เดิมบันทึกแล้วหรือไม่/)).toBeTruthy()
  await waitFor(() => expect(screen.getByRole('button', { name: 'ยืนยันและบันทึกมื้ออาหาร' }).hasAttribute('disabled')).toBe(false))
  expect(screen.getByLabelText(/สัดส่วนของสูตรที่รับประทาน/)).toHaveProperty('value', '0.5')
  expect(fetchMock.mock.calls.filter(([url, options]) => url.endsWith('/meals') && options?.method === 'POST')).toHaveLength(1)
})

it('shows profile-selection guidance without issuing profile meal requests', () => {
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ items: [] }) }))
  vi.stubGlobal('fetch', fetchMock)
  render(<MealTracking profileId={null} />)
  expect(screen.getByRole('link', { name: 'ไปเลือกโปรไฟล์' })).toBeTruthy()
  expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/profiles/null/meals'))).toBe(false)
})

it('does not start a non-idempotent write when its recovery marker cannot be stored', async () => {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === '/experimental/recipes') return { ok: true, json: async () => ({ items: [{ id: 8, name: 'ข้าวต้มสมมติ' }] }) }
    throw new Error(`Unexpected request ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage disabled') })
  render(<MealTracking profileId={4} />)
  await screen.findByRole('option', { name: 'ข้าวต้มสมมติ' })
  fireEvent.change(screen.getByLabelText('สูตรอาหารที่รับประทาน'), { target: { value: '8' } })
  fireEvent.click(screen.getByRole('button', { name: 'ยืนยันและบันทึกมื้ออาหาร' }))
  expect(await screen.findByText(/เริ่มบันทึกไม่ได้/)).toBeTruthy()
  expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false)
})

it('labels voided snapshots and leaves active counts to the API totals', async () => {
  const voidedMeal = { ...meal, adjustment: { action: 'void', replacement_entry_id: null, reason: 'duplicate', recorded_at: '2026-11-03T05:10:00+00:00' } }
  const fetchMock = vi.fn(async (url: string) => {
    if (url === '/experimental/recipes') return { ok: true, json: async () => ({ items: [] }) }
    if (url.startsWith('/experimental/profiles/4/meals?day=')) return { ok: true, json: async () => ({ items: [voidedMeal], profile_id: 4, day: new URL(`http://local${url}`).searchParams.get('day'), synthetic_only: true, clinical_use: false }) }
    if (url.includes('/meals/daily?') || url.includes('/meals/weekly?')) return { ok: true, json: async () => ({ ...summary, entry_count: 0 }) }
    throw new Error(`Unexpected request ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  render(<MealTracking profileId={4} />)
  expect(await screen.findByText('ยกเลิกรายการนี้แล้ว · ไม่รวมในยอดรวม')).toBeTruthy()
  expect(screen.getAllByText(/0 มื้อ/).length).toBeGreaterThan(0)
})

it('refreshes pristine Bangkok time and saved recipes on re-entry, while preserving an edited time', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-03T05:00:00Z'))
  let recipeLoad = 0
  const fetchMock = vi.fn(async (url: string) => {
    if (url === '/experimental/recipes') return { ok: true, json: async () => ({ items: [{ id: 8, name: `สูตร ${++recipeLoad}` }] }) }
    if (url.startsWith('/experimental/profiles/4/meals?day=')) return { ok: true, json: async () => ({ items: [], profile_id: 4, day: '2026-11-03', synthetic_only: true, clinical_use: false }) }
    if (url.includes('/meals/daily?') || url.includes('/meals/weekly?')) return { ok: true, json: async () => summary }
    throw new Error(`Unexpected request ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  const view = render(<MealTracking profileId={4} active />)
  await act(async () => { await Promise.resolve() })
  const timeInput = screen.getByLabelText(/วันและเวลาที่รับประทาน/)
  expect(timeInput).toHaveProperty('value', '2026-11-03T12:00')
  expect(screen.getByRole('option', { name: 'สูตร 1' })).toBeTruthy()

  view.rerender(<MealTracking profileId={4} active={false} />)
  vi.setSystemTime(new Date('2026-11-03T06:15:00Z'))
  view.rerender(<MealTracking profileId={4} active />)
  await act(async () => { await Promise.resolve() })
  expect(screen.getByLabelText(/วันและเวลาที่รับประทาน/)).toHaveProperty('value', '2026-11-03T13:15')
  expect(screen.getByRole('option', { name: 'สูตร 2' })).toBeTruthy()

  fireEvent.change(screen.getByLabelText(/วันและเวลาที่รับประทาน/), { target: { value: '2026-11-04T09:30' } })
  view.rerender(<MealTracking profileId={4} active={false} />)
  vi.setSystemTime(new Date('2026-11-03T07:00:00Z'))
  view.rerender(<MealTracking profileId={4} active />)
  await act(async () => { await Promise.resolve() })
  expect(screen.getByLabelText(/วันและเวลาที่รับประทาน/)).toHaveProperty('value', '2026-11-04T09:30')
  expect(fetchMock.mock.calls.filter(([url]) => url === '/experimental/recipes')).toHaveLength(3)
})

it('clears previous-day history and totals immediately when the new day request fails', async () => {
  const today = Temporal.Now.zonedDateTimeISO('Asia/Bangkok').toPlainDate().toString()
  const tomorrow = Temporal.PlainDate.from(today).add({ days: 1 }).toString()
  const todayMeal = { ...meal, local_date: today }
  const fetchMock = vi.fn(async (url: string) => {
    if (url === '/experimental/recipes') return { ok: true, json: async () => ({ items: [] }) }
    if (url.includes(`/meals?day=${today}`)) return { ok: true, json: async () => ({ items: [todayMeal], profile_id: 4, day: today, synthetic_only: true, clinical_use: false }) }
    if (url.includes(`/meals?day=${tomorrow}`) || url.includes(`/meals/daily?day=${tomorrow}`) || url.includes(`/meals/weekly?day=${tomorrow}`))
      return { ok: false, json: async () => ({ detail: 'unavailable' }) }
    if (url.includes('/meals/daily?') || url.includes('/meals/weekly?')) return { ok: true, json: async () => summary }
    throw new Error(`Unexpected request ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  render(<MealTracking profileId={4} />)
  expect(await screen.findByRole('heading', { name: 'ข้าวต้มสมมติ' })).toBeTruthy()
  fireEvent.change(screen.getByLabelText('วันที่ในประเทศไทย'), { target: { value: tomorrow } })
  expect(screen.queryByRole('heading', { name: 'ข้าวต้มสมมติ' })).toBeNull()
  expect(await screen.findByRole('alert')).toBeTruthy()
  expect(screen.getByText('ยังไม่มีมื้อที่บันทึกในวันนี้')).toBeTruthy()
  expect(screen.getAllByText('ยังโหลดสรุปไม่ได้').length).toBe(2)
})

it('does not let late profile A acknowledgement overwrite profile B history', async () => {
  const today = Temporal.Now.zonedDateTimeISO('Asia/Bangkok').toPlainDate().toString()
  let finishPost!: (response: { ok: boolean; json: () => Promise<unknown> }) => void
  const profileBMeal = { ...meal, id: 55, profile_id: 5, recipe_name: 'โปรไฟล์ห้า', local_date: today }
  const fetchMock = vi.fn((url: string, options?: RequestInit) => {
    if (url === '/experimental/recipes') return Promise.resolve({ ok: true, json: async () => ({ items: [{ id: 8, name: 'ข้าวต้มสมมติ' }] }) })
    if (url.endsWith('/meals') && options?.method === 'POST') return new Promise(resolve => { finishPost = resolve })
    const match = url.match(/\/profiles\/(\d+)\/meals(?:\?|\/)/)
    if (match) {
      const id = Number(match[1])
      if (url.includes('/daily?') || url.includes('/weekly?')) return Promise.resolve({ ok: true, json: async () => ({ ...summary, profile_id: id }) })
      const requestedDay = new URL(`http://local${url}`).searchParams.get('day')
      return Promise.resolve({ ok: true, json: async () => ({ items: id === 5 ? [profileBMeal] : [], profile_id: id, day: requestedDay, synthetic_only: true, clinical_use: false }) })
    }
    throw new Error(`Unexpected request ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  const view = render(<MealTracking profileId={4} />)
  await screen.findByRole('option', { name: 'ข้าวต้มสมมติ' })
  fireEvent.change(screen.getByLabelText('สูตรอาหารที่รับประทาน'), { target: { value: '8' } })
  fireEvent.change(screen.getByLabelText(/วันและเวลาที่รับประทาน/), { target: { value: `${today}T12:00` } })
  fireEvent.click(screen.getByRole('button', { name: 'ยืนยันและบันทึกมื้ออาหาร' }))
  view.rerender(<MealTracking profileId={5} />)
  expect(await screen.findByRole('heading', { name: 'โปรไฟล์ห้า' })).toBeTruthy()
  await act(async () => finishPost({ ok: true, json: async () => ({ id: 19, profile_id: 4, recipe_id: 8, saved: true, synthetic_only: true, clinical_use: false }) }))
  expect(await screen.findByText(/บันทึกสำเร็จในโปรไฟล์ #4/)).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'โปรไฟล์ห้า' })).toBeTruthy()
  expect(screen.queryByRole('heading', { name: 'ข้าวต้มสมมติ' })).toBeNull()
})
