import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Camera, FileText, Settings, RefreshCw, Save, AlertCircle, ScanLine, Sliders, Map, LayoutGrid, ChevronRight, CheckCircle, Upload } from 'lucide-react';

// ==========================================
// การตั้งค่าบล็อกตารางเริ่มต้น (ปรับจูนใหม่ให้ตรงกับกระดาษของคุณ)
// ==========================================
const DEFAULT_BLOCKS = [
  { id: 'q1_7', type: 'q', startQ: 1, endQ: 7, u: 0.160, v: 0.201, stepU: 0.059, stepV: 0.045 },
  { id: 'q8_15', type: 'q', startQ: 8, endQ: 15, u: 0.160, v: 0.555, stepU: 0.059, stepV: 0.045 }, 
  { id: 'q16_20', type: 'q', startQ: 16, endQ: 20, u: 0.534, v: 0.201, stepU: 0.059, stepV: 0.045 },
  { id: 'student_id', type: 'id', digits: 5, u: 0.690, v: 0.510, stepU: 0.058, stepV: 0.045 } 
];

// ตำแหน่งของเป้าเล็งบนหน้าจอ (ใช้เป็น Fallback หากหาจุดไม่เจอ)
const TARGET_ZONES = {
  tl: { x: 0.10, y: 0.16, w: 0.15, h: 0.12 },
  tr: { x: 0.90, y: 0.16, w: 0.15, h: 0.12 },
  bl: { x: 0.10, y: 0.84, w: 0.15, h: 0.12 },
  br: { x: 0.90, y: 0.84, w: 0.15, h: 0.12 }
};

