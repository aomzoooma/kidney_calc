import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { App } from '../src/main'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  window.history.replaceState(null, '', '/')
})

it('shows attributed source and opens editable blank-weight recipe draft', () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ items: [] }) })))
  render(<App />)
  fireEvent.click(screen.getByRole('link', { name: 'สูตรอาหาร' }))

  expect(screen.getByRole('link', { name: 'ต้นฉบับฉบับที่อ้างอิง' }).getAttribute('href')).toContain('oldid=4512943')
  expect(screen.getByText(/CC BY-SA 4.0/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'ปรับสูตรนี้ในแบบร่าง' }))

  expect(screen.getByLabelText('ชื่อสูตร')).toHaveProperty('value', 'ข้าวผัด (Khao Pad)')
  expect(screen.getAllByLabelText('ชื่อวัตถุดิบ')[0]).toHaveProperty('value', 'น้ำมันพืช')
  expect(screen.getAllByLabelText('ชื่อวัตถุดิบ')).toHaveLength(10)
  expect(screen.getByText('เนื้อสัตว์ปรุงสุก (เช่น กุ้ง หมู ไก่ ฯลฯ) — 1 ถ้วย')).toBeTruthy()
  expect(screen.getAllByLabelText('ปริมาณที่ใช้ในสูตร')[0]).toHaveProperty('value', '')
  expect(screen.getAllByLabelText('ปริมาณฐานสารอาหาร')[0]).toHaveProperty('value', '')
  expect(screen.getByText(/ปริมาณจากต้นฉบับยังไม่แปลงเป็นกรัม\/มล/)).toBeTruthy()
  expect(screen.getByText('ต้นหอมซอย — ตามต้องการ')).toBeTruthy()
  const calculation = screen.getByRole('button', { name: 'คำนวณสารอาหาร' })
  expect(calculation).toHaveProperty('disabled', true)
  const review = screen.getByLabelText(/ตรวจชื่อ สภาพอาหาร หน่วย ปริมาณ/)
  const units = screen.getAllByLabelText('หน่วยปริมาณ')
  const states = screen.getAllByLabelText('สภาพอาหาร')
  expect(units).toHaveLength(10)
  expect(states[0]).toHaveProperty('value', '')
  expect(states[3]).toHaveProperty('value', 'cooked')
  expect(states[6]).toHaveProperty('value', 'cooked')
  for (let index = 0; index < 10; index++) {
    fireEvent.change(screen.getAllByLabelText('ปริมาณที่ใช้ในสูตร')[index], { target: { value: '100' } })
    fireEvent.change(screen.getAllByLabelText('ปริมาณฐานสารอาหาร')[index], { target: { value: '100' } })
    fireEvent.change(units[index], { target: { value: 'g' } })
    if (index !== 3 && index !== 6) fireEvent.change(states[index], { target: { value: 'raw' } })
  }
  fireEvent.click(review)
  expect(calculation).toHaveProperty('disabled', false)
  fireEvent.change(screen.getAllByLabelText('ชื่อวัตถุดิบ')[0], { target: { value: 'แก้ชื่อแล้ว' } })
  expect(review).toHaveProperty('checked', false)
  expect(calculation).toHaveProperty('disabled', true)
  fireEvent.click(review)
  fireEvent.click(screen.getByRole('button', { name: '＋ เพิ่มวัตถุดิบ' }))
  expect(review).toHaveProperty('checked', false)
  expect(screen.getAllByLabelText('หน่วยปริมาณ').at(-1)).toHaveProperty('value', '')
  expect(screen.getAllByLabelText('สภาพอาหาร').at(-1)).toHaveProperty('value', '')
  expect(screen.getAllByLabelText('ปริมาณฐานสารอาหาร').at(-1)).toHaveProperty('value', '')
  expect(calculation).toHaveProperty('disabled', true)
})

it('asks before replacing a changed draft and keeps it when cancelled', () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ items: [] }) })))
  vi.stubGlobal('confirm', vi.fn(() => true))
  render(<App />)
  fireEvent.click(screen.getByRole('link', { name: 'สูตรอาหาร' }))
  fireEvent.click(screen.getByRole('button', { name: 'ปรับสูตรนี้ในแบบร่าง' }))
  fireEvent.change(screen.getAllByLabelText('ชื่อวัตถุดิบ')[0], { target: { value: 'แก้แบบร่างเอง' } })
  vi.mocked(window.confirm).mockReturnValue(false)

  fireEvent.click(screen.getByRole('button', { name: 'ปรับสูตรนี้ในแบบร่าง' }))

  expect(window.confirm).toHaveBeenCalledOnce()
  expect(screen.getAllByLabelText('ชื่อวัตถุดิบ')[0]).toHaveProperty('value', 'แก้แบบร่างเอง')
})

