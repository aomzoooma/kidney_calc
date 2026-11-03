import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { App } from '../src/main'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  window.history.replaceState(null, '', '/')
})

it('shows clear navigation for every app area and keeps usable flows reachable', () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ items: [] }) })))
  render(<App />)

  const nav = screen.getByRole('navigation', { name: 'เมนูหลัก' })
  expect(nav).toBeTruthy()
  for (const name of ['หน้าหลัก', 'ผู้ป่วย', 'วัตถุดิบและเครื่องปรุง', 'สูตรอาหาร', 'บันทึกอาหาร']) {
    expect(screen.getByRole('link', { name })).toBeTruthy()
  }
  expect(screen.getByRole('heading', { name: /วางแผนอาหาร.*ทีละขั้น/ })).toBeTruthy()

  fireEvent.click(screen.getByRole('link', { name: 'วัตถุดิบและเครื่องปรุง' }))
  expect(screen.getByRole('heading', { name: 'วัตถุดิบและเครื่องปรุง' })).toBeTruthy()
  expect(screen.getByLabelText(/ถ่ายหรือเลือกภาพฉลากทดสอบ/).getAttribute('capture')).toBe('environment')
  expect(screen.getByText(/ยังใช้ได้เฉพาะภาพทดสอบ/)).toBeTruthy()

  fireEvent.click(screen.getByRole('link', { name: 'สูตรอาหาร' }))
  expect(screen.getByRole('heading', { name: 'สูตรอาหาร' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'คำนวณสารอาหาร' })).toBeTruthy()
  expect(screen.getByRole('link', { name: 'สูตรอาหาร' }).getAttribute('aria-current')).toBe('page')

  fireEvent.click(screen.getByRole('link', { name: 'ผู้ป่วย' }))
  expect(screen.getByRole('heading', { name: 'โปรไฟล์ข้อมูลสมมติ' })).toBeTruthy()
  expect(screen.getByText(/ห้ามกรอกชื่อจริง เลขประจำตัว หรือข้อมูลผู้ป่วยจริง/)).toBeTruthy()
  expect(screen.getByRole('textbox', { name: 'ชื่อเรียกข้อมูลสมมติ' })).toBeTruthy()

  fireEvent.click(screen.getByRole('link', { name: 'บันทึกอาหาร' }))
  expect(screen.getByRole('heading', { name: 'บันทึกอาหาร' })).toBeTruthy()
  expect(screen.getByText(/เลือกโปรไฟล์สมมติในหน้า/)).toBeTruthy()
  expect(screen.getByRole('link', { name: 'ไปเลือกโปรไฟล์' })).toBeTruthy()
})

it('lets the home action open the principal seasoning flow', () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ items: [] }) })))
  render(<App />)
  fireEvent.click(screen.getByRole('link', { name: /วัตถุดิบและเครื่องปรุง.*เพิ่มจากภาพทดสอบ/ }))
  expect(screen.getByRole('heading', { name: 'วัตถุดิบและเครื่องปรุง' })).toBeTruthy()
  expect(window.location.hash).toBe('#ingredients')
})

it('keeps the selected synthetic profile when moving from profiles to meal tracking', async () => {
  const totals = Object.fromEntries(['energy_kcal', 'protein_g', 'sodium_mg', 'potassium_mg', 'phosphorus_mg']
    .map(key => [key, { value: null, complete: false }]))
  const fetchMock = vi.fn(async (url: string) => {
    if (url === '/experimental/profiles') return { ok: true, json: async () => ({ items: [{ id: 4, name: 'ตัวอย่าง' }] }) }
    if (url === '/experimental/profiles/4') return { ok: true, json: async () => ({ id: 4, name: 'ตัวอย่าง', dry_weights: [], goals: [] }) }
    if (url === '/experimental/recipes') return { ok: true, json: async () => ({ items: [] }) }
    if (url.startsWith('/experimental/profiles/4/meals?day=')) return { ok: true, json: async () => ({ items: [], profile_id: 4, day: new URL(`http://local${url}`).searchParams.get('day'), synthetic_only: true, clinical_use: false }) }
    if (url.includes('/meals/daily?') || url.includes('/meals/weekly?')) return { ok: true, json: async () => ({ profile_id: 4, start_date: '2026-11-03', end_date: '2026-11-03', entry_count: 0, totals, synthetic_only: true, clinical_use: false }) }
    throw new Error(`Unexpected request ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  render(<App />)
  fireEvent.click(screen.getByRole('link', { name: 'ผู้ป่วย' }))
  expect(await screen.findByRole('option', { name: 'ตัวอย่าง' })).toBeTruthy()
  await waitFor(() => expect(screen.getByLabelText('เลือกโปรไฟล์')).toHaveProperty('value', '4'))
  fireEvent.click(screen.getByRole('link', { name: 'บันทึกอาหาร' }))
  expect(await screen.findByRole('heading', { name: 'ประวัติวันที่เลือก' })).toBeTruthy()
  expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/experimental/profiles/4/meals?day='))).toBe(true)
})

it('preserves a draft when navigating and using the skip link', () => {
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: vi.fn() })
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ items: [] }) })))
  render(<App />)
  fireEvent.click(screen.getByRole('link', { name: 'วัตถุดิบและเครื่องปรุง' }))
  fireEvent.change(screen.getByLabelText(/ถ่ายหรือเลือกภาพฉลากทดสอบ/), { target: { files: [new File(['x'], 'test.png', { type: 'image/png' })] } })
  fireEvent.change(screen.getByLabelText('ชื่อเครื่องปรุง'), { target: { value: 'ตัวอย่าง' } })
  fireEvent.click(screen.getByRole('link', { name: 'สูตรอาหาร' }))
  fireEvent.click(screen.getByRole('link', { name: 'วัตถุดิบและเครื่องปรุง' }))
  expect(screen.getByLabelText('ชื่อเครื่องปรุง')).toHaveProperty('value', 'ตัวอย่าง')
  window.location.hash = '#main-content'
  fireEvent(window, new HashChangeEvent('hashchange'))
  expect(screen.getByRole('heading', { name: 'วัตถุดิบและเครื่องปรุง' })).toBeTruthy()
  expect(screen.getByLabelText('ชื่อเครื่องปรุง')).toHaveProperty('value', 'ตัวอย่าง')
})
