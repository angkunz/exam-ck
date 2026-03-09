import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Camera, Key, History, Upload, CheckCircle, XCircle, AlertCircle, ChevronLeft, RefreshCw, Settings } from 'lucide-react';

// ==========================================
// การตั้งค่าพิกัด OMR (อิงจากภาพกระดาษคำตอบ)
// ==========================================
const getLayout = () => {
  const q = [];
  // คอลัมน์ซ้ายบน: ข้อ 1-7
  for (let i = 0; i < 7; i++) {
    q.push({ id: i + 1, startX: 0.135, stepX: 0.050, y: 0.181 + i * 0.0416 });
  }
  // คอลัมน์ซ้ายล่าง: ข้อ 8-15
  for (let i = 0; i < 8; i++) {
    q.push({ id: i + 8, startX: 0.135, stepX: 0.050, y: 0.587 + i * 0.0444 });
  }
  // คอลัมน์ขวาบน: ข้อ 16-20
  for (let i = 0; i < 5; i++) {
    q.push({ id: i + 16, startX: 0.454, stepX: 0.050, y: 0.181 + i * 0.0416 });
  }
  
  // รหัสนักเรียน 5 หลัก
  const sid = [];
  for (let col = 0; col < 5; col++) {
    const colArr = [];
    for (let row = 0; row < 10; row++) {
      colArr.push({
        val: row,
        x: 0.706 + col * 0.0542,
        y: 0.530 + row * 0.0445
      });
    }
    sid.push(colArr);
  }
  return { questions: q, studentId: sid };
};

const OPTIONS_TH = ['ก', 'ข', 'ค', 'ง', 'จ'];

// ==========================================
// คอมโพเนนต์หลักของแอป
// ==========================================
export default function App() {
  const [activeTab, setActiveTab] = useState('grade'); // grade, key, history
  const [answerKey, setAnswerKey] = useState({});
  const [history, setHistory] = useState([]);

  // สร้างเฉลยแบบสุ่มสำหรับทดสอบ (ถ้ายังไม่ได้ตั้ง)
  useEffect(() => {
    const initialKey = {};
    for (let i = 1; i <= 20; i++) {
      initialKey[i] = Math.floor(Math.random() * 5); // สุ่ม ก-จ
    }
    setAnswerKey(initialKey);
  }, []);

  const addHistory = (result) => {
    setHistory(prev => [{ ...result, date: new Date().toISOString(), id: Date.now() }, ...prev]);
  };

  return (
    <div className="flex flex-col h-screen bg-gray-50 font-sans">
      {/* Header */}
      <header className="bg-indigo-600 text-white shadow-md pt-safe">
        <div className="flex items-center justify-center p-4">
          <h1 className="text-xl font-bold tracking-wide">OMR Grade (เวอร์ชันภาษาไทย)</h1>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 overflow-y-auto relative">
        {activeTab === 'grade' && <ScannerTab answerKey={answerKey} onSaveResult={addHistory} />}
        {activeTab === 'key' && <AnswerKeyTab answerKey={answerKey} setAnswerKey={setAnswerKey} />}
        {activeTab === 'history' && <HistoryTab history={history} />}
      </main>

      {/* Bottom Navigation */}
      <nav className="bg-white border-t border-gray-200 pb-safe shadow-[0_-2px_10px_rgba(0,0,0,0.05)]">
        <div className="flex justify-around py-3">
          <NavButton 
            active={activeTab === 'grade'} 
            icon={<Camera size={24} />} 
            label="ตรวจข้อสอบ" 
            onClick={() => setActiveTab('grade')} 
          />
          <NavButton 
            active={activeTab === 'key'} 
            icon={<Key size={24} />} 
            label="เฉลย" 
            onClick={() => setActiveTab('key')} 
          />
          <NavButton 
            active={activeTab === 'history'} 
            icon={<History size={24} />} 
            label="ประวัติ" 
            onClick={() => setActiveTab('history')} 
          />
        </div>
      </nav>
    </div>
  );
}

