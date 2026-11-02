import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { OcrPreview } from '../src/OcrPreview'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

function chooseTestImage() {
  const image = new File(['test'], 'synthetic.png', { type: 'image/png' })
  image.arrayBuffer = async () => new Uint8Array([1, 2, 3]).buffer
  fireEvent.change(screen.getByLabelText(/ถ่ายหรือเลือกภาพ/), { target: { files: [image] } })
}

it('shows untrusted OCR text beside image and does not autofill fields', async () => {
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: vi.fn() })
  const fetchMock = vi.fn(async (url: string) => url === '/experimental/seasonings'
    ? { ok: true, json: async () => ({ items: [] }) }
    : { ok: true, json: async () => ({ text: 'โซเดียม 100 มก.', suggestions: { name: { value: 'แต่งข้อมูล', evidence: 'unmatched' } } }) })
  vi.stubGlobal('fetch', fetchMock)
  render(<OcrPreview />)
  chooseTestImage()
  fireEvent.click(screen.getByRole('checkbox', { name: /ภาพทดสอบ/ }))
  await act(async () => {
    fireEvent.submit(screen.getByRole('button', { name: 'อ่านข้อความจากภาพ' }).closest('form')!)
  })
  expect(screen.getByAltText('ภาพฉลากทดสอบที่เลือก')).toBeTruthy()
  expect(screen.getByText('โซเดียม 100 มก.')).toBeTruthy()
  expect(screen.getByLabelText('ชื่อเครื่องปรุง')).toHaveProperty('value', '')
  expect(screen.getByText(/OCR ยังไม่มีข้อเสนอที่ตรวจสอบได้/)).toBeTruthy()
  expect(fetchMock).toHaveBeenCalledWith('/experimental/ocr', expect.objectContaining({ method: 'POST' }))
})

it('fills only blank fields after an explicit action and resets review', async () => {
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: vi.fn() })
  const suggestions = {
    basis_quantity: '100', basis_unit: 'g', basis_conflict: false, requires_human_review: true,
    nutrients: { energy_kcal: '12', protein_g: null, sodium_mg: '40', potassium_mg: null, phosphorus_mg: '0' },
  }
  const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/experimental/ocr') return { ok: true, json: async () => ({ text: 'ข้อความจากฉลาก', suggestions, requires_human_review: true }) }
    if (options?.method === 'POST') return { ok: true, json: async () => ({ ingredient_id: 8, version_id: 14 }) }
    return { ok: true, json: async () => ({ items: [] }) }
  })
  vi.stubGlobal('fetch', fetchMock)
  render(<OcrPreview />)
  chooseTestImage()
  fireEvent.click(screen.getByRole('checkbox', { name: /ภาพทดสอบ/ }))
  fireEvent.change(screen.getByLabelText('ชื่อเครื่องปรุง'), { target: { value: 'ชื่อกรอกเอง' } })
  fireEvent.change(screen.getByLabelText('ข้อมูลต่อปริมาณ'), { target: { value: '100' } })
  fireEvent.change(screen.getByLabelText('หน่วยฐาน'), { target: { value: 'g' } })
  fireEvent.change(screen.getByLabelText(/โซเดียม/), { target: { value: '500' } })
  await act(async () => { fireEvent.submit(screen.getByRole('button', { name: 'อ่านข้อความจากภาพ' }).closest('form')!) })
  expect(screen.getByLabelText('ชื่อเครื่องปรุง')).toHaveProperty('value', 'ชื่อกรอกเอง')
  expect(screen.getByLabelText('ข้อมูลต่อปริมาณ')).toHaveProperty('value', '100')
  expect(screen.getByLabelText(/โซเดียม/)).toHaveProperty('value', '500')
  const apply = screen.getByRole('button', { name: 'เติมช่องว่างจาก OCR' })
  expect((apply as HTMLButtonElement).disabled).toBe(false)
  fireEvent.click(apply)
  expect(screen.getByLabelText('ข้อมูลต่อปริมาณ')).toHaveProperty('value', '100')
  expect(screen.getByLabelText('หน่วยฐาน')).toHaveProperty('value', 'g')
  expect(screen.getByLabelText(/พลังงาน/)).toHaveProperty('value', '12')
  expect(screen.getByLabelText(/โซเดียม/)).toHaveProperty('value', '500')
  expect(screen.getByLabelText(/ฟอสฟอรัส/)).toHaveProperty('value', '0')
  expect((screen.getByRole('checkbox', { name: /ตรวจชื่อ/ }) as HTMLInputElement).checked).toBe(false)
  expect((screen.getByRole('button', { name: 'บันทึกเครื่องปรุงทดลอง' }) as HTMLButtonElement).disabled).toBe(true)
})