it('resets template review after adding saved or USDA ingredients', async () => {
  const savedIngredient = {
    ingredient_id: 1, version_id: 7, name: 'ข้าวสังเคราะห์', brand: null, version: 'test-v1',
    provider: 'test', source_version: 'test-v1', source_date: null, retrieved_on: '2026-11-03',
    source_reference: 'synthetic://test', provenance: 'test fixture', basis_quantity: '100', basis_unit: 'g',
    food_state: 'cooked', reviewed: true,
    nutrients: { energy_kcal: null, protein_g: null, sodium_mg: null, potassium_mg: null, phosphorus_mg: null },
  }
  const usdaFood = { fdc_id: 42, description: 'Synthetic USDA food', source_type: 'Foundation', source_version: 'test-v1', food_state: 'raw' }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.startsWith('/experimental/ingredients/search')) return { ok: true, json: async () => ({ items: [savedIngredient] }) }
    if (url.startsWith('/experimental/usda/search')) return { ok: true, json: async () => ({ items: [usdaFood] }) }
    return { ok: true, json: async () => ({ items: [] }) }
  }))
  render(<App />)
  fireEvent.click(screen.getByRole('link', { name: 'สูตรอาหาร' }))
  fireEvent.click(screen.getByRole('button', { name: 'ปรับสูตรนี้ในแบบร่าง' }))
  const review = screen.getByLabelText(/ตรวจชื่อ สภาพอาหาร หน่วย ปริมาณ/)
  fireEvent.click(review)

  fireEvent.click(screen.getAllByText('ค้นหาวัตถุดิบที่บันทึกไว้ในเครื่อง')[0])
  fireEvent.change(screen.getByLabelText('ชื่อที่บันทึกไว้'), { target: { value: 'ข้าวสังเคราะห์' } })
  fireEvent.click(screen.getByRole('button', { name: 'ค้นหารายการในเครื่อง' }))
  fireEvent.click(await screen.findByRole('button', { name: 'เลือกเป็นรายการใหม่' }))
  expect(review).toHaveProperty('checked', false)

  fireEvent.click(review)
  fireEvent.click(screen.getAllByText('USDA · ข้อมูลอาหารหนึ่งรายการ ไม่ใช่สูตร')[0])
  fireEvent.change(screen.getByLabelText('ชื่ออาหารหรือคำค้นภาษาไทยหรืออังกฤษ'), { target: { value: 'synthetic' } })
  fireEvent.click(screen.getByRole('button', { name: 'ค้นหา USDA' }))
  fireEvent.click(await screen.findByRole('button', { name: 'เลือกวัตถุดิบนี้' }))
  expect(review).toHaveProperty('checked', false)
})