const NavButton = ({ active, icon, label, onClick }) => (
  <button 
    onClick={onClick} 
    className={`flex flex-col items-center gap-1 w-24 transition-colors ${active ? 'text-indigo-600' : 'text-gray-400 hover:text-gray-600'}`}
  >
    <div className={`${active ? 'scale-110' : 'scale-100'} transition-transform duration-200`}>
      {icon}
    </div>
    <span className="text-[10px] font-medium">{label}</span>
  </button>
);

// ==========================================
// หน้าจอ 1: ระบบสแกนและตรวจข้อสอบ
// ==========================================
function ScannerTab({ answerKey, onSaveResult }) {
  const [imageSrc, setImageSrc] = useState(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [result, setResult] = useState(null);

  const handleImageUpload = (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        setImageSrc(event.target.result);
        setResult(null);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleProcess = async (imageElement, cropPoints) => {
    setIsProcessing(true);
    // หน่วงเวลาเล็กน้อยให้ UI อัปเดตสถานะ Loading
    await new Promise(r => setTimeout(r, 100)); 
    
    try {
      const gradeResult = processOMR(imageElement, cropPoints, answerKey);
      setResult(gradeResult);
      onSaveResult(gradeResult);
    } catch (err) {
      alert("เกิดข้อผิดพลาดในการประมวลผล กรุณาลองจัดตำแหน่งใหม่อีกครั้ง");
      console.error(err);
    }
    setIsProcessing(false);
  };

  const resetScanner = () => {
    setImageSrc(null);
    setResult(null);
  };

  if (result) {
    return <ResultDisplay result={result} onReset={resetScanner} />;
  }

  if (imageSrc) {
    return (
      <ImageAligner 
        imageSrc={imageSrc} 
        onCancel={resetScanner} 
        onConfirm={handleProcess}
        isProcessing={isProcessing}
      />
    );
  }

  return (
    <div className="flex flex-col items-center justify-center h-full p-6 bg-gray-50">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-lg p-8 text-center border border-gray-100">
        <div className="w-24 h-24 bg-indigo-50 rounded-full flex items-center justify-center mx-auto mb-6">
          <Upload className="text-indigo-500 w-12 h-12" />
        </div>
        <h2 className="text-2xl font-bold text-gray-800 mb-2">อัปโหลดกระดาษคำตอบ</h2>
        <p className="text-gray-500 text-sm mb-8">ถ่ายรูปหรือเลือกภาพกระดาษคำตอบจากแกลเลอรี่ของคุณ</p>
        
        <label className="flex items-center justify-center gap-2 w-full bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-4 px-6 rounded-xl cursor-pointer transition-colors shadow-md active:scale-95">
          <Camera size={20} />
          ถ่ายภาพ / เลือกไฟล์
          <input 
            type="file" 
            accept="image/*" 
            capture="environment" 
            className="hidden" 
            onChange={handleImageUpload} 
          />
        </label>
        
        <div className="mt-6 flex items-start gap-2 text-left text-sm text-yellow-700 bg-yellow-50 p-4 rounded-lg">
          <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
          <p>ถ่ายภาพให้เห็นจุดสี่เหลี่ยมสีดำทั้ง 4 มุมให้ชัดเจน และพยายามให้กระดาษเรียบที่สุด</p>
        </div>
      </div>
    </div>
  );
}

// ==========================================
// เครื่องมือจัดตำแหน่งภาพ (Image Aligner)
// ==========================================
function ImageAligner({ imageSrc, onCancel, onConfirm, isProcessing }) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const imageRef = useRef(null);
  
  // จุด 4 มุม (Normalized 0.0 - 1.0)
  const [points, setPoints] = useState({
    tl: { x: 0.1, y: 0.1 },
    tr: { x: 0.9, y: 0.1 },
    br: { x: 0.9, y: 0.9 },
    bl: { x: 0.1, y: 0.9 },
  });
  
  const [draggingPoint, setDraggingPoint] = useState(null);

  useEffect(() => {
    const img = new Image();
    img.src = imageSrc;
    img.onload = () => {
      imageRef.current = img;
      drawCanvas();
    };
  }, [imageSrc, points]);

  const drawCanvas = () => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    const img = imageRef.current;
    if (!canvas || !img || !container) return;

    const ctx = canvas.getContext('2d');
    
    // ตั้งขนาด Canvas ให้พอดีจอ
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    canvas.width = cw;
    canvas.height = ch;

    // คำนวณ Scale เพื่อวาดรูปตรงกลาง
    const scale = Math.min(cw / img.width, ch / img.height) * 0.95;
    const dw = img.width * scale;
    const dh = img.height * scale;
    const dx = (cw - dw) / 2;
    const dy = (ch - dh) / 2;

    ctx.clearRect(0, 0, cw, ch);
    
    // วาดภาพพื้นหลัง
    ctx.drawImage(img, dx, dy, dw, dh);

    // ฟังก์ชันช่วยแปลง Normalized -> Canvas Coords
    const toPx = (normX, normY) => ({
      x: dx + normX * dw,
      y: dy + normY * dh
    });

    const pTL = toPx(points.tl.x, points.tl.y);
    const pTR = toPx(points.tr.x, points.tr.y);
    const pBR = toPx(points.br.x, points.br.y);
    const pBL = toPx(points.bl.x, points.bl.y);

    // วาดกรอบสี่เหลี่ยม (Polygon)
    ctx.beginPath();
    ctx.moveTo(pTL.x, pTL.y);
    ctx.lineTo(pTR.x, pTR.y);
    ctx.lineTo(pBR.x, pBR.y);
    ctx.lineTo(pBL.x, pBL.y);
    ctx.closePath();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#22c55e'; // Green
    ctx.fillStyle = 'rgba(34, 197, 94, 0.2)';
    ctx.fill();
    ctx.stroke();

    // วาดจุดจับ (Handles)
    const drawHandle = (p) => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 14, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#22c55e';
      ctx.stroke();
      
      // วาดเป้าตรงกลาง
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
      ctx.fillStyle = '#ef4444';
      ctx.fill();
    };

    drawHandle(pTL);
    drawHandle(pTR);
    drawHandle(pBR);
    drawHandle(pBL);
  };

  const handlePointerDown = (e) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX || (e.touches && e.touches[0].clientX) - rect.left;
    const y = e.clientY || (e.touches && e.touches[0].clientY) - rect.top;

    const img = imageRef.current;
    const cw = canvas.width;
    const ch = canvas.height;
    const scale = Math.min(cw / img.width, ch / img.height) * 0.95;
    const dw = img.width * scale;
    const dh = img.height * scale;
    const dx = (cw - dw) / 2;
    const dy = (ch - dh) / 2;

    const toPx = (normX, normY) => ({ x: dx + normX * dw, y: dy + normY * dh });
    const hitRadius = 30; // รัศมีการสัมผัสกว้างหน่อยสำหรับมือถือ

    for (const key of ['tl', 'tr', 'br', 'bl']) {
      const p = toPx(points[key].x, points[key].y);
      const dist = Math.sqrt(Math.pow(p.x - x, 2) + Math.pow(p.y - y, 2));
      if (dist < hitRadius) {
        setDraggingPoint(key);
        return;
      }
    }
  };

  const handlePointerMove = (e) => {
    if (!draggingPoint) return;
    
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX || (e.touches && e.touches[0].clientX)) - rect.left;
    const y = (e.clientY || (e.touches && e.touches[0].clientY)) - rect.top;

    const img = imageRef.current;
    const cw = canvas.width;
    const ch = canvas.height;
    const scale = Math.min(cw / img.width, ch / img.height) * 0.95;
    const dw = img.width * scale;
    const dh = img.height * scale;
    const dx = (cw - dw) / 2;
    const dy = (ch - dh) / 2;

    // แปลงกลับเป็น Normalized
    let normX = (x - dx) / dw;
    let normY = (y - dy) / dh;
    
    // ขีดจำกัดให้อยู่ในภาพ
    normX = Math.max(0, Math.min(1, normX));
    normY = Math.max(0, Math.min(1, normY));

    setPoints(prev => ({
      ...prev,
      [draggingPoint]: { x: normX, y: normY }
    }));
  };

  const handlePointerUp = () => {
    setDraggingPoint(null);
  };

  return (
    <div className="flex flex-col h-full bg-black relative">
      <div className="absolute top-4 left-0 right-0 z-10 flex justify-center pointer-events-none">
        <div className="bg-black/60 text-white px-4 py-2 rounded-full text-sm font-medium backdrop-blur-sm">
          ลากจุดให้ตรงกับสี่เหลี่ยมสีดำทั้ง 4 มุม
        </div>
      </div>

      <div 
        ref={containerRef} 
        className="flex-1 overflow-hidden relative"
        onMouseDown={handlePointerDown}
        onMouseMove={handlePointerMove}
        onMouseUp={handlePointerUp}
        onMouseLeave={handlePointerUp}
        onTouchStart={handlePointerDown}
        onTouchMove={handlePointerMove}
        onTouchEnd={handlePointerUp}
      >
        <canvas ref={canvasRef} className="absolute inset-0 w-full h-full touch-none" />
      </div>

      <div className="bg-white p-4 pb-safe-bottom flex gap-4 shadow-lg rounded-t-2xl z-10">
        <button 
          onClick={onCancel}
          className="flex-1 py-3 px-4 bg-gray-100 text-gray-700 font-semibold rounded-xl active:bg-gray-200 transition-colors"
        >
          ยกเลิก
        </button>
        <button 
          onClick={() => onConfirm(imageRef.current, points)}
          disabled={isProcessing}
          className="flex-1 py-3 px-4 bg-indigo-600 text-white font-semibold rounded-xl active:bg-indigo-700 transition-colors flex justify-center items-center gap-2 disabled:opacity-70"
        >
          {isProcessing ? (
            <><RefreshCw className="animate-spin" size={20} /> กำลังตรวจ...</>
          ) : (
            <><CheckCircle size={20} /> ตรวจคำตอบ</>
          )}
        </button>
      </div>
    </div>
  );
}

