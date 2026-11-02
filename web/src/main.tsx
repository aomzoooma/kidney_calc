import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './style.css'

function App() {
  return (
    <div className="app-shell">
      <header className="topbar">
        <p className="brand">ครัวอุ่นใจ <span>เครื่องมือสำหรับผู้ดูแล</span></p>
      </header>
      <main>
        <section className="intro" aria-labelledby="page-title">
          <p className="eyebrow">วางแผนมื้ออาหาร</p>
          <h1 id="page-title">ดูแลมื้ออาหาร<br />อย่างมั่นใจไปด้วยกัน</h1>
          <p>เครื่องมือช่วยเตรียมอาหารสำหรับผู้ดูแล โดยอ้างอิงเป้าหมายที่แพทย์หรือนักกำหนดอาหารให้ไว้</p>
        </section>
        <section className="notice" aria-labelledby="notice-title">
          <span className="notice-mark" aria-hidden="true">!</span>
          <div>
            <h2 id="notice-title">อยู่ระหว่างพัฒนา</h2>
            <p>ยังไม่มีข้อมูลผู้ป่วยหรือการคำนวณ กรุณาอย่าใช้เพื่อตัดสินใจเรื่องอาหารหรือการรักษา</p>
          </div>
        </section>
        <section className="features" aria-labelledby="next-title">
          <h2 id="next-title">สิ่งที่จะช่วยจัดการ</h2>
          <ul className="feature-list">
            <li><span aria-hidden="true">01</span><p>บันทึกเป้าหมายที่ทีมรักษากำหนด</p></li>
            <li><span aria-hidden="true">02</span><p>จัดสูตรอาหารจากวัตถุดิบที่มีข้อมูล</p></li>
            <li><span aria-hidden="true">03</span><p>ติดตามมื้ออาหารและข้อมูลที่ยังไม่ครบ</p></li>
          </ul>
          <p className="footnote">ข้อมูลสารอาหารที่ไม่มีแหล่งอ้างอิงจะแสดงว่าไม่ทราบ</p>
        </section>
      </main>
      <footer><p>สำหรับผู้ดูแล · ข้อมูลยังไม่ผ่านการตรวจสอบทางคลินิก</p></footer>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
