import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { App } from '../src/main'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  window.history.replaceState(null, '', '/')
})

it('saves only user-entered clinician goals and reloads the saved profile', async () => {
  let profile: {
    id: number; name: string; dry_weights: Array<{ measured_on: string; kilograms: number }>
    goals: Array<{ nutrient: string; amount: number; unit: string; effective_on: string }>
  } | null = null
  const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/experimental/profiles' && options?.method === 'POST') {
      profile = { id: 7, name: JSON.parse(String(options.body)).name, dry_weights: [], goals: [] }
      return { ok: true, json: async () => ({ id: profile!.id, name: profile!.name }) }
    }
    if (url === '/experimental/profiles')
      return { ok: true, json: async () => ({ items: profile ? [{ id: profile.id, name: profile.name }] : [] }) }
    if (url.endsWith('/goals') && options?.method === 'POST') {
      const body = JSON.parse(String(options.body))
      profile!.goals.push({ nutrient: body.nutrient, amount: Number(body.amount), unit: body.unit, effective_on: body.effective_on })
      return { ok: true, json: async () => ({ ...profile }) }
    }
    if (url.endsWith('/dry-weights') && options?.method === 'POST') {
      const body = JSON.parse(String(options.body))
      profile!.dry_weights.push({ measured_on: body.measured_on, kilograms: Number(body.kilograms) })
      return { ok: true, json: async () => ({ ...profile }) }
    }
    return { ok: true, json: async () => ({ ...profile }) }
  })
  vi.stubGlobal('fetch', fetchMock)
  render(<App />)
  fireEvent.click(screen.getByRole('link', { name: 'ผู้ป่วย' }))
  expect(await screen.findByText(/ยังไม่มีโปรไฟล์สมมติ/)).toBeTruthy()

  fireEvent.change(screen.getByLabelText('ชื่อเรียกข้อมูลสมมติ'), { target: { value: 'ข้อมูลตัวอย่าง' } })
  fireEvent.click(screen.getByRole('button', { name: 'สร้างโปรไฟล์สมมติ' }))
  await screen.findByRole('heading', { name: 'เป้าหมายจากบุคลากรทางการแพทย์' })
  expect(screen.getByText(/ระบบไม่เติมค่าแทน/)).toBeTruthy()
  fireEvent.change(screen.getByLabelText('สารอาหารตามเอกสารที่ได้รับ'), { target: { value: 'โซเดียม' } })
  fireEvent.change(screen.getByLabelText('ค่าเป้าหมาย'), { target: { value: '1800' } })
  fireEvent.change(screen.getByLabelText('หน่วยตามเอกสาร'), { target: { value: 'มก./วัน' } })
  fireEvent.change(screen.getByLabelText('วันที่เริ่มใช้'), { target: { value: '2026-11-01' } })
  fireEvent.click(screen.getByRole('button', { name: 'บันทึกเป้าหมายที่ได้รับ' }))
  expect(await screen.findByText('โซเดียม: 1800 มก./วัน')).toBeTruthy()

  const saveGoal = fetchMock.mock.calls.find(([url, options]) => String(url).endsWith('/goals') && options?.method === 'POST')
  expect(JSON.parse(String(saveGoal?.[1]?.body))).toMatchObject({
    synthetic_only: true, clinician_set: true, nutrient: 'โซเดียม', amount: '1800', unit: 'มก./วัน',
  })
  expect(fetchMock.mock.calls.some(([url, options]) => url === '/experimental/profiles' && options?.method === 'POST')).toBe(true)

  fireEvent.change(screen.getByLabelText('น้ำหนักแห้ง (กก.)'), { target: { value: '62.5' } })
  fireEvent.change(screen.getByLabelText('วันที่วัด'), { target: { value: '2026-11-02' } })
  fireEvent.click(screen.getByRole('button', { name: 'บันทึกน้ำหนักแห้ง' }))
  expect(await screen.findByText('62.5 กก.')).toBeTruthy()
  const saveWeight = fetchMock.mock.calls.find(([url, options]) => String(url).endsWith('/dry-weights') && options?.method === 'POST')
  expect(JSON.parse(String(saveWeight?.[1]?.body))).toMatchObject({
    synthetic_only: true, measured_on: '2026-11-02', kilograms: '62.5',
  })

  fireEvent.click(screen.getByRole('link', { name: 'หน้าหลัก' }))
  fireEvent.click(screen.getByRole('link', { name: 'ผู้ป่วย' }))
  expect(await screen.findByText('โซเดียม: 1800 มก./วัน')).toBeTruthy()
  expect(screen.getByText('62.5 กก.')).toBeTruthy()
})