it('does not attach an OCR basis to manually entered nutrients with no basis', async () => {
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: vi.fn() })
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url === '/experimental/ocr'
    ? { ok: true, json: async () => ({ text: 'test', requires_human_review: true, suggestions: {
      basis_quantity: '100', basis_unit: 'g', basis_conflict: false, requires_human_review: true,
      nutrients: { energy_kcal: '12', protein_g: null, sodium_mg: '40', potassium_mg: null, phosphorus_mg: null },
    } }) }
    : { ok: true, json: async () => ({ items: [] }) }))
  render(<OcrPreview />)
  chooseTestImage()
  fireEvent.click(screen.getByRole('checkbox', { name: /ภาพทดสอบ/ }))
  fireEvent.change(screen.getByLabelText(/โซเดียม/), { target: { value: '500' } })
  await act(async () => { fireEvent.submit(screen.getByRole('button', { name: 'อ่านข้อความจากภาพ' }).closest('form')!) })
  expect((screen.getByRole('button', { name: 'เติมช่องว่างจาก OCR' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByLabelText('ข้อมูลต่อปริมาณ')).toHaveProperty('value', '')
})

it('saves only reviewed user-entered values and keeps unknown nutrients null', async () => {
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: vi.fn() })
  const saved = { items: [{ ingredient_id: 3, version_id: 9, name: 'ซอสตัวอย่าง', brand: null, basis_quantity: '100', basis_unit: 'g', nutrients: { energy_kcal: null, protein_g: null, sodium_mg: '120', potassium_mg: null, phosphorus_mg: null } }] }
  let hasSaved = false
  const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/experimental/ocr') return { ok: true, json: async () => ({ text: 'ฉลากทดสอบ' }) }
    if (options?.method === 'POST') { hasSaved = true; return { ok: true, json: async () => ({ ingredient_id: 3, version_id: 9 }) } }
    return { ok: true, json: async () => ({ items: hasSaved ? saved.items : [] }) }
  })
  vi.stubGlobal('fetch', fetchMock)
  render(<OcrPreview />)
  chooseTestImage()
  fireEvent.click(screen.getByRole('checkbox', { name: /ภาพทดสอบ/ }))
  await act(async () => { fireEvent.submit(screen.getByRole('button', { name: 'อ่านข้อความจากภาพ' }).closest('form')!) })
  fireEvent.change(screen.getByLabelText('ชื่อเครื่องปรุง'), { target: { value: 'ซอสตัวอย่าง' } })
  fireEvent.change(screen.getByLabelText('ข้อมูลต่อปริมาณ'), { target: { value: '100' } })
  fireEvent.change(screen.getByLabelText('หน่วยฐาน'), { target: { value: 'g' } })
  fireEvent.change(screen.getByLabelText(/โซเดียม/), { target: { value: '120' } })
  expect((screen.getByRole('button', { name: 'บันทึกเครื่องปรุงทดลอง' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('checkbox', { name: /ตรวจชื่อ/ }))
  expect((screen.getByRole('button', { name: 'บันทึกเครื่องปรุงทดลอง' }) as HTMLButtonElement).disabled).toBe(false)
  fireEvent.change(screen.getByLabelText(/โซเดียม/), { target: { value: '121' } })
  expect((screen.getByRole('button', { name: 'บันทึกเครื่องปรุงทดลอง' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('checkbox', { name: /ตรวจชื่อ/ }))
  await act(async () => { fireEvent.submit(screen.getByRole('button', { name: 'บันทึกเครื่องปรุงทดลอง' }).closest('form')!) })
  await waitFor(() => expect(screen.getByText(/บันทึกข้อมูลทดลองแล้ว · รุ่น 9/)).toBeTruthy())
  const post = fetchMock.mock.calls.find(([path, request]) => path === '/experimental/seasonings' && request?.method === 'POST')
  expect(post).toBeTruthy()
  const payload = JSON.parse(String(post?.[1]?.body))
  expect(payload).toMatchObject({ synthetic_only: true, name: 'ซอสตัวอย่าง', basis_quantity: '100', basis_unit: 'g', reviewed: true })
  expect(payload.nutrients).toMatchObject({ sodium_mg: '121', potassium_mg: null, phosphorus_mg: null })
  expect(screen.getByText(/เลือกเครื่องปรุงที่บันทึกไว้ในเครื่องคำนวณสูตรทดลองได้/)).toBeTruthy()
})

it('requires the synthetic-image attestation before allowing review or save', async () => {
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: vi.fn() })
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ items: [] }) }))
  vi.stubGlobal('fetch', fetchMock)
  render(<OcrPreview />)
  chooseTestImage()
  fireEvent.change(screen.getByLabelText('ชื่อเครื่องปรุง'), { target: { value: 'ซอสตัวอย่าง' } })
  fireEvent.change(screen.getByLabelText('ข้อมูลต่อปริมาณ'), { target: { value: '100' } })
  fireEvent.change(screen.getByLabelText('หน่วยฐาน'), { target: { value: 'g' } })
  const review = screen.getByRole('checkbox', { name: /ตรวจชื่อ/ }) as HTMLInputElement
  expect(review.disabled).toBe(true)
  expect((screen.getByRole('button', { name: 'บันทึกเครื่องปรุงทดลอง' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.submit(screen.getByRole('button', { name: 'บันทึกเครื่องปรุงทดลอง' }).closest('form')!)
  expect(fetchMock.mock.calls.some(([url, options]) => url === '/experimental/seasonings' && options?.method === 'POST')).toBe(false)
})

it('locks editable fields while save is pending', async () => {
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: vi.fn() })
  let hasSaved = false
  let finishSave!: (value: { ok: boolean; json: () => Promise<{ ingredient_id: number; version_id: number }> }) => void
  const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/experimental/ocr') return { ok: true, json: async () => ({ text: 'ฉลากทดสอบ' }) }
    if (options?.method === 'POST') return new Promise<{ ok: boolean; json: () => Promise<{ ingredient_id: number; version_id: number }> }>(resolve => { finishSave = resolve })
    return { ok: true, json: async () => ({ items: hasSaved ? [{ ingredient_id: 4, version_id: 10, name: 'เครื่องปรุงตัวอย่าง', brand: null, basis_quantity: '100', basis_unit: 'g', nutrients: { energy_kcal: null, protein_g: null, sodium_mg: null, potassium_mg: null, phosphorus_mg: null } }] : [] }) }
  })
  vi.stubGlobal('fetch', fetchMock)
  render(<OcrPreview />)
  chooseTestImage()
  fireEvent.click(screen.getByRole('checkbox', { name: /ภาพทดสอบ/ }))
  await act(async () => { fireEvent.submit(screen.getByRole('button', { name: 'อ่านข้อความจากภาพ' }).closest('form')!) })
  fireEvent.change(screen.getByLabelText('ชื่อเครื่องปรุง'), { target: { value: 'เครื่องปรุงตัวอย่าง' } })
  fireEvent.change(screen.getByLabelText('ข้อมูลต่อปริมาณ'), { target: { value: '100' } })
  fireEvent.change(screen.getByLabelText('หน่วยฐาน'), { target: { value: 'g' } })
  fireEvent.click(screen.getByRole('checkbox', { name: /ตรวจชื่อ/ }))
  await act(async () => { fireEvent.submit(screen.getByRole('button', { name: 'บันทึกเครื่องปรุงทดลอง' }).closest('form')!) })
  expect((screen.getByLabelText('ชื่อเครื่องปรุง') as HTMLInputElement).disabled).toBe(true)
  expect((screen.getByLabelText(/ถ่ายหรือเลือกภาพ/) as HTMLInputElement).disabled).toBe(true)
  expect(screen.getByRole('button', { name: 'กำลังบันทึก…' })).toBeTruthy()
  hasSaved = true
  await act(async () => { finishSave({ ok: true, json: async () => ({ ingredient_id: 4, version_id: 10 }) }) })
  await waitFor(() => expect(screen.getByText(/บันทึกข้อมูลทดลองแล้ว · รุ่น 10/)).toBeTruthy())
  expect(screen.getByText('เครื่องปรุงตัวอย่าง')).toBeTruthy()
})

