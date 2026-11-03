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
  expect(screen.getAllByLabelText('ปริมาณที่ใช้ในสูตร')[0]).toHaveProperty('value', '')
  expect(screen.getAllByLabelText('ปริมาณฐานสารอาหาร')[0]).toHaveProperty('value', '')
  expect(screen.getByText(/ปริมาณจากต้นฉบับยังไม่แปลงเป็นกรัม\/มล/)).toBeTruthy()
  expect(screen.getByText('ต้นหอมซอย — ตามต้องการ')).toBeTruthy()
  const calculation = screen.getByRole('button', { name: 'คำนวณสารอาหาร' })
  expect(calculation).toHaveProperty('disabled', true)
  const review = screen.getByLabelText(/ตรวจชื่อ สภาพอาหาร และปริมาณทุกแถว/)
  fireEvent.click(review)
  expect(calculation).toHaveProperty('disabled', false)
  fireEvent.change(screen.getAllByLabelText('ชื่อวัตถุดิบ')[0], { target: { value: 'แก้ชื่อแล้ว' } })
  expect(review).toHaveProperty('checked', false)
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
