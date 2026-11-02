import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
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
    fireEvent.change(screen.getByLabelText(/แหล่งข้อมูลวัตถุดิบ 1/), { target: { value: 'seasoning' } })
    await screen.findByRole('option', { name: /Test seasoning/ })
    fireEvent.change(screen.getAllByLabelText(/เลือกเครื่องปรุงที่บันทึกไว้/)[0], { target: { value: '42' } })
    expect((screen.getAllByLabelText(/หน่วยปริมาณ/)[0] as HTMLSelectElement).value).toBe('ml')
    expect((screen.getAllByLabelText(/สภาพอาหาร/)[0] as HTMLSelectElement).value).toBe('as_sold')
    expect((screen.getAllByLabelText(/ข้อมูลสารอาหารต่อ/)[0] as HTMLInputElement).value).toBe('15')
    fireEvent.change(screen.getAllByLabelText(/ปริมาณที่ใช้/)[0], { target: { value: '30' } })
    fireEvent.click(screen.getByRole('checkbox', { name: /ยืนยันว่ากำลังทดสอบ/ }))
    fireEvent.click(screen.getByRole('button', { name: 'คำนวณสารอาหาร' }))
    expect(fetchMock.mock.calls.some(([url]) => url === '/experimental/recipes/calculate')).toBe(true)
    await screen.findByText('สารอาหารโดยประมาณ · 1 ของสูตร')
    const calculation = fetchMock.mock.calls.find(([url]) => url === '/experimental/recipes/calculate')
    const body = JSON.parse(String(calculation?.[1]?.body))
    expect(body.ingredients[0].seasoning_version_id).toBe(42)
    expect(body.ingredients[0]).toMatchObject({ unit: 'ml', food_state: 'as_sold', reference_quantity: '15' })
    expect(body.ingredients[0]).not.toHaveProperty('sodium_mg')
  })

  it('requires synthetic-only confirmation', () => {
    const fetchMock = vi.fn(async (url: string) => ({ ok: true, json: async () => ({ items: [] }) }))
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    openRecipes()
    expect(screen.getByRole('checkbox', { name: /ยืนยันว่ากำลังทดสอบ/ }).required).toBe(true)
    expect(screen.getByText(/ตัวเลขสมมติเท่านั้น/)).toBeTruthy()
    expect(screen.getByText(/ห้ามใช้ค่าจากฉลากอาหารจริงหรือข้อมูลผู้ป่วย/)).toBeTruthy()
    fireEvent.change(screen.getAllByLabelText(/ปริมาณที่ใช้/)[0], { target: { value: '100' } })
    fireEvent.click(screen.getByRole('button', { name: 'คำนวณสารอาหาร' }))
    expect(fetchMock.mock.calls.some(([url]) => url === '/experimental/recipes/calculate')).toBe(false)
  })

  it('reviews a manual recipe row before saving its exact basis and then saves the recipe by immutable ID', async () => {
    const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === '/experimental/ingredients' && options?.method === 'POST') return { ok: true, json: async () => ({ ingredient_id: 8, version_id: 55 }) }
      if (url === '/experimental/recipes' && options?.method === 'POST') return { ok: true, json: async () => ({ id: 77, name: 'ข้าวตุ๋นสมมติ' }) }
      if (url === '/experimental/recipes') return { ok: true, json: async () => ({ items: [] }) }
      if (url === '/experimental/seasonings') return { ok: true, json: async () => ({ items: [] }) }
      return { ok: true, json: async () => response }
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    openRecipes()
    const row = document.querySelector('[data-ingredient-index="0"]')!
    fireEvent.change(within(row).getByLabelText('ชื่อวัตถุดิบ'), { target: { value: 'ถั่วสมมติ' } })
    fireEvent.change(within(row).getByLabelText('ปริมาณที่ใช้ในสูตร'), { target: { value: '12' } })
    fireEvent.change(within(row).getByLabelText(/หน่วยปริมาณ/), { target: { value: 'ml' } })
    fireEvent.change(within(row).getByLabelText(/สภาพอาหาร/), { target: { value: 'as_sold' } })
    fireEvent.change(within(row).getByLabelText('ปริมาณฐานสารอาหาร'), { target: { value: '30' } })
    const nutrientInputs = row.querySelectorAll<HTMLInputElement>('.nutrient-grid input')
    fireEvent.change(nutrientInputs[1], { target: { value: '2.5' } })
    fireEvent.change(nutrientInputs[2], { target: { value: '0' } })
    fireEvent.change(within(row).getByLabelText('แหล่งข้อมูล / ผู้เผยแพร่'), { target: { value: 'ผู้ใช้ระบุจากตัวอย่าง' } })
    fireEvent.change(within(row).getByLabelText('รุ่นหรือฉบับของแหล่งข้อมูล'), { target: { value: 'fixture-v1' } })
    fireEvent.change(within(row).getByLabelText('วันที่ของแหล่งข้อมูล (ถ้าระบุ)'), { target: { value: '2026-01-02' } })
    fireEvent.change(within(row).getByLabelText('ตำแหน่งอ้างอิง เช่น หน้าเอกสารหรือ URL'), { target: { value: 'synthetic page 4' } })
    fireEvent.change(within(row).getByLabelText('วิธีได้มาของข้อมูล'), { target: { value: 'คัดจากตัวอย่างสมมติ' } })
    const review = within(row).getByRole('checkbox', { name: /ยืนยันว่าเป็นข้อมูลสมมติ/ })
    expect((within(row).getByRole('button', { name: 'ตรวจแล้ว · บันทึกวัตถุดิบในเครื่อง' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(review)
    expect((review as HTMLInputElement).checked).toBe(true)
    fireEvent.change(nutrientInputs[2], { target: { value: '0.5' } })
    expect((review as HTMLInputElement).checked).toBe(false)
    fireEvent.click(review)
    fireEvent.change(within(row).getByLabelText('วิธีได้มาของข้อมูล'), { target: { value: 'ปรับปรุงจากตัวอย่างสมมติ' } })
    expect((review as HTMLInputElement).checked).toBe(false)
    fireEvent.click(review)
    fireEvent.click(within(row).getByRole('button', { name: 'ตรวจแล้ว · บันทึกวัตถุดิบในเครื่อง' }))
    await screen.findByText(/บันทึกวัตถุดิบนี้ในเครื่องแล้ว · รุ่น 55/)

    const ingredientCall = fetchMock.mock.calls.find(([url, options]) => url === '/experimental/ingredients' && options?.method === 'POST')
    expect(JSON.parse(String(ingredientCall?.[1]?.body))).toEqual({
      synthetic_only: true, reviewed: true, name: 'ถั่วสมมติ', provider: 'ผู้ใช้ระบุจากตัวอย่าง',
      source_version: 'fixture-v1', source_date: '2026-01-02', source_reference: 'synthetic page 4',
      provenance: 'ปรับปรุงจากตัวอย่างสมมติ', basis_quantity: '30', basis_unit: 'ml', food_state: 'as_sold',
      nutrients: { energy_kcal: null, protein_g: '2.5', sodium_mg: '0.5', potassium_mg: null, phosphorus_mg: null },
    })
    expect((within(row).getByLabelText('แหล่งข้อมูลวัตถุดิบ 1') as HTMLSelectElement).value).toBe('saved')
    expect((within(row).getByLabelText('ปริมาณที่ใช้ในสูตร') as HTMLInputElement).value).toBe('12')
    expect((within(row).getByLabelText('ปริมาณฐานสารอาหาร') as HTMLInputElement).value).toBe('30')

    fireEvent.change(screen.getByLabelText('ชื่อสูตร'), { target: { value: 'ข้าวตุ๋นสมมติ' } })
    fireEvent.click(screen.getByRole('button', { name: 'บันทึกสูตร' }))
    await screen.findByText('บันทึกสูตร “ข้าวตุ๋นสมมติ” แล้ว')
    const recipeCall = fetchMock.mock.calls.find(([url, options]) => url === '/experimental/recipes' && options?.method === 'POST')
    expect(JSON.parse(String(recipeCall?.[1]?.body))).toEqual({ synthetic_only: true, name: 'ข้าวตุ๋นสมมติ', ingredients: [
      { ingredient_version_id: 55, amount: '12', unit: 'ml', food_state: 'as_sold' },
    ] })
  })

  it('keeps the manual ingredient draft after save failure and locks row identity while saving', async () => {
    let rejectSnapshot!: (reason?: unknown) => void
    const pendingSnapshot = new Promise<{ ok: boolean; json: () => Promise<{ detail?: string }> }>((_resolve, reject) => { rejectSnapshot = reject })
    const fetchMock = vi.fn((url: string, options?: RequestInit) => {
      if (url === '/experimental/ingredients' && options?.method === 'POST') return pendingSnapshot
      if (url === '/experimental/recipes') return Promise.resolve({ ok: true, json: async () => ({ items: [] }) })
      if (url === '/experimental/seasonings') return Promise.resolve({ ok: true, json: async () => ({ items: [] }) })
      return Promise.resolve({ ok: true, json: async () => response })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    openRecipes()
    fireEvent.change(screen.getByLabelText('ชื่อวัตถุดิบ'), { target: { value: 'ผักสมมติ' } })
    fireEvent.click(screen.getByRole('button', { name: /เพิ่มวัตถุดิบ/ }))
    const first = document.querySelector('[data-ingredient-index="0"]')!
    fireEvent.click(first.querySelector('summary')!)
    fireEvent.change(within(first).getByLabelText('แหล่งข้อมูล / ผู้เผยแพร่'), { target: { value: 'fixture source' } })
    fireEvent.change(within(first).getByLabelText('รุ่นหรือฉบับของแหล่งข้อมูล'), { target: { value: 'v1' } })
    fireEvent.change(within(first).getByLabelText('ตำแหน่งอ้างอิง เช่น หน้าเอกสารหรือ URL'), { target: { value: 'fixture reference' } })
    fireEvent.change(within(first).getByLabelText('วิธีได้มาของข้อมูล'), { target: { value: 'fixture transcription' } })
    fireEvent.click(within(first).getByRole('checkbox', { name: /ยืนยันว่าเป็นข้อมูลสมมติ/ }))
    fireEvent.click(within(first).getByRole('button', { name: 'ตรวจแล้ว · บันทึกวัตถุดิบในเครื่อง' }))
    const secondName = document.querySelector<HTMLInputElement>('[data-ingredient-index="1"] input[autocomplete="off"]')!
    expect((screen.getByRole('button', { name: /เพิ่มวัตถุดิบ/ }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'ลบวัตถุดิบ 2' }) as HTMLButtonElement).disabled).toBe(true)
    expect(secondName.matches(':disabled')).toBe(true)
    fireEvent.change(secondName, { target: { value: 'พยายามเปลี่ยนแถวระหว่างบันทึก' } })
    expect(secondName.value).toBe('')
    await act(async () => { rejectSnapshot(new TypeError('Failed to fetch')); await pendingSnapshot.catch(() => undefined) })
    expect(await screen.findByText(/อาจบันทึกสำเร็จแล้ว/)).toBeTruthy()
    expect((within(first).getByLabelText('ชื่อวัตถุดิบ') as HTMLInputElement).value).toBe('ผักสมมติ')
    expect((within(first).getByLabelText('แหล่งข้อมูล \/ ผู้เผยแพร่') as HTMLInputElement).value).toBe('fixture source')
    expect((within(first).getByLabelText('ปริมาณที่ใช้ในสูตร') as HTMLInputElement).value).toBe('')
    expect((within(first).getByLabelText('แหล่งข้อมูลวัตถุดิบ 1') as HTMLSelectElement).value).toBe('manual')
    expect(fetchMock.mock.calls.some(([url, options]) => url === '/experimental/recipes' && options?.method === 'POST')).toBe(false)
  })

  it('keeps manual snapshot provenance with its ingredient when an earlier row is removed', async () => {
    const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === '/experimental/ingredients' && options?.method === 'POST') return { ok: true, json: async () => ({ ingredient_id: 9, version_id: 91 }) }
      if (url === '/experimental/recipes') return { ok: true, json: async () => ({ items: [] }) }
      if (url === '/experimental/seasonings') return { ok: true, json: async () => ({ items: [] }) }
      return { ok: true, json: async () => response }
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    openRecipes()
    const first = document.querySelector('[data-ingredient-index="0"]')!
    fireEvent.change(within(first).getByLabelText('ชื่อวัตถุดิบ'), { target: { value: 'วัตถุดิบ A' } })
    fireEvent.change(within(first).getByLabelText('แหล่งข้อมูล / ผู้เผยแพร่'), { target: { value: 'source A' } })
    fireEvent.change(within(first).getByLabelText('รุ่นหรือฉบับของแหล่งข้อมูล'), { target: { value: 'version A' } })
    fireEvent.change(within(first).getByLabelText('ตำแหน่งอ้างอิง เช่น หน้าเอกสารหรือ URL'), { target: { value: 'reference A' } })
    fireEvent.change(within(first).getByLabelText('วิธีได้มาของข้อมูล'), { target: { value: 'provenance A' } })
    fireEvent.click(screen.getByRole('button', { name: /เพิ่มวัตถุดิบ/ }))
    const second = document.querySelector('[data-ingredient-index="1"]')!
    fireEvent.change(within(second).getByLabelText('ชื่อวัตถุดิบ'), { target: { value: 'วัตถุดิบ B' } })
    fireEvent.change(within(second).getByLabelText('แหล่งข้อมูล / ผู้เผยแพร่'), { target: { value: 'source B' } })
    fireEvent.change(within(second).getByLabelText('รุ่นหรือฉบับของแหล่งข้อมูล'), { target: { value: 'version B' } })
    fireEvent.change(within(second).getByLabelText('ตำแหน่งอ้างอิง เช่น หน้าเอกสารหรือ URL'), { target: { value: 'reference B' } })
    fireEvent.change(within(second).getByLabelText('วิธีได้มาของข้อมูล'), { target: { value: 'provenance B' } })

    fireEvent.click(screen.getByRole('button', { name: 'ลบวัตถุดิบ 1' }))
    const remaining = document.querySelector('[data-ingredient-index="0"]')!
    expect((within(remaining).getByLabelText('ชื่อวัตถุดิบ') as HTMLInputElement).value).toBe('วัตถุดิบ B')
    expect((within(remaining).getByLabelText('แหล่งข้อมูล / ผู้เผยแพร่') as HTMLInputElement).value).toBe('source B')
    fireEvent.click(within(remaining).getByRole('checkbox', { name: /ยืนยันว่าเป็นข้อมูลสมมติ/ }))
    fireEvent.click(within(remaining).getByRole('button', { name: 'ตรวจแล้ว · บันทึกวัตถุดิบในเครื่อง' }))
    await screen.findByText(/บันทึกวัตถุดิบนี้ในเครื่องแล้ว · รุ่น 91/)
    const snapshotCall = fetchMock.mock.calls.find(([url, options]) => url === '/experimental/ingredients' && options?.method === 'POST')
    expect(JSON.parse(String(snapshotCall?.[1]?.body))).toMatchObject({
      name: 'วัตถุดิบ B', provider: 'source B', source_version: 'version B', source_reference: 'reference B', provenance: 'provenance B',
    })
    expect(JSON.parse(String(snapshotCall?.[1]?.body))).not.toMatchObject({ provider: 'source A', source_reference: 'reference A', provenance: 'provenance A' })
  })

  it('saves a custom recipe from reviewed local ingredient versions only', async () => {
    const saved = { ingredient_id: 8, version_id: 24, name: 'ข้าวสวย', brand: null, version: '1',
      provider: 'Synthetic provider', source_version: 'fixture-v1', source_date: null, retrieved_on: '2026-11-03',
      source_reference: 'synthetic fixture', provenance: 'synthetic input', basis_quantity: '100', basis_unit: 'g',
      food_state: 'cooked', reviewed: true,
      nutrients: { energy_kcal: null, protein_g: '2', sodium_mg: '1', potassium_mg: null, phosphorus_mg: null } }
    const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === '/experimental/recipes' && options?.method === 'POST') return { ok: true, json: async () => ({ id: 42, name: 'ข้าวต้ม', saved: true }) }
      if (url === '/experimental/recipes') return { ok: true, json: async () => ({ items: [] }) }
      if (url === '/experimental/seasonings') return { ok: true, json: async () => ({ items: [] }) }
      if (url.startsWith('/experimental/ingredients/search')) return { ok: true, json: async () => ({ items: [saved] }) }
      return { ok: true, json: async () => response }
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    openRecipes()
    fireEvent.change(screen.getByLabelText('ชื่อที่บันทึกไว้'), { target: { value: 'ข้าว' } })
    fireEvent.click(screen.getByRole('button', { name: 'ค้นหารายการในเครื่อง' }))
    fireEvent.click(await screen.findByRole('button', { name: 'เลือกเป็นรายการใหม่' }))
    fireEvent.change(document.querySelector<HTMLInputElement>('[data-ingredient-index="1"] .field-grid input[type="number"]')!, { target: { value: '120' } })
    fireEvent.click(screen.getByRole('button', { name: 'ลบวัตถุดิบ 1' }))
    fireEvent.change(screen.getByLabelText('ชื่อสูตร'), { target: { value: 'ข้าวต้ม' } })
    const save = screen.getByRole('button', { name: 'บันทึกสูตร' })
    expect((save as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(save)
    await screen.findByText('บันทึกสูตร “ข้าวต้ม” แล้ว')
    const createCall = fetchMock.mock.calls.find(([url, options]) => url === '/experimental/recipes' && options?.method === 'POST')
    expect(JSON.parse(String(createCall?.[1]?.body))).toEqual({ synthetic_only: true, name: 'ข้าวต้ม', ingredients: [
      { ingredient_version_id: 24, amount: '120', unit: 'g', food_state: 'cooked' },
    ] })
  })

  it('saves and reopens a custom recipe with the exact reviewed seasoning version and measure', async () => {
    const seasoning = { ingredient_id: 8, version_id: 42, name: 'น้ำปลา', brand: 'ฉลากสมมติ', basis_quantity: '15', basis_unit: 'ml',
      reviewed: true, nutrients: { energy_kcal: null, protein_g: null, sodium_mg: '900', potassium_mg: null, phosphorus_mg: null } }
    const detail = { id: 7, name: 'แกงสมมติ', favorite: false, ingredients: [{ ingredient_version_id: 42,
      seasoning_version_id: 42, amount: '22.5', unit: 'ml', food_state: 'as_sold', ingredient_name: 'น้ำปลา', brand: 'ฉลากสมมติ',
      basis_quantity: '15', basis_unit: 'ml', reviewed: true, provider: 'ฉลากสมมติ', source_version: 'user-reviewed label',
      source_date: null, retrieved_on: '2026-11-03', source_reference: 'synthetic label fixture', provenance: 'user-entered label',
      energy_kcal: null, protein_g: null, sodium_mg: '900', potassium_mg: null, phosphorus_mg: null }] }
    let replacementAttempts = 0
    const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === '/experimental/seasonings') return { ok: true, json: async () => ({ items: [seasoning] }) }
      if (url === '/experimental/recipes' && options?.method === 'POST') return { ok: true, json: async () => ({ id: 7, name: 'แกงสมมติ' }) }
      if (url === '/experimental/recipes/7/ingredients' && options?.method === 'PUT') {
        replacementAttempts++
        return replacementAttempts === 1
          ? { ok: false, status: 422, json: async () => ({ detail: 'recipe amount unit and food state must match the source version' }) }
          : { ok: true, json: async () => ({ ingredients_updated: true }) }
      }
      if (url === '/experimental/recipes/7') return { ok: true, json: async () => detail }
      if (url === '/experimental/recipes') return { ok: true, json: async () => ({ items: [{ id: 7, name: 'แกงสมมติ', favorite: false }] }) }
      return { ok: true, json: async () => response }
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    openRecipes()
    fireEvent.change(screen.getByLabelText('แหล่งข้อมูลวัตถุดิบ 1'), { target: { value: 'seasoning' } })
    await screen.findByRole('option', { name: /น้ำปลา · ฉลากสมมติ \(รุ่น 42\)/ })
    fireEvent.change(screen.getByLabelText('เลือกเครื่องปรุงที่บันทึกไว้'), { target: { value: '42' } })
    fireEvent.change(document.querySelector<HTMLInputElement>('[data-ingredient-index="0"] .field-grid input[type="number"]')!, { target: { value: '22.5' } })
    fireEvent.click(screen.getByRole('button', { name: /เพิ่มวัตถุดิบ/ }))
    fireEvent.click(screen.getByRole('button', { name: 'ลบวัตถุดิบ 2' }))
    fireEvent.change(screen.getByLabelText('ชื่อสูตร'), { target: { value: 'แกงสมมติ' } })
    expect(screen.getByText(/เครื่องปรุงที่ตรวจแล้ว · รุ่น 42 · ใช้ปริมาณเป็น มล\. ตามฐานของรุ่นนี้ \(15 มล\.\)/)).toBeTruthy()
    expect(screen.getByText(/ระบบไม่แปลงกรัมเป็นมิลลิลิตร/)).toBeTruthy()
    expect((screen.getByLabelText(/หน่วยปริมาณ/) as HTMLSelectElement).value).toBe('ml')
    expect((screen.getByLabelText(/หน่วยปริมาณ/) as HTMLSelectElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'บันทึกสูตร' }))
    await screen.findByText('บันทึกสูตร “แกงสมมติ” แล้ว')
    const createCall = fetchMock.mock.calls.find(([url, options]) => url === '/experimental/recipes' && options?.method === 'POST')
    const createBody = JSON.parse(String(createCall?.[1]?.body))
    expect(createBody.ingredients).toEqual([{ seasoning_version_id: 42, amount: '22.5', unit: 'ml', food_state: 'as_sold' }])
    expect(createBody.ingredients[0]).not.toHaveProperty('ingredient_version_id')

    fireEvent.click(await screen.findByRole('button', { name: 'เปิดสูตรนี้' }))
    await screen.findByDisplayValue('แกงสมมติ')
    expect((screen.getByLabelText('แหล่งข้อมูลวัตถุดิบ 1') as HTMLSelectElement).value).toBe('seasoning')
    expect((screen.getByLabelText('เลือกเครื่องปรุงที่บันทึกไว้') as HTMLSelectElement).value).toBe('42')
    expect((document.querySelector<HTMLInputElement>('[data-ingredient-index="0"] .field-grid input[type="number"]')!).value).toBe('22.5')
    expect((screen.getByLabelText(/หน่วยปริมาณ/) as HTMLSelectElement).value).toBe('ml')
    expect((screen.getByLabelText('สภาพอาหาร') as HTMLSelectElement).value).toBe('as_sold')
    fireEvent.change(document.querySelector<HTMLInputElement>('[data-ingredient-index="0"] .field-grid input[type="number"]')!, { target: { value: '30' } })
    fireEvent.click(screen.getByRole('button', { name: 'บันทึกการเปลี่ยนแปลง' }))
    expect(await screen.findByText(/ปริมาณหรือสภาพอาหารไม่ตรงกับฐานของรายการที่ตรวจไว้/)).toBeTruthy()
    expect((document.querySelector<HTMLInputElement>('[data-ingredient-index="0"] .field-grid input[type="number"]')!).value).toBe('30')
    fireEvent.click(screen.getByRole('button', { name: 'บันทึกการเปลี่ยนแปลง' }))
    await screen.findByText('บันทึกการเปลี่ยนแปลงของ “แกงสมมติ” แล้ว')
    const replaceCall = fetchMock.mock.calls.findLast(([url, options]) => url === '/experimental/recipes/7/ingredients' && options?.method === 'PUT')
    const replaceBody = JSON.parse(String(replaceCall?.[1]?.body))
    expect(replaceBody.ingredients).toEqual([{ seasoning_version_id: 42, amount: '30', unit: 'ml', food_state: 'as_sold' }])
    expect(replaceBody.ingredients[0]).not.toHaveProperty('ingredient_version_id')
  })

  it('does not let a delayed initial recipe list erase a newly created recipe', async () => {
    let releaseList!: (value: { ok: boolean; json: () => Promise<{ items: object[] }> }) => void
    const listPending = new Promise<{ ok: boolean; json: () => Promise<{ items: object[] }> }>(resolve => { releaseList = resolve })
    const saved = { ingredient_id: 8, version_id: 24, name: 'ข้าวสวย', brand: null, version: '1', provider: 'fixture',
      source_version: 'v1', source_date: null, retrieved_on: '2026-11-03', source_reference: 'fixture', provenance: 'synthetic',
      basis_quantity: '100', basis_unit: 'g', food_state: 'cooked', reviewed: true,
      nutrients: { energy_kcal: null, protein_g: '2', sodium_mg: '1', potassium_mg: null, phosphorus_mg: null } }
    const fetchMock = vi.fn((url: string, options?: RequestInit) => {
      if (url === '/experimental/recipes' && options?.method === 'POST') return Promise.resolve({ ok: true, json: async () => ({ id: 42 }) })
      if (url === '/experimental/recipes') return listPending
      if (url === '/experimental/seasonings') return Promise.resolve({ ok: true, json: async () => ({ items: [] }) })
      if (url.startsWith('/experimental/ingredients/search')) return Promise.resolve({ ok: true, json: async () => ({ items: [saved] }) })
      return Promise.resolve({ ok: true, json: async () => response })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    openRecipes()
    fireEvent.change(screen.getByLabelText('ชื่อที่บันทึกไว้'), { target: { value: 'ข้าว' } })
    fireEvent.click(screen.getByRole('button', { name: 'ค้นหารายการในเครื่อง' }))
    fireEvent.click(await screen.findByRole('button', { name: 'เลือกเป็นรายการใหม่' }))
    fireEvent.click(screen.getByRole('button', { name: 'ลบวัตถุดิบ 1' }))
    fireEvent.change(document.querySelector<HTMLInputElement>('[data-ingredient-index="0"] .field-grid input[type="number"]')!, { target: { value: '80' } })
    fireEvent.change(screen.getByLabelText('ชื่อสูตร'), { target: { value: 'ข้าวต้มใหม่' } })
    fireEvent.click(screen.getByRole('button', { name: 'บันทึกสูตร' }))
    await screen.findByText('บันทึกสูตร “ข้าวต้มใหม่” แล้ว')
    await act(async () => { releaseList({ ok: true, json: async () => ({ items: [] }) }); await listPending })
    expect(screen.getByRole('button', { name: 'เปิดสูตรนี้' })).toBeTruthy()
    expect(screen.getByText('ข้าวต้มใหม่')).toBeTruthy()
  })

  it('serializes favorite changes with recipe saves', async () => {
    let releaseFavorite!: (value: { ok: boolean; json: () => Promise<object> }) => void
    let releaseSave!: (value: { ok: boolean; json: () => Promise<object> }) => void
    const favoritePending = new Promise<{ ok: boolean; json: () => Promise<object> }>(resolve => { releaseFavorite = resolve })
    const savePending = new Promise<{ ok: boolean; json: () => Promise<object> }>(resolve => { releaseSave = resolve })
    const detail = { id: 7, name: 'ข้าวต้ม', favorite: false, ingredients: [{ ingredient_version_id: 24, amount: '60', unit: 'g',
      food_state: 'cooked', ingredient_name: 'ข้าวสวย', basis_quantity: '100', basis_unit: 'g', reviewed: true,
      energy_kcal: null, protein_g: '2', sodium_mg: '1', potassium_mg: null, phosphorus_mg: null }] }
    const fetchMock = vi.fn((url: string, options?: RequestInit) => {
      if (url === '/experimental/recipes') return Promise.resolve({ ok: true, json: async () => ({ items: [{ id: 7, name: 'ข้าวต้ม', favorite: false }] }) })
      if (url === '/experimental/seasonings') return Promise.resolve({ ok: true, json: async () => ({ items: [] }) })
      if (url === '/experimental/recipes/7' && options?.method === 'PATCH' && JSON.parse(String(options.body)).favorite) return favoritePending
      if (url === '/experimental/recipes/7/ingredients' && options?.method === 'PUT') return savePending
      if (url === '/experimental/recipes/7') return Promise.resolve({ ok: true, json: async () => detail })
      return Promise.resolve({ ok: true, json: async () => response })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    openRecipes()
    fireEvent.click(await screen.findByRole('button', { name: 'เปิดสูตรนี้' }))
    await screen.findByDisplayValue('ข้าวต้ม')
    fireEvent.change(document.querySelector<HTMLInputElement>('[data-ingredient-index="0"] .field-grid input[type="number"]')!, { target: { value: '75' } })
    fireEvent.click(screen.getByRole('button', { name: 'เพิ่มในรายการโปรด' }))
    const save = screen.getByRole('button', { name: 'บันทึกการเปลี่ยนแปลง' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.click(save)
    expect(fetchMock.mock.calls.some(([url, options]) => url === '/experimental/recipes/7/ingredients' && options?.method === 'PUT')).toBe(false)
    await act(async () => { releaseFavorite({ ok: true, json: async () => ({ updated: true }) }); await favoritePending })
    await screen.findByRole('button', { name: 'นำออกจากรายการโปรด' })
    fireEvent.click(screen.getByRole('button', { name: 'บันทึกการเปลี่ยนแปลง' }))
    expect((screen.getByRole('button', { name: 'นำออกจากรายการโปรด' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { releaseSave({ ok: true, json: async () => ({ updated: true }) }); await savePending })
    await screen.findByText('บันทึกการเปลี่ยนแปลงของ “ข้าวต้ม” แล้ว')
    expect(screen.getByText('อยู่ในรายการโปรด')).toBeTruthy()
  })

  it('locks recipe identity and editing while a new recipe save is pending', async () => {
    let releaseCreate!: (value: { ok: boolean; json: () => Promise<{ id: number; name: string }> }) => void
    const createPending = new Promise<{ ok: boolean; json: () => Promise<{ id: number; name: string }> }>(resolve => { releaseCreate = resolve })
    const detail = { id: 7, name: 'สูตรเดิม', favorite: false, ingredients: [{
      ingredient_version_id: 24, amount: '60', unit: 'g', food_state: 'cooked', ingredient_name: 'ข้าวสวย',
      basis_quantity: '100', basis_unit: 'g', reviewed: true,
      energy_kcal: null, protein_g: '2', sodium_mg: '1', potassium_mg: null, phosphorus_mg: null,
    }] }
    const fetchMock = vi.fn((url: string, options?: RequestInit) => {
      if (url === '/experimental/recipes' && options?.method === 'POST') return createPending
      if (url === '/experimental/recipes') return Promise.resolve({ ok: true, json: async () => ({ items: [{ id: 7, name: 'สูตรเดิม', favorite: false }] }) })
      if (url === '/experimental/seasonings') return Promise.resolve({ ok: true, json: async () => ({ items: [] }) })
      if (url.startsWith('/experimental/ingredients/search')) return Promise.resolve({ ok: true, json: async () => ({ items: [{
        ingredient_id: 8, version_id: 24, name: 'ข้าวสวย', brand: null, version: '1', provider: 'fixture',
        source_version: 'v1', source_date: null, retrieved_on: '2026-11-03', source_reference: 'fixture',
        provenance: 'synthetic fixture', basis_quantity: '100', basis_unit: 'g', food_state: 'cooked', reviewed: true,
        nutrients: { energy_kcal: null, protein_g: '2', sodium_mg: '1', potassium_mg: null, phosphorus_mg: null },
      }] }) })
      if (url === '/experimental/recipes/7') return Promise.resolve({ ok: true, json: async () => detail })
      return Promise.resolve({ ok: true, json: async () => response })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    openRecipes()
    fireEvent.change(screen.getByLabelText('ชื่อที่บันทึกไว้'), { target: { value: 'ข้าว' } })
    fireEvent.click(screen.getByRole('button', { name: 'ค้นหารายการในเครื่อง' }))
    fireEvent.click(await screen.findByRole('button', { name: 'เลือกเป็นรายการใหม่' }))
    fireEvent.click(screen.getByRole('button', { name: 'ลบวัตถุดิบ 1' }))
    fireEvent.change(document.querySelector<HTMLInputElement>('[data-ingredient-index="0"] .field-grid input[type="number"]')!, { target: { value: '90' } })
    fireEvent.change(screen.getByLabelText('ชื่อสูตร'), { target: { value: 'สูตรใหม่' } })
    fireEvent.click(screen.getByRole('button', { name: 'บันทึกสูตร' }))

    const name = screen.getByLabelText('ชื่อสูตร') as HTMLInputElement
    const open = await screen.findByRole('button', { name: 'เปิดสูตรนี้' }) as HTMLButtonElement
    const newRecipe = screen.getByRole('button', { name: 'เริ่มสูตรใหม่' }) as HTMLButtonElement
    expect(name.disabled).toBe(true)
    expect(open.disabled).toBe(true)
    expect(newRecipe.disabled).toBe(true)
    expect(document.querySelector<HTMLInputElement>('[data-ingredient-index="0"] .field-grid input[type="number"]')!.matches(':disabled')).toBe(true)
    fireEvent.click(open)
    fireEvent.change(name, { target: { value: 'พยายามแก้ระหว่างบันทึก' } })
    expect(name.value).toBe('สูตรใหม่')
    expect(fetchMock.mock.calls.some(([url]) => url === '/experimental/recipes/7')).toBe(false)

    await act(async () => { releaseCreate({ ok: true, json: async () => ({ id: 42, name: 'สูตรใหม่' }) }); await createPending })
    await screen.findByText('บันทึกสูตร “สูตรใหม่” แล้ว')
    expect((screen.getByLabelText('ชื่อสูตร') as HTMLInputElement).value).toBe('สูตรใหม่')
    expect(fetchMock.mock.calls.some(([url, options]) => url === '/experimental/recipes/42/ingredients' && options?.method === 'PUT')).toBe(false)
  })

  it('blocks saving and starting a new recipe while a saved recipe is loading', async () => {
    let releaseDetail!: (value: { ok: boolean; json: () => Promise<object> }) => void
    const detailPending = new Promise<{ ok: boolean; json: () => Promise<object> }>(resolve => { releaseDetail = resolve })
    const saved = { ingredient_id: 8, version_id: 24, name: 'ข้าวสวย', brand: null, version: '1', provider: 'fixture',
      source_version: 'v1', source_date: null, retrieved_on: '2026-11-03', source_reference: 'fixture', provenance: 'synthetic',
      basis_quantity: '100', basis_unit: 'g', food_state: 'cooked', reviewed: true,
      nutrients: { energy_kcal: null, protein_g: '2', sodium_mg: '1', potassium_mg: null, phosphorus_mg: null } }
    const detail = { id: 7, name: 'สูตรเดิม', favorite: false, ingredients: [{ ingredient_version_id: 24, amount: '60', unit: 'g',
      food_state: 'cooked', ingredient_name: 'ข้าวสวย', basis_quantity: '100', basis_unit: 'g', reviewed: true,
      energy_kcal: null, protein_g: '2', sodium_mg: '1', potassium_mg: null, phosphorus_mg: null }] }
    const fetchMock = vi.fn((url: string, options?: RequestInit) => {
      if (url === '/experimental/recipes/7') return detailPending
      if (url === '/experimental/recipes' && options?.method === 'POST') return Promise.resolve({ ok: true, json: async () => ({ id: 42 }) })
      if (url === '/experimental/recipes') return Promise.resolve({ ok: true, json: async () => ({ items: [{ id: 7, name: 'สูตรเดิม', favorite: false }] }) })
      if (url === '/experimental/seasonings') return Promise.resolve({ ok: true, json: async () => ({ items: [] }) })
      if (url.startsWith('/experimental/ingredients/search')) return Promise.resolve({ ok: true, json: async () => ({ items: [saved] }) })
      return Promise.resolve({ ok: true, json: async () => response })
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<App />)
    openRecipes()
    fireEvent.change(screen.getByLabelText('ชื่อที่บันทึกไว้'), { target: { value: 'ข้าว' } })
    fireEvent.click(screen.getByRole('button', { name: 'ค้นหารายการในเครื่อง' }))
    fireEvent.click(await screen.findByRole('button', { name: 'เลือกเป็นรายการใหม่' }))
    fireEvent.click(screen.getByRole('button', { name: 'ลบวัตถุดิบ 1' }))
    fireEvent.change(document.querySelector<HTMLInputElement>('[data-ingredient-index="0"] .field-grid input[type="number"]')!, { target: { value: '90' } })
    fireEvent.change(screen.getByLabelText('ชื่อสูตร'), { target: { value: 'แบบร่าง' } })
    fireEvent.click(screen.getByRole('button', { name: 'เปิดสูตรนี้' }))
    expect((screen.getByRole('button', { name: 'บันทึกสูตร' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'เริ่มสูตรใหม่' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'บันทึกสูตร' }))
    fireEvent.click(screen.getByRole('button', { name: 'เริ่มสูตรใหม่' }))
    expect(fetchMock.mock.calls.some(([url, options]) => url === '/experimental/recipes' && options?.method === 'POST')).toBe(false)
    await act(async () => { releaseDetail({ ok: true, json: async () => detail }); await detailPending })
    await screen.findByText(/เปิดสูตร “สูตรเดิม” แล้ว/)
  })

  it('filters saved recipes to favorites and opens the selected recipe to repeat it', async () => {
    const detail = { id: 8, name: 'ข้าวต้มที่ชอบ', favorite: true, ingredients: [{ ingredient_version_id: 24, amount: '60', unit: 'g',
      food_state: 'cooked', ingredient_name: 'ข้าวสวย', basis_quantity: '100', basis_unit: 'g', reviewed: true,
      energy_kcal: null, protein_g: '2', sodium_mg: '1', potassium_mg: null, phosphorus_mg: null }] }
    const fetchMock = vi.fn(async (url: string) => url === '/experimental/recipes'
      ? { ok: true, json: async () => ({ items: [
        { id: 7, name: 'สูตรทั่วไป', favorite: false }, { id: 8, name: 'ข้าวต้มที่ชอบ', favorite: true },
      ] }) }
      : url === '/experimental/recipes/8' ? { ok: true, json: async () => detail }
        : url === '/experimental/seasonings' ? { ok: true, json: async () => ({ items: [] }) }
          : { ok: true, json: async () => response })
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    openRecipes()
    expect(await screen.findByText('สูตรทั่วไป')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'เมนูโปรด (1)' }))
    expect(screen.queryByText('สูตรทั่วไป')).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: 'เปิดสูตรนี้' }))
    expect(await screen.findByDisplayValue('ข้าวต้มที่ชอบ')).toBeTruthy()
    expect(fetchMock.mock.calls.some(([url]) => url === '/experimental/recipes/8')).toBe(true)
  })

  it('opens, edits, renames, and favorites a saved recipe', async () => {
    const detail = { id: 7, name: 'ข้าวต้ม', favorite: false, ingredients: [{
      ingredient_version_id: 24, amount: '60', unit: 'g', food_state: 'cooked', ingredient_name: 'ข้าวสวย',
      basis_quantity: '100', basis_unit: 'g', reviewed: true, energy_kcal: null, protein_g: '2', sodium_mg: '1', potassium_mg: null, phosphorus_mg: null,
    }] }
    const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === '/experimental/recipes') return { ok: true, json: async () => ({ items: [{ id: 7, name: 'ข้าวต้ม', favorite: false }] }) }
      if (url === '/experimental/seasonings') return { ok: true, json: async () => ({ items: [] }) }
      if (url === '/experimental/recipes/7' && options?.method === 'PATCH') return { ok: true, json: async () => ({ updated: true }) }
      if (url === '/experimental/recipes/7/ingredients' && options?.method === 'PUT') return { ok: true, json: async () => ({ ingredients_updated: true }) }
      if (url === '/experimental/recipes/7') return { ok: true, json: async () => detail }
      return { ok: true, json: async () => response }
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    openRecipes()
    fireEvent.click(await screen.findByRole('button', { name: 'เปิดสูตรนี้' }))
    await screen.findByDisplayValue('ข้าวต้ม')
    fireEvent.change(document.querySelector<HTMLInputElement>('[data-ingredient-index="0"] .field-grid input[type="number"]')!, { target: { value: '75' } })
    fireEvent.change(screen.getByLabelText('ชื่อสูตร'), { target: { value: 'ข้าวต้มของฉัน' } })
    fireEvent.click(screen.getByRole('button', { name: 'เพิ่มในรายการโปรด' }))
    await screen.findByRole('button', { name: 'นำออกจากรายการโปรด' })
    fireEvent.click(screen.getByRole('button', { name: 'บันทึกการเปลี่ยนแปลง' }))
    await screen.findByText('บันทึกการเปลี่ยนแปลงของ “ข้าวต้มของฉัน” แล้ว')
    const replaceCall = fetchMock.mock.calls.find(([url, options]) => url === '/experimental/recipes/7/ingredients' && options?.method === 'PUT')
    expect(JSON.parse(String(replaceCall?.[1]?.body))).toEqual({ synthetic_only: true, ingredients: [
      { ingredient_version_id: 24, amount: '75', unit: 'g', food_state: 'cooked' },
    ] })
    const favoriteCall = fetchMock.mock.calls.find(([url, options]) => url === '/experimental/recipes/7' && options?.method === 'PATCH')
    expect(JSON.parse(String(favoriteCall?.[1]?.body))).toEqual({ synthetic_only: true, favorite: true })
    const renameCall = fetchMock.mock.calls.find(([url, options]) => url === '/experimental/recipes/7' && options?.method === 'PATCH'
      && JSON.parse(String(options?.body)).name)
    expect(JSON.parse(String(renameCall?.[1]?.body))).toEqual({ synthetic_only: true, name: 'ข้าวต้มของฉัน' })
  })

  it('keeps an unsaved draft when opening a saved recipe is cancelled', async () => {
    const fetchMock = vi.fn(async (url: string) => url === '/experimental/recipes'
      ? { ok: true, json: async () => ({ items: [{ id: 7, name: 'ข้าวต้ม', favorite: true }] }) }
      : url === '/experimental/seasonings' ? { ok: true, json: async () => ({ items: [] }) }
        : { ok: true, json: async () => response })
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<App />)
    openRecipes()
    fireEvent.change(screen.getByLabelText(/ชื่อวัตถุดิบ/), { target: { value: 'สูตรที่ยังไม่บันทึก' } })
    fireEvent.change(document.querySelector<HTMLInputElement>('[data-ingredient-index="0"] .field-grid input[type="number"]')!, { target: { value: '55' } })
    fireEvent.click(await screen.findByRole('button', { name: 'เมนูโปรด (1)' }))
    fireEvent.click(await screen.findByRole('button', { name: 'เปิดสูตรนี้' }))
    expect(window.confirm).toHaveBeenCalledOnce()
    expect((screen.getByLabelText(/ชื่อวัตถุดิบ/) as HTMLInputElement).value).toBe('สูตรที่ยังไม่บันทึก')
    expect(document.querySelector<HTMLInputElement>('[data-ingredient-index="0"] .field-grid input[type="number"]')?.value).toBe('55')
    expect(fetchMock.mock.calls.some(([url]) => url === '/experimental/recipes/7')).toBe(false)
  })

  it('restores focus after removing the last favorite and preserves the draft through confirmation', async () => {
    const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === '/experimental/recipes') return { ok: true, json: async () => ({ items: [
        { id: 7, name: 'สูตรทั่วไป', favorite: false }, { id: 8, name: 'ข้าวต้มที่ชอบ', favorite: true },
      ] }) }
      if (url === '/experimental/seasonings') return { ok: true, json: async () => ({ items: [] }) }
      if (url === '/experimental/recipes/8' && options?.method === 'PATCH') return { ok: true, json: async () => ({ updated: true }) }
      return { ok: true, json: async () => response }
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<App />)
    openRecipes()
    expect(await screen.findByText('ข้าวต้มที่ชอบ')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'เมนูโปรด (1)' }))
    fireEvent.change(screen.getByLabelText(/ชื่อวัตถุดิบ/), { target: { value: 'แบบร่างของฉัน' } })
    fireEvent.change(document.querySelector<HTMLInputElement>('[data-ingredient-index="0"] .field-grid input[type="number"]')!, { target: { value: '55' } })

    const removeFavorite = screen.getByRole('button', { name: 'นำออกจากรายการโปรด' })
    removeFavorite.focus()
    fireEvent.click(removeFavorite)
    expect(await screen.findByText(/ยังไม่มีเมนูโปรด/)).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'เมนูโปรด (0)' }))
    expect(window.confirm).not.toHaveBeenCalled()
    expect((screen.getByLabelText(/ชื่อวัตถุดิบ/) as HTMLInputElement).value).toBe('แบบร่างของฉัน')
    expect(document.querySelector<HTMLInputElement>('[data-ingredient-index="0"] .field-grid input[type="number"]')?.value).toBe('55')

    fireEvent.click(screen.getByRole('button', { name: 'สูตรทั้งหมด (2)' }))
    const generalRecipe = screen.getByText('สูตรทั่วไป').closest('li')!
    fireEvent.click(within(generalRecipe).getByRole('button', { name: 'เปิดสูตรนี้' }))
    expect(window.confirm).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls.some(([url]) => url === '/experimental/recipes/7')).toBe(false)
    expect((screen.getByLabelText(/ชื่อวัตถุดิบ/) as HTMLInputElement).value).toBe('แบบร่างของฉัน')
  })

  it('restores focus when removing one of several favorites', async () => {
    const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === '/experimental/recipes') return { ok: true, json: async () => ({ items: [
        { id: 7, name: 'ข้าวต้มมื้อแรก', favorite: true }, { id: 8, name: 'ข้าวต้มมื้อสอง', favorite: true },
      ] }) }
      if (url === '/experimental/seasonings') return { ok: true, json: async () => ({ items: [] }) }
      if (url === '/experimental/recipes/7' && options?.method === 'PATCH') return { ok: true, json: async () => ({ updated: true }) }
      return { ok: true, json: async () => response }
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    openRecipes()
    expect(await screen.findByText('ข้าวต้มมื้อแรก')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'เมนูโปรด (2)' }))

    const firstFavorite = screen.getByText('ข้าวต้มมื้อแรก').closest('li')!
    const removeFavorite = within(firstFavorite).getByRole('button', { name: 'นำออกจากรายการโปรด' })
    removeFavorite.focus()
    fireEvent.click(removeFavorite)
    expect(await screen.findByText('ข้าวต้มมื้อสอง')).toBeTruthy()
    expect(await screen.findByText('นำ “ข้าวต้มมื้อแรก” ออกจากรายการโปรดแล้ว')).toBeTruthy()
    expect(screen.queryByText('ข้าวต้มมื้อแรก')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'เมนูโปรด (1)' }))
  })

  it('previews and explicitly saves USDA values before using them in a reusable recipe', async () => {
    const preview = { fdc_id: 88, name: 'Rice, cooked', source_type: 'Foundation', source_version: 'fixture-v1',
      source_date: '2026-01-01', food_state: 'cooked', basis_quantity: '100', basis_unit: 'g',
      nutrients: { energy_kcal: '130', protein_g: '2.7', sodium_mg: null, potassium_mg: '35', phosphorus_mg: null },
      snapshot_digest: 'fixture-digest' }
    const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === '/experimental/recipes' && options?.method === 'POST') return { ok: true, json: async () => ({ id: 42, name: 'ข้าวต้ม', saved: true }) }
      if (url === '/experimental/recipes') return { ok: true, json: async () => ({ items: [] }) }
      if (url === '/experimental/seasonings') return { ok: true, json: async () => ({ items: [] }) }
      if (url.startsWith('/experimental/usda/search')) return { ok: true, json: async () => ({ items: [{
        fdc_id: 88, description: 'Rice, cooked', source_type: 'Foundation', source_version: 'fixture-v1', food_state: 'cooked',
      }] }) }
      if (url === '/experimental/ingredients/usda/preview') return { ok: true, json: async () => preview }
      if (url === '/experimental/ingredients/usda') return { ok: true, json: async () => ({ ingredient_id: 10, version_id: 31 }) }
      return { ok: true, json: async () => response }
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    openRecipes()
    fireEvent.change(screen.getByLabelText('ชื่ออาหารหรือคำค้นภาษาไทยหรืออังกฤษ'), { target: { value: 'rice cooked' } })
    fireEvent.click(screen.getByRole('button', { name: 'ค้นหา USDA' }))
    fireEvent.click(await screen.findByRole('button', { name: 'เลือกวัตถุดิบนี้' }))
    fireEvent.click(screen.getByRole('button', { name: 'ลบวัตถุดิบ 1' }))
    fireEvent.change(document.querySelector<HTMLInputElement>('[data-ingredient-index="0"] .field-grid input[type="number"]')!, { target: { value: '80' } })
    fireEvent.click(screen.getByRole('button', { name: 'ตรวจข้อมูล USDA ก่อนบันทึกในเครื่อง' }))
    expect(await screen.findByText(/Rice, cooked · Foundation · fixture-v1/)).toBeTruthy()
    expect(screen.getByText(/โซเดียม: ไม่ทราบ/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'ยืนยันและบันทึกวัตถุดิบนี้' })).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('checkbox', { name: 'ตรวจชื่อ สภาพ และค่าสารอาหารแล้ว' }))
    fireEvent.click(screen.getByRole('button', { name: 'ยืนยันและบันทึกวัตถุดิบนี้' }))
    await screen.findByText(/บันทึกข้อมูล USDA รุ่นที่ตรวจแล้วในเครื่อง/)
    fireEvent.change(screen.getByLabelText('ชื่อสูตร'), { target: { value: 'ข้าวต้ม' } })
    fireEvent.click(screen.getByRole('button', { name: 'บันทึกสูตร' }))
    await screen.findByText('บันทึกสูตร “ข้าวต้ม” แล้ว')
    const snapshotCall = fetchMock.mock.calls.find(([url]) => url === '/experimental/ingredients/usda')
    expect(JSON.parse(String(snapshotCall?.[1]?.body))).toEqual({ synthetic_only: true, reviewed: true,
      fdc_id: 88, food_state: 'cooked', snapshot_digest: 'fixture-digest' })
    const createCall = fetchMock.mock.calls.find(([url, options]) => url === '/experimental/recipes' && options?.method === 'POST')
    expect(JSON.parse(String(createCall?.[1]?.body))).toEqual({ synthetic_only: true, name: 'ข้าวต้ม', ingredients: [
      { ingredient_version_id: 31, amount: '80', unit: 'g', food_state: 'cooked' },
    ] })
  })

  it('clears a USDA preview when an earlier duplicate FDC row is removed', async () => {
    const preview = { fdc_id: 88, name: 'Rice, cooked', source_type: 'Foundation', source_version: 'fixture-v1',
      source_date: null, food_state: 'cooked', basis_quantity: '100', basis_unit: 'g',
      nutrients: { energy_kcal: '130', protein_g: '2.7', sodium_mg: null, potassium_mg: '35', phosphorus_mg: null },
      snapshot_digest: 'fixture-digest' }
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/experimental/recipes') return { ok: true, json: async () => ({ items: [] }) }
      if (url === '/experimental/seasonings') return { ok: true, json: async () => ({ items: [] }) }
      if (url.startsWith('/experimental/usda/search')) return { ok: true, json: async () => ({ items: [
        { fdc_id: 88, description: 'Rice, cooked', source_type: 'Foundation', source_version: 'fixture-v1', food_state: 'cooked' },
      ] }) }
      if (url === '/experimental/ingredients/usda/preview') return { ok: true, json: async () => preview }
      return { ok: true, json: async () => response }
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    openRecipes()
    fireEvent.change(screen.getByLabelText('ชื่ออาหารหรือคำค้นภาษาไทยหรืออังกฤษ'), { target: { value: 'rice' } })
    fireEvent.click(screen.getByRole('button', { name: 'ค้นหา USDA' }))
    const choose = await screen.findByRole('button', { name: 'เลือกวัตถุดิบนี้' })
    fireEvent.click(choose)
    fireEvent.click(choose)
    fireEvent.click(screen.getByRole('button', { name: /เพิ่มวัตถุดิบ/ }))
    fireEvent.click(screen.getByRole('button', { name: 'ลบวัตถุดิบ 1' }))
    const reviewButtons = screen.getAllByRole('button', { name: 'ตรวจข้อมูล USDA ก่อนบันทึกในเครื่อง' })
    fireEvent.click(reviewButtons[1])
    await screen.findByText(/Rice, cooked · Foundation · fixture-v1/)
    fireEvent.click(screen.getByRole('button', { name: 'ลบวัตถุดิบ 1' }))
    expect(screen.queryByText(/Rice, cooked · Foundation · fixture-v1/)).toBeNull()
    expect(screen.queryByRole('checkbox', { name: 'ตรวจชื่อ สภาพ และค่าสารอาหารแล้ว' })).toBeNull()
    expect(fetchMock.mock.calls.filter(([url]) => url === '/experimental/ingredients/usda')).toHaveLength(0)
  })

  it('ignores an older USDA preview after a newer row preview completes', async () => {
    let resolveA!: (value: { ok: boolean; json: () => Promise<object> }) => void
    let resolveB!: (value: { ok: boolean; json: () => Promise<object> }) => void
    const pendingA = new Promise<{ ok: boolean; json: () => Promise<object> }>(resolve => { resolveA = resolve })
    const pendingB = new Promise<{ ok: boolean; json: () => Promise<object> }>(resolve => { resolveB = resolve })
    const preview = (fdc_id: number, name: string) => ({ fdc_id, name, source_type: 'Foundation', source_version: 'fixture-v1',
      source_date: null, food_state: 'cooked', basis_quantity: '100', basis_unit: 'g',
      nutrients: { energy_kcal: '100', protein_g: '2', sodium_mg: null, potassium_mg: null, phosphorus_mg: null }, snapshot_digest: `digest-${fdc_id}` })
    const fetchMock = vi.fn((url: string, options?: RequestInit) => {
      if (url === '/experimental/recipes') return Promise.resolve({ ok: true, json: async () => ({ items: [] }) })
      if (url.startsWith('/experimental/ingredients/search')) return Promise.resolve({ ok: true, json: async () => ({ items: [] }) })
      if (url === '/experimental/seasonings') return Promise.resolve({ ok: true, json: async () => ({ items: [] }) })
      if (url.startsWith('/experimental/usda/search')) return Promise.resolve({ ok: true, json: async () => ({ items: [
        { fdc_id: 91, description: 'Rice A cooked', source_type: 'Foundation', source_version: 'fixture-v1', food_state: 'cooked' },
        { fdc_id: 92, description: 'Rice B cooked', source_type: 'Foundation', source_version: 'fixture-v1', food_state: 'cooked' },
      ] }) })
      if (url === '/experimental/ingredients/usda/preview') {
        const fdcId = JSON.parse(String(options?.body)).fdc_id
        return fdcId === 91 ? pendingA : pendingB
      }
      return Promise.resolve({ ok: true, json: async () => response })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    openRecipes()
    fireEvent.change(screen.getByLabelText('ชื่ออาหารหรือคำค้นภาษาไทยหรืออังกฤษ'), { target: { value: 'rice' } })
    fireEvent.click(screen.getByRole('button', { name: 'ค้นหา USDA' }))
    const chooseButtons = await screen.findAllByRole('button', { name: 'เลือกวัตถุดิบนี้' })
    fireEvent.click(chooseButtons[0])
    fireEvent.click(chooseButtons[1])
    const previewButtons = screen.getAllByRole('button', { name: 'ตรวจข้อมูล USDA ก่อนบันทึกในเครื่อง' })
    fireEvent.click(previewButtons[0])
    fireEvent.click(screen.getByRole('button', { name: 'ลบวัตถุดิบ 2' }))
    fireEvent.click(screen.getByRole('button', { name: 'ตรวจข้อมูล USDA ก่อนบันทึกในเครื่อง' }))
    await act(async () => { resolveB({ ok: true, json: async () => preview(92, 'Rice B cooked') }); await pendingB })
    expect(await screen.findByText(/Rice B cooked · Foundation/)).toBeTruthy()
    await act(async () => { resolveA({ ok: true, json: async () => preview(91, 'Rice A cooked') }); await pendingA })
    expect(screen.getByText(/Rice B cooked · Foundation/)).toBeTruthy()
    expect(screen.queryByText(/Rice A cooked · Foundation/)).toBeNull()
  })

  it('keeps the USDA draft and clears confirmation when the snapshot changes', async () => {
    const preview = { fdc_id: 88, name: 'Rice, cooked', source_type: 'Foundation', source_version: 'fixture-v1',
      source_date: null, food_state: 'cooked', basis_quantity: '100', basis_unit: 'g',
      nutrients: { energy_kcal: '130', protein_g: '2.7', sodium_mg: null, potassium_mg: '35', phosphorus_mg: null },
      snapshot_digest: 'stale-digest' }
    const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === '/experimental/recipes') return { ok: true, json: async () => ({ items: [] }) }
      if (url === '/experimental/seasonings') return { ok: true, json: async () => ({ items: [] }) }
      if (url.startsWith('/experimental/usda/search')) return { ok: true, json: async () => ({ items: [{
        fdc_id: 88, description: 'Rice, cooked', source_type: 'Foundation', source_version: 'fixture-v1', food_state: 'cooked',
      }] }) }
      if (url === '/experimental/ingredients/usda/preview') return { ok: true, json: async () => preview }
      if (url === '/experimental/ingredients/usda') return { ok: false, status: 409, json: async () => ({ detail: 'USDA snapshot changed' }) }
      return { ok: true, json: async () => response }
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    openRecipes()
    fireEvent.change(screen.getByLabelText('ชื่ออาหารหรือคำค้นภาษาไทยหรืออังกฤษ'), { target: { value: 'rice cooked' } })
    fireEvent.click(screen.getByRole('button', { name: 'ค้นหา USDA' }))
    fireEvent.click(await screen.findByRole('button', { name: 'เลือกวัตถุดิบนี้' }))
    fireEvent.click(screen.getByRole('button', { name: 'ลบวัตถุดิบ 1' }))
    fireEvent.change(document.querySelector<HTMLInputElement>('[data-ingredient-index="0"] .field-grid input[type="number"]')!, { target: { value: '80' } })
    fireEvent.click(screen.getByRole('button', { name: 'ตรวจข้อมูล USDA ก่อนบันทึกในเครื่อง' }))
    await screen.findByText(/Rice, cooked · Foundation/)
    fireEvent.click(screen.getByRole('checkbox', { name: 'ตรวจชื่อ สภาพ และค่าสารอาหารแล้ว' }))
    fireEvent.click(screen.getByRole('button', { name: 'ยืนยันและบันทึกวัตถุดิบนี้' }))
    expect(await screen.findByText(/ข้อมูล USDA เปลี่ยนหลังตรวจ/)).toBeTruthy()
    expect((screen.getByLabelText('แหล่งข้อมูลวัตถุดิบ 1') as HTMLSelectElement).value).toBe('usda')
    expect((document.querySelector<HTMLInputElement>('[data-ingredient-index="0"] .field-grid input[type="number"]')!).value).toBe('80')
    expect(screen.queryByRole('checkbox', { name: 'ตรวจชื่อ สภาพ และค่าสารอาหารแล้ว' })).toBeNull()
    expect(screen.getByRole('button', { name: 'ตรวจข้อมูล USDA ก่อนบันทึกในเครื่อง' })).toBeTruthy()
  })

  it('searches English USDA entries and submits only selected ID plus amount', async () => {
    const fetchMock = vi.fn(async (url: string) => url.startsWith('/experimental/usda/search')
      ? { ok: true, json: async () => ({ items: [{ fdc_id: 77, description: 'Rice, brown, cooked',
          source_type: 'Foundation', source_version: '2026-01-01', food_state: 'cooked' }] }) }
      : url === '/experimental/seasonings'
        ? { ok: true, json: async () => ({ items: [] }) }
        : { ok: true, json: async () => response })
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    openRecipes()
    fireEvent.change(screen.getByLabelText('ชื่อวัตถุดิบ'), { target: { value: 'Manual rice' } })
    fireEvent.change(screen.getAllByLabelText(/ปริมาณที่ใช้/)[0], { target: { value: '25' } })
    fireEvent.change(screen.getByLabelText('ชื่ออาหารหรือคำค้นภาษาไทยหรืออังกฤษ'), { target: { value: 'brown rice' } })
    fireEvent.click(screen.getByRole('button', { name: 'ค้นหา USDA' }))
    fireEvent.click(await screen.findByRole('button', { name: 'เลือกวัตถุดิบนี้' }))
    expect(screen.getAllByLabelText('ชื่อวัตถุดิบ')[0]).toHaveProperty('value', 'Manual rice')
    expect(screen.getAllByLabelText(/ปริมาณที่ใช้/)[0]).toHaveProperty('value', '25')
    expect(screen.getByText(/USDA FoodData Central.*ID 77.*สภาพ: สุก/)).toBeTruthy()
    expect(screen.getByText(/ไม่ใช่การแปลหรือเทียบอาหารไทย/)).toBeTruthy()
    expect(screen.getAllByText(/รายการอ้างอิงไม่ใช่สินค้าแบรนด์/).length).toBeGreaterThan(1)
    const searchCall = fetchMock.mock.calls.find(([url]) => String(url).startsWith('/experimental/usda/search'))
    expect(new URL(String(searchCall?.[0]), window.location.origin).searchParams.get('q')).toBe('brown rice')
    fireEvent.change(document.querySelector<HTMLInputElement>('[data-ingredient-index="1"] input[type="number"]')!, { target: { value: '100' } })
    fireEvent.click(screen.getByRole('checkbox', { name: /ยืนยันว่ากำลังทดสอบ/ }))
    fireEvent.click(screen.getByRole('button', { name: 'คำนวณสารอาหาร' }))
    expect(fetchMock.mock.calls.some(([url]) => url === '/experimental/recipes/calculate')).toBe(true)
    await screen.findByText('สารอาหารโดยประมาณ · 1 ของสูตร')
    const calculation = fetchMock.mock.calls.find(([url]) => url === '/experimental/recipes/calculate')
    const body = JSON.parse(String(calculation?.[1]?.body))
    expect(body.ingredients[0]).toMatchObject({ source_type: 'manual', amount: '25' })
    expect(body.ingredients[1]).toMatchObject({ source_type: 'usda', fdc_id: 77, amount: '100', unit: 'g' })
    expect(body.ingredients[1]).not.toHaveProperty('energy_kcal')
    expect(body.ingredients[1]).not.toHaveProperty('protein_g')
  })

  it('blocks USDA records with unknown food state and explains how to recover', async () => {
    const fetchMock = vi.fn(async (url: string) => url.startsWith('/experimental/usda/search')
      ? { ok: true, json: async () => ({ items: [
        { fdc_id: 88, description: 'Soup, HEALTHY CHOICE Chicken and Rice Soup, canned, ready-to-serve', source_type: 'Foundation', source_version: 'test-v1', food_state: null },
        { fdc_id: 89, description: 'Soup, chicken, canned', source_type: 'Branded', source_version: 'test-v1', food_state: 'as_sold' },
      ] }) }
      : { ok: true, json: async () => ({ items: [] }) })
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    openRecipes()
    fireEvent.change(screen.getByLabelText('ชื่ออาหารหรือคำค้นภาษาไทยหรืออังกฤษ'), { target: { value: 'chicken and rice soup' } })
    fireEvent.click(screen.getByRole('button', { name: 'ค้นหา USDA' }))
    const select = await screen.findByRole('button', { name: 'เลือกไม่ได้ · ระบุสภาพไม่ได้' })
    expect((select as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/ระบบไม่สามารถระบุจากรายการ USDA นี้ได้ว่าเป็นอาหารดิบหรือสุก/)).toBeTruthy()
    expect((await screen.findByRole('button', { name: 'เลือกไม่ได้ · หมวดนี้ยังไม่รองรับ' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByText(/วัตถุดิบ 2/)).toBeNull()
  })

  it('shows a plain Thai recovery message for USDA state errors', async () => {
    const fetchMock = vi.fn(async (url: string) => url === '/experimental/seasonings'
      ? { ok: true, json: async () => ({ items: [] }) }
      : { ok: false, json: async () => ({ detail: 'USDA record does not identify raw or cooked state' }) })
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    openRecipes()
    fireEvent.change(screen.getAllByLabelText(/ปริมาณที่ใช้/)[0], { target: { value: '100' } })
    fireEvent.click(screen.getByRole('checkbox', { name: /ยืนยันว่ากำลังทดสอบ/ }))
    fireEvent.click(screen.getByRole('button', { name: 'คำนวณสารอาหาร' }))
    expect((await screen.findByRole('alert')).textContent).toContain('ระบบระบุสภาพดิบ/สุกจากรายการ USDA นี้ไม่ได้')
    expect(screen.queryByText(/USDA record does not identify/)).toBeNull()
  })

  it('suggests Thai USDA search terms, preserves USDA records and lets user select cooked food by exact ID', async () => {
    const foods = [
      { fdc_id: 101, description: 'Chicken breast, raw', source_type: 'Foundation', source_version: 'test-v1', food_state: 'raw' },
      { fdc_id: 102, description: 'Chicken breast, cooked', source_type: 'SR Legacy', source_version: 'test-v2', food_state: 'cooked' },
    ]
    const fetchMock = vi.fn(async (url: string) => url.startsWith('/experimental/usda/search')
      ? { ok: true, json: async () => ({ items: foods }) }
      : { ok: true, json: async () => ({ items: [] }) })
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    openRecipes()
    fireEvent.change(screen.getByLabelText('ชื่ออาหารหรือคำค้นภาษาไทยหรืออังกฤษ'), { target: { value: 'อกไก่' } })
    expect(screen.getByText(/คำค้นอังกฤษแนะนำสำหรับ “อกไก่”/)).toBeTruthy()
    expect(screen.getByText('chicken breast')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'ค้นหา USDA ด้วยคำแนะนำ' }))

    const searchCall = fetchMock.mock.calls.find(([url]) => String(url).startsWith('/experimental/usda/search'))
    expect(new URL(String(searchCall?.[0]), window.location.origin).searchParams.get('q')).toBe('chicken breast')
    await screen.findByText('Chicken breast, raw')
    const cookedName = await screen.findByText('Chicken breast, cooked')
    const cookedRecord = cookedName.closest('li')!
    expect(cookedRecord.querySelector('.usda-food-state')?.textContent).toContain('สภาพอาหาร: สุก')
    expect(cookedRecord.querySelector('small')?.textContent).toContain('USDA FDC')

    const cookedResult = cookedName.closest('li')!
    fireEvent.click(within(cookedResult).getByRole('button', { name: 'เลือกวัตถุดิบนี้' }))
    fireEvent.change(document.querySelector<HTMLInputElement>('[data-ingredient-index="1"] input[type="number"]')!, { target: { value: '500' } })
    expect(document.querySelector('[data-ingredient-index="1"] summary')?.textContent).toContain('Chicken breast, cooked')
    expect(document.querySelector('[data-ingredient-index="1"] summary')?.textContent).toContain('500 กรัม')
  })

  it.each([
    ['อกไก่', 'chicken breast'], ['น่องไก่', 'chicken drumstick'], ['สะโพกไก่', 'chicken thigh'],
    ['หมูสันใน', 'pork tenderloin'], ['น้ำปลา', 'fish sauce'], ['ซีอิ๊วขาว', 'light soy sauce'],
    ['ซีอิ๊วดำ', 'dark soy sauce'], ['ซอสหอยนางรม', 'oyster sauce'], ['กะปิ', 'fermented shrimp paste'],
  ])('suggests only the exact Thai term %s as %s', async (thai, english) => {
    const fetchMock = vi.fn(async (url: string) => ({ ok: true, json: async () => ({ items: [] }) }))
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    openRecipes()
    fireEvent.change(screen.getByLabelText('ชื่ออาหารหรือคำค้นภาษาไทยหรืออังกฤษ'), { target: { value: thai } })
    fireEvent.click(screen.getByRole('button', { name: 'ค้นหา USDA ด้วยคำแนะนำ' }))
    const searchCall = fetchMock.mock.calls.find(([url]) => String(url).startsWith('/experimental/usda/search'))
    expect(new URL(String(searchCall?.[0]), window.location.origin).searchParams.get('q')).toBe(english)
  })

  it('does not search USDA when the query is empty', () => {
    const fetchMock = vi.fn(async (url: string) => ({ ok: true, json: async () => ({ items: [] }) }))
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    openRecipes()
    expect((screen.getByRole('button', { name: 'ค้นหา USDA' }) as HTMLButtonElement).disabled).toBe(true)
    expect(fetchMock.mock.calls.some(([url]) => url.startsWith('/experimental/usda/search'))).toBe(false)
  })

  it('offers explicit cut choices for broad chicken and gates unsupported Thai terms', () => {
    const fetchMock = vi.fn(async (url: string) => ({ ok: true, json: async () => ({ items: [] }) }))
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    openRecipes()
    const search = screen.getByRole('button', { name: 'ค้นหา USDA' }) as HTMLButtonElement
    expect(search.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('ชื่ออาหารหรือคำค้นภาษาไทยหรืออังกฤษ'), { target: { value: 'ไก่' } })
    expect(screen.getByRole('group', { name: 'เลือกส่วนของอาหารสำหรับ ไก่' })).toBeTruthy()
    expect((screen.getByRole('button', { name: 'ค้นหา USDA' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'chicken thigh' }))
    expect((screen.getByRole('button', { name: 'ค้นหา USDA ด้วยคำแนะนำ' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'ค้นหา USDA ด้วยคำแนะนำ' }))
    const selectedCall = fetchMock.mock.calls.find(([url]) => String(url).startsWith('/experimental/usda/search'))
    expect(new URL(String(selectedCall?.[0]), window.location.origin).searchParams.get('q')).toBe('chicken thigh')

    fireEvent.change(screen.getByLabelText('ชื่ออาหารหรือคำค้นภาษาไทยหรืออังกฤษ'), { target: { value: 'หมู' } })
    expect(screen.getByText(/ลองระบุชนิดหรือส่วนอาหารให้ชัดขึ้น/)).toBeTruthy()
    expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/experimental/usda/search'))).toHaveLength(1)
  })

  it('previews local query translation and requires explicit USDA search acceptance', async () => {
    const translationRequests: Array<Record<string, unknown>> = []
    const foods = [{ fdc_id: 301, description: 'Chicken breast, raw', source_type: 'Foundation', source_version: 'test-v1', food_state: 'raw' }]
    const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === '/experimental/local-food-translation') {
        const body = JSON.parse(String(options?.body)) as Record<string, unknown>
        translationRequests.push(body)
        return { ok: true, json: async () => ({ translation: body.target_language === 'en' ? 'chicken breast' : 'อกไก่' }) }
      }
      if (url.startsWith('/experimental/usda/search')) return { ok: true, json: async () => ({ items: foods }) }
      if (url === '/experimental/recipes/calculate') return { ok: true, json: async () => response }
      return { ok: true, json: async () => ({ items: [] }) }
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    openRecipes()
    fireEvent.change(screen.getByLabelText('ชื่อวัตถุดิบ'), { target: { value: 'Test item' } })
    fireEvent.change(screen.getAllByLabelText(/ปริมาณที่ใช้/)[0], { target: { value: '100' } })
    const query = screen.getByLabelText('ชื่ออาหารหรือคำค้นภาษาไทยหรืออังกฤษ')
    fireEvent.change(query, { target: { value: 'อกไก่' } })
    fireEvent.click(screen.getByRole('button', { name: 'แปลคำค้นไทยเป็นอังกฤษผ่าน Ollama' }))
    await screen.findByText('chicken breast')
    expect(translationRequests).toEqual([{ text: 'อกไก่', target_language: 'en' }])
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/experimental/usda/search'))).toBe(false)
    expect((query as HTMLInputElement).value).toBe('อกไก่')

    fireEvent.click(screen.getByRole('button', { name: 'ค้นหา USDA ด้วยคำแปลนี้' }))
    await screen.findByText('Chicken breast, raw')
    expect(new URL(String(fetchMock.mock.calls.find(([url]) => String(url).startsWith('/experimental/usda/search'))?.[0]), window.location.origin).searchParams.get('q')).toBe('chicken breast')

    fireEvent.click(screen.getByRole('button', { name: 'แปลชื่อ USDA เป็นไทยผ่าน Ollama' }))
    await screen.findByText('อกไก่')
    const exactResult = screen.getByText('Chicken breast, raw').closest('li')!
    expect(exactResult.querySelector('.usda-food-state')?.textContent).toContain('สภาพอาหาร: ดิบ')
    expect(exactResult.querySelector('small')?.textContent).toContain('USDA FDC')
    expect(exactResult.textContent).toContain('อกไก่')
    fireEvent.click(exactResult.querySelector('button.add-button:last-child')!)
    expect(document.querySelector('[data-ingredient-index="1"] summary')?.textContent).toContain('Chicken breast, raw')
    expect(document.querySelector('[data-ingredient-index="1"] summary')?.textContent).not.toContain('อกไก่')
    fireEvent.change(document.querySelector<HTMLInputElement>('[data-ingredient-index="1"] input[type="number"]')!, { target: { value: '500' } })
    fireEvent.click(screen.getByRole('checkbox', { name: /ยืนยันว่ากำลังทดสอบ/ }))
    expect(Array.from(document.querySelectorAll(':invalid')).map(item => [item.outerHTML, (item as HTMLInputElement).value])).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'คำนวณสารอาหาร' }))
    const calculation = fetchMock.mock.calls.find(([url]) => url === '/experimental/recipes/calculate')
    const payload = JSON.parse(String(calculation?.[1]?.body))
    expect(payload.ingredients[1]).toMatchObject({ source_type: 'usda', fdc_id: 301, food_state: 'raw', amount: '500' })
    expect(payload.ingredients[1]).not.toHaveProperty('description_translation')
  })

  it('ignores a failed query translation after the search text changes', async () => {
    let resolveTranslation!: (value: { ok: boolean; json: () => Promise<{ detail?: string }> }) => void
    const fetchMock = vi.fn((url: string) => url === '/experimental/local-food-translation'
      ? new Promise<{ ok: boolean; json: () => Promise<{ detail?: string }> }>(resolve => { resolveTranslation = resolve })
      : Promise.resolve({ ok: true, json: async () => ({ items: [] }) }))
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    openRecipes()
    const query = screen.getByLabelText('ชื่ออาหารหรือคำค้นภาษาไทยหรืออังกฤษ')
    fireEvent.change(query, { target: { value: 'อกไก่' } })
    fireEvent.click(screen.getByRole('button', { name: 'แปลคำค้นไทยเป็นอังกฤษผ่าน Ollama' }))
    fireEvent.change(query, { target: { value: 'สะโพกไก่' } })
    await act(async () => resolveTranslation({ ok: false, json: async () => ({ detail: 'local error' }) }))
    expect(screen.queryByRole('alert')).toBeNull()
    expect((query as HTMLInputElement).value).toBe('สะโพกไก่')
    expect(screen.getByRole('button', { name: 'ค้นหา USDA ด้วยคำแนะนำ' })).toBeTruthy()
  })

  it('keeps the dictionary search available when local translation fails', async () => {
    const fetchMock = vi.fn(async (url: string) => url === '/experimental/local-food-translation'
      ? { ok: false, json: async () => ({ detail: 'local model unavailable' }) }
      : url.startsWith('/experimental/usda/search')
        ? { ok: true, json: async () => ({ items: [] }) }
        : { ok: true, json: async () => ({ items: [] }) })
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    openRecipes()
    fireEvent.change(screen.getByLabelText('ชื่ออาหารหรือคำค้นภาษาไทยหรืออังกฤษ'), { target: { value: 'อกไก่' } })
    fireEvent.click(screen.getByRole('button', { name: 'แปลคำค้นไทยเป็นอังกฤษผ่าน Ollama' }))
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: 'ค้นหา USDA ด้วยคำแนะนำ' }))
    const searchCall = fetchMock.mock.calls.find(([url]) => String(url).startsWith('/experimental/usda/search'))
    expect(new URL(String(searchCall?.[0]), window.location.origin).searchParams.get('q')).toBe('chicken breast')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('ignores a failed result translation after its USDA result is cleared', async () => {
    let resolveTranslation!: (value: { ok: boolean; json: () => Promise<{ detail?: string }> }) => void
    const fetchMock = vi.fn((url: string) => url === '/experimental/local-food-translation'
      ? new Promise<{ ok: boolean; json: () => Promise<{ detail?: string }> }>(resolve => { resolveTranslation = resolve })
      : url.startsWith('/experimental/usda/search')
        ? Promise.resolve({ ok: true, json: async () => ({ items: [{ fdc_id: 401, description: 'Chicken breast, raw', source_type: 'Foundation', source_version: 'test', food_state: 'raw' }] }) })
        : Promise.resolve({ ok: true, json: async () => ({ items: [] }) }))
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    openRecipes()
    const query = screen.getByLabelText('ชื่ออาหารหรือคำค้นภาษาไทยหรืออังกฤษ')
    fireEvent.change(query, { target: { value: 'chicken breast' } })
    fireEvent.click(screen.getByRole('button', { name: 'ค้นหา USDA' }))
    await screen.findByText('Chicken breast, raw')
    fireEvent.click(screen.getByRole('button', { name: 'แปลชื่อ USDA เป็นไทยผ่าน Ollama' }))
    fireEvent.change(query, { target: { value: 'brown rice' } })
    await act(async () => resolveTranslation({ ok: false, json: async () => ({ detail: 'local error' }) }))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText('Chicken breast, raw')).toBeNull()
    expect((query as HTMLInputElement).value).toBe('brown rice')
  })

  it('translates one USDA result at a time', async () => {
    let resolveTranslation!: (value: { ok: boolean; json: () => Promise<{ translation: string }> }) => void
    let translationCalls = 0
    const fetchMock = vi.fn((url: string) => url === '/experimental/local-food-translation'
      ? (++translationCalls, new Promise<{ ok: boolean; json: () => Promise<{ translation: string }> }>(resolve => { resolveTranslation = resolve }))
      : url.startsWith('/experimental/usda/search')
        ? Promise.resolve({ ok: true, json: async () => ({ items: [
          { fdc_id: 501, description: 'Chicken breast, raw', source_type: 'Foundation', source_version: 'test', food_state: 'raw' },
          { fdc_id: 502, description: 'Chicken thigh, raw', source_type: 'Foundation', source_version: 'test', food_state: 'raw' },
        ] }) })
        : Promise.resolve({ ok: true, json: async () => ({ items: [] }) }))
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    openRecipes()
    fireEvent.change(screen.getByLabelText('ชื่ออาหารหรือคำค้นภาษาไทยหรืออังกฤษ'), { target: { value: 'chicken' } })
    fireEvent.click(screen.getByRole('button', { name: 'ค้นหา USDA' }))
    await screen.findByText('Chicken thigh, raw')
    fireEvent.click(screen.getAllByRole('button', { name: 'แปลชื่อ USDA เป็นไทยผ่าน Ollama' })[0])
    expect((screen.getAllByRole('button', { name: 'แปลชื่อ USDA เป็นไทยผ่าน Ollama' })[0] as HTMLButtonElement).disabled).toBe(true)
    expect(translationCalls).toBe(1)
    await act(async () => resolveTranslation({ ok: true, json: async () => ({ translation: 'อกไก่ดิบ' }) }))
    await screen.findByText('อกไก่ดิบ')
  })

  it('keeps translated USDA queries within the 200-character search limit', async () => {
    const fetchMock = vi.fn(async (url: string) => url === '/experimental/local-food-translation'
      ? { ok: true, json: async () => ({ translation: 'x'.repeat(201) }) }
      : { ok: true, json: async () => ({ items: [] }) })
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    openRecipes()
    fireEvent.change(screen.getByLabelText('ชื่ออาหารหรือคำค้นภาษาไทยหรืออังกฤษ'), { target: { value: 'เนื้อสัตว์ชื่อยาว' } })
    fireEvent.click(screen.getByRole('button', { name: 'แปลคำค้นไทยเป็นอังกฤษผ่าน Ollama' }))
    expect(await screen.findByText(/คำแปลเกินขีดจำกัด USDA 200 ตัวอักษร/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'ค้นหา USDA ด้วยคำแปลนี้' }) as HTMLButtonElement).disabled).toBe(true)
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/experimental/usda/search'))).toBe(false)
  })

  it('discards a delayed USDA response after changing the selected Thai cut', async () => {
    let resolveSearch!: (value: { ok: boolean; json: () => Promise<{ items: unknown[] }> }) => void
    const fetchMock = vi.fn((url: string) => url.startsWith('/experimental/usda/search')
      ? new Promise<{ ok: boolean; json: () => Promise<{ items: unknown[] }> }>(resolve => { resolveSearch = resolve })
      : Promise.resolve({ ok: true, json: async () => ({ items: [] }) }))
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    openRecipes()
    fireEvent.change(screen.getByLabelText('ชื่ออาหารหรือคำค้นภาษาไทยหรืออังกฤษ'), { target: { value: 'ไก่' } })
    fireEvent.click(screen.getByRole('button', { name: 'chicken breast' }))
    fireEvent.click(screen.getByRole('button', { name: 'ค้นหา USDA ด้วยคำแนะนำ' }))
    fireEvent.click(screen.getByRole('button', { name: 'chicken thigh' }))
    await act(async () => resolveSearch({ ok: true, json: async () => ({ items: [
      { fdc_id: 201, description: 'Chicken breast, raw', source_type: 'Foundation', source_version: 'test', food_state: 'raw' },
    ] }) }))
    expect(screen.queryByText('Chicken breast, raw')).toBeNull()
    expect((screen.getByRole('button', { name: 'ค้นหา USDA ด้วยคำแนะนำ' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('clears already loaded USDA results when the selected Thai cut changes', async () => {
    const fetchMock = vi.fn(async (url: string) => url.startsWith('/experimental/usda/search')
      ? { ok: true, json: async () => ({ items: [
        { fdc_id: 202, description: 'Chicken breast, raw', source_type: 'Foundation', source_version: 'test', food_state: 'raw' },
      ] }) }
      : { ok: true, json: async () => ({ items: [] }) })
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    openRecipes()
    fireEvent.change(screen.getByLabelText('ชื่ออาหารหรือคำค้นภาษาไทยหรืออังกฤษ'), { target: { value: 'ไก่' } })
    fireEvent.click(screen.getByRole('button', { name: 'chicken breast' }))
    fireEvent.click(screen.getByRole('button', { name: 'ค้นหา USDA ด้วยคำแนะนำ' }))
    await screen.findByText('Chicken breast, raw')
    fireEvent.click(screen.getByRole('button', { name: 'chicken thigh' }))
    expect(screen.queryByText('Chicken breast, raw')).toBeNull()
  })

  it('treats prototype property names as ordinary English USDA queries', () => {
    const fetchMock = vi.fn(async (url: string) => ({ ok: true, json: async () => ({ items: [] }) }))
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    openRecipes()
    fireEvent.change(screen.getByLabelText('ชื่ออาหารหรือคำค้นภาษาไทยหรืออังกฤษ'), { target: { value: 'constructor' } })
    fireEvent.click(screen.getByRole('button', { name: 'ค้นหา USDA' }))
    const searchCall = fetchMock.mock.calls.find(([url]) => String(url).startsWith('/experimental/usda/search'))
    expect(new URL(String(searchCall?.[0]), window.location.origin).searchParams.get('q')).toBe('constructor')
  })

  it('blocks USDA records with unknown preparation state before calculation', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.startsWith('/experimental/usda/search')
      ? { ok: true, json: async () => ({ items: [{ fdc_id: 78, description: 'Rice', source_type: 'Foundation', source_version: null, food_state: null }] }) }
      : { ok: true, json: async () => ({ items: [] }) }))
    render(<App />)
    openRecipes()
    fireEvent.change(screen.getByLabelText('ชื่ออาหารหรือคำค้นภาษาไทยหรืออังกฤษ'), { target: { value: 'rice' } })
    fireEvent.click(screen.getByRole('button', { name: 'ค้นหา USDA' }))
    expect((await screen.findByRole('button', { name: 'เลือกไม่ได้ · ระบุสภาพไม่ได้' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/ระบบไม่สามารถระบุจากรายการ USDA นี้ได้ว่าเป็นอาหารดิบหรือสุก/)).toBeTruthy()
    expect(screen.queryByLabelText('แหล่งข้อมูลวัตถุดิบ 2')).toBeNull()
  })

  it('keeps selected USDA name tied to ID and lets source switch clear it to manual', async () => {
    const fetchMock = vi.fn(async (url: string) => url.startsWith('/experimental/usda/search')
      ? { ok: true, json: async () => ({ items: [{ fdc_id: 79, description: 'Rice, cooked', source_type: 'Foundation', source_version: null, food_state: 'cooked' }] }) }
      : url === '/experimental/seasonings' ? { ok: true, json: async () => ({ items: [] }) }
        : { ok: true, json: async () => response })
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    openRecipes()
    fireEvent.change(screen.getByLabelText('ชื่ออาหารหรือคำค้นภาษาไทยหรืออังกฤษ'), { target: { value: 'rice' } })
    fireEvent.click(screen.getByRole('button', { name: 'ค้นหา USDA' }))
    fireEvent.click(await screen.findByRole('button', { name: 'เลือกวัตถุดิบนี้' }))
    expect(screen.getAllByLabelText('ชื่อวัตถุดิบ')).toHaveLength(1)
    const source = screen.getByLabelText('แหล่งข้อมูลวัตถุดิบ 2')
    expect((source as HTMLSelectElement).value).toBe('usda')
    fireEvent.change(source, { target: { value: 'manual' } })
    expect(screen.getAllByLabelText('ชื่อวัตถุดิบ').at(-1)).toHaveProperty('value', 'Rice, cooked')
    expect((screen.getAllByLabelText(/หน่วยปริมาณ/)[1] as HTMLSelectElement).disabled).toBe(false)
    fireEvent.change(document.querySelector<HTMLInputElement>('[data-ingredient-index="1"] input[type="number"]')!, { target: { value: '50' } })
    expect(screen.queryByText(/USDA FoodData Central · ID 79/)).toBeNull()
    fireEvent.change(document.querySelector<HTMLInputElement>('[data-ingredient-index="0"] input[type="number"]')!, { target: { value: '10' } })
    fireEvent.click(screen.getByRole('checkbox', { name: /ยืนยันว่ากำลังทดสอบ/ }))
    fireEvent.click(screen.getByRole('button', { name: 'คำนวณสารอาหาร' }))
    const calculation = fetchMock.mock.calls.find(([url]) => url === '/experimental/recipes/calculate')
    const body = JSON.parse(String(calculation?.[1]?.body))
    expect(body.ingredients[1]).toMatchObject({ source_type: 'manual', amount: '50' })
    expect(body.ingredients[1]).not.toHaveProperty('fdc_id')
  })

  it('collapses the previous ingredient, opens the new one, and preserves inputs on reopen', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ items: [] }) })))
    render(<App />)
    openRecipes()
    const firstAmount = document.querySelector<HTMLInputElement>('[data-ingredient-index="0"] input[type="number"]')!
    fireEvent.change(screen.getByLabelText('ชื่อวัตถุดิบ'), { target: { value: 'ข้าวสวย' } })
    fireEvent.change(firstAmount, { target: { value: '150' } })
    fireEvent.click(screen.getByRole('button', { name: /เพิ่มวัตถุดิบ/ }))

    const cards = Array.from(document.querySelectorAll<HTMLDetailsElement>('.ingredient-details'))
    expect(cards[0].open).toBe(false)
    expect(cards[1].open).toBe(true)
    expect(cards[0].querySelector('summary')?.textContent).toContain('ข้าวสวย')
    expect(cards[0].querySelector('summary')?.textContent).toContain('150 กรัม')
    expect(cards[0].querySelector('summary')?.tabIndex).toBe(0)

    fireEvent.click(cards[0].querySelector('summary')!)
    expect(cards[0].open).toBe(true)
    expect(cards[1].open).toBe(false)
    expect(firstAmount.value).toBe('150')
  })

  it('opens the first collapsed ingredient when browser validation reports its hidden control', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ items: [] }) })))
    render(<App />)
    openRecipes()
    fireEvent.click(screen.getByRole('button', { name: /เพิ่มวัตถุดิบ/ }))
    const first = document.querySelector<HTMLDetailsElement>('[data-ingredient-index="0"]')!
    const firstAmount = first.querySelector<HTMLInputElement>('input[required]')!
    expect(first.open).toBe(false)
    expect(firstAmount.checkValidity()).toBe(false)
    await act(async () => { await Promise.resolve() })
    expect(first.open).toBe(true)
    expect(document.activeElement).toBe(firstAmount)
  })

  it('keeps the remaining ingredient values when a different card is removed', () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ items: [] }) })))
    render(<App />)
    openRecipes()
    fireEvent.click(screen.getByRole('button', { name: /เพิ่มวัตถุดิบ/ }))
    const second = document.querySelector<HTMLDetailsElement>('[data-ingredient-index="1"]')!
    const secondName = second.querySelector<HTMLInputElement>('input[autocomplete="off"]')!
    const secondAmount = second.querySelector<HTMLInputElement>('input[required]')!
    fireEvent.change(secondName, { target: { value: 'ผักสมมติ' } })
    fireEvent.change(secondAmount, { target: { value: '25' } })
    fireEvent.click(screen.getByRole('button', { name: 'ลบวัตถุดิบ 1' }))
    const remaining = document.querySelector<HTMLDetailsElement>('[data-ingredient-index="0"]')!
    expect(remaining.open).toBe(true)
    expect(remaining.querySelector('summary')?.textContent).toContain('ผักสมมติ')
    expect(remaining.querySelector('summary')?.textContent).toContain('25 กรัม')
    expect(remaining.querySelector<HTMLInputElement>('input[autocomplete="off"]')?.value).toBe('ผักสมมติ')
    expect(remaining.querySelector<HTMLInputElement>('input[required]')?.value).toBe('25')
  })

  it.each([
    ['editing an ingredient', () => fireEvent.change(screen.getAllByLabelText(/ปริมาณที่ใช้/)[0], { target: { value: '200' } })],
    ['adding an ingredient', () => fireEvent.click(screen.getByRole('button', { name: /เพิ่มวัตถุดิบ/ }))],
    ['removing an ingredient', () => {
      fireEvent.click(screen.getByRole('button', { name: /เพิ่มวัตถุดิบ/ }))
      fireEvent.click(screen.getByRole('button', { name: 'ลบวัตถุดิบ 2' }))
    }],
    ['changing the portion', () => fireEvent.change(screen.getByLabelText('สัดส่วนของสูตรที่รับประทาน'), { target: { value: '0.5' } })],
  ])('hides delayed totals after %s', async (_change, change) => {
    let resolveFetch!: (value: { ok: boolean; json: () => Promise<typeof response> }) => void
    const delayedResponse = new Promise<{ ok: boolean; json: () => Promise<typeof response> }>(resolve => { resolveFetch = resolve })
    const fetchMock = vi.fn(() => delayedResponse)
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    openRecipes()

    fireEvent.change(screen.getAllByLabelText(/ปริมาณที่ใช้/)[0], { target: { value: '100' } })
    fireEvent.click(screen.getByRole('checkbox', { name: /ยืนยันว่ากำลังทดสอบ/ }))
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

  it('searches local reviewed Thai entries first and submits only saved version ID', async () => {
    const saved = { ingredient_id: 8, version_id: 24, name: 'ข้าวสมมติ', brand: null,
      version: 'synthetic-v1', provider: 'user-entered', source_version: 'reviewed fixture',
      source_date: null, retrieved_on: '2026-11-02', source_reference: 'synthetic source',
      provenance: 'synthetic user-reviewed fixture', basis_quantity: '100', basis_unit: 'g',
      food_state: 'cooked', reviewed: true,
      nutrients: { energy_kcal: '123', protein_g: null, sodium_mg: '0', potassium_mg: null, phosphorus_mg: null } }
    const fetchMock = vi.fn(async (url: string) => url.startsWith('/experimental/ingredients/search')
      ? { ok: true, json: async () => ({ items: [saved], local_only: true }) }
      : url === '/experimental/seasonings'
        ? { ok: true, json: async () => ({ items: [] }) }
        : { ok: true, json: async () => response })
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    openRecipes()
    fireEvent.change(screen.getByLabelText('ชื่อที่บันทึกไว้'), { target: { value: 'ข้าวสมมติ' } })
    fireEvent.click(screen.getByRole('button', { name: 'ค้นหารายการในเครื่อง' }))
    fireEvent.click(await screen.findByRole('button', { name: 'เลือกเป็นรายการใหม่' }))
    expect(screen.getByText(/รายการในเครื่อง · รุ่น 24/)).toBeTruthy()
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/experimental/usda/search'))).toBe(false)
    fireEvent.change(document.querySelector<HTMLInputElement>('[data-ingredient-index="0"] input[type="number"]')!, { target: { value: '100' } })
    fireEvent.change(document.querySelector<HTMLInputElement>('[data-ingredient-index="1"] input[type="number"]')!, { target: { value: '50' } })
    fireEvent.click(screen.getByRole('checkbox', { name: /ยืนยันว่ากำลังทดสอบ/ }))
    fireEvent.click(screen.getByRole('button', { name: 'คำนวณสารอาหาร' }))
    expect(fetchMock.mock.calls.some(([url]) => url === '/experimental/recipes/calculate')).toBe(true)
    await screen.findByText('สารอาหารโดยประมาณ · 1 ของสูตร')
    const calculation = fetchMock.mock.calls.find(([url]) => url === '/experimental/recipes/calculate')
    const body = JSON.parse(String(calculation?.[1]?.body))
    expect(body.ingredients[1]).toMatchObject({ source_type: 'saved', ingredient_version_id: 24, amount: '50', unit: 'g', food_state: 'cooked' })
    expect(body.ingredients[1]).not.toHaveProperty('energy_kcal')
    expect(body.ingredients[1]).not.toHaveProperty('sodium_mg')
  })

  it('clears saved values when switching the selected record to manual', async () => {
    const saved = { ingredient_id: 8, version_id: 24, name: 'ข้าวสมมติ', brand: null,
      version: 'synthetic-v1', provider: 'user-entered', source_version: 'reviewed fixture',
      source_date: null, retrieved_on: '2026-11-02', source_reference: 'synthetic source',
      provenance: 'synthetic user-reviewed fixture', basis_quantity: '100', basis_unit: 'g',
      food_state: 'cooked', reviewed: true,
      nutrients: { energy_kcal: '123', protein_g: null, sodium_mg: '0', potassium_mg: null, phosphorus_mg: null } }
    const fetchMock = vi.fn(async (url: string) => url.startsWith('/experimental/ingredients/search')
      ? { ok: true, json: async () => ({ items: [saved], local_only: true }) }
      : { ok: true, json: async () => ({ items: [] }) })
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    openRecipes()
    fireEvent.change(screen.getByLabelText('ชื่อที่บันทึกไว้'), { target: { value: 'ข้าวสมมติ' } })
    fireEvent.click(screen.getByRole('button', { name: 'ค้นหารายการในเครื่อง' }))
    fireEvent.click(await screen.findByRole('button', { name: 'เลือกเป็นรายการใหม่' }))
    fireEvent.change(screen.getAllByLabelText(/แหล่งข้อมูลวัตถุดิบ/)[1], { target: { value: 'manual' } })
    expect(screen.queryByText(/รายการในเครื่อง · รุ่น 24/)).toBeNull()
    expect(document.querySelector<HTMLInputElement>('[data-ingredient-index="1"] .nutrient-grid input')?.value).toBe('')
  })

  it('clears and ignores delayed local results after the Thai query changes', async () => {
    let releaseSearch!: (value: { ok: boolean; json: () => Promise<{ items: object[] }> }) => void
    const delayedSearch = new Promise<{ ok: boolean; json: () => Promise<{ items: object[] }> }>(resolve => { releaseSearch = resolve })
    const staleItem = { ingredient_id: 8, version_id: 24, name: 'ผลเก่า', brand: null,
      version: 'v1', provider: 'local', source_version: 'reviewed', source_date: null,
      retrieved_on: '2026-11-02', source_reference: 'synthetic', provenance: 'synthetic fixture',
      basis_quantity: '100', basis_unit: 'g', food_state: 'cooked', reviewed: true,
      nutrients: { energy_kcal: '1', protein_g: null, sodium_mg: null, potassium_mg: null, phosphorus_mg: null } }
    const fetchMock = vi.fn((url: string) => url.startsWith('/experimental/ingredients/search')
      ? delayedSearch
      : Promise.resolve({ ok: true, json: async () => ({ items: [] }) }))
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    openRecipes()
    const query = screen.getByLabelText('ชื่อที่บันทึกไว้')
    fireEvent.change(query, { target: { value: 'คำค้นเก่า' } })
    fireEvent.click(screen.getByRole('button', { name: 'ค้นหารายการในเครื่อง' }))
    fireEvent.change(query, { target: { value: 'คำค้นใหม่' } })
    expect(screen.queryByText('ผลเก่า')).toBeNull()
    await act(async () => { releaseSearch({ ok: true, json: async () => ({ items: [staleItem] }) }); await delayedSearch })
    expect(screen.queryByText('ผลเก่า')).toBeNull()
  })

  it('clears previous USDA results and ignores an older delayed result after the query changes', async () => {
    let resolveStale!: (value: { ok: boolean; json: () => Promise<{ items: object[] }> }) => void
    const staleSearch = new Promise<{ ok: boolean; json: () => Promise<{ items: object[] }> }>(resolve => { resolveStale = resolve })
    const item = (fdc_id: number, description: string) => ({ fdc_id, description, source_type: 'Foundation', source_version: 'synthetic', food_state: 'cooked' })
    const fetchMock = vi.fn((url: string) => {
      if (url.startsWith('/experimental/usda/search')) {
        const query = new URL(url, window.location.origin).searchParams.get('q')
        if (query === 'first') return Promise.resolve({ ok: true, json: async () => ({ items: [item(91, 'Previous synthetic result')] }) })
        if (query === 'stale') return staleSearch
        if (query === 'fresh') return Promise.resolve({ ok: true, json: async () => ({ items: [item(93, 'Current synthetic result')] }) })
      }
      return Promise.resolve({ ok: true, json: async () => ({ items: [] }) })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    openRecipes()
    const query = screen.getByLabelText('ชื่ออาหารหรือคำค้นภาษาไทยหรืออังกฤษ')
    const search = () => fireEvent.click(screen.getByRole('button', { name: 'ค้นหา USDA' }))

    fireEvent.change(query, { target: { value: 'first' } })
    search()
    await screen.findByText('Previous synthetic result')
    fireEvent.change(query, { target: { value: 'stale' } })
    expect(screen.queryByText('Previous synthetic result')).toBeNull()
    search()
    fireEvent.change(query, { target: { value: 'fresh' } })
    search()
    await screen.findByText('Current synthetic result')

    await act(async () => {
      resolveStale({ ok: true, json: async () => ({ items: [item(92, 'Stale synthetic result')] }) })
      await staleSearch
    })
    expect(screen.getByText('Current synthetic result')).toBeTruthy()
    expect(screen.queryByText('Stale synthetic result')).toBeNull()
  })

  it('ignores a delayed USDA error after the query changes', async () => {
    let rejectStale!: (error: Error) => void
    const staleSearch = new Promise<never>((_resolve, reject) => { rejectStale = reject })
    const fetchMock = vi.fn((url: string) => url.startsWith('/experimental/usda/search')
      ? staleSearch
      : Promise.resolve({ ok: true, json: async () => ({ items: [] }) }))
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    openRecipes()
    const query = screen.getByLabelText('ชื่ออาหารหรือคำค้นภาษาไทยหรืออังกฤษ')
    fireEvent.change(query, { target: { value: 'old synthetic query' } })
    fireEvent.click(screen.getByRole('button', { name: 'ค้นหา USDA' }))
    fireEvent.change(query, { target: { value: 'new synthetic query' } })

    await act(async () => { rejectStale(new Error('synthetic delayed failure')) })
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
