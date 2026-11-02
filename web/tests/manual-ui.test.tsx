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
    await screen.findByText('สารอาหารโดยประมาณ · 1 ส่วน')
    const calculation = fetchMock.mock.calls.find(([url]) => url === '/experimental/recipes/calculate')
    const body = JSON.parse(String(calculation?.[1]?.body))
    expect(body.ingredients[0].seasoning_version_id).toBe(42)
    expect(body.ingredients[0]).toMatchObject({ unit: 'ml', food_state: 'as_sold', reference_quantity: '15' })
    expect(body.ingredients[0]).not.toHaveProperty('sodium_mg')
  })

  it('requires synthetic-only confirmation', () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ items: [] }) }))
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
    fireEvent.change(screen.getByLabelText('ชื่ออาหารภาษาอังกฤษ'), { target: { value: 'brown rice' } })
    fireEvent.click(screen.getByRole('button', { name: 'ค้นหา USDA' }))
    fireEvent.click(await screen.findByRole('button', { name: 'เพิ่มเป็นรายการใหม่' }))
    expect(screen.getAllByLabelText('ชื่อวัตถุดิบ')[0]).toHaveProperty('value', 'Manual rice')
    expect(screen.getAllByLabelText(/ปริมาณที่ใช้/)[0]).toHaveProperty('value', '25')
    expect(screen.getByText(/USDA FoodData Central.*ID 77.*สภาพ: สุก/)).toBeTruthy()
    expect(screen.getByText(/ไม่ใช่การแปลหรือเทียบอาหารไทย/)).toBeTruthy()
    expect(screen.getAllByText(/รายการอ้างอิงไม่ใช่สินค้าแบรนด์/).length).toBeGreaterThan(1)
    fireEvent.change(document.querySelector<HTMLInputElement>('[data-ingredient-index="1"] input[type="number"]')!, { target: { value: '100' } })
    fireEvent.click(screen.getByRole('checkbox', { name: /ยืนยันว่ากำลังทดสอบ/ }))
    fireEvent.click(screen.getByRole('button', { name: 'คำนวณสารอาหาร' }))
    expect(fetchMock.mock.calls.some(([url]) => url === '/experimental/recipes/calculate')).toBe(true)
    await screen.findByText('สารอาหารโดยประมาณ · 1 ส่วน')
    const calculation = fetchMock.mock.calls.find(([url]) => url === '/experimental/recipes/calculate')
    const body = JSON.parse(String(calculation?.[1]?.body))
    expect(body.ingredients[0]).toMatchObject({ source_type: 'manual', amount: '25' })
    expect(body.ingredients[1]).toMatchObject({ source_type: 'usda', fdc_id: 77, amount: '100', unit: 'g' })
    expect(body.ingredients[1]).not.toHaveProperty('energy_kcal')
    expect(body.ingredients[1]).not.toHaveProperty('protein_g')
  })

  it('shows unknown preparation state and leaves server to block calculation', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.startsWith('/experimental/usda/search')
      ? { ok: true, json: async () => ({ items: [{ fdc_id: 78, description: 'Rice', source_type: 'Foundation', source_version: null, food_state: null }] }) }
      : { ok: true, json: async () => ({ items: [] }) }))
    render(<App />)
    openRecipes()
    fireEvent.change(screen.getByLabelText('ชื่ออาหารภาษาอังกฤษ'), { target: { value: 'rice' } })
    fireEvent.click(screen.getByRole('button', { name: 'ค้นหา USDA' }))
    fireEvent.click(await screen.findByRole('button', { name: 'เพิ่มเป็นรายการใหม่' }))
    expect(screen.getAllByText(/ไม่ระบุสภาพ · ยังใช้คำนวณไม่ได้/).length).toBeGreaterThan(0)
    expect((screen.getAllByLabelText(/หน่วยปริมาณ/)[1] as HTMLSelectElement).disabled).toBe(true)
  })

  it('keeps selected USDA name tied to ID and lets source switch clear it to manual', async () => {
    const fetchMock = vi.fn(async (url: string) => url.startsWith('/experimental/usda/search')
      ? { ok: true, json: async () => ({ items: [{ fdc_id: 79, description: 'Rice, cooked', source_type: 'Foundation', source_version: null, food_state: 'cooked' }] }) }
      : url === '/experimental/seasonings' ? { ok: true, json: async () => ({ items: [] }) }
        : { ok: true, json: async () => response })
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    openRecipes()
    fireEvent.change(screen.getByLabelText('ชื่ออาหารภาษาอังกฤษ'), { target: { value: 'rice' } })
    fireEvent.click(screen.getByRole('button', { name: 'ค้นหา USDA' }))
    fireEvent.click(await screen.findByRole('button', { name: 'เพิ่มเป็นรายการใหม่' }))
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
    ['changing the portion', () => fireEvent.change(screen.getByLabelText('สัดส่วนที่เสิร์ฟ'), { target: { value: '0.5' } })],
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
    await screen.findByText('สารอาหารโดยประมาณ · 1 ส่วน')
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
    const query = screen.getByLabelText('ชื่ออาหารภาษาอังกฤษ')
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
    const query = screen.getByLabelText('ชื่ออาหารภาษาอังกฤษ')
    fireEvent.change(query, { target: { value: 'old synthetic query' } })
    fireEvent.click(screen.getByRole('button', { name: 'ค้นหา USDA' }))
    fireEvent.change(query, { target: { value: 'new synthetic query' } })

    await act(async () => { rejectStale(new Error('synthetic delayed failure')) })
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