it('requires review before saving template as independent recipe, then reopens reviewed source', async () => {
  let finishRecipeSave!: () => void
  const pendingRecipeSave = new Promise<{ ok: boolean; json: () => Promise<{ id: number }> }>(resolve => {
    finishRecipeSave = () => resolve({ ok: true, json: async () => ({ id: 25 }) })
  })
  const detail = {
    id: 25, name: 'ข้าวผัด (Khao Pad)', favorite: false,
    ingredients: [{ ingredient_version_id: 7, seasoning_version_id: null, amount: '100', unit: 'g',
      food_state: 'raw', ingredient_name: 'น้ำมันพืช', basis_quantity: '100', basis_unit: 'g', reviewed: true,
      energy_kcal: null, protein_g: null, sodium_mg: null, potassium_mg: null, phosphorus_mg: null }],
  }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === '/experimental/ingredients' && init?.method === 'POST') return { ok: true, json: async () => ({ version_id: 7 }) }
    if (url === '/experimental/recipes' && init?.method === 'POST') return pendingRecipeSave
    if (url === '/experimental/recipes/25') return { ok: true, json: async () => detail }
    return { ok: true, json: async () => ({ items: [] }) }
  }))
  render(<App />)
  fireEvent.click(screen.getByRole('link', { name: 'สูตรอาหาร' }))
  fireEvent.click(screen.getByRole('button', { name: 'ปรับสูตรนี้ในแบบร่าง' }))
  for (let index = 10; index > 1; index--) {
    fireEvent.click(screen.getByRole('button', { name: `ลบวัตถุดิบ ${index}` }))
  }

  fireEvent.change(screen.getByLabelText('ปริมาณที่ใช้ในสูตร'), { target: { value: '100' } })
  fireEvent.change(screen.getByLabelText('หน่วยปริมาณ'), { target: { value: 'g' } })
  fireEvent.change(screen.getByLabelText('สภาพอาหาร'), { target: { value: 'raw' } })
  fireEvent.change(screen.getByLabelText('ปริมาณฐานสารอาหาร'), { target: { value: '100' } })
  fireEvent.click(screen.getByText('แหล่งข้อมูลและบันทึกรุ่นวัตถุดิบ'))
  fireEvent.change(screen.getByLabelText('แหล่งข้อมูล / ผู้เผยแพร่'), { target: { value: 'Synthetic test source' } })
  fireEvent.change(screen.getByLabelText('รุ่นหรือฉบับของแหล่งข้อมูล'), { target: { value: 'test-v1' } })
  fireEvent.change(screen.getByLabelText('ตำแหน่งอ้างอิง เช่น หน้าเอกสารหรือ URL'), { target: { value: 'synthetic://test' } })
  fireEvent.change(screen.getByLabelText('วิธีได้มาของข้อมูล'), { target: { value: 'test fixture' } })
  fireEvent.click(screen.getByLabelText(/ยืนยันว่าเป็นข้อมูลสมมติ/))
  fireEvent.click(screen.getByRole('button', { name: 'ตรวจแล้ว · บันทึกวัตถุดิบในเครื่อง' }))
  await screen.findByText(/บันทึกวัตถุดิบนี้ในเครื่องแล้ว/)

  const review = screen.getByLabelText(/ตรวจชื่อ สภาพอาหาร หน่วย ปริมาณ/)
  const save = screen.getByRole('button', { name: 'บันทึกสูตร' })
  expect(review).toHaveProperty('checked', false)
  expect(save).toHaveProperty('disabled', true)
  fireEvent.click(review)
  expect(save).toHaveProperty('disabled', false)
  fireEvent.click(save)
  expect(review).toHaveProperty('disabled', true)
  fireEvent.click(review)
  expect(review).toHaveProperty('checked', true)
  finishRecipeSave()
  await screen.findByText(/บันทึกสูตร “ข้าวผัด/)
  fireEvent.click(screen.getByRole('button', { name: 'เปิดสูตรนี้' }))
  await screen.findByText(/เปิดสูตร “ข้าวผัด/)

  expect(screen.queryByLabelText(/ตรวจชื่อ สภาพอาหาร หน่วย ปริมาณ/)).toBeNull()
  expect(screen.getByRole('button', { name: 'คำนวณสารอาหาร' })).toHaveProperty('disabled', false)
})

it('locks review during deferred calculation and clears result when review is revoked', async () => {
  let finishCalculation!: () => void
  const totals = Object.fromEntries(['energy_kcal', 'protein_g', 'sodium_mg', 'potassium_mg', 'phosphorus_mg']
    .map(key => [key, { value: null, complete: false }]))
  const pendingCalculation = new Promise<{ ok: boolean; json: () => Promise<unknown> }>(resolve => {
    finishCalculation = () => resolve({ ok: true, json: async () => ({
      experimental: true, clinical_use: false, rounding: 'none', portion: '1', totals,
    }) })
  })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    return String(input) === '/experimental/recipes/calculate'
      ? pendingCalculation
      : { ok: true, json: async () => ({ items: [] }) }
  }))
  render(<App />)
  fireEvent.click(screen.getByRole('link', { name: 'สูตรอาหาร' }))
  fireEvent.click(screen.getByRole('button', { name: 'ปรับสูตรนี้ในแบบร่าง' }))
  for (let index = 0; index < 10; index++) {
    fireEvent.change(screen.getAllByLabelText('ปริมาณที่ใช้ในสูตร')[index], { target: { value: '100' } })
    fireEvent.change(screen.getAllByLabelText('ปริมาณฐานสารอาหาร')[index], { target: { value: '100' } })
    fireEvent.change(screen.getAllByLabelText('หน่วยปริมาณ')[index], { target: { value: 'g' } })
    if (index !== 3 && index !== 6) fireEvent.change(screen.getAllByLabelText('สภาพอาหาร')[index], { target: { value: 'raw' } })
  }
  const review = screen.getByLabelText(/ตรวจชื่อ สภาพอาหาร หน่วย ปริมาณ/)
  fireEvent.click(review)
  fireEvent.click(screen.getByLabelText(/ยืนยันว่ากำลังทดสอบด้วยสูตรสมมติ/))
  const calculation = screen.getByRole('button', { name: 'คำนวณสารอาหาร' })
  expect(calculation).toHaveProperty('disabled', false)
  fireEvent.submit(calculation.closest('form')!)
  expect(review).toHaveProperty('disabled', true)
  fireEvent.click(review)
  expect(review).toHaveProperty('checked', true)

  finishCalculation()
  await screen.findByRole('heading', { name: /สารอาหารโดยประมาณ/ })
  fireEvent.click(review)
  expect(review).toHaveProperty('checked', false)
  expect(screen.queryByRole('heading', { name: /สารอาหารโดยประมาณ/ })).toBeNull()
}, 15000)
