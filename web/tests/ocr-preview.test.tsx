import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { OcrPreview } from '../src/OcrPreview'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('shows the selected synthetic image and untrusted result without saving', async () => {
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: vi.fn() })
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ text: 'TEST ONLY' }) }))
  vi.stubGlobal('fetch', fetchMock)
  render(<OcrPreview />)
  const image = new File(['abc'], 'test.png', { type: 'image/png' })
  image.arrayBuffer = async () => new Uint8Array([1, 2, 3]).buffer
  fireEvent.change(screen.getByLabelText(/เลือกภาพ/), { target: { files: [image] } })
  fireEvent.click(screen.getByRole('checkbox'))
  await act(async () => { fireEvent.submit(screen.getByRole('button', { name: /อ่านภาพด้วย Ollama/ }).closest('form')!) })
  expect(screen.getByAltText('ภาพที่เลือกสำหรับตรวจเทียบ')).toBeTruthy()
  expect(screen.getByText('TEST ONLY')).toBeTruthy()
  expect(fetchMock).toHaveBeenCalledOnce()
})

it('requires confirmation again and does not send an old file after selection changes', async () => {
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: vi.fn() })
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  render(<OcrPreview />)
  let finish!: (value: ArrayBuffer) => void
  const oldFile = new File(['old'], 'old.png', { type: 'image/png' })
  oldFile.arrayBuffer = () => new Promise(resolve => { finish = resolve })
  const input = screen.getByLabelText(/เลือกภาพ/)
  fireEvent.change(input, { target: { files: [oldFile] } })
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.submit(screen.getByRole('button', { name: /อ่านภาพด้วย Ollama/ }).closest('form')!)
  fireEvent.change(input, { target: { files: [new File(['new'], 'new.png', { type: 'image/png' })] } })
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
  await act(async () => { finish(new Uint8Array([1]).buffer) })
  expect(fetchMock).not.toHaveBeenCalled()
})
