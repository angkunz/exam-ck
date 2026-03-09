import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Camera, Upload, CheckCircle, XCircle, Settings, RefreshCw, Save, AlertCircle, ScanLine, Sliders, Map } from 'lucide-react';

export default function App() {
  const [activeTab, setActiveTab] = useState('scan'); 
  const [answerKey, setAnswerKey] = useState(Array(20).fill(null));
  const [subjectName, setSubjectName] = useState('วิชาการออกแบบและเทคโนโลยี ว33106');
  
  const videoRef = useRef(null);
  const fileInputRef = useRef(null);
  const streamRef = useRef(null); 
  const [stream, setStream] = useState(null);
  const [imageSource, setImageSource] = useState(null); 
  const [isProcessing, setIsProcessing] = useState(false);
  const [cameraError, setCameraError] = useState('');
  
  const isProcessingRef = useRef(false);
  const answerKeyRef = useRef(answerKey);
  const animationFrameId = useRef(null);
  const stableFramesCount = useRef(0);
  const [alignedStatus, setAlignedStatus] = useState({ tl: false, tr: false, bl: false, br: false });

  const [scanResult, setScanResult] = useState(null);
  const [warpedImageUrl, setWarpedImageUrl] = useState(null); 

  // ==========================================
  // Grid Config (บนภาพที่ถูกยืดให้ตรงแล้ว 100%)
  // ==========================================
  const [gridConfig, setGridConfig] = useState(() => {
    const saved = localStorage.getItem('omr_flex_config');
    return saved ? JSON.parse(saved) : {
      uLeft: 0.165,   uRight: 0.515,  uStep: 0.052,
      vQ1_7: 0.205,   vQ8_15: 0.612,  vStep: 0.0515,
      uId: 0.697,     vId: 0.550,     uIdStep: 0.052, vIdStep: 0.047
    };
  });

  const saveGridConfig = (newConfig) => {
    setGridConfig(newConfig);
    localStorage.setItem('omr_flex_config', JSON.stringify(newConfig));
  };

  const OPTIONS = ['ก', 'ข', 'ค', 'ง', 'จ'];

  // --- จัดการกล้อง ---
  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    setStream(null);
    if (animationFrameId.current) cancelAnimationFrame(animationFrameId.current);
  }, []);

  const startCamera = useCallback(async () => {
    setCameraError('');
    try {
      if (streamRef.current) streamRef.current.getTracks().forEach(track => track.stop());
      const newStream = await navigator.mediaDevices.getUserMedia({ 
        video: { facingMode: 'environment', width: { ideal: 1080 }, height: { ideal: 1920 } } 
      });
      streamRef.current = newStream;
      setStream(newStream);
      setImageSource('camera');
      setActiveTab('scan');
    } catch (err) {
      setCameraError("ไม่สามารถเข้าถึงกล้องได้ กรุณาอนุญาตการใช้งานกล้อง");
    }
  }, []);

  useEffect(() => {
    if (activeTab === 'scan' && !streamRef.current && imageSource !== 'file') startCamera();
    else if (activeTab !== 'scan') stopCamera(); 
  }, [activeTab, imageSource, startCamera, stopCamera]);

  useEffect(() => { return () => stopCamera(); }, [stopCamera]);

  // ==========================================
  // อัลกอริทึมหาจุด 4 มุมแบบยืดหยุ่นสูง (Center of Mass)
  // ==========================================
  const extractMarkers = (ctx, w, h) => {
    const data = ctx.getImageData(0, 0, w, h).data;
    
    // ค้นหาจุดศูนย์ถ่วงของสีดำในกล่องที่กำหนด (ทนทานต่อแสงและเงา)
    const getMarker = (xPct, yPct, wPct, hPct) => {
      const sx = Math.floor(xPct * w), sy = Math.floor(yPct * h);
      const ew = Math.floor(wPct * w), eh = Math.floor(hPct * h);
      
      let sumX = 0, sumY = 0, count = 0;
      
      // สแกนทุกพิกเซลในโซน
      for (let y = sy; y < sy + eh; y += 2) {
        for (let x = sx; x < sx + ew; x += 2) {
          const i = (y * w + x) * 4;
          const gray = data[i]*0.299 + data[i+1]*0.587 + data[i+2]*0.114;
          if (gray < 90) { // เกณฑ์สีดำ
            sumX += x; sumY += y; count++;
          }
        }
      }
      
      const area = (ew / 2) * (eh / 2); 
      // ต้องมีสีดำอย่างน้อย 1% ของกล่อง และไม่เกิน 40% (ป้องกันมืดทั้งกล่อง)
      if (count > area * 0.01 && count < area * 0.40) { 
        return { x: sumX / count, y: sumY / count }; // คืนค่าพิกัดศูนย์กลางที่แท้จริง
      }
      return null;
    };

    // กำหนดโซนค้นหา 4 มุม ให้กว้างและยืดหยุ่น
    const tl = getMarker(0.0, 0.12, 0.25, 0.20); // บนซ้าย
    const tr = getMarker(0.75, 0.12, 0.25, 0.20); // บนขวา
    const bl = getMarker(0.0, 0.70, 0.25, 0.25); // ล่างซ้าย
    const br = getMarker(0.75, 0.70, 0.25, 0.25); // ล่างขวา

    if (tl && tr && bl && br) {
      const topWidth = Math.hypot(tr.x - tl.x, tr.y - tl.y);
      const leftHeight = Math.hypot(bl.x - tl.x, bl.y - tl.y);
      if (topWidth > w * 0.4 && leftHeight > h * 0.4) return { tl, tr, bl, br }; 
    }
    return { tl, tr, bl, br };
  };

  // ==========================================
  // อัลกอริทึมยืดกระดาษให้ตรงเป๊ะ (Bilinear Mapping to Flat Canvas)
  // ==========================================
  const flattenImage = (sourceCanvas, markers, flatW = 800, flatH = 1131) => {
    const flatCanvas = document.createElement('canvas');
    flatCanvas.width = flatW;
    flatCanvas.height = flatH;
    const flatCtx = flatCanvas.getContext('2d', { willReadFrequently: true });
    const srcCtx = sourceCanvas.getContext('2d', { willReadFrequently: true });
    
    const srcData = srcCtx.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
    const flatData = flatCtx.createImageData(flatW, flatH);
    
    // แมปพิกเซลจากภาพแบน กลับไปยังภาพบิดเบี้ยว เพื่อดึงสีมาใส่
    for (let y = 0; y < flatH; y++) {
      const v = y / flatH;
      for (let x = 0; x < flatW; x++) {
        const u = x / flatW;
        
        const topX = markers.tl.x + (markers.tr.x - markers.tl.x) * u;
        const topY = markers.tl.y + (markers.tr.y - markers.tl.y) * u;
        const botX = markers.bl.x + (markers.br.x - markers.bl.x) * u;
        const botY = markers.bl.y + (markers.br.y - markers.bl.y) * u;

        const srcX = Math.floor(topX + (botX - topX) * v);
        const srcY = Math.floor(topY + (botY - topY) * v);

        if (srcX >= 0 && srcX < sourceCanvas.width && srcY >= 0 && srcY < sourceCanvas.height) {
          const srcIdx = (srcY * sourceCanvas.width + srcX) * 4;
          const flatIdx = (y * flatW + x) * 4;
          flatData.data[flatIdx] = srcData.data[srcIdx];
          flatData.data[flatIdx+1] = srcData.data[srcIdx+1];
          flatData.data[flatIdx+2] = srcData.data[srcIdx+2];
          flatData.data[flatIdx+3] = 255;
        }
      }
    }
    flatCtx.putImageData(flatData, 0, 0);
    return flatCanvas;
  };

  // --- สร้างพิกัดอ้างอิงบนภาพแบนๆ ---
  const generateExpectedPoints = (config) => {
    const points = [];
    for (let q = 0; q < 20; q++) {
      let baseU, v;
      if (q < 7) { baseU = config.uLeft; v = config.vQ1_7 + (q * config.vStep); }
      else if (q < 15) { baseU = config.uLeft; v = config.vQ8_15 + ((q - 7) * config.vStep); }
      else { baseU = config.uRight; v = config.vQ1_7 + ((q - 15) * config.vStep); }

      for (let opt = 0; opt < 5; opt++) {
        points.push({ type: 'ans', q, opt, u: baseU + (opt * config.uStep), v });
      }
    }
    for (let digit = 0; digit < 5; digit++) {
      const u = config.uId + (digit * config.uIdStep);
      for (let num = 0; num < 10; num++) {
        points.push({ type: 'id', digit, num, u, v: config.vId + (num * config.vIdStep) });
      }
    }
    return points;
  };

  // --- OMR Logic บนภาพแบน ---
  const processImageInternal = useCallback((sourceCanvas, markers) => {
    setIsProcessing(true);
    setScanResult(null);

    if (answerKeyRef.current.includes(null)) {
      alert("คำเตือน: ยังไม่ได้ตั้งค่าเฉลยให้ครบ 20 ข้อ กรุณาตั้งเฉลยก่อนสแกน");
      setIsProcessing(false);
      setActiveTab('keys');
      return;
    }

    setTimeout(() => {
      // 1. ดึงภาพให้ตรงเป๊ะเป็นขนาด A4 (800x1131)
      const flatCanvas = flattenImage(sourceCanvas, markers, 800, 1131);
      const flatCtx = flatCanvas.getContext('2d', { willReadFrequently: true });
      const flatImageData = flatCtx.getImageData(0, 0, 800, 1131).data;
      
      setWarpedImageUrl(flatCanvas.toDataURL('image/jpeg', 0.8));

      // 2. ระบบค้นหาจุดที่ดำที่สุดบริเวณใกล้เคียง (Dynamic Local Search)
      const radius = 12; // รัศมีวงกลมตัวเลือกโดยประมาณ
      
      const analyzeBubble = (u, v) => {
        const centerX = Math.floor(u * 800);
        const centerY = Math.floor(v * 1131);
        
        let darkPixels = 0, totalPixels = 0, totalGray = 0;
        
        // กวาดรอบๆ จุดศูนย์กลาง เพื่อแก้ปัญหาพิกัดเคลื่อนเล็กน้อย
        for (let y = centerY - radius; y < centerY + radius; y++) {
          for (let x = centerX - radius; x < centerX + radius; x++) {
            if (x >= 0 && x < 800 && y >= 0 && y < 1131) {
              const idx = (y * 800 + x) * 4;
              const gray = 0.299 * flatImageData[idx] + 0.587 * flatImageData[idx + 1] + 0.114 * flatImageData[idx + 2];
              if (gray < 130) darkPixels++; 
              totalGray += gray;
              totalPixels++;
            }
          }
        }

        return {
          density: totalPixels > 0 ? (darkPixels / totalPixels) : 0,
          avgGray: totalPixels > 0 ? (totalGray / totalPixels) : 255,
          center: { x: u, y: v } 
        };
      };

      const points = generateExpectedPoints(gridConfig);
      const detectedAnswers = Array(20).fill(null);
      const idValues = Array(5).fill("?");
      
      const optionsData = {}; 
      const idData = {};

      points.forEach(pt => {
        const res = analyzeBubble(pt.u, pt.v);
        if (pt.type === 'ans') {
          if(!optionsData[pt.q]) optionsData[pt.q] = [];
          optionsData[pt.q].push({ ...pt, ...res });
        } else {
          if(!idData[pt.digit]) idData[pt.digit] = [];
          idData[pt.digit].push({ ...pt, ...res });
        }
      });

      // ประมวลผลคำตอบ
      Object.keys(optionsData).forEach(q => {
        const options = optionsData[q];
        options.sort((a, b) => a.avgGray - b.avgGray); // หาช่องที่มืดที่สุด
        const darkest = options[0];
        const lightest = options[options.length - 1];
        
        // ถ้าช่องที่มืดที่สุด มีความต่างสีชัดเจน และดำเกิน 8% ให้ถือว่าฝน
        if (lightest.avgGray - darkest.avgGray > 15 || darkest.density > 0.08) {
          detectedAnswers[q] = OPTIONS[darkest.opt];
        }
      });

      // ประมวลผลรหัสนักเรียน
      Object.keys(idData).forEach(d => {
        const options = idData[d];
        options.sort((a, b) => a.avgGray - b.avgGray);
        const darkest = options[0];
        const lightest = options[options.length - 1];
        if (lightest.avgGray - darkest.avgGray > 15 || darkest.density > 0.08) {
          idValues[d] = darkest.num.toString();
        }
      });

      let score = 0;
      const details = [];
      const keys = answerKeyRef.current;
      
      for (let i = 0; i < 20; i++) {
        const isCorrect = detectedAnswers[i] === keys[i];
        if (isCorrect) score++;
        details.push({
          qNumber: i + 1, studentAns: detectedAnswers[i], correctAns: keys[i], isCorrect, 
          // บันทึกตำแหน่งกล่องสีแดง/เขียว สำหรับหน้าผลลัพธ์
          box: { x: optionsData[i][0].u - 0.015, y: optionsData[i][0].v - 0.011, w: 0.03, h: 0.022 } 
        });
      }

      setScanResult({
        studentId: idValues.join(''), score, total: 20, details, 
        radarPoints: points // ส่งจุดไปวาดสีน้ำเงิน
      });
      setIsProcessing(false);
      setActiveTab('results');
      stopCamera(); 

    }, 50); // ดีเลย์เล็กน้อยเพื่อให้ UI อัปเดต state กำลังประมวลผล
  }, [answerKey, gridConfig, stopCamera]);

  const captureAndProcess = useCallback(() => {
    if (!videoRef.current || isProcessingRef.current) return;
    const video = videoRef.current;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    
    // ถ่ายภาพที่ความละเอียดเต็มของวิดีโอ เพื่อให้ได้ข้อมูลชัดที่สุด
    canvas.width = video.videoWidth; 
    canvas.height = video.videoHeight; 
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    
    const markers = extractMarkers(ctx, canvas.width, canvas.height);
    
    if (markers.tl && markers.tr && markers.bl && markers.br) {
      processImageInternal(canvas, markers);
    } else {
      alert("ไม่พบจุด 4 มุม โปรดให้ 4 มุมอยู่ในกรอบแล้วกดถ่ายใหม่");
    }
  }, [processImageInternal]);

  // --- Real-time Video Analysis Loop ---
  const checkAlignmentAndScan = useCallback(() => {
    if (!videoRef.current || isProcessingRef.current || !streamRef.current) {
      animationFrameId.current = requestAnimationFrame(checkAlignmentAndScan);
      return;
    }
    const video = videoRef.current;
    if (video.readyState !== 4) {
      animationFrameId.current = requestAnimationFrame(checkAlignmentAndScan);
      return;
    }

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    canvas.width = 150; canvas.height = 200; // ย่อภาพเพื่อความเร็วในการจับสด
    
    const vW = video.videoWidth, vH = video.videoHeight;
    const targetRatio = canvas.width / canvas.height;
    let sX = 0, sY = 0, sW = vW, sH = vH;
    if ((vW / vH) > targetRatio) { sW = vH * targetRatio; sX = (vW - sW) / 2; } 
    else { sH = vW / targetRatio; sY = (vH - sH) / 2; }

    ctx.drawImage(video, sX, sY, sW, sH, 0, 0, canvas.width, canvas.height);
    const markers = extractMarkers(ctx, canvas.width, canvas.height);
    
    setAlignedStatus({ tl: !!markers.tl, tr: !!markers.tr, bl: !!markers.bl, br: !!markers.br });

    if (markers.tl && markers.tr && markers.bl && markers.br) {
      stableFramesCount.current++;
      // ทนนิ่ง 10 เฟรม (~0.3 วิ) ก็สั่งถ่ายเลย
      if (stableFramesCount.current > 10 && !answerKeyRef.current.includes(null)) {
        stableFramesCount.current = 0;
        captureAndProcess(); 
        return; 
      }
    } else {
      stableFramesCount.current = 0;
    }
    animationFrameId.current = requestAnimationFrame(checkAlignmentAndScan);
  }, [captureAndProcess]);

  useEffect(() => {
    if (activeTab === 'scan' && stream && videoRef.current) {
      videoRef.current.srcObject = stream;
      videoRef.current.play().then(() => {
          stableFramesCount.current = 0;
          animationFrameId.current = requestAnimationFrame(checkAlignmentAndScan);
      }).catch(e => console.error(e));
    }
    return () => { if (animationFrameId.current) cancelAnimationFrame(animationFrameId.current); };
  }, [activeTab, stream, checkAlignmentAndScan]);

  const handleManualUpload = (e) => {
    const file = e.target.files[0];
    if (file) {
      stopCamera();
      const reader = new FileReader();
      reader.onload = (event) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = img.width; canvas.height = img.height; 
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(img, 0, 0);
          
          const markers = extractMarkers(ctx, canvas.width, canvas.height);
          if (markers.tl && markers.tr && markers.bl && markers.br) {
            setImageSource('file');
            processImageInternal(canvas, markers);
          } else {
            alert("รูปภาพไม่ชัดเจน ระบบหาจุดสี่เหลี่ยมสีดำ 4 มุมไม่เจอครับ");
            startCamera();
          }
        };
        img.src = event.target.result;
      };
      reader.readAsDataURL(file);
    }
  };

  // ==========================================
  // UI RENDERERS
  // ==========================================

  const renderKeysTab = () => (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto bg-white rounded-xl shadow-sm border border-gray-100">
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-2xl font-bold text-gray-800 flex items-center"><Settings className="w-6 h-6 mr-2 text-indigo-600" />ตั้งค่าเฉลย</h2>
        <button onClick={() => setAnswerKey(Array(20).fill(null).map(() => OPTIONS[Math.floor(Math.random() * 5)]))} className="text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 py-2 px-4 rounded-lg">สุ่มเฉลย</button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-8">
        {[0, 1].map(col => (
          <div key={`col-${col}`} className="space-y-3">
            {Array(10).fill(null).map((_, i) => {
              const qNum = (col * 10) + i;
              return (
                <div key={qNum} className="flex items-center p-2 hover:bg-gray-50 rounded-lg border-b border-gray-50">
                  <span className="w-8 font-bold text-gray-700 text-right mr-4">{qNum + 1}.</span>
                  <div className="flex space-x-2">
                    {OPTIONS.map(opt => (
                      <button key={opt} onClick={() => { const newKeys = [...answerKey]; newKeys[qNum] = opt; setAnswerKey(newKeys); }} className={`w-10 h-10 rounded-full font-medium transition-all ${ answerKey[qNum] === opt ? 'bg-indigo-600 text-white scale-110 shadow-md' : 'bg-white border-2 border-gray-300 text-gray-600' }`}>{opt}</button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );

  const renderScanTab = () => (
    <div className="p-4 sm:p-6 max-w-2xl mx-auto bg-white rounded-xl shadow-sm border border-gray-100 text-center">
      <h2 className="text-2xl font-bold text-gray-800 mb-2 flex items-center justify-center"><ScanLine className="w-6 h-6 mr-2 text-indigo-600" />สแกนยืดหยุ่น 360 องศา</h2>
      <p className="text-gray-500 mb-6 text-sm">ถือกล้องเอียงได้เลย ขอแค่จุดสี่เหลี่ยมดำ 4 มุม อยู่ในโซนกรอบสีขาวบนจอ</p>
      
      <div style={{ aspectRatio: '3 / 4' }} className="relative bg-black rounded-xl overflow-hidden shadow-inner max-w-sm mx-auto mb-6 flex items-center justify-center">
        {stream ? (
          <>
            <video ref={videoRef} autoPlay playsInline muted className="absolute w-full h-full object-cover" />
            <div className="absolute inset-0 pointer-events-none">
              {/* โซนค้นหามุมแบบกว้างขวาง เอียงได้สบายๆ */}
              <div className={`absolute top-[12%] left-[12%] w-[25%] h-[20%] -translate-x-1/2 -translate-y-1/2 border-2 rounded-xl transition-all ${alignedStatus.tl ? 'border-green-500 bg-green-500/20' : 'border-white/40 border-dashed'}`}></div>
              <div className={`absolute top-[12%] left-[88%] w-[25%] h-[20%] -translate-x-1/2 -translate-y-1/2 border-2 rounded-xl transition-all ${alignedStatus.tr ? 'border-green-500 bg-green-500/20' : 'border-white/40 border-dashed'}`}></div>
              <div className={`absolute top-[70%] left-[12%] w-[25%] h-[25%] -translate-x-1/2 -translate-y-1/2 border-2 rounded-xl transition-all ${alignedStatus.bl ? 'border-green-500 bg-green-500/20' : 'border-white/40 border-dashed'}`}></div>
              <div className={`absolute top-[70%] left-[88%] w-[25%] h-[25%] -translate-x-1/2 -translate-y-1/2 border-2 rounded-xl transition-all ${alignedStatus.br ? 'border-green-500 bg-green-500/20' : 'border-white/40 border-dashed'}`}></div>
            </div>
            <div className="absolute bottom-6 left-1/2 transform -translate-x-1/2 z-20">
              <button onClick={captureAndProcess} className="bg-white/90 text-indigo-600 rounded-full p-4 shadow-xl border-4 border-indigo-200 hover:bg-white active:scale-95"><Camera size={32} /></button>
            </div>
            {isProcessing && (
              <div className="absolute inset-0 bg-indigo-900/80 flex flex-col items-center justify-center z-30">
                <RefreshCw className="w-12 h-12 text-white animate-spin mb-4" />
                <p className="text-white font-bold">กำลังดึงภาพให้แบนราบ...</p>
              </div>
            )}
          </>
        ) : (
           <div className="text-gray-400 p-8"><RefreshCw className="w-12 h-12 animate-spin mx-auto mb-4" /><p>กำลังเปิดกล้อง...</p></div>
        )}
      </div>

      <div className="relative w-full max-w-sm mx-auto">
        <input type="file" accept="image/*" ref={fileInputRef} onChange={handleManualUpload} className="hidden" />
        <button onClick={() => fileInputRef.current.click()} className="w-full bg-white border-2 border-gray-300 hover:bg-gray-50 text-gray-700 font-bold py-3 px-8 rounded-lg flex justify-center"><Upload className="w-5 h-5 mr-2" />อัปโหลดภาพจากเครื่อง</button>
      </div>
    </div>
  );

  const renderCalibrateTab = () => {
    if (!warpedImageUrl) {
      return (
        <div className="p-8 text-center bg-white rounded-xl shadow-sm border border-gray-100 max-w-2xl mx-auto">
          <Map className="w-16 h-16 text-indigo-300 mx-auto mb-4" />
          <h2 className="text-xl font-bold text-gray-800 mb-2">ต้องถ่ายภาพก่อนตั้งค่า</h2>
          <button onClick={() => setActiveTab('scan')} className="bg-indigo-600 text-white px-6 py-2 rounded-lg mt-4">ไปหน้าสแกน</button>
        </div>
      );
    }

    const expectedPoints = generateExpectedPoints(gridConfig);

    return (
      <div className="p-4 sm:p-6 max-w-5xl mx-auto bg-white rounded-xl shadow-sm border border-gray-100">
        <h2 className="text-2xl font-bold text-gray-800 mb-2 flex items-center"><Sliders className="w-6 h-6 mr-2 text-indigo-600" /> ปรับจูนพิกัดบนภาพที่ยืดแล้ว</h2>
        <p className="text-gray-500 mb-6 text-sm">ภาพถูกยืดให้ตรง 100% แล้ว เลื่อนแถบด้านล่างเพื่อให้จุดสีน้ำเงินตรงกับช่องวงกลม (ทำครั้งเดียว)</p>
        
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          <div className="flex flex-col items-center">
            <div style={{ aspectRatio: '800 / 1131' }} className="relative border-2 border-gray-200 rounded-lg overflow-hidden max-w-sm w-full bg-gray-100">
              <img src={warpedImageUrl} alt="Warped" className="absolute top-0 left-0 w-full h-full object-cover" />
              {expectedPoints.map((pt, idx) => (
                <div key={`calib-${idx}`} className="absolute w-1.5 h-1.5 bg-blue-600 rounded-full transform -translate-x-1/2 -translate-y-1/2" style={{ left: `${pt.u * 100}%`, top: `${pt.v * 100}%` }}></div>
              ))}
            </div>
          </div>

          <div className="space-y-4 bg-gray-50 p-4 rounded-xl border border-gray-200">
            <h3 className="font-bold text-gray-700">คอลัมน์ซ้าย (ข้อ 1-15)</h3>
            <div>
              <label className="text-xs font-medium">ตำแหน่ง X (ซ้าย-ขวา)</label>
              <input type="range" min="0.10" max="0.25" step="0.001" value={gridConfig.uLeft} onChange={e => setGridConfig({...gridConfig, uLeft: parseFloat(e.target.value)})} className="w-full" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs font-medium">ตำแหน่ง Y ข้อ 1-7</label>
                <input type="range" min="0.15" max="0.30" step="0.001" value={gridConfig.vQ1_7} onChange={e => setGridConfig({...gridConfig, vQ1_7: parseFloat(e.target.value)})} className="w-full" />
              </div>
              <div>
                <label className="text-xs font-medium">ตำแหน่ง Y ข้อ 8-15</label>
                <input type="range" min="0.50" max="0.70" step="0.001" value={gridConfig.vQ8_15} onChange={e => setGridConfig({...gridConfig, vQ8_15: parseFloat(e.target.value)})} className="w-full" />
              </div>
            </div>

            <h3 className="font-bold text-gray-700 mt-4 border-t pt-4">คอลัมน์ขวา (ข้อ 16-20)</h3>
            <div>
              <label className="text-xs font-medium">ตำแหน่ง X (ซ้าย-ขวา)</label>
              <input type="range" min="0.45" max="0.60" step="0.001" value={gridConfig.uRight} onChange={e => setGridConfig({...gridConfig, uRight: parseFloat(e.target.value)})} className="w-full" />
            </div>

            <h3 className="font-bold text-gray-700 mt-4 border-t pt-4">รหัสนักเรียน</h3>
            <div className="grid grid-cols-2 gap-4">
               <div>
                <label className="text-xs font-medium">ตำแหน่ง X</label>
                <input type="range" min="0.60" max="0.80" step="0.001" value={gridConfig.uId} onChange={e => setGridConfig({...gridConfig, uId: parseFloat(e.target.value)})} className="w-full" />
              </div>
              <div>
                <label className="text-xs font-medium">ตำแหน่ง Y</label>
                <input type="range" min="0.45" max="0.65" step="0.001" value={gridConfig.vId} onChange={e => setGridConfig({...gridConfig, vId: parseFloat(e.target.value)})} className="w-full" />
              </div>
            </div>

            <h3 className="font-bold text-gray-700 mt-4 border-t pt-4">ความห่างระหว่างช่อง</h3>
            <div className="grid grid-cols-2 gap-4">
               <div>
                <label className="text-xs font-medium">แนวนอน (uStep)</label>
                <input type="range" min="0.04" max="0.07" step="0.0005" value={gridConfig.uStep} onChange={e => setGridConfig({...gridConfig, uStep: parseFloat(e.target.value)})} className="w-full" />
              </div>
              <div>
                <label className="text-xs font-medium">แนวตั้ง (vStep)</label>
                <input type="range" min="0.04" max="0.07" step="0.0005" value={gridConfig.vStep} onChange={e => setGridConfig({...gridConfig, vStep: parseFloat(e.target.value)})} className="w-full" />
              </div>
            </div>

            <button onClick={() => { saveGridConfig(gridConfig); alert('บันทึกสำเร็จ!'); }} className="w-full mt-4 bg-green-600 text-white font-bold py-3 rounded-lg"><Save className="inline mr-2"/> บันทึกพิกัด</button>
          </div>
        </div>
      </div>
    );
  };

  const renderResultsTab = () => {
    if (!scanResult) return null;

    return (
      <div className="p-4 sm:p-6 max-w-5xl mx-auto bg-white rounded-xl shadow-sm border border-gray-100">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          
          <div className="order-2 lg:order-1 flex flex-col items-center">
            <h3 className="font-bold text-lg text-gray-800 mb-4 flex items-center"><ScanLine className="w-5 h-5 mr-2 text-indigo-600" /> กระดาษที่ถูกยืดให้ตรงแล้ว</h3>
            <div style={{ aspectRatio: '800 / 1131' }} className="relative border-2 border-gray-200 rounded-lg overflow-hidden max-w-sm w-full bg-gray-100 shadow-inner">
              {warpedImageUrl && (
                <>
                  <img src={warpedImageUrl} alt="Warped" className="absolute top-0 left-0 w-full h-full object-cover" />
                  
                  {scanResult.radarPoints && scanResult.radarPoints.map((pt, idx) => (
                    <div key={`radar-${idx}`} className="absolute w-1 h-1 bg-blue-500 rounded-full transform -translate-x-1/2 -translate-y-1/2" style={{ left: `${pt.x * 100}%`, top: `${pt.y * 100}%` }}></div>
                  ))}

                  {scanResult.details.map((item, idx) => {
                    if (!item.box) return null; 
                    return (
                      <div key={idx} className={`absolute border-[3px] rounded-full shadow-sm ${item.isCorrect ? 'border-green-500 bg-green-500/20' : 'border-red-500 bg-red-500/30'}`} style={{ left: `${item.box.x * 100}%`, top: `${item.box.y * 100}%`, width: `${item.box.w * 100}%`, height: `${item.box.h * 100}%` }}>
                        {!item.isCorrect && <span className="absolute -top-6 left-1/2 transform -translate-x-1/2 bg-red-600 text-white text-[10px] font-bold px-1.5 py-0.5 rounded">{item.correctAns}</span>}
                      </div>
                    );
                  })}
                </>
              )}
            </div>
            <button onClick={() => setActiveTab('calibrate')} className="mt-4 text-sm text-indigo-600 hover:text-indigo-800 font-medium"><Sliders className="w-4 h-4 inline mr-1"/> ถ้าพิกัดสีน้ำเงินยังเบี้ยว กดตรงนี้เพื่อจูนแก้ไข</button>
          </div>

          <div className="order-1 lg:order-2">
            <div className="text-center mb-6 pb-6 border-b border-gray-100">
              <h2 className="text-3xl font-bold text-gray-800 mb-2">ผลการตรวจ</h2>
              <div className="flex justify-center gap-4 mt-6">
                <div className="bg-indigo-50 p-4 rounded-xl border border-indigo-100 w-1/2">
                  <p className="text-sm text-indigo-600 font-medium mb-1">รหัสประจำตัว</p>
                  <p className="text-xl font-black text-indigo-900">{scanResult.studentId}</p>
                </div>
                <div className={`p-4 rounded-xl border w-1/2 ${scanResult.score >= 10 ? 'bg-green-50 border-green-100' : 'bg-red-50 border-red-100'}`}>
                  <p className="text-sm font-medium mb-1">คะแนนรวม</p>
                  <p className="text-3xl font-black">{scanResult.score} <span className="text-base text-gray-500 font-medium">/ 20</span></p>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 mb-8">
              {scanResult.details.map((item, index) => (
                <div key={index} className={`p-2 rounded-lg flex items-center justify-between border text-sm ${item.isCorrect ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
                  <span className="font-bold w-6">{item.qNumber}.</span>
                  <span className="flex-1">ตอบ: <b>{item.studentAns || '-'}</b></span>
                  {item.isCorrect ? <CheckCircle className="w-4 h-4 text-green-500" /> : <span className="text-red-500 font-bold text-xs bg-white px-1 border border-red-100 rounded">เฉลย: {item.correctAns}</span>}
                </div>
              ))}
            </div>

            <button onClick={() => setActiveTab('scan')} className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-4 px-8 rounded-lg shadow-md transition flex items-center justify-center text-lg">
              <Camera className="w-6 h-6 mr-2" />สแกนแผ่นต่อไป
            </button>
          </div>
          
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-gray-50 font-sans text-gray-900 pb-12">
      <header className="bg-indigo-600 text-white shadow-md sticky top-0 z-50">
        <div className="max-w-5xl mx-auto px-4 py-3 flex flex-col sm:flex-row items-center justify-between">
          <div className="flex items-center font-bold text-lg mb-2 sm:mb-0">
            <CheckCircle className="w-5 h-5 mr-2 text-indigo-200" /> OMR Ultimate Flex
          </div>
          <nav className="flex space-x-1 bg-indigo-700 p-1 rounded-lg text-sm overflow-x-auto">
            <button onClick={() => setActiveTab('keys')} className={`px-3 py-1.5 rounded-md transition whitespace-nowrap ${activeTab === 'keys' ? 'bg-white text-indigo-700 shadow' : 'text-indigo-100 hover:bg-indigo-600'}`}>เฉลย</button>
            <button onClick={() => setActiveTab('scan')} className={`px-3 py-1.5 rounded-md transition whitespace-nowrap ${activeTab === 'scan' ? 'bg-white text-indigo-700 shadow' : 'text-indigo-100 hover:bg-indigo-600'}`}>สแกน</button>
            <button onClick={() => setActiveTab('results')} disabled={!scanResult} className={`px-3 py-1.5 rounded-md transition whitespace-nowrap ${activeTab === 'results' ? 'bg-white text-indigo-700 shadow' : 'text-indigo-300 opacity-50 cursor-not-allowed'}`}>ผลลัพธ์</button>
            <button onClick={() => setActiveTab('calibrate')} disabled={!warpedImageUrl} className={`px-3 py-1.5 rounded-md transition whitespace-nowrap ${activeTab === 'calibrate' ? 'bg-amber-400 text-amber-900 shadow' : 'text-indigo-100 hover:bg-indigo-600'}`}>
              <Sliders className="w-4 h-4 inline mr-1"/> จูนพิกัด
            </button>
          </nav>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-6">
        {activeTab === 'keys' && renderKeysTab()}
        {activeTab === 'scan' && renderScanTab()}
        {activeTab === 'results' && renderResultsTab()}
        {activeTab === 'calibrate' && renderCalibrateTab()}
      </main>
    </div>
  );
}