it('keeps OCR loading independent from edits and allows reviewed save after slow OCR', async () => {
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: vi.fn() })
  let finishOcr!: (value: { ok: boolean; json: () => Promise<{ text: string }> }) => void
  const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/experimental/ocr') return new Promise<{ ok: boolean; json: () => Promise<{ text: string }> }>(resolve => { finishOcr = resolve })
    if (options?.method === 'POST') return { ok: true, json: async () => ({ ingredient_id: 5, version_id: 11 }) }
    return { ok: true, json: async () => ({ items: [] }) }
  })
  vi.stubGlobal('fetch', fetchMock)
  render(<OcrPreview />)
  chooseTestImage()
  fireEvent.click(screen.getByRole('checkbox', { name: /ภาพทดสอบ/ }))
  await act(async () => { fireEvent.submit(screen.getByRole('button', { name: 'อ่านข้อความจากภาพ' }).closest('form')!); await Promise.resolve() })
  fireEvent.change(screen.getByLabelText('ชื่อเครื่องปรุง'), { target: { value: 'ซอสช้า' } })
  fireEvent.change(screen.getByLabelText('ข้อมูลต่อปริมาณ'), { target: { value: '100' } })
  fireEvent.change(screen.getByLabelText('หน่วยฐาน'), { target: { value: 'g' } })
  fireEvent.click(screen.getByRole('checkbox', { name: /ตรวจชื่อ/ }))
  expect((screen.getByRole('button', { name: /รอ OCR เสร็จ/ }) as HTMLButtonElement).disabled).toBe(true)
  await act(async () => { finishOcr({ ok: true, json: async () => ({ text: 'ผล OCR ทดสอบ', requires_human_review: true, suggestions: { basis_quantity: '75', basis_unit: 'g', basis_conflict: false, requires_human_review: true, nutrients: { energy_kcal: '10', protein_g: null, sodium_mg: '300', potassium_mg: null, phosphorus_mg: null } } }) }) })
  expect(screen.getByLabelText('ชื่อเครื่องปรุง')).toHaveProperty('value', 'ซอสช้า')
  expect(screen.getByLabelText('ข้อมูลต่อปริมาณ')).toHaveProperty('value', '100')
  expect(screen.getByLabelText(/โซเดียม/)).toHaveProperty('value', '')
  expect((screen.getByRole('button', { name: 'เติมช่องว่างจาก OCR' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByText(/มีการแก้ไขระหว่าง OCR/)).toBeTruthy()
  expect(screen.getByText('ผล OCR ทดสอบ')).toBeTruthy()
  expect((screen.getByRole('button', { name: 'บันทึกเครื่องปรุงทดลอง' }) as HTMLButtonElement).disabled).toBe(false)
  await act(async () => { fireEvent.submit(screen.getByRole('button', { name: 'บันทึกเครื่องปรุงทดลอง' }).closest('form')!) })
  await waitFor(() => expect(screen.getByText(/บันทึกข้อมูลทดลองแล้ว · รุ่น 11/)).toBeTruthy())
})

it('preserves manual values when OCR is retried for the same image', async () => {
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: vi.fn() })
  const fetchMock = vi.fn(async (url: string) => url === '/experimental/ocr'
    ? { ok: true, json: async () => ({ text: 'ผล OCR ใหม่' }) }
    : { ok: true, json: async () => ({ items: [] }) })
  vi.stubGlobal('fetch', fetchMock)
  render(<OcrPreview />)
  chooseTestImage()
  fireEvent.click(screen.getByRole('checkbox', { name: /ภาพทดสอบ/ }))
  await act(async () => { fireEvent.submit(screen.getByRole('button', { name: 'อ่านข้อความจากภาพ' }).closest('form')!) })
  fireEvent.change(screen.getByLabelText('ชื่อเครื่องปรุง'), { target: { value: 'กรอกไว้แล้ว' } })
  fireEvent.change(screen.getByLabelText('ข้อมูลต่อปริมาณ'), { target: { value: '30' } })
  await act(async () => { fireEvent.submit(screen.getByRole('button', { name: 'อ่านข้อความจากภาพ' }).closest('form')!) })
  expect(screen.getByLabelText('ชื่อเครื่องปรุง')).toHaveProperty('value', 'กรอกไว้แล้ว')
  expect(screen.getByLabelText('ข้อมูลต่อปริมาณ')).toHaveProperty('value', '30')
  expect(fetchMock.mock.calls.filter(([url]) => url === '/experimental/ocr')).toHaveLength(2)
})