export default function App() {
  const [activeTab, setActiveTab] = useState('scan'); 
  
  const [answerKey, setAnswerKey] = useState(() => {
    const saved = localStorage.getItem('omr_answer_key');
    return saved ? JSON.parse(saved) : Array(20).fill(null);
  });
  
  const [subjectName, setSubjectName] = useState(() => {
    return localStorage.getItem('omr_subject_name') || 'วิชาการออกแบบและเทคโนโลยี';
  });
  
  const updateAnswerKey = (newKeys) => {
    setAnswerKey(newKeys);
    answerKeyRef.current = newKeys; 
    localStorage.setItem('omr_answer_key', JSON.stringify(newKeys));
  };

  const updateSubjectName = (val) => {
    setSubjectName(val);
    localStorage.setItem('omr_subject_name', val);
  };
  
  const [cvReady, setCvReady] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);

  const videoRef = useRef(null);
  const fileInputRef = useRef(null);
  const streamRef = useRef(null); 
  const [stream, setStream] = useState(null);
  const [cameraError, setCameraError] = useState('');
  
  const isProcessingRef = useRef(false);
  const answerKeyRef = useRef(answerKey);
  const animationFrameId = useRef(null);
  const stableFramesCount = useRef(0);
  const [alignedCorners, setAlignedCorners] = useState({ tl: false, tr: false, bl: false, br: false });

  const [blocks, setBlocks] = useState(() => {
    const saved = localStorage.getItem('omr_blocks_config');
    return saved ? JSON.parse(saved) : DEFAULT_BLOCKS;
  });

  const [scanResult, setScanResult] = useState(null);
  const [warpedImageUrl, setWarpedImageUrl] = useState(null); 

  const OPTIONS = ['ก', 'ข', 'ค', 'ง', 'จ'];

  useEffect(() => {
    if (window.cv) { setCvReady(true); return; }
    const script = document.createElement("script");
    script.src = "https://docs.opencv.org/4.8.0/opencv.js";
    script.async = true;
    script.onload = () => {
      if (window.cv instanceof Promise) {
          window.cv.then((target) => { window.cv = target; setCvReady(true); });
      } else {
          window.cv['onRuntimeInitialized'] = () => { setCvReady(true); };
      }
    };
    document.body.appendChild(script);
  }, []);

  useEffect(() => { isProcessingRef.current = isProcessing; }, [isProcessing]);

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
        video: { facingMode: 'environment', width: { ideal: 1080 }, height: { ideal: 1440 } } 
      });
      streamRef.current = newStream;
      setStream(newStream);
    } catch (err) {
      setCameraError("ไม่สามารถเข้าถึงกล้องได้ กรุณาอนุญาตกล้อง");
    }
  }, []);

  useEffect(() => {
    if (activeTab === 'scan' && !streamRef.current && cvReady) startCamera();
    else if (activeTab !== 'scan') stopCamera(); 
  }, [activeTab, startCamera, stopCamera, cvReady]);

  useEffect(() => { return () => stopCamera(); }, [stopCamera]);

  // ==========================================
  // Core Engine: หาจุด 4 มุม แบบ Strict Regional (บังคับหาเฉพาะในกรอบ)
  // ==========================================
  const findMarkersStrict = (srcMat) => {
    const cv = window.cv;
    const w = srcMat.cols;
    const h = srcMat.rows;
    let gray = new cv.Mat();
    
    cv.cvtColor(srcMat, gray, cv.COLOR_RGBA2GRAY, 0);

    const getCenterOfMassInZone = (zone) => {
      // คำนวณขอบเขตการค้นหาจากโซนที่กำหนด (± เล็กน้อยเผื่อมือสั่น)
      const sx = Math.max(0, Math.floor((zone.x - zone.w/2) * w));
      const sy = Math.max(0, Math.floor((zone.y - zone.h/2) * h));
      const ew = Math.floor(zone.w * w);
      const eh = Math.floor(zone.h * h);
      
      let sumX = 0, sumY = 0, count = 0;
      
      for (let y = sy; y < sy + eh; y += 2) {
        for (let x = sx; x < sx + ew; x += 2) {
          if (x >= w || y >= h) continue;
          const pixel = gray.ucharPtr(y, x)[0];
          if (pixel < 100) { // เกณฑ์สีดำ
            sumX += x; sumY += y; count++;
          }
        }
      }
      
      const area = (ew / 2) * (eh / 2);
      // ถ้าเจอสีดำมากพอ ให้คืนค่าจุดศูนย์ถ่วง
      if (count > area * 0.05 && count < area * 0.6) {
        return { x: sumX / count, y: sumY / count, found: true };
      }
      // **FALLBACK (สำคัญมาก):** ถ้าหาไม่เจอ ให้ยึดเอาตรงกลางเป้าเล็งเป็นหลักเลย ป้องกันแอปค้าง
      return { x: zone.x * w, y: zone.y * h, found: false };
    };

    try {
      const tl = getCenterOfMassInZone(TARGET_ZONES.tl); 
      const tr = getCenterOfMassInZone(TARGET_ZONES.tr); 
      const bl = getCenterOfMassInZone(TARGET_ZONES.bl); 
      const br = getCenterOfMassInZone(TARGET_ZONES.br); 

      return { tl, tr, bl, br }; 
    } finally {
      gray.delete();
    }
  };

  const generateExpectedPoints = (configBlocks) => {
    const points = [];
    configBlocks.forEach(block => {
      if (block.type === 'q') {
        for (let q = block.startQ - 1; q < block.endQ; q++) {
          const v = block.v + ((q - (block.startQ - 1)) * block.stepV);
          for (let opt = 0; opt < 5; opt++) {
            points.push({ type: 'ans', q, opt, u: block.u + (opt * block.stepU), v });
          }
        }
      } else if (block.type === 'id') {
        for (let digit = 0; digit < block.digits; digit++) {
          const u = block.u + (digit * block.stepU);
          for (let num = 0; num < 10; num++) {
            points.push({ type: 'id', digit, num, u, v: block.v + (num * block.stepV) });
          }
        }
      }
    });
    return points;
  };

  const processImageInternal = useCallback((sourceCanvas) => {
    const cv = window.cv;
    setIsProcessing(true);
    setScanResult(null);

    setTimeout(() => {
      let src = null, warped = null, warpedGray = null, warpedThresh = null;
      let M = null;
      let srcCoords = null, dstCoords = null; 

      try {
        src = cv.imread(sourceCanvas);
        
        // ใช้ระบบจับมุมแบบใหม่ การันตีว่าได้พิกัดเสมอ 100%
        const markersResult = findMarkersStrict(src);

        const WARP_W = 800, WARP_H = 1131; // สัดส่วน A4 (1:1.414)
        warped = new cv.Mat();
        
        srcCoords = cv.matFromArray(4, 1, cv.CV_32FC2, [
          markersResult.tl.x, markersResult.tl.y, 
          markersResult.tr.x, markersResult.tr.y, 
          markersResult.br.x, markersResult.br.y, 
          markersResult.bl.x, markersResult.bl.y
        ]);
        dstCoords = cv.matFromArray(4, 1, cv.CV_32FC2, [
          0, 0, WARP_W, 0, WARP_W, WARP_H, 0, WARP_H
        ]);

        // ดึงภาพให้ตรง
        M = cv.getPerspectiveTransform(srcCoords, dstCoords);
        cv.warpPerspective(src, warped, M, new cv.Size(WARP_W, WARP_H));

        const displayCanvas = document.createElement('canvas');
        cv.imshow(displayCanvas, warped);
        setWarpedImageUrl(displayCanvas.toDataURL('image/jpeg', 0.9));

        warpedGray = new cv.Mat();
        warpedThresh = new cv.Mat();
        cv.cvtColor(warped, warpedGray, cv.COLOR_RGBA2GRAY, 0);
        // Adaptive Threshold เพื่อสู้แสงเงา
        cv.adaptiveThreshold(warpedGray, warpedThresh, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 31, 15);

        const analyzeBubble = (u, v) => {
          const x = Math.floor(u * WARP_W);
          const y = Math.floor(v * WARP_H);
          const radius = 14; 
          
          let roiRect = new cv.Rect(Math.max(0, x - radius), Math.max(0, y - radius), radius * 2, radius * 2);
          let roi = warpedThresh.roi(roiRect);
          
          let nonZero = cv.countNonZero(roi);
          let total = roi.rows * roi.cols;
          let density = total > 0 ? nonZero / total : 0;
          
          roi.delete();
          return { density, center: { x: u, y: v } };
        };

        const points = generateExpectedPoints(blocks);
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

        Object.keys(optionsData).forEach(q => {
          const options = optionsData[q];
          options.sort((a, b) => b.density - a.density); 
          const darkest = options[0];
          // เกณฑ์ความเข้ม
          if (darkest.density > 0.12) {
            detectedAnswers[q] = OPTIONS[darkest.opt];
          }
        });

        Object.keys(idData).forEach(d => {
          const options = idData[d];
          options.sort((a, b) => b.density - a.density);
          const darkest = options[0];
          if (darkest.density > 0.12) {
            idValues[d] = darkest.num.toString();
          }
        });

        let score = 0;
        let totalGraded = 0;
        const details = [];
        const keys = answerKeyRef.current;
        const isKeyEmpty = keys.every(k => k === null); 
        
        for (let i = 0; i < 20; i++) {
          const isGraded = keys[i] !== null; 
          let isCorrect = false;

          if (isGraded) {
            totalGraded++;
            isCorrect = detectedAnswers[i] === keys[i];
            if (isCorrect) score++;
          }
          
          let box = null;
          if (detectedAnswers[i]) {
            const optIdx = OPTIONS.indexOf(detectedAnswers[i]);
            const pt = optionsData[i].find(o => o.opt === optIdx);
            if (pt) box = { x: pt.u - 0.015, y: pt.v - 0.011, w: 0.03, h: 0.022 };
          }
          
          details.push({ 
            qNumber: i + 1, studentAns: detectedAnswers[i], correctAns: keys[i] || '-', 
            isCorrect, box, isGraded 
          });
        }

        setScanResult({
          studentId: idValues.join(''), score, total: totalGraded, details, 
          radarPoints: points, missingKey: isKeyEmpty 
        });
        
        setIsProcessing(false);
        setActiveTab('results');
        stopCamera();

      } catch (err) {
        console.error("Engine Error:", err);
        alert("เกิดข้อผิดพลาดในการประมวลผล กรุณาลองใหม่อีกครั้ง");
        setIsProcessing(false);
      } finally {
        if(src) src.delete(); if(warped) warped.delete(); if(warpedGray) warpedGray.delete();
        if(warpedThresh) warpedThresh.delete(); if(srcCoords) srcCoords.delete();
        if(dstCoords) dstCoords.delete(); if(M) M.delete();
      }
    }, 50); 
  }, [blocks, stopCamera, startCamera]);

  const captureAndProcess = useCallback(() => {
    if (!videoRef.current || isProcessingRef.current) return;
    const video = videoRef.current;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    
    // ครอบตัดภาพตามสัดส่วน 3:4 ให้ตรงกับ UI
    const targetRatio = 3 / 4;
    let sX = 0, sY = 0, sW = video.videoWidth, sH = video.videoHeight;
    
    if ((sW / sH) > targetRatio) { 
      sW = sH * targetRatio; 
      sX = (video.videoWidth - sW) / 2; 
    } else { 
      sH = sW / targetRatio; 
      sY = (video.videoHeight - sH) / 2; 
    }

    canvas.width = sW; 
    canvas.height = sH; 
    ctx.drawImage(video, sX, sY, sW, sH, 0, 0, canvas.width, canvas.height);
    
    processImageInternal(canvas);
  }, [processImageInternal]);

  const checkAlignmentAndScan = useCallback(() => {
    if (!videoRef.current || isProcessingRef.current || !streamRef.current || !window.cv) {
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
    
    const targetRatio = canvas.width / canvas.height;
    let sX = 0, sY = 0, sW = video.videoWidth, sH = video.videoHeight;
    if ((sW / sH) > targetRatio) { sW = sH * targetRatio; sX = (video.videoWidth - sW) / 2; } 
    else { sH = sW / targetRatio; sY = (video.videoHeight - sH) / 2; }

    ctx.drawImage(video, sX, sY, sW, sH, 0, 0, canvas.width, canvas.height);
    
    try {
      let src = window.cv.imread(canvas);
      const markers = findMarkersStrict(src);
      src.delete();

      setAlignedCorners({
        tl: markers.tl.found, tr: markers.tr.found, bl: markers.bl.found, br: markers.br.found
      });

      // ถ้าล็อกเจอ 4 มุมจริงๆ (พบสีดำชัดเจน) จะถ่ายรูปอัตโนมัติ
      if (markers.tl.found && markers.tr.found && markers.bl.found && markers.br.found) {
        stableFramesCount.current++;
        if (stableFramesCount.current > 8) {
          stableFramesCount.current = 0;
          captureAndProcess(); 
          return; 
        }
      } else {
        stableFramesCount.current = 0;
      }
    } catch(e) {}

    animationFrameId.current = requestAnimationFrame(checkAlignmentAndScan);
  }, [captureAndProcess]);

  useEffect(() => {
    if (activeTab === 'scan' && stream && videoRef.current && cvReady) {
      videoRef.current.srcObject = stream;
      videoRef.current.play().then(() => {
          stableFramesCount.current = 0;
          animationFrameId.current = requestAnimationFrame(checkAlignmentAndScan);
      }).catch(e => console.error(e));
    }
    return () => { if (animationFrameId.current) cancelAnimationFrame(animationFrameId.current); };
  }, [activeTab, stream, cvReady, checkAlignmentAndScan]);

  const handleManualUpload = (e) => {
    const file = e.target.files[0];
    if (file) {
      stopCamera();
      const reader = new FileReader();
      reader.onload = (event) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          
          const targetRatio = 3 / 4;
          let sX = 0, sY = 0, sW = img.width, sH = img.height;
          if ((sW / sH) > targetRatio) { sW = sH * targetRatio; sX = (img.width - sW) / 2; } 
          else { sH = sW / targetRatio; sY = (img.height - sH) / 2; }

          const MAX_WIDTH = 1200;
          let w = sW, h = sH;
          if (w > MAX_WIDTH) { h = Math.floor(h * (MAX_WIDTH / w)); w = MAX_WIDTH; }
          
          canvas.width = w; canvas.height = h; 
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(img, sX, sY, sW, sH, 0, 0, w, h);
          
          processImageInternal(canvas);
        };
        img.src = event.target.result;
      };
      reader.readAsDataURL(file);
    }
  };

  // ==========================================
  // UI RENDERERS
  // ==========================================

  if (!cvReady) {
    return (
      <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center p-4 text-white">
        <ScanLine className="w-16 h-16 text-emerald-400 animate-pulse mb-4" />
        <h2 className="text-2xl font-bold tracking-wider">กำลังโหลด AI Engine...</h2>
      </div>
    );
  }

  const renderKeysTab = () => (
    <div className="p-4 max-w-4xl mx-auto bg-white rounded-2xl shadow-sm pb-24 mt-4">
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center mb-6 space-y-4 sm:space-y-0">
        <h2 className="text-2xl font-extrabold text-slate-800">1. ตั้งค่าเฉลย</h2>
        <div className="flex space-x-2">
          <button onClick={() => updateAnswerKey(Array(20).fill(null))} className="text-sm bg-rose-50 hover:bg-rose-100 text-rose-600 py-2 px-4 rounded-full font-bold transition">ล้างข้อมูล</button>
          <button onClick={() => updateAnswerKey(Array(20).fill(null).map(() => OPTIONS[Math.floor(Math.random() * 5)]))} className="text-sm bg-slate-100 hover:bg-slate-200 text-slate-700 py-2 px-4 rounded-full font-bold transition">สุ่มเฉลยด่วน</button>
        </div>
      </div>

      <div className="mb-6">
        <label className="block text-sm font-semibold text-slate-600 mb-2">ชื่อแบบทดสอบ</label>
        <input type="text" value={subjectName} onChange={(e) => updateSubjectName(e.target.value)} className="w-full p-4 bg-slate-50 border-0 rounded-xl focus:ring-2 focus:ring-emerald-500 font-medium" />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {[0, 1].map(col => (
          <div key={`col-${col}`} className="space-y-2 bg-slate-50 p-4 rounded-2xl">
            {Array(10).fill(null).map((_, i) => {
              const qNum = (col * 10) + i;
              return (
                <div key={qNum} className="flex items-center justify-between p-2 hover:bg-white rounded-xl transition">
                  <span className="w-8 font-bold text-slate-400 text-right">{qNum + 1}.</span>
                  <div className="flex space-x-1 sm:space-x-2">
                    {OPTIONS.map(opt => (
                      <button key={opt} onClick={() => { const newKeys = [...answerKey]; newKeys[qNum] = opt; updateAnswerKey(newKeys); }} 
                        className={`w-10 h-10 rounded-full font-bold transition-all ${ answerKey[qNum] === opt ? 'bg-emerald-500 text-white shadow-lg scale-110' : 'bg-white border-2 border-slate-200 text-slate-400 hover:border-emerald-300' }`}>
                        {opt}
                      </button>
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
    <div className="flex flex-col items-center justify-center min-h-[85vh] bg-slate-900 pb-24">
      <div className="text-center mb-4 mt-4">
        <h2 className="text-white font-bold text-xl tracking-wide">สแกนกระดาษคำตอบ</h2>
        <p className="text-slate-400 text-sm">จัดสี่เหลี่ยมมุมกระดาษให้อยู่ในเป้าเล็งแล้วกดถ่าย</p>
      </div>
      
      <div className="relative w-full max-w-sm aspect-[3/4] bg-black rounded-3xl overflow-hidden shadow-2xl border-4 border-slate-800">
        {stream ? (
          <>
            <video ref={videoRef} autoPlay playsInline muted className="absolute w-full h-full object-cover" />
            
            <div className="absolute inset-0 pointer-events-none">
              <div className="absolute inset-0 shadow-[0_0_0_9999px_rgba(0,0,0,0.4)] pointer-events-none rounded-xl m-4"></div>
              {/* เป้าเล็ง 4 มุม ที่เชื่อมกับ TARGET_ZONES */}
              <div className={`absolute top-[16%] left-[10%] w-12 h-12 -translate-x-1/2 -translate-y-1/2 rounded-full border-4 transition-all ${alignedCorners.tl ? 'border-emerald-500 bg-emerald-500/30 scale-110' : 'border-white/50 border-dashed'}`}></div>
              <div className={`absolute top-[16%] left-[90%] w-12 h-12 -translate-x-1/2 -translate-y-1/2 rounded-full border-4 transition-all ${alignedCorners.tr ? 'border-emerald-500 bg-emerald-500/30 scale-110' : 'border-white/50 border-dashed'}`}></div>
              <div className={`absolute top-[84%] left-[10%] w-12 h-12 -translate-x-1/2 -translate-y-1/2 rounded-full border-4 transition-all ${alignedCorners.bl ? 'border-emerald-500 bg-emerald-500/30 scale-110' : 'border-white/50 border-dashed'}`}></div>
              <div className={`absolute top-[84%] left-[90%] w-12 h-12 -translate-x-1/2 -translate-y-1/2 rounded-full border-4 transition-all ${alignedCorners.br ? 'border-emerald-500 bg-emerald-500/30 scale-110' : 'border-white/50 border-dashed'}`}></div>
            </div>

            <div className="absolute bottom-6 w-full flex justify-center z-20">
              <button onClick={captureAndProcess} className="bg-white text-slate-800 rounded-full p-5 shadow-[0_0_20px_rgba(0,0,0,0.3)] hover:scale-95 active:scale-90 transition"><Camera size={32} /></button>
            </div>

            {isProcessing && (
              <div className="absolute inset-0 bg-slate-900/90 flex flex-col items-center justify-center z-30 backdrop-blur-sm">
                <RefreshCw className="w-12 h-12 text-emerald-400 animate-spin mb-4" />
                <p className="text-white font-bold tracking-widest text-lg">กำลังประมวลผล...</p>
              </div>
            )}
          </>
        ) : (
           <div className="text-slate-500 flex flex-col items-center justify-center h-full"><RefreshCw className="w-10 h-10 animate-spin mb-4" />กำลังเปิดกล้อง...</div>
        )}
      </div>

      <div className="mt-8">
        <input type="file" accept="image/*" ref={fileInputRef} onChange={handleManualUpload} className="hidden" />
        <button onClick={() => fileInputRef.current.click()} className="text-slate-300 font-medium px-6 py-2 rounded-full border border-slate-700 hover:bg-slate-800 flex items-center"><Upload className="w-4 h-4 mr-2" />เลือกรูปจากอัลบั้ม</button>
      </div>
    </div>
  );

  const renderTemplateTab = () => {
    if (!warpedImageUrl) {
      return (
        <div className="p-8 text-center bg-white rounded-2xl shadow-sm max-w-xl mx-auto mt-10">
          <LayoutGrid className="w-16 h-16 text-slate-200 mx-auto mb-4" />
          <h2 className="text-xl font-bold text-slate-800 mb-2">ต้องถ่ายภาพกระดาษ 1 แผ่นก่อน</h2>
          <p className="text-slate-500 mb-6 text-sm">การสร้างเทมเพลต (แบ่งโซนข้อสอบ) ต้องใช้ภาพที่ถูกสแกนและยืดให้ตรงแล้ว กรุณาไปสแกนกระดาษเปล่าหรือกระดาษที่ฝนแล้วมา 1 แผ่น</p>
          <button onClick={() => setActiveTab('scan')} className="bg-emerald-500 text-white font-bold px-8 py-3 rounded-full hover:bg-emerald-600 transition shadow-lg">ไปหน้าสแกน</button>
        </div>
      );
    }

    const expectedPoints = generateExpectedPoints(blocks);

    return (
      <div className="p-4 max-w-6xl mx-auto bg-slate-50 rounded-2xl pb-24 mt-4">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-extrabold text-slate-800 flex items-center"><LayoutGrid className="w-6 h-6 mr-2 text-emerald-500" /> สร้างเทมเพลต (Template Editor)</h2>
            <p className="text-slate-500 text-sm mt-1">ปรับตารางจุดสีน้ำเงินให้ตรงกับวงกลมกระดาษ (ลากปรับบล็อกซ้าย-ขวา)</p>
          </div>
          <button onClick={() => { localStorage.setItem('omr_blocks_config', JSON.stringify(blocks)); alert('บันทึกเทมเพลตสำเร็จ! การสแกนครั้งต่อไปจะใช้เทมเพลตนี้'); }} className="bg-slate-800 text-white font-bold py-2 px-6 rounded-full flex items-center shadow-lg hover:bg-black transition"><Save className="w-4 h-4 mr-2"/> บันทึก</button>
        </div>
        
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          <div className="flex justify-center bg-white p-4 rounded-3xl shadow-sm">
            <div style={{ aspectRatio: '800 / 1131' }} className="relative w-full max-w-md border border-slate-200 rounded-xl overflow-hidden bg-slate-100">
              <img src={warpedImageUrl} alt="Template" className="absolute top-0 left-0 w-full h-full object-cover opacity-60" />
              {expectedPoints.map((pt, idx) => (
                <div key={`tp-${idx}`} className="absolute w-2 h-2 bg-blue-600 rounded-full transform -translate-x-1/2 -translate-y-1/2 shadow-sm ring-2 ring-white/50" style={{ left: `${pt.u * 100}%`, top: `${pt.v * 100}%` }}></div>
              ))}
            </div>
          </div>

          <div className="space-y-6">
            {blocks.map((block, idx) => (
              <div key={block.id} className="bg-white p-5 rounded-2xl shadow-sm border border-slate-100">
                <h3 className="font-bold text-slate-700 mb-4 border-b pb-2">
                  {block.type === 'q' ? `โซนคำตอบ (ข้อ ${block.startQ} - ${block.endQ})` : 'โซนรหัสนักเรียน'}
                </h3>
                <div className="grid grid-cols-2 gap-x-6 gap-y-4">
                  <div>
                    <label className="text-xs font-bold text-slate-400 uppercase tracking-wider">แกน X (ซ้าย-ขวา)</label>
                    <input type="range" min="0.05" max="0.90" step="0.001" value={block.u} onChange={e => { const nb = [...blocks]; nb[idx].u = parseFloat(e.target.value); setBlocks(nb); }} className="w-full accent-emerald-500" />
                  </div>
                  <div>
                    <label className="text-xs font-bold text-slate-400 uppercase tracking-wider">แกน Y (บน-ล่าง)</label>
                    <input type="range" min="0.05" max="0.90" step="0.001" value={block.v} onChange={e => { const nb = [...blocks]; nb[idx].v = parseFloat(e.target.value); setBlocks(nb); }} className="w-full accent-emerald-500" />
                  </div>
                  <div>
                    <label className="text-xs font-bold text-slate-400 uppercase tracking-wider">ระยะห่างแนวนอน</label>
                    <input type="range" min="0.03" max="0.08" step="0.0005" value={block.stepU} onChange={e => { const nb = [...blocks]; nb[idx].stepU = parseFloat(e.target.value); setBlocks(nb); }} className="w-full accent-emerald-500" />
                  </div>
                  <div>
                    <label className="text-xs font-bold text-slate-400 uppercase tracking-wider">ระยะห่างแนวตั้ง</label>
                    <input type="range" min="0.03" max="0.08" step="0.0005" value={block.stepV} onChange={e => { const nb = [...blocks]; nb[idx].stepV = parseFloat(e.target.value); setBlocks(nb); }} className="w-full accent-emerald-500" />
                  </div>
                </div>
              </div>
            ))}
            
            <button onClick={() => {
               const canvas = document.createElement('canvas'); canvas.width = 800; canvas.height = 1131;
               const ctx = canvas.getContext('2d');
               const img = new Image(); img.onload = () => { ctx.drawImage(img,0,0,800,1131); processImageInternal(canvas); };
               img.src = warpedImageUrl; 
            }} className="w-full bg-emerald-50 text-emerald-700 font-bold py-4 rounded-xl border border-emerald-200 hover:bg-emerald-100 transition flex items-center justify-center shadow-sm">
              <RefreshCw className="w-5 h-5 mr-2" /> ทดสอบตรวจแผ่นนี้ใหม่ด้วยเทมเพลตปัจจุบัน
            </button>
          </div>
        </div>
      </div>
    );
  };

  const renderResultsTab = () => {
    if (!scanResult) return null;

    return (
      <div className="p-4 sm:p-6 max-w-5xl mx-auto bg-white rounded-2xl shadow-sm pb-24 mt-4">
        
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          <div className="flex flex-col items-center bg-slate-50 p-4 rounded-3xl">
            <div style={{ aspectRatio: '800 / 1131' }} className="relative w-full max-w-md border border-slate-200 rounded-xl overflow-hidden bg-white shadow-sm">
              {warpedImageUrl && (
                <>
                  <img src={warpedImageUrl} alt="Warped" className="absolute top-0 left-0 w-full h-full object-cover" />
                  
                  {scanResult.radarPoints && scanResult.radarPoints.map((pt, idx) => (
                    <div key={`radar-${idx}`} className="absolute w-1.5 h-1.5 bg-blue-500/80 rounded-full transform -translate-x-1/2 -translate-y-1/2" style={{ left: `${pt.u * 100}%`, top: `${pt.v * 100}%` }}></div>
                  ))}

                  {!scanResult.missingKey && scanResult.details.map((item, idx) => {
                    if (!item.box) return null; 
                    
                    let ringClass = 'border-slate-400 bg-slate-400/20'; 
                    if (item.isGraded) {
                       ringClass = item.isCorrect ? 'border-emerald-500 bg-emerald-500/20' : 'border-rose-500 bg-rose-500/30';
                    }

                    return (
                      <div key={idx} className={`absolute border-4 rounded-full shadow-sm ${ringClass}`} style={{ left: `${item.box.x * 100}%`, top: `${item.box.y * 100}%`, width: `${item.box.w * 100}%`, height: `${item.box.h * 100}%` }}>
                        {item.isGraded && !item.isCorrect && <span className="absolute -top-7 left-1/2 transform -translate-x-1/2 bg-rose-600 text-white text-xs font-black px-2 py-0.5 rounded-md shadow">{item.correctAns}</span>}
                      </div>
                    );
                  })}
                </>
              )}
            </div>
            <button onClick={() => setActiveTab('template')} className="mt-6 text-sm text-slate-500 hover:text-slate-800 font-medium flex items-center bg-white px-4 py-2 rounded-full shadow-sm border border-slate-200">
              <Sliders className="w-4 h-4 mr-2"/> จุดสีน้ำเงินเบี้ยว? สร้างเทมเพลตใหม่
            </button>
          </div>

          <div className="flex flex-col">
            <div className="bg-slate-800 p-6 rounded-3xl text-white mb-8 shadow-xl flex items-center justify-between">
              <div>
                <p className="text-slate-400 font-medium text-sm mb-1">รหัสประจำตัว</p>
                <p className="text-3xl font-black tracking-widest">{scanResult.studentId}</p>
              </div>
              <div className="text-right">
                <p className="text-slate-400 font-medium text-sm mb-1">คะแนนที่ได้</p>
                <div className="flex items-baseline">
                  <span className={`text-5xl font-black ${scanResult.score > 0 ? 'text-emerald-400' : 'text-slate-400'}`}>
                    {scanResult.missingKey ? '-' : scanResult.score}
                  </span>
                  <span className="text-xl text-slate-500 ml-1">/{scanResult.total}</span>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 flex-1 content-start">
              {scanResult.details.map((item, index) => (
                <div key={index} className={`p-3 rounded-xl flex items-center justify-between border-2 text-sm font-medium ${
                    !item.isGraded ? 'bg-slate-50 border-slate-200' :
                    item.isCorrect ? 'bg-emerald-50 border-emerald-100' : 'bg-rose-50 border-rose-100'
                }`}>
                  <span className="text-slate-500 w-6">{item.qNumber}.</span>
                  <span className="flex-1 text-slate-800 ml-2">ตอบ: <span className="font-black text-lg ml-1">{item.studentAns || '-'}</span></span>
                  
                  {!item.isGraded ? (
                     <span className="text-slate-400 font-bold text-xs bg-slate-200 px-2 py-1 rounded-md shadow-sm">ไม่ได้เฉลย</span>
                  ) : item.isCorrect ? (
                     <CheckCircle className="w-5 h-5 text-emerald-500" />
                  ) : (
                     <span className="text-rose-600 font-bold bg-white px-2 py-1 rounded-md shadow-sm">เฉลย {item.correctAns}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-slate-100 font-sans">
      <header className="bg-white px-6 py-4 shadow-sm sticky top-0 z-40 flex items-center justify-between">
        <div className="flex items-center text-slate-800 font-black text-xl tracking-tight">
          <div className="w-8 h-8 bg-emerald-500 rounded-lg flex items-center justify-center mr-3">
            <CheckCircle className="w-5 h-5 text-white" />
          </div>
          ZipGrade<span className="text-emerald-500 font-light ml-1">Clone</span>
        </div>
      </header>

      <main className="w-full">
        {activeTab === 'keys' && renderKeysTab()}
        {activeTab === 'scan' && renderScanTab()}
        {activeTab === 'results' && renderResultsTab()}
        {activeTab === 'template' && renderTemplateTab()}
      </main>

      <nav className="fixed bottom-0 w-full bg-white border-t border-slate-200 px-6 py-4 flex justify-between items-center z-50 shadow-[0_-10px_20px_rgba(0,0,0,0.05)]">
        <button onClick={() => setActiveTab('keys')} className={`flex flex-col items-center flex-1 transition ${activeTab === 'keys' ? 'text-emerald-600' : 'text-slate-400 hover:text-slate-600'}`}>
          <FileText className={`w-6 h-6 mb-1 ${activeTab === 'keys' ? 'fill-emerald-100' : ''}`} />
          <span className="text-[10px] font-bold tracking-wider">เฉลย</span>
        </button>
        <div className="flex-1 flex justify-center -mt-8">
          <button onClick={() => setActiveTab('scan')} className={`w-16 h-16 rounded-full flex items-center justify-center shadow-xl transition-transform active:scale-95 ${activeTab === 'scan' ? 'bg-emerald-500 text-white' : 'bg-slate-800 text-white'}`}>
            <ScanLine className="w-8 h-8" />
          </button>
        </div>
        <button onClick={() => setActiveTab('template')} className={`flex flex-col items-center flex-1 transition ${activeTab === 'template' ? 'text-emerald-600' : 'text-slate-400 hover:text-slate-600'}`}>
          <LayoutGrid className={`w-6 h-6 mb-1 ${activeTab === 'template' ? 'fill-emerald-100' : ''}`} />
          <span className="text-[10px] font-bold tracking-wider">เทมเพลต</span>
        </button>
      </nav>
    </div>
  );
}