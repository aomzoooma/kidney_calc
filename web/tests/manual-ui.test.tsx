import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from '../src/main'

const response = {
  experimental: true,
  clinical_use: false,
  rounding: 'test',
  portion: '1',
  totals: {
    energy_kcal: { value: '777', complete: true },
    protein_g: { value: '777', complete: true },
    sodium_mg: { value: '777', complete: true },
    potassium_mg: { value: '777', complete: true },
    phosphorus_mg: { value: '777', complete: true },
  },
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  window.history.replaceState(null, '', '/')
})

const openRecipes = () => fireEvent.click(screen.getByRole('link', { name: 'สูตรอาหาร' }))

describe('manual recipe UI', () => {
  it('selects a saved seasoning version with its stored basis and measure', async () => {
    const fetchMock = vi.fn(async (url: string, options?: RequestInit) => url === '/experimental/seasonings'
      ? { ok: true, json: async () => ({ items: [{ version_id: 42, name: 'Test seasoning', brand: null,
          basis_quantity: '15', basis_unit: 'ml', reviewed: true,
          nutrients: { energy_kcal: null, protein_g: null, sodium_mg: '0', potassium_mg: null, phosphorus_mg: null } }] }) }
      : { ok: true, json: async () => response })
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    openRecipes()
    await screen.findByRole('option', { name: /Test seasoning/ })
    fireEvent.change(screen.getAllByLabelText(/เลือกเครื่องปรุงที่บันทึกไว้/)[0], { target: { value: '42' } })
    expect((screen.getAllByLabelText(/หน่วยปริมาณ/)[0] as HTMLSelectElement).value).toBe('ml')
    expect((screen.getAllByLabelText(/สภาพอาหาร/)[0] as HTMLSelectElement).value).toBe('as_sold')
    expect((screen.getAllByLabelText(/ข้อมูลสารอาหารต่อ/)[0] as HTMLInputElement).value).toBe('15')
    fireEvent.change(screen.getAllByLabelText(/ปริมาณที่ใช้/)[0], { target: { value: '30' } })
    fireEvent.click(screen.getByRole('checkbox', { name: /ยืนยันว่าข้อมูลทั้งหมด/ }))
    fireEvent.click(screen.getByRole('button', { name: 'คำนวณสารอาหาร' }))
    await screen.findByText('สารอาหารโดยประมาณ · 1 ส่วน')
    const calculation = fetchMock.mock.calls.find(([url]) => url === '/experimental/recipes/calculate')
    const body = JSON.parse(String(calculation?.[1]?.body))
    expect(body.ingredients[0].seasoning_version_id).toBe(42)
    expect(body.ingredients[0]).toMatchObject({ unit: 'ml', food_state: 'as_sold', reference_quantity: '15' })
    expect(body.ingredients[0].sodium_mg).toBe('0')
  })

  it('requires synthetic-only confirmation', () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ items: [] }) }))
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    openRecipes()
    expect(screen.getByRole('checkbox', { name: /ยืนยันว่าข้อมูลทั้งหมด/ }).required).toBe(true)
    expect(screen.getByText(/ตัวเลขสมมติเท่านั้น/)).toBeTruthy()
    expect(screen.getByText(/ห้ามใช้ค่าจากฉลากอาหารจริงหรือข้อมูลผู้ป่วย/)).toBeTruthy()
    fireEvent.change(screen.getAllByLabelText(/ปริมาณที่ใช้/)[0], { target: { value: '100' } })
    fireEvent.click(screen.getByRole('button', { name: 'คำนวณสารอาหาร' }))
    expect(fetchMock.mock.calls.some(([url]) => url === '/experimental/recipes/calculate')).toBe(false)
  })

  it.each([
    ['editing an ingredient', () => fireEvent.change(screen.getAllByLabelText(/ปริมาณที่ใช้/)[0], { target: { value: '200' } })],
    ['adding an ingredient', () => fireEvent.click(screen.getByRole('button', { name: /เพิ่มวัตถุดิบ/ }))],
    ['removing an ingredient', () => {
      fireEvent.click(screen.getByRole('button', { name: /เพิ่มวัตถุดิบ/ }))
      fireEvent.click(screen.getByRole('button', { name: 'ลบวัตถุดิบ 2' }))
    }],
    ['changing the portion', () => fireEvent.change(screen.getByLabelText('สัดส่วนที่เสิร์ฟ'), { target: { value: '0.5' } })],
  ])('hides delayed totals after %s', async (_change, change) => {
    let resolveFetch!: (value: { ok: boolean; json: () => Promise<typeof response> }) => void
    const delayedResponse = new Promise<{ ok: boolean; json: () => Promise<typeof response> }>(resolve => { resolveFetch = resolve })
    const fetchMock = vi.fn(() => delayedResponse)
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    openRecipes()

    fireEvent.change(screen.getAllByLabelText(/ปริมาณที่ใช้/)[0], { target: { value: '100' } })
    fireEvent.click(screen.getByRole('checkbox', { name: /ยืนยันว่าข้อมูลทั้งหมด/ }))
    fireEvent.click(screen.getByRole('button', { name: 'คำนวณสารอาหาร' }))
    expect(fetchMock.mock.calls.filter(([url]) => url === '/experimental/recipes/calculate')).toHaveLength(1)

    change()

    await act(async () => {
      resolveFetch({ ok: true, json: async () => response })
      await delayedResponse
    })
    expect(screen.queryByText('สารอาหารโดยประมาณ')).toBeNull()
    expect(screen.queryByText('777 กิโลแคลอรี')).toBeNull()
  })
})