// ==========================================
// อัลกอริทึมประมวลผล OMR (Pure JS)
// ==========================================
const processOMR = (imgElement, normPoints, answerKey) => {
  const outW = 600;
  const outH = 800;
  
  // 1. ดึงข้อมูลภาพต้นฉบับ
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = imgElement.naturalWidth;
  tempCanvas.height = imgElement.naturalHeight;
  const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
  tempCtx.drawImage(imgElement, 0, 0);

  // 2. แปลงพิกัดเป็นพิกัดจริงบนภาพ
  const pts = {
    tl: { x: normPoints.tl.x * tempCanvas.width, y: normPoints.tl.y * tempCanvas.height },
    tr: { x: normPoints.tr.x * tempCanvas.width, y: normPoints.tr.y * tempCanvas.height },
    bl: { x: normPoints.bl.x * tempCanvas.width, y: normPoints.bl.y * tempCanvas.height },
    br: { x: normPoints.br.x * tempCanvas.width, y: normPoints.br.y * tempCanvas.height },
  };

  // 3. Bilinear Interpolation (Perspective Warp แบบประยุกต์)
  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  
  const srcData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height).data;
  const destImgData = ctx.createImageData(outW, outH);
  const destData = destImgData.data;

  for (let y = 0; y < outH; y++) {
    const v = y / outH;
    for (let x = 0; x < outW; x++) {
      const u = x / outW;
      
      const topX = pts.tl.x + (pts.tr.x - pts.tl.x) * u;
      const topY = pts.tl.y + (pts.tr.y - pts.tl.y) * u;
      const botX = pts.bl.x + (pts.br.x - pts.bl.x) * u;
      const botY = pts.bl.y + (pts.br.y - pts.bl.y) * u;

      const sx = Math.floor(topX + (botX - topX) * v);
      const sy = Math.floor(topY + (botY - topY) * v);

      if (sx >= 0 && sx < tempCanvas.width && sy >= 0 && sy < tempCanvas.height) {
        const srcIdx = (sy * tempCanvas.width + sx) * 4;
        const destIdx = (y * outW + x) * 4;
        destData[destIdx] = srcData[srcIdx];
        destData[destIdx + 1] = srcData[srcIdx + 1];
        destData[destIdx + 2] = srcData[srcIdx + 2];
        destData[destIdx + 3] = 255;
      }
    }
  }
  ctx.putImageData(destImgData, 0, 0);

  // 4. วิเคราะห์ความเข้ม (Darkness Analysis)
  const layout = getLayout();
  const radius = 9; // รัศมีวงกลมที่ใช้อ่าน
  const threshold = 50; // ความเข้มขั้นต่ำที่จะถือว่าระบาย (0-255)

  const getDarkness = (normX, normY) => {
    const px = Math.floor(normX * outW);
    const py = Math.floor(normY * outH);
    const size = radius * 2;
    const sx = Math.max(0, px - radius);
    const sy = Math.max(0, py - radius);
    
    // ตรวจสอบขอบเขต
    if (sx < 0 || sy < 0 || sx + size > outW || sy + size > outH) return 0;
    
    const data = ctx.getImageData(sx, sy, size, size).data;
    let darkSum = 0;
    for (let i = 0; i < data.length; i += 4) {
      // แปลงเป็น Grayscale และกลับค่า (ดำ = มาก)
      const gray = 0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2];
      darkSum += (255 - gray);
    }
    return darkSum / (size * size);
  };

  const results = [];
  let score = 0;

  // ตรวจคำตอบข้อ 1-20
  layout.questions.forEach(q => {
    let maxDarkness = -1;
    let selectedOpt = -1;
    const optionsDarkness = [];

    for (let i = 0; i < 5; i++) {
      const cx = q.startX + i * q.stepX;
      const cy = q.y;
      const d = getDarkness(cx, cy);
      optionsDarkness.push(d);
      
      if (d > maxDarkness) {
        maxDarkness = d;
        selectedOpt = i;
      }
    }

    if (maxDarkness < threshold) {
      selectedOpt = -1; // ไม่ได้ตอบ
    } else {
      // เช็คฝนหลายข้อ
      const sorted = [...optionsDarkness].sort((a, b) => b - a);
      if (sorted[1] > threshold && (maxDarkness - sorted[1]) < 25) {
        selectedOpt = -2; // ฝนมามากกว่า 1 ข้อ
      }
    }

    const correctOpt = answerKey[q.id];
    const isCorrect = selectedOpt === correctOpt && selectedOpt >= 0;
    if (isCorrect) score++;

    results.push({
      id: q.id,
      selected: selectedOpt,
      correct: correctOpt,
      isCorrect,
      cx: q.startX,
      cy: q.y,
      stepX: q.stepX
    });
  });

  // อ่านรหัสนักเรียน
  let studentId = "";
  layout.studentId.forEach(col => {
    let maxD = -1;
    let selectedDigit = "?";
    col.forEach(row => {
      const d = getDarkness(row.x, row.y);
      if (d > maxD && d > threshold) {
        maxD = d;
        selectedDigit = row.val.toString();
      }
    });
    studentId += selectedDigit;
  });

  // 5. วาด Overlay แสดงผลตรวจบนรูป
  ctx.lineWidth = 4;
  results.forEach(res => {
    // วงกลมสีเขียว = คำตอบที่ถูกต้อง
    if (res.correct !== undefined && res.correct >= 0) {
      ctx.strokeStyle = '#22c55e';
      ctx.beginPath();
      ctx.arc((res.cx + res.correct * res.stepX) * outW, res.cy * outH, 16, 0, Math.PI * 2);
      ctx.stroke();
    }
    // วงกลมสีแดง = ตอบผิด
    if (!res.isCorrect && res.selected >= 0) {
      ctx.strokeStyle = '#ef4444';
      ctx.beginPath();
      ctx.arc((res.cx + res.selected * res.stepX) * outW, res.cy * outH, 16, 0, Math.PI * 2);
      ctx.stroke();
    }
    // วงกลมสีเหลืองทึบ = ฝนหลายข้อ
    if (res.selected === -2) {
      ctx.fillStyle = 'rgba(234, 179, 8, 0.5)';
      ctx.beginPath();
      ctx.arc(res.cx * outW, res.cy * outH, 20, 0, Math.PI * 2);
      ctx.fill();
    }
  });

  return {
    score,
    total: 20,
    studentId,
    details: results,
    processedImage: canvas.toDataURL('image/jpeg', 0.8)
  };
};