it.each([
  {
    name: 'mixed bases',
    suggestion: { basis_quantity: null, basis_unit: null, basis_conflict: true, requires_human_review: true, nutrients: { energy_kcal: null, protein_g: null, sodium_mg: null, potassium_mg: null, phosphorus_mg: null } },
    manualBasis: null,
    reason: /คนละฐาน/,
  },
  {
    name: 'missing basis unit',
    suggestion: { basis_quantity: '100', basis_unit: null, basis_conflict: false, requires_human_review: true, nutrients: { energy_kcal: null, protein_g: null, sodium_mg: '30', potassium_mg: null, phosphorus_mg: null } },
    manualBasis: null,
    reason: /จับคู่ปริมาณและหน่วยฐานไม่ครบ/,
  },
  {
    name: 'mismatched manual basis',
    suggestion: { basis_quantity: '100', basis_unit: 'g', basis_conflict: false, requires_human_review: true, nutrients: { energy_kcal: null, protein_g: null, sodium_mg: '30', potassium_mg: null, phosphorus_mg: null } },
    manualBasis: { quantity: '50', unit: 'g' },
    reason: /ฐานที่กรอกไม่ตรง/,
  },
])('withholds OCR fill for $name', async ({ suggestion, manualBasis, reason }) => {
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: vi.fn() })
  const fetchMock = vi.fn(async (url: string) => url === '/experimental/ocr'
    ? { ok: true, json: async () => ({ text: 'ฉลากที่ยังจับคู่ฐานไม่ได้', requires_human_review: true, suggestions: suggestion }) }
    : { ok: true, json: async () => ({ items: [] }) })
  vi.stubGlobal('fetch', fetchMock)
  render(<OcrPreview />)
  chooseTestImage()
  fireEvent.click(screen.getByRole('checkbox', { name: /ภาพทดสอบ/ }))
  if (manualBasis) {
    fireEvent.change(screen.getByLabelText('ข้อมูลต่อปริมาณ'), { target: { value: manualBasis.quantity } })
    fireEvent.change(screen.getByLabelText('หน่วยฐาน'), { target: { value: manualBasis.unit } })
  }
  await act(async () => { fireEvent.submit(screen.getByRole('button', { name: 'อ่านข้อความจากภาพ' }).closest('form')!) })
  expect((screen.getByRole('button', { name: 'เติมช่องว่างจาก OCR' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByText(reason)).toBeTruthy()
  expect(screen.getByLabelText(/โซเดียม/)).toHaveProperty('value', '')
  if (manualBasis) expect(screen.getByLabelText('ข้อมูลต่อปริมาณ')).toHaveProperty('value', manualBasis.quantity)
})

it('refreshes the saved list after an ambiguous network failure', async () => {
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: vi.fn() })
  let saveMayHaveCompleted = false
  const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === 'POST') { saveMayHaveCompleted = true; throw new TypeError('Network request failed') }
    return { ok: true, json: async () => ({ items: saveMayHaveCompleted ? [{ ingredient_id: 6, version_id: 12, name: 'ซอสไม่แน่ใจ', brand: null, basis_quantity: '100', basis_unit: 'g', nutrients: { energy_kcal: null, protein_g: null, sodium_mg: null, potassium_mg: null, phosphorus_mg: null } }] : [] }) }
  })
  vi.stubGlobal('fetch', fetchMock)
  render(<OcrPreview />)
  chooseTestImage()
  fireEvent.click(screen.getByRole('checkbox', { name: /ภาพทดสอบ/ }))
  fireEvent.change(screen.getByLabelText('ชื่อเครื่องปรุง'), { target: { value: 'ซอสไม่แน่ใจ' } })
  fireEvent.change(screen.getByLabelText('ข้อมูลต่อปริมาณ'), { target: { value: '100' } })
  fireEvent.change(screen.getByLabelText('หน่วยฐาน'), { target: { value: 'g' } })
  fireEvent.click(screen.getByRole('checkbox', { name: /ตรวจชื่อ/ }))
  await act(async () => { fireEvent.submit(screen.getByRole('button', { name: 'บันทึกเครื่องปรุงทดลอง' }).closest('form')!) })
  expect(screen.getByRole('alert').textContent).toMatch(/ยืนยันผลบันทึกไม่ได้ ตรวจรายการก่อนบันทึกซ้ำ/)
  expect(screen.getByText('ซอสไม่แน่ใจ')).toBeTruthy()
  expect(fetchMock.mock.calls.filter(([url, request]) => url === '/experimental/seasonings' && request?.method !== 'POST')).toHaveLength(2)
})