it('ignores an older profile read after a newer selection finishes', async () => {
  const profile = (id: number, name: string) => ({ id, name, dry_weights: [], goals: [] })
  let releaseSecond!: (response: { ok: boolean; json: () => Promise<object> }) => void
  const secondRead = new Promise<{ ok: boolean; json: () => Promise<object> }>(resolve => { releaseSecond = resolve })
  const fetchMock = vi.fn((url: string) => {
    if (url === '/experimental/profiles') return Promise.resolve({ ok: true, json: async () => ({ items: [profile(1, 'ตัวอย่าง 1'), profile(2, 'ตัวอย่าง 2')] }) })
    if (url === '/experimental/profiles/2') return secondRead
    if (url === '/experimental/profiles/1') return Promise.resolve({ ok: true, json: async () => profile(1, 'ตัวอย่าง 1') })
    throw new Error(`Unexpected request: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  render(<App />)
  fireEvent.click(screen.getByRole('link', { name: 'ผู้ป่วย' }))
  const selector = await screen.findByLabelText('เลือกโปรไฟล์') as HTMLSelectElement
  await screen.findByText('น้ำหนักแห้ง (กก.)')
  expect(selector.value).toBe('1')
  fireEvent.change(selector, { target: { value: '2' } })
  await waitFor(() => expect(selector.disabled).toBe(true))
  fireEvent.change(selector, { target: { value: '1' } })
  await screen.findByText('น้ำหนักแห้ง (กก.)')
  await act(async () => { releaseSecond({ ok: true, json: async () => profile(2, 'ตัวอย่าง 2') }); await secondRead })
  expect(selector.value).toBe('1')
})

it('locks profile switching while a write is pending and keeps the saved profile selected', async () => {
  const first = { id: 1, name: 'ตัวอย่าง 1', dry_weights: [], goals: [] }
  const second = { id: 2, name: 'ตัวอย่าง 2', dry_weights: [], goals: [] }
  let releaseWrite!: (response: { ok: boolean; json: () => Promise<object> }) => void
  const pendingWrite = new Promise<{ ok: boolean; json: () => Promise<object> }>(resolve => { releaseWrite = resolve })
  const fetchMock = vi.fn((url: string, options?: RequestInit) => {
    if (url === '/experimental/profiles') return Promise.resolve({ ok: true, json: async () => ({ items: [first, second] }) })
    if (url === '/experimental/profiles/1') return Promise.resolve({ ok: true, json: async () => first })
    if (url === '/experimental/profiles/2') return Promise.resolve({ ok: true, json: async () => second })
    if (url.endsWith('/dry-weights') && options?.method === 'POST') return pendingWrite
    throw new Error(`Unexpected request: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  render(<App />)
  fireEvent.click(screen.getByRole('link', { name: 'ผู้ป่วย' }))
  const selector = await screen.findByLabelText('เลือกโปรไฟล์') as HTMLSelectElement
  fireEvent.change(screen.getByLabelText('น้ำหนักแห้ง (กก.)'), { target: { value: '62.5' } })
  fireEvent.change(screen.getByLabelText('วันที่วัด'), { target: { value: '2026-11-02' } })
  fireEvent.click(screen.getByRole('button', { name: 'บันทึกน้ำหนักแห้ง' }))
  expect(await screen.findByText('กำลังบันทึกข้อมูล…')).toBeTruthy()
  await waitFor(() => expect(selector.disabled).toBe(true))
  fireEvent.change(selector, { target: { value: '2' } })
  await waitFor(() => expect(selector.value).toBe('2'))
  await act(async () => { releaseWrite({ ok: true, json: async () => ({ saved: true }) }); await pendingWrite })
  expect(await screen.findByText('บันทึกน้ำหนักแล้ว')).toBeTruthy()
  expect(selector.value).toBe('2')
  expect(screen.queryByText('62.5 กก.')).toBeNull()
})

it('clears unsaved goal, weight and date drafts when switching profiles', async () => {
  const profile = (id: number, name: string) => ({ id, name, dry_weights: [], goals: [] })
  const fetchMock = vi.fn(async (url: string) => {
    if (url === '/experimental/profiles') return { ok: true, json: async () => ({ items: [profile(1, 'ตัวอย่าง A'), profile(2, 'ตัวอย่าง B')] }) }
    if (url === '/experimental/profiles/1') return { ok: true, json: async () => profile(1, 'ตัวอย่าง A') }
    if (url === '/experimental/profiles/2') return { ok: true, json: async () => profile(2, 'ตัวอย่าง B') }
    throw new Error(`Unexpected request: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  render(<App />)
  fireEvent.click(screen.getByRole('link', { name: 'ผู้ป่วย' }))
  const selector = await screen.findByLabelText('เลือกโปรไฟล์') as HTMLSelectElement
  await screen.findByLabelText('น้ำหนักแห้ง (กก.)')
  fireEvent.change(screen.getByLabelText('สารอาหารตามเอกสารที่ได้รับ'), { target: { value: 'โซเดียม' } })
  fireEvent.change(screen.getByLabelText('ค่าเป้าหมาย'), { target: { value: '1800' } })
  fireEvent.change(screen.getByLabelText('หน่วยตามเอกสาร'), { target: { value: 'มก./วัน' } })
  fireEvent.change(screen.getByLabelText('วันที่เริ่มใช้'), { target: { value: '2026-11-01' } })
  fireEvent.change(screen.getByLabelText('น้ำหนักแห้ง (กก.)'), { target: { value: '62.5' } })
  fireEvent.change(screen.getByLabelText('วันที่วัด'), { target: { value: '2026-11-02' } })

  fireEvent.change(selector, { target: { value: '2' } })
  await screen.findByLabelText('น้ำหนักแห้ง (กก.)')
  expect(selector.value).toBe('2')
  for (const label of ['สารอาหารตามเอกสารที่ได้รับ', 'ค่าเป้าหมาย', 'หน่วยตามเอกสาร', 'วันที่เริ่มใช้', 'น้ำหนักแห้ง (กก.)', 'วันที่วัด'])
    expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe('')
})