// ==========================================
// แสดงผลลัพธ์การตรวจ
// ==========================================
function ResultDisplay({ result, onReset }) {
  return (
    <div className="flex flex-col h-full bg-gray-100">
      <div className="bg-white p-4 shadow-sm flex items-center gap-4 z-10">
        <button onClick={onReset} className="p-2 bg-gray-100 rounded-full text-gray-600 hover:bg-gray-200">
          <ChevronLeft size={24} />
        </button>
        <h2 className="text-lg font-bold">ผลการตรวจ</h2>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* สรุปคะแนน */}
        <div className="bg-white rounded-2xl p-6 shadow-sm border border-gray-100 text-center">
          <p className="text-gray-500 text-sm font-medium mb-1">รหัสนักเรียน</p>
          <p className="text-2xl font-mono font-bold text-gray-800 tracking-widest mb-6">
            {result.studentId.includes('?') ? (
              <span className="text-red-500">{result.studentId} (อ่านไม่ชัด)</span>
            ) : result.studentId}
          </p>
          
          <div className="inline-flex items-end justify-center gap-2">
            <span className="text-6xl font-black text-indigo-600 leading-none">{result.score}</span>
            <span className="text-2xl font-bold text-gray-400 mb-1">/ {result.total}</span>
          </div>
          <p className="text-green-600 font-medium mt-3">
            คิดเป็น {Math.round((result.score / result.total) * 100)}%
          </p>
        </div>

        {/* ภาพกระดาษคำตอบที่ตรวจแล้ว */}
        <div className="bg-white rounded-2xl p-2 shadow-sm border border-gray-100">
          <div className="flex justify-between items-center px-4 py-2 border-b border-gray-50 mb-2">
            <span className="font-semibold text-gray-700">กระดาษคำตอบที่สแกน</span>
            <div className="flex gap-3 text-xs font-medium">
              <span className="text-green-600 flex items-center gap-1"><div className="w-3 h-3 rounded-full border-2 border-green-500"></div> ถูกต้อง</span>
              <span className="text-red-500 flex items-center gap-1"><div className="w-3 h-3 rounded-full border-2 border-red-500"></div> ผิด</span>
            </div>
          </div>
          <img 
            src={result.processedImage} 
            alt="Processed OMR" 
            className="w-full h-auto rounded-xl border border-gray-200"
          />
        </div>

        <button 
          onClick={onReset}
          className="w-full py-4 bg-indigo-600 text-white font-bold rounded-xl shadow-md active:bg-indigo-700 transition-colors"
        >
          สแกนแผ่นต่อไป
        </button>
      </div>
    </div>
  );
}

