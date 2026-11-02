import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
  expect(screen.getByRole('heading', { name: 'ผู้ป่วย' })).toBeTruthy()
  expect(screen.getByText(/ยังไม่มีระบบสร้างหรือบันทึกโปรไฟล์/)).toBeTruthy()
  expect(screen.queryByRole('textbox')).toBeNull()

  fireEvent.click(screen.getByRole('link', { name: 'บันทึกอาหาร' }))
  expect(screen.getByRole('heading', { name: 'บันทึกอาหาร' })).toBeTruthy()
  expect(screen.getByText(/ยังไม่มีระบบบันทึกมื้ออาหาร/)).toBeTruthy()
})

it('lets the home action open the principal seasoning flow', () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ items: [] }) })))
  render(<App />)
  fireEvent.click(screen.getByRole('link', { name: /วัตถุดิบและเครื่องปรุง.*เพิ่มจากภาพทดสอบ/ }))
  expect(screen.getByRole('heading', { name: 'วัตถุดิบและเครื่องปรุง' })).toBeTruthy()
  expect(window.location.hash).toBe('#ingredients')
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