it('clears the test confirmation when selected image changes and cancels stale OCR', async () => {
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: vi.fn() })
  let finish!: (value: ArrayBuffer) => void
  const fetchMock = vi.fn(async (url: string) => {
    if (url === '/experimental/seasonings') return { ok: true, json: async () => ({ items: [] }) }
    return { ok: true, json: async () => ({ text: 'old OCR' }) }
  })
  vi.stubGlobal('fetch', fetchMock)
  render(<OcrPreview />)
  const oldImage = new File(['old'], 'old.png', { type: 'image/png' })
  oldImage.arrayBuffer = () => new Promise(resolve => { finish = resolve })
  const input = screen.getByLabelText(/ถ่ายหรือเลือกภาพ/)
  fireEvent.change(input, { target: { files: [oldImage] } })
  fireEvent.click(screen.getByRole('checkbox', { name: /ภาพทดสอบ/ }))
  fireEvent.submit(screen.getByRole('button', { name: 'อ่านข้อความจากภาพ' }).closest('form')!)
  fireEvent.change(input, { target: { files: [new File(['new'], 'new.png', { type: 'image/png' })] } })
  expect((screen.getByRole('checkbox', { name: /ภาพทดสอบ/ }) as HTMLInputElement).checked).toBe(false)
  expect(screen.getByRole('button', { name: 'อ่านข้อความจากภาพ' }).textContent).toBe('อ่านข้อความจากภาพ')
  await act(async () => { finish(new Uint8Array([1]).buffer) })
  expect(fetchMock.mock.calls.filter(([url]) => url === '/experimental/ocr')).toHaveLength(0)
})
