import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from '../src/main'

const calculation = {
  experimental: true, clinical_use: false, rounding: 'test', portion: '1',
  saved_sources: [{ version_id: 24, name: 'ข้าวทดสอบ', provider: 'Synthetic publisher', source_version: 'fixture-v1',
    source_date: '2026-01-02', source_reference: 'synthetic page 4', provenance: 'synthetic manual transcription',
    retrieved_on: '2026-11-03', food_state: 'cooked' }],
  totals: Object.fromEntries(['energy_kcal', 'protein_g', 'sodium_mg', 'potassium_mg', 'phosphorus_mg']
    .map(key => [key, { value: null, complete: false }])),
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  window.history.replaceState(null, '', '/')
})

it('saves reviewed synthetic source metadata, then finds and selects that version in recipes', async () => {
  const saved = {
    ingredient_id: 8, version_id: 24, name: 'ข้าวทดสอบ', brand: null, version: '1',
    provider: 'Synthetic publisher', source_version: 'fixture-v1', source_date: '2026-01-02',
    retrieved_on: '2026-11-03', source_reference: 'synthetic page 4',
    provenance: 'synthetic manual transcription', basis_quantity: '100', basis_unit: 'g',
    food_state: 'cooked', reviewed: true,
    nutrients: { energy_kcal: null, protein_g: null, sodium_mg: '0', potassium_mg: null, phosphorus_mg: null },
  }
  const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/experimental/ingredients') return { ok: true, json: async () => ({ ingredient_id: 8, version_id: 24 }) }
    if (url.startsWith('/experimental/ingredients/search')) return { ok: true, json: async () => ({ items: [saved], local_only: true }) }
    if (url === '/experimental/seasonings') return { ok: true, json: async () => ({ items: [] }) }
    if (url === '/experimental/recipes/calculate') return { ok: true, json: async () => calculation }
    throw new Error(`Unexpected request: ${url} ${options?.method ?? 'GET'}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  render(<App />)

  fireEvent.click(screen.getByRole('link', { name: 'วัตถุดิบและเครื่องปรุง' }))
  const saveForm = within(screen.getByRole('heading', { name: 'บันทึกวัตถุดิบจากข้อมูลสมมติ' }).closest('section')!)
  fireEvent.change(saveForm.getByLabelText('ชื่อวัตถุดิบ'), { target: { value: 'ข้าวทดสอบ' } })
  fireEvent.change(saveForm.getByLabelText('แหล่งข้อมูล / ผู้เผยแพร่'), { target: { value: 'Synthetic publisher' } })
  fireEvent.change(saveForm.getByLabelText('รุ่นหรือฉบับของแหล่งข้อมูล'), { target: { value: 'fixture-v1' } })
  fireEvent.change(saveForm.getByLabelText('วันที่ของแหล่งข้อมูล (ถ้าระบุ)'), { target: { value: '2026-01-02' } })
  fireEvent.change(saveForm.getByLabelText('ตำแหน่งอ้างอิง เช่น หน้าเอกสารหรือ URL'), { target: { value: 'synthetic page 4' } })
  fireEvent.change(saveForm.getByLabelText('วิธีได้มาของข้อมูล'), { target: { value: 'synthetic manual transcription' } })
  fireEvent.change(saveForm.getByLabelText('ข้อมูลสารอาหารต่อปริมาณ'), { target: { value: '100' } })
  fireEvent.change(saveForm.getByLabelText('หน่วยฐาน'), { target: { value: 'g' } })
  fireEvent.change(saveForm.getByLabelText('สภาพอาหาร'), { target: { value: 'cooked' } })
  fireEvent.change(saveForm.getByLabelText(/โซเดียม/), { target: { value: '0' } })
  fireEvent.click(saveForm.getByRole('checkbox'))
  fireEvent.click(saveForm.getByRole('button', { name: 'บันทึกตัวอย่างวัตถุดิบ' }))
  expect((await screen.findByRole('status')).textContent).toContain('บันทึกแล้ว · รุ่น 24')
  const create = fetchMock.mock.calls.find(([url]) => url === '/experimental/ingredients')
  expect(JSON.parse(String(create?.[1]?.body))).toMatchObject({
    synthetic_only: true, reviewed: true, name: 'ข้าวทดสอบ', provider: 'Synthetic publisher',
    source_version: 'fixture-v1', source_date: '2026-01-02', source_reference: 'synthetic page 4',
    provenance: 'synthetic manual transcription', basis_quantity: '100', basis_unit: 'g', food_state: 'cooked',
    nutrients: { energy_kcal: null, sodium_mg: '0' },
  })

  fireEvent.click(screen.getByRole('link', { name: 'สูตรอาหาร' }))
  fireEvent.change(screen.getByLabelText('ชื่อที่บันทึกไว้'), { target: { value: 'ข้าวทดสอบ' } })
  fireEvent.click(screen.getByRole('button', { name: 'ค้นหารายการในเครื่อง' }))
  fireEvent.click(await screen.findByRole('button', { name: 'เลือกเป็นรายการใหม่' }))
  const recipeSection = screen.getByRole('heading', { name: 'สูตรอาหาร' }).closest('section')!
  const recipe = within(recipeSection)
  const amounts = Array.from(recipeSection.querySelectorAll<HTMLInputElement>('[data-ingredient-index] .input-unit input[type="number"]'))
  expect(amounts).toHaveLength(2)
  fireEvent.change(amounts[0], { target: { value: '100' } })
  fireEvent.change(amounts[1], { target: { value: '50' } })
  expect(amounts.map(input => (input as HTMLInputElement).value)).toEqual(['100', '50'])
  fireEvent.click(screen.getByRole('checkbox', { name: /ยืนยันว่ากำลังทดสอบ/ }))
  const submit = recipe.getByRole('button', { name: 'คำนวณสารอาหาร' })
  const recipeForm = submit.closest('form') as HTMLFormElement
  expect(Array.from(recipeForm.elements).filter((element: Element) => !(element as HTMLInputElement).validity.valid)
    .map(element => [element.tagName, (element as HTMLInputElement).type, element.getAttribute('aria-label'), element.outerHTML])).toEqual([])
  fireEvent.click(submit)
  const recipeCall = fetchMock.mock.calls.find(([url]) => url === '/experimental/recipes/calculate')
  const body = JSON.parse(String(recipeCall?.[1]?.body))
  expect(body.ingredients[1]).toMatchObject({ source_type: 'saved', ingredient_version_id: 24, amount: '50', food_state: 'cooked' })
  expect(body.ingredients[1]).not.toHaveProperty('sodium_mg')
  await screen.findByText('สารอาหารโดยประมาณ · 1 ส่วน')
  expect(await screen.findAllByText(/วันที่แหล่งข้อมูล 2026-01-02/)).toHaveLength(2)
})

it('blocks edits while save is pending and clears saved status after a later edit', async () => {
  type SaveResponse = { ok: boolean; json: () => Promise<{ ingredient_id: number; version_id: number }> }
  let resolveSave!: (response: SaveResponse) => void
  const pendingSave = new Promise<SaveResponse>(resolve => { resolveSave = resolve })
  const fetchMock = vi.fn(async (url: string) => url === '/experimental/ingredients'
    ? pendingSave : { ok: true, json: async () => ({ items: [] }) })
  vi.stubGlobal('fetch', fetchMock)
  render(<App />)

  fireEvent.click(screen.getByRole('link', { name: 'วัตถุดิบและเครื่องปรุง' }))
  const saveForm = within(screen.getByRole('heading', { name: 'บันทึกวัตถุดิบจากข้อมูลสมมติ' }).closest('section')!)
  const name = saveForm.getByLabelText('ชื่อวัตถุดิบ') as HTMLInputElement
  fireEvent.change(name, { target: { value: 'ข้าวทดสอบ' } })
  fireEvent.change(saveForm.getByLabelText('แหล่งข้อมูล / ผู้เผยแพร่'), { target: { value: 'Synthetic publisher' } })
  fireEvent.change(saveForm.getByLabelText('รุ่นหรือฉบับของแหล่งข้อมูล'), { target: { value: 'fixture-v1' } })
  fireEvent.change(saveForm.getByLabelText('ตำแหน่งอ้างอิง เช่น หน้าเอกสารหรือ URL'), { target: { value: 'synthetic reference' } })
  fireEvent.change(saveForm.getByLabelText('วิธีได้มาของข้อมูล'), { target: { value: 'synthetic manual transcription' } })
  fireEvent.change(saveForm.getByLabelText('ข้อมูลสารอาหารต่อปริมาณ'), { target: { value: '100' } })
  fireEvent.change(saveForm.getByLabelText('หน่วยฐาน'), { target: { value: 'g' } })
  fireEvent.change(saveForm.getByLabelText('สภาพอาหาร'), { target: { value: 'raw' } })
  fireEvent.click(saveForm.getByRole('checkbox'))
  const submit = saveForm.getByRole('button', { name: 'บันทึกตัวอย่างวัตถุดิบ' })
  const form = submit.closest('form') as HTMLFormElement
  const fieldset = form.querySelector('fieldset') as HTMLFieldSetElement
  expect(Array.from(form.elements).filter((element: Element) => !(element as HTMLInputElement).validity.valid))
    .toEqual([])
  fireEvent.click(submit)
  expect(fetchMock).toHaveBeenCalled()
  await waitFor(() => {
    expect(fieldset.disabled).toBe(true)
    expect(name.matches(':disabled')).toBe(true)
    expect((submit as HTMLButtonElement).disabled).toBe(true)
  })

  await act(async () => {
    resolveSave({ ok: true, json: async () => ({ ingredient_id: 1, version_id: 1 }) })
    await pendingSave
  })
  expect((await screen.findByRole('status')).textContent).toContain('บันทึกแล้ว · รุ่น 1')
  expect(fieldset.disabled).toBe(false)
  expect(name.matches(':disabled')).toBe(false)
  fireEvent.change(name, { target: { value: 'ข้าวที่แก้แล้ว' } })
  expect(name.value).toBe('ข้าวที่แก้แล้ว')
  expect(screen.queryByRole('status')).toBeNull()
})