// ==========================================
// หน้าจอ 2: ระบบตั้งเฉลย
// ==========================================
function AnswerKeyTab({ answerKey, setAnswerKey }) {
  const setAnswer = (qId, optIdx) => {
    setAnswerKey(prev => ({ ...prev, [qId]: optIdx }));
  };

  const randomizeKeys = () => {
    if(window.confirm("ต้องการล้างเฉลยเดิมและสุ่มใหม่ใช่หรือไม่?")) {
      const newKey = {};
      for (let i = 1; i <= 20; i++) {
        newKey[i] = Math.floor(Math.random() * 5);
      }
      setAnswerKey(newKey);
    }
  };

  return (
    <div className="p-4 pb-24">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-2xl font-bold text-gray-800">เฉลยข้อสอบ</h2>
          <p className="text-sm text-gray-500">กำหนดคำตอบที่ถูกต้องสำหรับ 20 ข้อ</p>
        </div>
        <button onClick={randomizeKeys} className="p-2 bg-indigo-50 text-indigo-600 rounded-lg hover:bg-indigo-100">
          <RefreshCw size={20} />
        </button>
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="grid grid-cols-[3rem_1fr] bg-gray-50 border-b border-gray-200 py-3 px-4 font-semibold text-gray-600 text-sm">
          <div className="text-center">ข้อ</div>
          <div className="flex justify-between px-2">
            {OPTIONS_TH.map(opt => <span key={opt} className="w-8 text-center">{opt}</span>)}
          </div>
        </div>
        
        <div className="divide-y divide-gray-100">
          {Array.from({ length: 20 }).map((_, i) => {
            const qId = i + 1;
            return (
              <div key={qId} className="grid grid-cols-[3rem_1fr] py-3 px-4 hover:bg-indigo-50/30 transition-colors">
                <div className="flex items-center justify-center font-bold text-gray-700">
                  {qId}
                </div>
                <div className="flex justify-between px-2">
                  {OPTIONS_TH.map((opt, optIdx) => {
                    const isSelected = answerKey[qId] === optIdx;
                    return (
                      <button
                        key={optIdx}
                        onClick={() => setAnswer(qId, optIdx)}
                        className={`w-8 h-8 rounded-full flex items-center justify-center border-2 transition-all ${
                          isSelected 
                            ? 'border-indigo-600 bg-indigo-600 text-white font-bold scale-110 shadow-sm' 
                            : 'border-gray-300 text-gray-400 hover:border-indigo-300'
                        }`}
                      >
                        {isSelected && <CheckCircle size={16} />}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ==========================================
// หน้าจอ 3: ประวัติการตรวจ
// ==========================================
function HistoryTab({ history }) {
  if (history.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-400 space-y-4 p-6">
        <History size={64} className="opacity-20" />
        <p className="text-lg font-medium text-gray-500">ยังไม่มีประวัติการตรวจข้อสอบ</p>
      </div>
    );
  }

  return (
    <div className="p-4 pb-24">
      <h2 className="text-2xl font-bold text-gray-800 mb-6">ประวัติการตรวจ ({history.length})</h2>
      <div className="space-y-3">
        {history.map(item => (
          <div key={item.id} className="bg-white p-4 rounded-xl shadow-sm border border-gray-100 flex items-center justify-between">
            <div>
              <p className="text-xs text-gray-400 mb-1">
                {new Date(item.date).toLocaleDateString('th-TH', { hour: '2-digit', minute:'2-digit' })}
              </p>
              <div className="flex items-center gap-2">
                <span className="font-medium text-gray-500">รหัส:</span>
                <span className="font-mono font-bold text-lg text-gray-800 tracking-wider">
                  {item.studentId}
                </span>
              </div>
            </div>
            <div className="text-right">
              <div className="inline-flex items-baseline gap-1">
                <span className="text-2xl font-black text-indigo-600">{item.score}</span>
                <span className="text-sm font-bold text-gray-400">/{item.total}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}