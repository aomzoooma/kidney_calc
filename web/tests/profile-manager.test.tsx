import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
  expect(fetchMock.mock.calls.some(([url]) => url === '/experimental/profiles/7')).toBe(true)

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
