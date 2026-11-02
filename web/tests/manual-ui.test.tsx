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
})

describe('manual recipe UI', () => {
  it('requires synthetic-only confirmation', () => {
    render(<App />)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(screen.getByRole('checkbox', { name: /ยืนยันว่าข้อมูลทั้งหมด/ }).required).toBe(true)
    expect(screen.getByText(/ตัวเลขสมมติเท่านั้น/)).toBeTruthy()
    expect(screen.getByText(/ห้ามใช้ค่าจากฉลากอาหารจริงหรือข้อมูลผู้ป่วย/)).toBeTruthy()
    fireEvent.change(screen.getAllByLabelText(/ปริมาณที่ใช้/)[0], { target: { value: '100' } })
    fireEvent.click(screen.getByRole('button', { name: 'คำนวณสารอาหาร' }))
    expect(fetchMock).not.toHaveBeenCalled()
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

    fireEvent.change(screen.getAllByLabelText(/ปริมาณที่ใช้/)[0], { target: { value: '100' } })
    fireEvent.click(screen.getByRole('checkbox', { name: /ยืนยันว่าข้อมูลทั้งหมด/ }))
    fireEvent.click(screen.getByRole('button', { name: 'คำนวณสารอาหาร' }))
    expect(fetchMock).toHaveBeenCalledTimes(1)

    change()

    await act(async () => {
      resolveFetch({ ok: true, json: async () => response })
      await delayedResponse
    })
    expect(screen.queryByText('สารอาหารโดยประมาณ')).toBeNull()
    expect(screen.queryByText('777 กิโลแคลอรี')).toBeNull()
  })
})
