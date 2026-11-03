import { useEffect, useState } from 'react'
import { apiFetch } from './authClient'
import { nutrients, type Ingredient, type NutrientKey } from './request'

type Props = {
  ingredient: Ingredient
  disabled: boolean
  onBusyChange: (busy: boolean) => void
  onErrorChange: (error: string) => void
  onSaved: (versionId: number) => void
}

const stateNames: Record<Ingredient['state'], string> = {
  raw: 'ดิบ', cooked: 'สุก', as_sold: 'ตามสภาพที่ซื้อ',
}

export function RecipeIngredientSnapshotForm({ ingredient, disabled, onBusyChange, onErrorChange, onSaved }: Props) {
  const [provider, setProvider] = useState('')
  const [sourceVersion, setSourceVersion] = useState('')
  const [sourceDate, setSourceDate] = useState('')
  const [sourceReference, setSourceReference] = useState('')
  const [provenance, setProvenance] = useState('')
  const [reviewed, setReviewed] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => { setReviewed(false) }, [ingredient])

  const basisValid = ingredient.name.trim().length > 0
    && Number.isFinite(Number(ingredient.reference)) && Number(ingredient.reference) > 0
  const nutrientsValid = nutrients.every(([key]) => {
    const value = ingredient.values[key as NutrientKey].trim()
    return value === '' || (Number.isFinite(Number(value)) && Number(value) >= 0)
  })
  const sourceDetailsValid = Boolean(provider.trim() && sourceVersion.trim() && sourceReference.trim() && provenance.trim())
  const canSave = basisValid && nutrientsValid && sourceDetailsValid && reviewed && !disabled && !busy

  async function save() {
    if (!canSave) return
    setBusy(true); onErrorChange(''); onBusyChange(true)
    try {
      const response = await apiFetch('/experimental/ingredients', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          synthetic_only: true, reviewed: true, name: ingredient.name.trim(), provider: provider.trim(),
          source_version: sourceVersion.trim(), source_date: sourceDate || null,
          source_reference: sourceReference.trim(), provenance: provenance.trim(),
          basis_quantity: ingredient.reference, basis_unit: ingredient.unit,
          food_state: ingredient.state,
          nutrients: Object.fromEntries(nutrients.map(([key]) => [key, ingredient.values[key].trim() || null])),
        }),
      })
      const payload = await response.json()
      if (!response.ok) {
        throw new Error(response.status === 422
          ? 'ข้อมูลบางช่องใช้ไม่ได้ · ตรวจชื่อ แหล่งอ้างอิง ปริมาณฐาน หน่วย สภาพ และค่าสารอาหาร แล้วลองใหม่'
          : 'บันทึกไม่สำเร็จ · ตรวจว่า API ทำงานอยู่ แล้วลองอีกครั้ง')
      }
      if (!Number.isInteger(payload.version_id) || payload.version_id <= 0) {
        throw new Error('ไม่ได้รับหมายเลขรุ่นจากเครื่อง · แบบร่างยังอยู่ ตรวจรายการในเครื่องก่อนลองใหม่')
      }
      onSaved(payload.version_id as number)
    } catch (cause) {
      const responseMayBeMissing = cause instanceof TypeError || cause instanceof SyntaxError
        || (cause instanceof Error && /failed to fetch|network/i.test(cause.message))
      const message = responseMayBeMissing
        ? 'ขาดการเชื่อมต่อหรือคำตอบจากเครื่องอ่านไม่ได้ · อาจบันทึกสำเร็จแล้ว ให้ค้นหารายการวัตถุดิบที่บันทึกไว้ก่อนส่งซ้ำ · แบบร่างยังอยู่'
        : cause instanceof Error ? cause.message : 'บันทึกไม่สำเร็จ · แบบร่างยังอยู่ ตรวจรายการวัตถุดิบที่บันทึกไว้ก่อนลองอีกครั้ง'
      onErrorChange(message)
    } finally {
      setBusy(false); onBusyChange(false)
    }
  }

  return <section className="recipe-snapshot-review" aria-label={`ตรวจข้อมูลวัตถุดิบ ${ingredient.name || 'ที่กรอกเอง'} ก่อนบันทึก`}>
    <h3>บันทึกข้อมูลวัตถุดิบนี้ในเครื่อง</h3>
    <p>ตรวจข้อมูลในแถว แล้วระบุแหล่งที่มาของค่าที่กรอกเอง · บันทึกเป็นรุ่นอ้างอิงคงที่ · ช่องสารอาหารที่เว้นว่างยังเป็น “ไม่ทราบ”</p>
    <div className="thai-query-suggestion" role="note">
      <strong>ตรวจข้อมูลที่จะบันทึก</strong>
      <p>ชื่อ: {ingredient.name || 'ยังไม่ระบุ'} · ปริมาณฐาน {ingredient.reference || 'ยังไม่ระบุ'} {ingredient.unit === 'g' ? 'กรัม' : 'มล.'} · สภาพอาหาร {stateNames[ingredient.state]}</p>
      <p>ปริมาณในสูตร: {ingredient.amount || 'ยังไม่ระบุ'} {ingredient.unit === 'g' ? 'กรัม' : 'มล.'}</p>
      <ul>{nutrients.map(([key, label, unit]) => {
        const value = ingredient.values[key as NutrientKey].trim()
        return <li key={key}>{label}: {value ? `${value} ${unit}` : 'ไม่ทราบ'}</li>
      })}</ul>
      <small>ฐานสารอาหารใช้หน่วยเดียวกับวัตถุดิบในแถวนี้ · ระบบไม่แปลงกรัมกับมิลลิลิตร</small>
    </div>
    <fieldset disabled={disabled || busy} onChange={event => {
      if ((event.target as HTMLInputElement).type !== 'checkbox') setReviewed(false)
    }}>
      <legend className="visually-hidden">แหล่งข้อมูลและการทบทวน</legend>
      <div className="field-grid">
        <label>แหล่งข้อมูล / ผู้เผยแพร่ <input maxLength={150} value={provider} onChange={event => setProvider(event.target.value)} autoComplete="off" /></label>
        <label>รุ่นหรือฉบับของแหล่งข้อมูล <input maxLength={200} value={sourceVersion} onChange={event => setSourceVersion(event.target.value)} autoComplete="off" /></label>
      </div>
      <label>วันที่ของแหล่งข้อมูล (ถ้าระบุ) <input type="date" value={sourceDate} onChange={event => setSourceDate(event.target.value)} /></label>
      <label>ตำแหน่งอ้างอิง เช่น หน้าเอกสารหรือ URL <input maxLength={500} value={sourceReference} onChange={event => setSourceReference(event.target.value)} autoComplete="off" /></label>
      <label>วิธีได้มาของข้อมูล <input maxLength={500} value={provenance} onChange={event => setProvenance(event.target.value)} autoComplete="off" /></label>
      <p>กรอกแหล่งข้อมูล รุ่น/ฉบับ ตำแหน่งอ้างอิง และวิธีได้มาตามข้อมูลจริง · ระบบไม่สร้างข้อมูลเหล่านี้แทน</p>
      {!basisValid && <p role="note">ใส่ชื่อวัตถุดิบและปริมาณฐานที่มากกว่าศูนย์ก่อนบันทึก</p>}
      {!nutrientsValid && <p role="note">แก้ค่าสารอาหารให้เป็นตัวเลขศูนย์ขึ้นไป หรือเว้นว่างเมื่อไม่ทราบ</p>}
      <label className="attestation"><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} /> ยืนยันว่าเป็นข้อมูลสมมติ ตรวจชื่อ แหล่งอ้างอิง ฐาน สภาพ และสารอาหารแล้ว</label>
      <button className="add-button" type="button" disabled={!canSave} onClick={() => void save()}>{busy ? 'กำลังบันทึกรุ่น…' : 'ตรวจแล้ว · บันทึกวัตถุดิบในเครื่อง'}</button>
    </fieldset>
  </section>
}
