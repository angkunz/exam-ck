import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Camera, Upload, CheckCircle, XCircle, Settings, Play, RefreshCw, Save, AlertCircle, ScanLine, Sliders, Map } from 'lucide-react';

export default function App() {
  const [activeTab, setActiveTab] = useState('scan'); 
  const [answerKey, setAnswerKey] = useState(Array(20).fill(null));
  const [subjectName, setSubjectName] = useState('วิชาการออกแบบและเทคโนโลยี ว33106');
  
  // Camera State
  const videoRef = useRef(null);
  const fileInputRef = useRef(null);
  const streamRef = useRef(null); 
  const [stream, setStream] = useState(null);
  const [cameraError, setCameraError] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  
  // OMR Process Refs & State
  const isProcessingRef = useRef(false); // แก้ไข: ประกาศตัวแปร isProcessingRef
  const animationFrameId = useRef(null);
  const stableFramesCount = useRef(0);
  const [alignedStatus, setAlignedStatus] = useState({ tl: false, tr: false, bl: false, br: false });

  // Results
  const [scanResult, setScanResult] = useState(null);
  const [scannedImageUrl, setScannedImageUrl] = useState(null); 
  const [frozenMarkers, setFrozenMarkers] = useState(null);

  // ==========================================
  // ระบบตั้งค่าพิกัดทองคำ (Calibration Grid)
  // ให้ผู้ใช้ปรับได้เองเพื่อความแม่นยำ 100%
  // ==========================================
  const [gridConfig, setGridConfig] = useState(() => {
    const saved = localStorage.getItem('omr_grid_config');
    return saved ? JSON.parse(saved) : {
      uLeft: 0.165,   // ตำแหน่งแนวนอนคอลัมน์ 1
      uRight: 0.505,  // ตำแหน่งแนวนอนคอลัมน์ 2
      uStep: 0.052,   // ระยะห่าง ก ข ค ง จ
      vQ1_7: 0.205,   // ตำแหน่งแนวตั้ง ข้อ 1
      vQ8_15: 0.620,  // ตำแหน่งแนวตั้ง ข้อ 8 (หลังกระโดดข้าม)
      vStep: 0.054,   // ระยะห่างระหว่างข้อแนวตั้ง
      uId: 0.697,     // แนวนอน รหัสนักเรียน
      vId: 0.558,     // แนวตั้ง รหัสนักเรียน
      uIdStep: 0.052, 
      vIdStep: 0.049
    };
  });

  const saveGridConfig = (newConfig) => {
    setGridConfig(newConfig);
    localStorage.setItem('omr_grid_config', JSON.stringify(newConfig));
  };

  const OPTIONS = ['ก', 'ข', 'ค', 'ง', 'จ'];

  // --- ระบบจัดการกล้อง ---
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
    } catch (err) {
      setCameraError("ไม่สามารถเข้าถึงกล้องได้ กรุณาอนุญาตการใช้งานกล้อง");
    }
  }, []);

  useEffect(() => {
    if (activeTab === 'scan' && !streamRef.current) startCamera();
    else if (activeTab !== 'scan') stopCamera(); 
  }, [activeTab, startCamera, stopCamera]);

  useEffect(() => { return () => stopCamera(); }, [stopCamera]);

  // ==========================================
  // คณิตศาสตร์ขั้นสูง: Perspective Transform (Homography)
  // แก้ปัญหาการถือกล้องเอียง 3 มิติ
  // ==========================================
  const createPerspectiveTransform = (markers) => {
    const { tl, tr, bl, br } = markers;
    const x0=tl.x, y0=tl.y, x1=tr.x, y1=tr.y, x2=br.x, y2=br.y, x3=bl.x, y3=bl.y;
    const dx1 = x1 - x2, dx2 = x3 - x2, sx = x0 - x1 + x2 - x3;
    const dy1 = y1 - y2, dy2 = y3 - y2, sy = y0 - y1 + y2 - y3;

    const det = dx1 * dy2 - dx2 * dy1;
    if (det === 0) return null;

    const g = (sx * dy2 - sy * dx2) / det;
    const h = (dx1 * sy - dy1 * sx) / det;
    const a = x1 - x0 + g * x1;
    const b = x3 - x0 + h * x3;
    const c = x0;
    const d = y1 - y0 + g * y1;
    const e = y3 - y0 + h * y3;
    const f = y0;

    return (u, v) => {
      const w = g * u + h * v + 1;
      return { x: (a * u + b * v + c) / w, y: (d * u + e * v + f) / w };
    };
  };

  // --- ค้นหา 4 มุมกระดาษ (Blob & Shape Detection) ---
  const extractMarkers = (ctx, w, h) => {
    const data = ctx.getImageData(0, 0, w, h).data;
    
    const getMarker = (xPct, yPct, wPct, hPct) => {
      const sx = Math.floor(xPct * w), sy = Math.floor(yPct * h);
      const ew = Math.floor(wPct * w), eh = Math.floor(hPct * h);
      let sumX = 0, sumY = 0, count = 0;
      
      for (let y = sy; y < sy + eh; y += 2) {
        for (let x = sx; x < sx + ew; x += 2) {
          const i = (y * w + x) * 4;
          const gray = data[i]*0.299 + data[i+1]*0.587 + data[i+2]*0.114;
          if (gray < 90) { sumX += x; sumY += y; count++; }
        }
      }
      
      const area = (ew / 2) * (eh / 2); 
      if (count > area * 0.015 && count < area * 0.40) { 
        return { x: sumX / count, y: sumY / count };
      }
      return null;
    };

    const tl = getMarker(0.0, 0.05, 0.25, 0.25); 
    const tr = getMarker(0.75, 0.05, 0.25, 0.25); 
    const bl = getMarker(0.0, 0.75, 0.25, 0.25); 
    const br = getMarker(0.75, 0.75, 0.25, 0.25); 

    if (tl && tr && bl && br) {
      const width = Math.hypot(tr.x - tl.x, tr.y - tl.y);
      const height = Math.hypot(bl.x - tl.x, bl.y - tl.y);
      if (width > w * 0.5 && height > h * 0.5) return { tl, tr, bl, br }; 
    }
    return { tl, tr, bl, br };
  };

  // --- ฟังก์ชันสร้างพิกัดวงกลมทั้งหมด (ใช้ร่วมกันทั้งตรวจผล และพรีวิว Calibration) ---
  const generateExpectedPoints = (config) => {
    const points = [];
    // ข้อ 1-20
    for (let q = 0; q < 20; q++) {
      let baseU, v;
      if (q < 7) { baseU = config.uLeft; v = config.vQ1_7 + (q * config.vStep); }
      else if (q < 15) { baseU = config.uLeft; v = config.vQ8_15 + ((q - 7) * config.vStep); }
      else { baseU = config.uRight; v = config.vQ1_7 + ((q - 15) * config.vStep); }

      for (let opt = 0; opt < 5; opt++) {
        points.push({ type: 'ans', q, opt, u: baseU + (opt * config.uStep), v });
      }
    }
    // รหัสนักเรียน
    for (let digit = 0; digit < 5; digit++) {
      const u = config.uId + (digit * config.uIdStep);
      for (let num = 0; num < 10; num++) {
        points.push({ type: 'id', digit, num, u, v: config.vId + (num * config.vIdStep) });
      }
    }
    return points;
  };

  // --- OMR Logic ---
  const processImageInternal = useCallback((sourceUrl, canvasWidth, canvasHeight, ctx, markers) => {
    setIsProcessing(true);
    setScannedImageUrl(sourceUrl);
    setFrozenMarkers(markers);

    if (answerKey.includes(null)) {
      alert("คำเตือน: ยังไม่ได้ตั้งค่าเฉลยให้ครบ 20 ข้อ ระบบจะแสดงแค่ภาพที่จับได้");
      setIsProcessing(false);
      setActiveTab('calibrate'); // ถ้ายังไม่ตั้งเฉลย ให้เด้งไปหน้า Calibration เพื่อดูความแม่นยำพิกัดก่อน
      return;
    }

    const transform = createPerspectiveTransform(markers);
    if (!transform) { alert("เกิดข้อผิดพลาดในการคำนวณ Perspective"); setIsProcessing(false); return; }

    const analyzePixels = () => {
      const imageData = ctx.getImageData(0, 0, canvasWidth, canvasHeight);
      const data = imageData.data;
      const radius = Math.floor(canvasWidth * 0.018); 

      const checkBubble = (u, v) => {
        const center = transform(u, v);
        let darkPixels = 0, totalPixels = 0, totalGray = 0;

        for (let i = Math.floor(center.y - radius); i < center.y + radius; i++) {
          for (let j = Math.floor(center.x - radius); j < center.x + radius; j++) {
            if (j >= 0 && j < canvasWidth && i >= 0 && i < canvasHeight) {
              const idx = (i * canvasWidth + j) * 4;
              const gray = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
              if (gray < 120) darkPixels++; 
              totalGray += gray; totalPixels++;
            }
          }
        }
        return {
          density: totalPixels > 0 ? (darkPixels / totalPixels) : 0,
          avgGray: totalPixels > 0 ? (totalGray / totalPixels) : 255,
          box: { x: (center.x - radius)/canvasWidth, y: (center.y - radius)/canvasHeight, w: (radius*2)/canvasWidth, h: (radius*2)/canvasHeight },
          center: { x: center.x / canvasWidth, y: center.y / canvasHeight } 
        };
      };

      const points = generateExpectedPoints(gridConfig);
      const detectedAnswers = Array(20).fill(null);
      const detectedBoxes = Array(20).fill(null);
      const idValues = Array(5).fill("?");
      
      const optionsData = {}; 
      const idData = {};

      // รวบรวมค่าความดำทั้งหมด
      points.forEach(pt => {
        const res = checkBubble(pt.u, pt.v);
        if (pt.type === 'ans') {
          if(!optionsData[pt.q]) optionsData[pt.q] = [];
          optionsData[pt.q].push({ ...pt, ...res });
        } else {
          if(!idData[pt.digit]) idData[pt.digit] = [];
          idData[pt.digit].push({ ...pt, ...res });
        }
      });

      // ประมวลผลคำตอบ (หาช่องที่มืดที่สุด)
      Object.keys(optionsData).forEach(q => {
        const options = optionsData[q];
        options.sort((a, b) => a.avgGray - b.avgGray);
        const darkest = options[0];
        const lightest = options[options.length - 1];
        if (lightest.avgGray - darkest.avgGray > 15 || darkest.density > 0.08) {
          detectedAnswers[q] = OPTIONS[darkest.opt];
          detectedBoxes[q] = darkest.box;
        }
      });

      // ประมวลผลรหัส
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
      for (let i = 0; i < 20; i++) {
        const isCorrect = detectedAnswers[i] === answerKey[i];
        if (isCorrect) score++;
        details.push({
          qNumber: i + 1, studentAns: detectedAnswers[i], correctAns: answerKey[i], isCorrect, box: detectedBoxes[i] 
        });
      }

      setScanResult({
        studentId: idValues.join(''), score, total: 20, details, 
        radarPoints: points.map(pt => checkBubble(pt.u, pt.v).center), anchors: markers 
      });
      setIsProcessing(false);
      setActiveTab('results');
      stopCamera(); 
    };

    setTimeout(analyzePixels, 100); 
  }, [answerKey, gridConfig, stopCamera]);

  const captureAndProcess = useCallback(() => {
    if (!videoRef.current || isProcessingRef.current) return;
    const video = videoRef.current;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    canvas.width = 600; canvas.height = 800; 

    const vW = video.videoWidth, vH = video.videoHeight;
    const targetRatio = canvas.width / canvas.height;
    let sX = 0, sY = 0, sW = vW, sH = vH;
    if ((vW / vH) > targetRatio) { sW = vH * targetRatio; sX = (vW - sW) / 2; } 
    else { sH = vW / targetRatio; sY = (vH - sH) / 2; }

    ctx.drawImage(video, sX, sY, sW, sH, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg');
    const markers = extractMarkers(ctx, canvas.width, canvas.height);
    
    if (markers.tl && markers.tr && markers.bl && markers.br) {
      processImageInternal(dataUrl, canvas.width, canvas.height, ctx, markers);
    } else {
      alert("ไม่พบจุด 4 มุม โปรดให้ 4 มุมอยู่ในกรอบแล้วกดถ่ายใหม่");
    }
  }, [processImageInternal]);

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
    canvas.width = 150; canvas.height = 200; 
    
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
      if (stableFramesCount.current > 15) {
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
          canvas.width = 600; canvas.height = 800; 
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          
          const vW = img.width, vH = img.height;
          const targetRatio = canvas.width / canvas.height;
          let sX = 0, sY = 0, sW = vW, sH = vH;
          if ((vW / vH) > targetRatio) { sW = vH * targetRatio; sX = (vW - sW) / 2; } 
          else { sH = vW / targetRatio; sY = (vH - sH) / 2; }
          
          ctx.drawImage(img, sX, sY, sW, sH, 0, 0, canvas.width, canvas.height);
          
          const markers = extractMarkers(ctx, canvas.width, canvas.height);
          if (markers.tl && markers.tr && markers.bl && markers.br) {
            setImageSource('file');
            processImageInternal(canvas.toDataURL('image/jpeg'), canvas.width, canvas.height, ctx, markers);
          } else {
            alert("ภาพไม่ชัดเจน ไม่พบสี่เหลี่ยมสีดำ 4 มุม");
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
      <h2 className="text-2xl font-bold text-gray-800 mb-2 flex items-center justify-center"><ScanLine className="w-6 h-6 mr-2 text-indigo-600" />สแกนกระดาษคำตอบ</h2>
      <p className="text-gray-500 mb-6 text-sm">เล็งสี่เหลี่ยมดำ 4 มุมนอกสุด ให้อยู่ในกรอบสีขาว</p>
      
      <div style={{ aspectRatio: '3 / 4' }} className="relative bg-black rounded-xl overflow-hidden shadow-inner max-w-sm mx-auto mb-6 flex items-center justify-center">
        {stream ? (
          <>
            <video ref={videoRef} autoPlay playsInline muted className="absolute w-full h-full object-cover" />
            <div className="absolute inset-0 pointer-events-none">
              <div className={`absolute top-[17%] left-[10%] w-[18%] h-[12%] -translate-x-1/2 -translate-y-1/2 border-2 rounded-sm transition-all ${alignedStatus.tl ? 'border-green-500 bg-green-500/30' : 'border-white/60 border-dashed'}`}></div>
              <div className={`absolute top-[17%] left-[90%] w-[18%] h-[12%] -translate-x-1/2 -translate-y-1/2 border-2 rounded-sm transition-all ${alignedStatus.tr ? 'border-green-500 bg-green-500/30' : 'border-white/60 border-dashed'}`}></div>
              <div className={`absolute top-[87%] left-[10%] w-[18%] h-[12%] -translate-x-1/2 -translate-y-1/2 border-2 rounded-sm transition-all ${alignedStatus.bl ? 'border-green-500 bg-green-500/30' : 'border-white/60 border-dashed'}`}></div>
              <div className={`absolute top-[87%] left-[90%] w-[18%] h-[12%] -translate-x-1/2 -translate-y-1/2 border-2 rounded-sm transition-all ${alignedStatus.br ? 'border-green-500 bg-green-500/30' : 'border-white/60 border-dashed'}`}></div>
            </div>
            <div className="absolute bottom-6 left-1/2 transform -translate-x-1/2 z-20">
              <button onClick={captureAndProcess} className="bg-white/90 text-indigo-600 rounded-full p-4 shadow-xl border-4 border-indigo-200 hover:bg-white active:scale-95"><Camera size={32} /></button>
            </div>
            {isProcessing && (
              <div className="absolute inset-0 bg-indigo-900/80 flex flex-col items-center justify-center z-30">
                <RefreshCw className="w-12 h-12 text-white animate-spin mb-4" />
                <p className="text-white font-bold">กำลังประมวลผล...</p>
              </div>
            )}
          </>
        ) : (
           <div className="text-gray-400 p-8"><RefreshCw className="w-12 h-12 animate-spin mx-auto mb-4" /><p>กำลังเปิดกล้อง...</p></div>
        )}
      </div>

      <div className="relative w-full max-w-sm mx-auto">
        <input type="file" accept="image/*" ref={fileInputRef} onChange={handleManualUpload} className="hidden" />
        <button onClick={() => fileInputRef.current.click()} className="w-full bg-white border-2 border-gray-300 hover:bg-gray-50 text-gray-700 font-bold py-3 px-8 rounded-lg flex justify-center"><Upload className="w-5 h-5 mr-2" />อัปโหลดภาพ</button>
      </div>
    </div>
  );

  // --- แถบใหม่: Calibration ปรับแต่งพิกัดด้วยสายตา ---
  const renderCalibrateTab = () => {
    if (!scannedImageUrl || !frozenMarkers) {
      return (
        <div className="p-8 text-center bg-white rounded-xl shadow-sm border border-gray-100 max-w-2xl mx-auto">
          <Map className="w-16 h-16 text-indigo-300 mx-auto mb-4" />
          <h2 className="text-xl font-bold text-gray-800 mb-2">ต้องถ่ายภาพก่อนปรับแต่ง</h2>
          <p className="text-gray-500 mb-6">กรุณาไปที่หน้าสแกน ถ่ายภาพกระดาษคำตอบ 1 ครั้ง แล้วกลับมาหน้านี้เพื่อปรับจุดสีน้ำเงินให้ตรงกับกระดาษของคุณ</p>
          <button onClick={() => setActiveTab('scan')} className="bg-indigo-600 text-white px-6 py-2 rounded-lg">ไปหน้าสแกน</button>
        </div>
      );
    }

    const transform = createPerspectiveTransform(frozenMarkers);
    const expectedPoints = generateExpectedPoints(gridConfig);
    const radarPoints = expectedPoints.map(pt => transform ? transform(pt.u, pt.v) : {x:0, y:0});

    return (
      <div className="p-4 sm:p-6 max-w-5xl mx-auto bg-white rounded-xl shadow-sm border border-gray-100">
        <h2 className="text-2xl font-bold text-gray-800 mb-2 flex items-center"><Sliders className="w-6 h-6 mr-2 text-indigo-600" /> ปรับจูนพิกัด (Calibration)</h2>
        <p className="text-gray-500 mb-6 text-sm">เลื่อนแถบด้านล่าง เพื่อให้ <b>จุดสีน้ำเงิน</b> ไปตกตรงกลางวงกลมบนกระดาษของคุณให้พอดีที่สุด (ทำครั้งเดียวจบ)</p>
        
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* พรีวิวแบบสดๆ */}
          <div className="flex flex-col items-center">
            <div style={{ aspectRatio: '3 / 4' }} className="relative border-2 border-gray-200 rounded-lg overflow-hidden max-w-sm w-full bg-gray-100">
              <img src={scannedImageUrl} alt="Scanned" className="absolute top-0 left-0 w-full h-full object-cover opacity-80" />
              {/* วาดจุด 4 มุม */}
              <div className="absolute w-4 h-4 border-2 border-red-500 transform -translate-x-1/2 -translate-y-1/2" style={{ left: `${(frozenMarkers.tl.x/600)*100}%`, top: `${(frozenMarkers.tl.y/800)*100}%` }}></div>
              <div className="absolute w-4 h-4 border-2 border-red-500 transform -translate-x-1/2 -translate-y-1/2" style={{ left: `${(frozenMarkers.tr.x/600)*100}%`, top: `${(frozenMarkers.tr.y/800)*100}%` }}></div>
              <div className="absolute w-4 h-4 border-2 border-red-500 transform -translate-x-1/2 -translate-y-1/2" style={{ left: `${(frozenMarkers.bl.x/600)*100}%`, top: `${(frozenMarkers.bl.y/800)*100}%` }}></div>
              <div className="absolute w-4 h-4 border-2 border-red-500 transform -translate-x-1/2 -translate-y-1/2" style={{ left: `${(frozenMarkers.br.x/600)*100}%`, top: `${(frozenMarkers.br.y/800)*100}%` }}></div>
              
              {/* วาดจุดสีน้ำเงินตามค่าใน Slider ปัจจุบัน */}
              {radarPoints.map((pt, idx) => (
                <div key={`calib-${idx}`} className="absolute w-1.5 h-1.5 bg-blue-600 rounded-full transform -translate-x-1/2 -translate-y-1/2" style={{ left: `${(pt.x/600) * 100}%`, top: `${(pt.y/800) * 100}%` }}></div>
              ))}
            </div>
          </div>

          {/* แผงควบคุม (Sliders) */}
          <div className="space-y-4 bg-gray-50 p-4 rounded-xl border border-gray-200">
            <h3 className="font-bold text-gray-700">คอลัมน์ซ้าย (ข้อ 1-15)</h3>
            <div>
              <label className="text-xs font-medium">ตำแหน่ง X (ซ้าย-ขวา)</label>
              <input type="range" min="0.10" max="0.25" step="0.001" value={gridConfig.uLeft} onChange={e => setGridConfig({...gridConfig, uLeft: parseFloat(e.target.value)})} className="w-full" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs font-medium">ตำแหน่ง Y ข้อ 1-7 (ขึ้น-ลง)</label>
                <input type="range" min="0.15" max="0.30" step="0.001" value={gridConfig.vQ1_7} onChange={e => setGridConfig({...gridConfig, vQ1_7: parseFloat(e.target.value)})} className="w-full" />
              </div>
              <div>
                <label className="text-xs font-medium">ตำแหน่ง Y ข้อ 8-15 (ขึ้น-ลง)</label>
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
                <label className="text-xs font-medium">ตำแหน่ง X (ซ้าย-ขวา)</label>
                <input type="range" min="0.60" max="0.80" step="0.001" value={gridConfig.uId} onChange={e => setGridConfig({...gridConfig, uId: parseFloat(e.target.value)})} className="w-full" />
              </div>
              <div>
                <label className="text-xs font-medium">ตำแหน่ง Y (ขึ้น-ลง)</label>
                <input type="range" min="0.45" max="0.65" step="0.001" value={gridConfig.vId} onChange={e => setGridConfig({...gridConfig, vId: parseFloat(e.target.value)})} className="w-full" />
              </div>
            </div>

            <h3 className="font-bold text-gray-700 mt-4 border-t pt-4">ระยะห่าง (Spacing)</h3>
            <div className="grid grid-cols-2 gap-4">
               <div>
                <label className="text-xs font-medium">ความกว้างระหว่าง ก ข ค ง</label>
                <input type="range" min="0.04" max="0.07" step="0.001" value={gridConfig.uStep} onChange={e => setGridConfig({...gridConfig, uStep: parseFloat(e.target.value)})} className="w-full" />
              </div>
              <div>
                <label className="text-xs font-medium">ความสูงระหว่างข้อ 1 และ 2</label>
                <input type="range" min="0.04" max="0.07" step="0.001" value={gridConfig.vStep} onChange={e => setGridConfig({...gridConfig, vStep: parseFloat(e.target.value)})} className="w-full" />
              </div>
            </div>

            <button onClick={() => { saveGridConfig(gridConfig); alert('บันทึกพิกัดทองคำเรียบร้อยแล้ว!'); }} className="w-full mt-4 bg-green-600 text-white font-bold py-3 rounded-lg flex items-center justify-center">
              <Save className="w-5 h-5 mr-2"/> บันทึกพิกัดใหม่
            </button>
            <button onClick={() => {
               const canvas = document.createElement('canvas'); canvas.width = 600; canvas.height = 800;
               const ctx = canvas.getContext('2d');
               const img = new Image(); img.onload = () => { ctx.drawImage(img,0,0,600,800); processImageInternal(scannedImageUrl, 600, 800, ctx, frozenMarkers); };
               img.src = scannedImageUrl;
            }} className="w-full mt-2 bg-indigo-100 text-indigo-700 font-bold py-3 rounded-lg">
              ทดสอบตรวจกระดาษแผ่นนี้ซ้ำ
            </button>
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
            <h3 className="font-bold text-lg text-gray-800 mb-4 flex items-center"><ScanLine className="w-5 h-5 mr-2 text-indigo-600" /> ภาพที่ระบบอ่านได้</h3>
            <div style={{ aspectRatio: '3 / 4' }} className="relative border-2 border-gray-200 rounded-lg overflow-hidden max-w-sm w-full bg-gray-100">
              {scannedImageUrl && (
                <>
                  <img src={scannedImageUrl} alt="Scanned" className="absolute top-0 left-0 w-full h-full object-cover" />
                  
                  {scanResult.anchors && (
                    <>
                      <div className="absolute w-4 h-4 border-2 border-red-500 transform -translate-x-1/2 -translate-y-1/2" style={{ left: `${(scanResult.anchors.tl.x/600)*100}%`, top: `${(scanResult.anchors.tl.y/800)*100}%` }}></div>
                      <div className="absolute w-4 h-4 border-2 border-red-500 transform -translate-x-1/2 -translate-y-1/2" style={{ left: `${(scanResult.anchors.tr.x/600)*100}%`, top: `${(scanResult.anchors.tr.y/800)*100}%` }}></div>
                      <div className="absolute w-4 h-4 border-2 border-red-500 transform -translate-x-1/2 -translate-y-1/2" style={{ left: `${(scanResult.anchors.bl.x/600)*100}%`, top: `${(scanResult.anchors.bl.y/800)*100}%` }}></div>
                      <div className="absolute w-4 h-4 border-2 border-red-500 transform -translate-x-1/2 -translate-y-1/2" style={{ left: `${(scanResult.anchors.br.x/600)*100}%`, top: `${(scanResult.anchors.br.y/800)*100}%` }}></div>
                    </>
                  )}

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
            {/* ปุ่มทางลัดไปหน้าปรับแต่ง หากพิกัดยังไม่ตรง */}
            <button onClick={() => setActiveTab('calibrate')} className="mt-4 text-sm text-indigo-600 hover:text-indigo-800 font-medium flex items-center">
              <Sliders className="w-4 h-4 mr-1"/> พิกัดเบี้ยว? กดที่นี่เพื่อปรับพิกัดให้ตรงเป๊ะ
            </button>
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
            <CheckCircle className="w-5 h-5 mr-2 text-indigo-200" /> OMR Auto-Grader Pro
          </div>
          <nav className="flex space-x-1 bg-indigo-700 p-1 rounded-lg text-sm overflow-x-auto">
            <button onClick={() => setActiveTab('keys')} className={`px-3 py-1.5 rounded-md transition whitespace-nowrap ${activeTab === 'keys' ? 'bg-white text-indigo-700 shadow' : 'text-indigo-100 hover:bg-indigo-600'}`}>1. เฉลย</button>
            <button onClick={() => setActiveTab('scan')} className={`px-3 py-1.5 rounded-md transition whitespace-nowrap ${activeTab === 'scan' ? 'bg-white text-indigo-700 shadow' : 'text-indigo-100 hover:bg-indigo-600'}`}>2. สแกน</button>
            <button onClick={() => setActiveTab('results')} disabled={!scanResult} className={`px-3 py-1.5 rounded-md transition whitespace-nowrap ${activeTab === 'results' ? 'bg-white text-indigo-700 shadow' : 'text-indigo-300 opacity-50 cursor-not-allowed'}`}>3. ผลลัพธ์</button>
            <button onClick={() => setActiveTab('calibrate')} disabled={!scannedImageUrl} className={`px-3 py-1.5 rounded-md transition whitespace-nowrap ${activeTab === 'calibrate' ? 'bg-amber-400 text-amber-900 shadow' : 'text-indigo-100 hover:bg-indigo-600'}`}>
              <Sliders className="w-4 h-4 inline-block mr-1"/> ปรับพิกัด
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