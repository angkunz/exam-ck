import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Camera, Upload, CheckCircle, XCircle, Settings, RefreshCw, Save, AlertCircle, ScanLine, Sliders, Map, Cpu } from 'lucide-react';

export default function App() {
  const [activeTab, setActiveTab] = useState('scan'); 
  const [answerKey, setAnswerKey] = useState(Array(20).fill(null));
  const [subjectName, setSubjectName] = useState('วิชาการออกแบบและเทคโนโลยี ว33106');
  
  // System State
  const [cvReady, setCvReady] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [cameraError, setCameraError] = useState('');

  // Camera State
  const videoRef = useRef(null);
  const fileInputRef = useRef(null);
  const streamRef = useRef(null); 
  const [stream, setStream] = useState(null);
  const [imageSource, setImageSource] = useState(null); 
  
  // OMR Refs
  const isProcessingRef = useRef(false);
  const answerKeyRef = useRef(answerKey);
  const animationFrameId = useRef(null);
  const stableFramesCount = useRef(0);
  const [hasAligned, setHasAligned] = useState(false);

  // Results
  const [scanResult, setScanResult] = useState(null);
  const [warpedImageUrl, setWarpedImageUrl] = useState(null); 

  // ==========================================
  // Grid Config (อิงจากภาพที่ถูกยืดตรงแล้ว 800x800)
  // ==========================================
  const [gridConfig, setGridConfig] = useState(() => {
    const saved = localStorage.getItem('omr_opencv_config');
    return saved ? JSON.parse(saved) : {
      uLeft: 0.120,   uRight: 0.550,  uStep: 0.065,
      vQ1_7: 0.050,   vQ8_15: 0.550,  vStep: 0.055,
      uId: 0.730,     vId: 0.460,     uIdStep: 0.060, vIdStep: 0.055
    };
  });

  const saveGridConfig = (newConfig) => {
    setGridConfig(newConfig);
    localStorage.setItem('omr_opencv_config', JSON.stringify(newConfig));
  };

  const OPTIONS = ['ก', 'ข', 'ค', 'ง', 'จ'];

  // ==========================================
  // โหลดไลบรารี OpenCV.js แบบ Asynchronous
  // ==========================================
  useEffect(() => {
    if (window.cv) {
      setCvReady(true);
      return;
    }
    const script = document.createElement("script");
    script.src = "https://docs.opencv.org/4.8.0/opencv.js";
    script.async = true;
    script.onload = () => {
      // รอจนกว่า WebAssembly จะรันเสร็จ
      if (window.cv instanceof Promise) {
          window.cv.then((target) => {
             window.cv = target;
             setCvReady(true);
          });
      } else {
          window.cv['onRuntimeInitialized'] = () => {
             setCvReady(true);
          };
      }
    };
    document.body.appendChild(script);
  }, []);

  useEffect(() => { isProcessingRef.current = isProcessing; }, [isProcessing]);
  useEffect(() => { answerKeyRef.current = answerKey; }, [answerKey]);

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
    if (activeTab === 'scan' && !streamRef.current && imageSource !== 'file' && cvReady) startCamera();
    else if (activeTab !== 'scan') stopCamera(); 
  }, [activeTab, imageSource, startCamera, stopCamera, cvReady]);

  useEffect(() => { return () => stopCamera(); }, [stopCamera]);

  // ==========================================
  // OpenCV: ค้นหาสี่เหลี่ยม 4 มุม (Contour Analysis)
  // ==========================================
  const findMarkersOpenCV = (srcMat) => {
    const cv = window.cv;
    let gray = new cv.Mat();
    let thresh = new cv.Mat();
    let contours = new cv.MatVector();
    let hierarchy = new cv.Mat();
    let markers = [];

    try {
      // 1. แปลงเป็นขาวดำ และปรับความต่างแสงให้หาสีดำง่ายขึ้น
      cv.cvtColor(srcMat, gray, cv.COLOR_RGBA2GRAY, 0);
      cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);
      
      // ใช้ Adaptive Threshold สู้กับเงาสะท้อนและแสงไม่สม่ำเสมอ
      cv.adaptiveThreshold(gray, thresh, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 21, 10);

      // 2. หา Contours (รูปทรงต่างๆ)
      cv.findContours(thresh, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

      // 3. คัดกรองหา "สี่เหลี่ยมจัตุรัส"
      const imgArea = srcMat.rows * srcMat.cols;
      for (let i = 0; i < contours.size(); ++i) {
        let cnt = contours.get(i);
        let area = cv.contourArea(cnt);
        
        // กรองขนาด (ต้องไม่เล็กไป และไม่ใหญ่เกินไป)
        if (area < imgArea * 0.001 || area > imgArea * 0.1) continue; 

        let rect = cv.boundingRect(cnt);
        let aspectRatio = rect.width / rect.height;
        
        // ต้องเป็นรูปสี่เหลี่ยมจัตุรัสโดยประมาณ (อัตราส่วน 0.7 - 1.3)
        if (aspectRatio < 0.7 || aspectRatio > 1.3) continue;

        // ต้องมีความทึบสีดำ (Solidness) อย่างน้อย 50% ของกล่อง
        let extent = area / (rect.width * rect.height);
        if (extent < 0.5) continue;

        // หาจุดศูนย์กลางของสี่เหลี่ยม
        let M = cv.moments(cnt);
        let cx = M.m10 / M.m00;
        let cy = M.m01 / M.m00;
        markers.push({ x: cx, y: cy });
      }

      // 4. ถ้าเจอหลายจุด ให้หา 4 จุดนอกสุด (TL, TR, BL, BR)
      if (markers.length >= 4) {
        // สูตรหา 4 มุมสุดคลาสสิก: 
        // TL = min(x+y), BR = max(x+y), TR = min(y-x), BL = max(y-x)
        const tl = markers.reduce((prev, curr) => (curr.x + curr.y < prev.x + prev.y ? curr : prev));
        const br = markers.reduce((prev, curr) => (curr.x + curr.y > prev.x + prev.y ? curr : prev));
        const tr = markers.reduce((prev, curr) => (curr.y - curr.x < prev.y - prev.x ? curr : prev));
        const bl = markers.reduce((prev, curr) => (curr.y - curr.x > prev.y - prev.x ? curr : prev));

        // ตรวจสอบว่าทั้ง 4 จุดกางออกเป็นกรอบสี่เหลี่ยมใหญ่จริงๆ (ป้องกันจับจุดกระจุกตัว)
        const width = Math.hypot(tr.x - tl.x, tr.y - tl.y);
        const height = Math.hypot(bl.x - tl.x, bl.y - tl.y);
        if (width > srcMat.cols * 0.3 && height > srcMat.rows * 0.3) {
          return { tl, tr, bl, br };
        }
      }
      return null;
    } finally {
      // คืนค่าหน่วยความจำ (สำคัญมากสำหรับ OpenCV.js ไม่งั้นเบราว์เซอร์จะค้าง)
      gray.delete(); thresh.delete(); contours.delete(); hierarchy.delete();
    }
  };

  // --- สร้างพิกัดอ้างอิงบนภาพที่ดึงตรงแล้ว ---
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

  // ==========================================
  // OMR Logic ด้วย OpenCV
  // ==========================================
  const processImageInternal = useCallback((sourceCanvas) => {
    const cv = window.cv;
    setIsProcessing(true);
    setScanResult(null);

    if (answerKeyRef.current.includes(null)) {
      alert("คำเตือน: ยังไม่ได้ตั้งค่าเฉลยให้ครบ 20 ข้อ ระบบจะแสดงภาพที่สแกนให้ตรวจสอบพิกัดเท่านั้น");
      setIsProcessing(false);
      setActiveTab('calibrate'); 
      return;
    }

    setTimeout(() => {
      let src = null, warped = null, warpedGray = null, warpedThresh = null;
      let M = null;

      try {
        src = cv.imread(sourceCanvas);
        const markers = findMarkersOpenCV(src);

        if (!markers) {
          alert("OpenCV ไม่พบสี่เหลี่ยมอ้างอิง 4 มุมที่ชัดเจน กรุณาถ่ายใหม่ในที่สว่าง หรือวางกระดาษให้เห็นครบมุม");
          setIsProcessing(false);
          startCamera();
          return;
        }

        // 1. Perspective Transform (ยืดกระดาษให้ตรงเป๊ะ)
        // สร้างกรอบภาพใหม่ขนาด 800x800 (อิงระยะห่างระหว่างจุดอ้างอิง)
        const WARP_W = 800;
        const WARP_H = 800;
        warped = new cv.Mat();
        
        let srcCoords = cv.matFromArray(4, 1, cv.CV_32FC2, [
          markers.tl.x, markers.tl.y, 
          markers.tr.x, markers.tr.y, 
          markers.br.x, markers.br.y, 
          markers.bl.x, markers.bl.y
        ]);
        let dstCoords = cv.matFromArray(4, 1, cv.CV_32FC2, [
          0, 0, 
          WARP_W, 0, 
          WARP_W, WARP_H, 
          0, WARP_H
        ]);

        M = cv.getPerspectiveTransform(srcCoords, dstCoords);
        cv.warpPerspective(src, warped, M, new cv.Size(WARP_W, WARP_H));

        // วาดภาพที่ยืดแล้วลง Canvas เพื่อแสดงผล
        const displayCanvas = document.createElement('canvas');
        cv.imshow(displayCanvas, warped);
        setWarpedImageUrl(displayCanvas.toDataURL('image/jpeg', 0.9));

        // 2. วิเคราะห์รอยดินสอ (Adaptive Threshold)
        warpedGray = new cv.Mat();
        warpedThresh = new cv.Mat();
        cv.cvtColor(warped, warpedGray, cv.COLOR_RGBA2GRAY, 0);
        
        // ใช้ Adaptive Threshold ช่วยกำจัดเงาแสง ทำให้รอยดินสอเด่นชัด
        cv.adaptiveThreshold(warpedGray, warpedThresh, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 31, 15);

        const analyzeBubble = (u, v) => {
          const x = Math.floor(u * WARP_W);
          const y = Math.floor(v * WARP_H);
          const radius = 12; // รัศมีวงกลมบนภาพ 800x800
          
          // ตัดภาพเฉพาะบริเวณวงกลมนั้น
          let roiRect = new cv.Rect(Math.max(0, x - radius), Math.max(0, y - radius), radius * 2, radius * 2);
          let roi = warpedThresh.roi(roiRect);
          
          // นับจำนวนพิกเซลสีดำ (ในภาพ Thresh_INV สีดำจะกลายเป็นสีขาว)
          let nonZero = cv.countNonZero(roi);
          let total = roi.rows * roi.cols;
          let density = total > 0 ? nonZero / total : 0;
          
          roi.delete();
          return { density, center: { x: u, y: v } };
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
          // เรียงจากความดำมากสุดไปน้อยสุด
          options.sort((a, b) => b.density - a.density); 
          const darkest = options[0];
          
          // ถ้าดำกว่า 15% ถือว่าฝน
          if (darkest.density > 0.15) {
            detectedAnswers[q] = OPTIONS[darkest.opt];
          }
        });

        // ประมวลผลรหัส
        Object.keys(idData).forEach(d => {
          const options = idData[d];
          options.sort((a, b) => b.density - a.density);
          const darkest = options[0];
          if (darkest.density > 0.15) {
            idValues[d] = darkest.num.toString();
          }
        });

        let score = 0;
        const details = [];
        const keys = answerKeyRef.current;
        
        for (let i = 0; i < 20; i++) {
          const isCorrect = detectedAnswers[i] === keys[i];
          if (isCorrect) score++;
          
          // หาตำแหน่ง X, Y ของข้อที่ถูกฝนเพื่อวาดกรอบ
          let box = null;
          if (detectedAnswers[i]) {
            const optIdx = OPTIONS.indexOf(detectedAnswers[i]);
            const pt = optionsData[i].find(o => o.opt === optIdx);
            if (pt) box = { x: pt.u - 0.015, y: pt.v - 0.015, w: 0.03, h: 0.03 };
          }

          details.push({
            qNumber: i + 1, studentAns: detectedAnswers[i], correctAns: keys[i], isCorrect, box
          });
        }

        setScanResult({
          studentId: idValues.join(''), score, total: 20, details, 
          radarPoints: points 
        });
        
        setIsProcessing(false);
        setActiveTab('results');
        stopCamera();

      } catch (err) {
        console.error("OpenCV Error:", err);
        alert("เกิดข้อผิดพลาดในการประมวลผลด้วย OpenCV");
        setIsProcessing(false);
      } finally {
        // สำคัญมาก! คืนค่าหน่วยความจำ C++ เสมอ
        if(src) src.delete();
        if(warped) warped.delete();
        if(warpedGray) warpedGray.delete();
        if(warpedThresh) warpedThresh.delete();
        if(srcCoords) srcCoords.delete();
        if(dstCoords) dstCoords.delete();
        if(M) M.delete();
      }
    }, 50); 
  }, [answerKey, gridConfig, stopCamera, startCamera]);

  const captureAndProcess = useCallback(() => {
    if (!videoRef.current || isProcessingRef.current) return;
    const video = videoRef.current;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    
    // ถ่ายภาพเต็มความละเอียด
    canvas.width = video.videoWidth; 
    canvas.height = video.videoHeight; 
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    
    processImageInternal(canvas);
  }, [processImageInternal]);

  // --- Real-time Auto Capture Loop ---
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

    // ย่อภาพให้เล็กลงเพื่อวิเคราะห์สด ไม่กินสเปค
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    canvas.width = 150; canvas.height = 200; 
    
    const vW = video.videoWidth, vH = video.videoHeight;
    const targetRatio = canvas.width / canvas.height;
    let sX = 0, sY = 0, sW = vW, sH = vH;
    if ((vW / vH) > targetRatio) { sW = vH * targetRatio; sX = (vW - sW) / 2; } 
    else { sH = vW / targetRatio; sY = (vH - sH) / 2; }

    ctx.drawImage(video, sX, sY, sW, sH, 0, 0, canvas.width, canvas.height);
    
    // ใช้ OpenCV วิเคราะห์ภาพสด
    try {
      let src = window.cv.imread(canvas);
      const markers = findMarkersOpenCV(src);
      src.delete();

      setHasAligned(!!markers);

      if (markers) {
        stableFramesCount.current++;
        // นิ่ง 8 เฟรม ถ่ายรูปเลย (OpenCV แม่นยำ ไม่ค่อยจับมั่ว)
        if (stableFramesCount.current > 8 && !answerKeyRef.current.includes(null)) {
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
          // จำกัดขนาดเพื่อไม่ให้ OpenCV เปลืองเมมโมรี่เกินไป
          const MAX_WIDTH = 1200;
          let w = img.width; let h = img.height;
          if (w > MAX_WIDTH) { h = Math.floor(h * (MAX_WIDTH / w)); w = MAX_WIDTH; }
          
          canvas.width = w; canvas.height = h; 
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(img, 0, 0, w, h);
          
          setImageSource('file');
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
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-4">
        <Cpu className="w-16 h-16 text-indigo-600 animate-pulse mb-4" />
        <h2 className="text-2xl font-bold text-gray-800">กำลังโหลด AI Engine...</h2>
        <p className="text-gray-500 mt-2">กำลังตั้งค่า OpenCV.js สำหรับการประมวลผลภาพขั้นสูง</p>
      </div>
    );
  }

  const renderKeysTab = () => (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto bg-white rounded-xl shadow-sm border border-gray-100">
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-2xl font-bold text-gray-800 flex items-center"><Settings className="w-6 h-6 mr-2 text-indigo-600" />ตั้งค่าเฉลย</h2>
        <button onClick={() => setAnswerKey(Array(20).fill(null).map(() => OPTIONS[Math.floor(Math.random() * 5)]))} className="text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 py-2 px-4 rounded-lg">สุ่มเฉลย</button>
      </div>
      <div className="mb-6">
        <label className="block text-sm font-medium text-gray-700 mb-2">ชื่อวิชา</label>
        <input type="text" value={subjectName} onChange={(e) => setSubjectName(e.target.value)} className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none" />
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
      <h2 className="text-2xl font-bold text-gray-800 mb-2 flex items-center justify-center"><ScanLine className="w-6 h-6 mr-2 text-indigo-600" />สแกนเอกสาร (OpenCV)</h2>
      <p className="text-gray-500 mb-6 text-sm">เล็งกล้องให้เห็นสี่เหลี่ยม 4 มุมบนกระดาษ เอียงได้ตามสบาย ระบบจะยืดให้ตรงอัตโนมัติ</p>
      
      <div style={{ aspectRatio: '3 / 4' }} className="relative bg-black rounded-xl overflow-hidden shadow-inner max-w-sm mx-auto mb-6 flex items-center justify-center">
        {stream ? (
          <>
            <video ref={videoRef} autoPlay playsInline muted className="absolute w-full h-full object-cover" />
            
            {/* โชว์กรอบสีเขียวรอบนอก เมื่อ AI ตรวจพบ 4 มุม */}
            <div className={`absolute inset-4 border-4 transition-all duration-300 pointer-events-none rounded-lg ${hasAligned ? 'border-green-500 shadow-[0_0_20px_rgba(34,197,94,0.8)]' : 'border-white/30 border-dashed'}`}></div>
            
            <div className="absolute bottom-6 left-1/2 transform -translate-x-1/2 z-20">
              <button onClick={captureAndProcess} className="bg-white/90 text-indigo-600 rounded-full p-4 shadow-xl border-4 border-indigo-200 hover:bg-white active:scale-95"><Camera size={32} /></button>
            </div>
            {isProcessing && (
              <div className="absolute inset-0 bg-indigo-900/80 flex flex-col items-center justify-center z-30">
                <RefreshCw className="w-12 h-12 text-white animate-spin mb-4" />
                <p className="text-white font-bold">OpenCV กำลังประมวลผล...</p>
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
        <h2 className="text-2xl font-bold text-gray-800 mb-2 flex items-center"><Sliders className="w-6 h-6 mr-2 text-indigo-600" /> ปรับจูนพิกัด (OpenCV Warped Map)</h2>
        <p className="text-gray-500 mb-6 text-sm">เลื่อนแถบด้านล่างเพื่อให้ <b>จุดสีน้ำเงิน</b> ไปตกตรงกลางวงกลมบนกระดาษที่ถูกยืดแล้ว</p>
        
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          <div className="flex flex-col items-center">
            <div style={{ aspectRatio: '1 / 1' }} className="relative border-2 border-gray-200 rounded-lg overflow-hidden max-w-md w-full bg-gray-100 shadow-inner">
              <img src={warpedImageUrl} alt="Warped" className="absolute top-0 left-0 w-full h-full object-cover opacity-80" />
              {expectedPoints.map((pt, idx) => (
                <div key={`calib-${idx}`} className="absolute w-1.5 h-1.5 bg-blue-600 rounded-full transform -translate-x-1/2 -translate-y-1/2 shadow-sm border border-white/50" style={{ left: `${pt.u * 100}%`, top: `${pt.v * 100}%` }}></div>
              ))}
            </div>
          </div>

          <div className="space-y-4 bg-gray-50 p-4 rounded-xl border border-gray-200">
            <h3 className="font-bold text-gray-700">คอลัมน์ซ้าย (ข้อ 1-15)</h3>
            <div>
              <label className="text-xs font-medium">ตำแหน่ง X</label>
              <input type="range" min="0.05" max="0.25" step="0.001" value={gridConfig.uLeft} onChange={e => setGridConfig({...gridConfig, uLeft: parseFloat(e.target.value)})} className="w-full" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs font-medium">ตำแหน่ง Y (ข้อ 1-7)</label>
                <input type="range" min="0.01" max="0.20" step="0.001" value={gridConfig.vQ1_7} onChange={e => setGridConfig({...gridConfig, vQ1_7: parseFloat(e.target.value)})} className="w-full" />
              </div>
              <div>
                <label className="text-xs font-medium">ตำแหน่ง Y (ข้อ 8-15)</label>
                <input type="range" min="0.40" max="0.65" step="0.001" value={gridConfig.vQ8_15} onChange={e => setGridConfig({...gridConfig, vQ8_15: parseFloat(e.target.value)})} className="w-full" />
              </div>
            </div>

            <h3 className="font-bold text-gray-700 mt-4 border-t pt-4">คอลัมน์ขวา (ข้อ 16-20)</h3>
            <div>
              <label className="text-xs font-medium">ตำแหน่ง X</label>
              <input type="range" min="0.40" max="0.70" step="0.001" value={gridConfig.uRight} onChange={e => setGridConfig({...gridConfig, uRight: parseFloat(e.target.value)})} className="w-full" />
            </div>

            <h3 className="font-bold text-gray-700 mt-4 border-t pt-4">รหัสนักเรียน</h3>
            <div className="grid grid-cols-2 gap-4">
               <div>
                <label className="text-xs font-medium">ตำแหน่ง X</label>
                <input type="range" min="0.60" max="0.90" step="0.001" value={gridConfig.uId} onChange={e => setGridConfig({...gridConfig, uId: parseFloat(e.target.value)})} className="w-full" />
              </div>
              <div>
                <label className="text-xs font-medium">ตำแหน่ง Y</label>
                <input type="range" min="0.30" max="0.60" step="0.001" value={gridConfig.vId} onChange={e => setGridConfig({...gridConfig, vId: parseFloat(e.target.value)})} className="w-full" />
              </div>
            </div>

            <h3 className="font-bold text-gray-700 mt-4 border-t pt-4">ระยะห่าง (Spacing)</h3>
            <div className="grid grid-cols-2 gap-4">
               <div>
                <label className="text-xs font-medium">ความกว้างตัวเลือก</label>
                <input type="range" min="0.04" max="0.08" step="0.001" value={gridConfig.uStep} onChange={e => setGridConfig({...gridConfig, uStep: parseFloat(e.target.value)})} className="w-full" />
              </div>
              <div>
                <label className="text-xs font-medium">ความสูงรายข้อ</label>
                <input type="range" min="0.04" max="0.08" step="0.001" value={gridConfig.vStep} onChange={e => setGridConfig({...gridConfig, vStep: parseFloat(e.target.value)})} className="w-full" />
              </div>
            </div>

            <button onClick={() => { saveGridConfig(gridConfig); alert('บันทึกสำเร็จ!'); }} className="w-full mt-4 bg-green-600 text-white font-bold py-3 rounded-lg"><Save className="inline mr-2"/> บันทึกพิกัด</button>
            <button onClick={() => {
               const canvas = document.createElement('canvas'); canvas.width = 800; canvas.height = 800;
               const ctx = canvas.getContext('2d');
               const img = new Image(); img.onload = () => { ctx.drawImage(img,0,0,800,800); processImageInternal(canvas); };
               img.src = warpedImageUrl; // ส่งภาพที่ยืดแล้วกลับไปตรวจซ้ำ
            }} className="w-full mt-2 bg-indigo-100 text-indigo-700 font-bold py-3 rounded-lg">
              ทดสอบตรวจใหม่ด้วยพิกัดนี้
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
            <h3 className="font-bold text-lg text-gray-800 mb-4 flex items-center"><ScanLine className="w-5 h-5 mr-2 text-indigo-600" /> ภาพที่ระบบอ่านได้ (Warped)</h3>
            <div style={{ aspectRatio: '1 / 1' }} className="relative border-2 border-gray-200 rounded-lg overflow-hidden max-w-md w-full bg-gray-100 shadow-inner">
              {warpedImageUrl && (
                <>
                  <img src={warpedImageUrl} alt="Warped" className="absolute top-0 left-0 w-full h-full object-cover" />
                  
                  {scanResult.radarPoints && scanResult.radarPoints.map((pt, idx) => (
                    <div key={`radar-${idx}`} className="absolute w-1 h-1 bg-blue-500 rounded-full transform -translate-x-1/2 -translate-y-1/2 shadow-sm border border-white/50" style={{ left: `${pt.u * 100}%`, top: `${pt.v * 100}%` }}></div>
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
            <button onClick={() => setActiveTab('calibrate')} className="mt-4 text-sm text-indigo-600 hover:text-indigo-800 font-medium"><Sliders className="w-4 h-4 inline mr-1"/> ถ้าพิกัดยังเบี้ยว กดตรงนี้เพื่อจูนแก้ไข (Warped Map)</button>
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
            <CheckCircle className="w-5 h-5 mr-2 text-indigo-200" /> OMR OpenCV Pro
          </div>
          <nav className="flex space-x-1 bg-indigo-700 p-1 rounded-lg text-sm overflow-x-auto">
            <button onClick={() => setActiveTab('keys')} className={`px-3 py-1.5 rounded-md transition whitespace-nowrap ${activeTab === 'keys' ? 'bg-white text-indigo-700 shadow' : 'text-indigo-100 hover:bg-indigo-600'}`}>1. เฉลย</button>
            <button onClick={() => setActiveTab('scan')} className={`px-3 py-1.5 rounded-md transition whitespace-nowrap ${activeTab === 'scan' ? 'bg-white text-indigo-700 shadow' : 'text-indigo-100 hover:bg-indigo-600'}`}>2. สแกน</button>
            <button onClick={() => setActiveTab('results')} disabled={!scanResult} className={`px-3 py-1.5 rounded-md transition whitespace-nowrap ${activeTab === 'results' ? 'bg-white text-indigo-700 shadow' : 'text-indigo-300 opacity-50 cursor-not-allowed'}`}>3. ผลลัพธ์</button>
            <button onClick={() => setActiveTab('calibrate')} disabled={!warpedImageUrl} className={`px-3 py-1.5 rounded-md transition whitespace-nowrap ${activeTab === 'calibrate' ? 'bg-amber-400 text-amber-900 shadow' : 'text-indigo-100 hover:bg-indigo-600'}`}>
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