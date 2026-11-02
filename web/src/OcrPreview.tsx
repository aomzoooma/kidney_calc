import { useEffect, useRef, useState } from 'react'

export function OcrPreview() {
  const [file, setFile] = useState<File | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState('')
  const revision = useRef(0)
  const pending = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!file) { setPreview(''); return }
    const url = URL.createObjectURL(file)
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!file || !confirmed) return
    const current = ++revision.current
    setText(''); setError(''); setBusy(true)
    try {
      if (file.size > 8 * 1024 * 1024 || !['image/png', 'image/jpeg'].includes(file.type)) throw new Error('เลือกภาพ PNG หรือ JPEG ขนาดไม่เกิน 8 MB')
      const bytes = new Uint8Array(await file.arrayBuffer())
      if (revision.current !== current) return
      let binary = ''
      for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
      const controller = new AbortController()
      pending.current = controller
      const response = await fetch('/experimental/ocr', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ synthetic_only: true, content_type: file.type, image_base64: btoa(binary) }),
        signal: controller.signal,
      })
      const result = await response.json()
      if (!response.ok) throw new Error('อ่านภาพไม่ได้ ตรวจว่า Ollama และโมเดลทำงานอยู่')
      if (revision.current === current) setText(result.text)
    } catch (cause) {
      if (revision.current === current) setError(cause instanceof Error ? cause.message : 'อ่านภาพไม่ได้')
    } finally { pending.current = null; setBusy(false) }
  }

  return <section className="portion-card" aria-labelledby="ocr-title">
    <h2 id="ocr-title">ทดลองอ่านภาพฉลากสมมติ</h2>
    <p>ใช้ภาพ TEST ONLY ที่ไม่มีข้อมูลส่วนบุคคล ผลอาจผิดหรือสร้างข้อความเพิ่ม ต้องตรวจเทียบกับภาพทุกครั้ง ระบบยังไม่บันทึกข้อมูล</p>
    <form onSubmit={submit}>
      <label>เลือกภาพ PNG หรือ JPEG <input type="file" accept="image/png,image/jpeg" required onChange={event => { revision.current++; pending.current?.abort(); setConfirmed(false); setFile(event.target.files?.[0] ?? null); setText(''); setError('') }} /></label>
      <label className="attestation"><input type="checkbox" required checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /> ยืนยันว่าเป็นภาพสมมติ ไม่มีข้อมูลส่วนบุคคล</label>
      <button type="submit" disabled={busy}>{busy ? 'กำลังอ่านภาพ…' : 'อ่านภาพด้วย Ollama'}</button>
    </form>
    {error && <p role="alert">{error}</p>}
    {preview && <img src={preview} alt="ภาพที่เลือกสำหรับตรวจเทียบ" style={{ maxWidth: '100%', maxHeight: '24rem', objectFit: 'contain' }} />}
    {text && <div aria-live="polite"><h3>ข้อความที่อ่านได้ — ต้องตรวจเทียบภาพ</h3><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{text}</pre></div>}
  </section>
}
