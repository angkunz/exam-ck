import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Camera, Upload, CheckCircle, XCircle, Settings, Play, RefreshCw, Save, AlertCircle, ScanLine, Camera as CameraIcon } from 'lucide-react';

export default function App() {
  const [activeTab, setActiveTab] = useState('scan'); 
  const [answerKey, setAnswerKey] = useState(Array(20).fill(null));
  const [subjectName, setSubjectName] = useState('วิชาการออกแบบและเทคโนโลยี ว33106');
  
  // Camera State
  const videoRef = useRef(null);
  const fileInputRef = useRef(null);
  const streamRef = useRef(null); 
  const [stream, setStream] = useState(null);
  const [imageSource, setImageSource] = useState(null); 
  const [isProcessing, setIsProcessing] = useState(false);
  const [cameraError, setCameraError] = useState('');
  
  // Refs for loop
  const isProcessingRef = useRef(false);
  const answerKeyRef = useRef(answerKey);
  const animationFrameId = useRef(null);
  const stableFramesCount = useRef(0);
  const [alignedStatus, setAlignedStatus] = useState({ tl: false, tr: false, bl: false, br: false });

  // Result State
  const [scanResult, setScanResult] = useState(null);
  const [scannedImageUrl, setScannedImageUrl] = useState(null); 

  const OPTIONS = ['ก', 'ข', 'ค', 'ง', 'จ'];

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
      setCameraError("ไม่สามารถเข้าถึงกล้องได้ กรุณาอนุญาตการใช้งานกล้องในบราวเซอร์");
    }
  }, []);

  useEffect(() => {
    if (activeTab === 'scan' && !streamRef.current && imageSource !== 'file') {
      startCamera();
    } else if (activeTab !== 'scan') {
      stopCamera(); 
    }
  }, [activeTab, imageSource, startCamera, stopCamera]);

  useEffect(() => {
    return () => stopCamera();
  }, [stopCamera]);

  // --- ค้นหา 4 มุมกระดาษ ---
  const extractMarkers = (ctx, w, h) => {
    const data = ctx.getImageData(0, 0, w, h).data;
    
    const getMarker = (xPct, yPct, wPct, hPct) => {
      const sx = Math.floor(xPct * w);
      const sy = Math.floor(yPct * h);
      const ew = Math.floor(wPct * w);
      const eh = Math.floor(hPct * h);
      
      let sumX = 0, sumY = 0, count = 0;
      for (let y = sy; y < sy + eh; y += 2) {
        for (let x = sx; x < sx + ew; x += 2) {
          const i = (y * w + x) * 4;
          const gray = data[i] * 0.299 + data[i+1] * 0.587 + data[i+2] * 0.114;
          if (gray < 90) { 
            sumX += x; sumY += y; count++;
          }
        }
      }
      
      const totalPixels = Math.floor(ew / 2) * Math.floor(eh / 2); 
      if (count > totalPixels * 0.02 && count < totalPixels * 0.35) { 
        return { x: sumX / count, y: sumY / count };
      }
      return null;
    };

    const tl = getMarker(0.02, 0.08, 0.20, 0.15); 
    const tr = getMarker(0.78, 0.08, 0.20, 0.15); 
    const bl = getMarker(0.02, 0.77, 0.20, 0.15); 
    const br = getMarker(0.78, 0.77, 0.20, 0.15); 

    if (tl && tr && bl && br) {
      const topWidth = Math.hypot(tr.x - tl.x, tr.y - tl.y);
      const leftHeight = Math.hypot(bl.x - tl.x, bl.y - tl.y);
      if (topWidth < w * 0.4 || leftHeight < h * 0.4) {
        return { tl: null, tr: null, bl: null, br: null }; 
      }
    }

    return { tl, tr, bl, br };
  };

  // --- ระบบตรวจคำตอบ (Bilinear + Density Check) ---
  const processImageInternal = useCallback((sourceUrl, canvasWidth, canvasHeight, ctx, markers) => {
    setIsProcessing(true);
    setScanResult(null);
    setScannedImageUrl(sourceUrl);

    if (answerKeyRef.current.includes(null)) {
      alert("กรุณาตั้งค่าเฉลยให้ครบทั้ง 20 ข้อก่อนทำการตรวจ");
      setActiveTab('keys');
      setIsProcessing(false);
      return;
    }

    const getInterpolatedPoint = (u, v) => {
      const topX = markers.tl.x + (markers.tr.x - markers.tl.x) * u;
      const topY = markers.tl.y + (markers.tr.y - markers.tl.y) * u;
      const botX = markers.bl.x + (markers.br.x - markers.bl.x) * u;
      const botY = markers.bl.y + (markers.br.y - markers.bl.y) * u;

      const x = topX + (botX - topX) * v;
      const y = topY + (botY - topY) * v;
      return { x, y };
    };

    const analyzePixels = () => {
      const imageData = ctx.getImageData(0, 0, canvasWidth, canvasHeight);
      const data = imageData.data;
      
      // ขยายกรอบค้นหา (Hitbox) ให้ใหญ่ขึ้นมาก เพื่อดักจับรอยฝนแม้พิกัดจะคลาดเคลื่อน
      const radiusX = Math.floor(canvasWidth * 0.020); 
      const radiusY = Math.floor(canvasHeight * 0.015);

      const checkBubble = (u, v) => {
        const center = getInterpolatedPoint(u, v);
        let darkPixels = 0;
        let totalPixels = 0;

        for (let i = Math.floor(center.y - radiusY); i < center.y + radiusY; i++) {
          for (let j = Math.floor(center.x - radiusX); j < center.x + radiusX; j++) {
            if (j >= 0 && j < canvasWidth && i >= 0 && i < canvasHeight) {
              const idx = (i * canvasWidth + j) * 4;
              const gray = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
              // เกณฑ์ความดำของรอยดินสอ
              if (gray < 120) darkPixels++;
              totalPixels++;
            }
          }
        }
        
        // คำนวณความหนาแน่นของสีดำในกรอบ (สู้กับเงาสะท้อนได้ดีกว่าหาค่าเฉลี่ยสี)
        const density = totalPixels > 0 ? (darkPixels / totalPixels) : 0;

        return {
          density: density, 
          box: { 
            x: (center.x - radiusX) / canvasWidth,
            y: (center.y - radiusY) / canvasHeight,
            w: (radiusX * 2) / canvasWidth,
            h: (radiusY * 2) / canvasHeight
          },
          center: { x: center.x / canvasWidth, y: center.y / canvasHeight } // ไว้ใช้วาดเรดาร์สีน้ำเงิน
        };
      };

      const detectedAnswers = Array(20).fill(null);
      const detectedBoxes = Array(20).fill(null);
      const allExpectedPoints = []; // เก็บพิกัดทั้งหมดเพื่อวาดเป็นจุดสีน้ำเงิน
      let studentIdStr = "";

      // พิกัดปรับจูนใหม่ให้ตรงกับกระดาษมาตรฐาน (อิงจากระยะระหว่างจุด 4 มุม)
      const U_LEFT = 0.150;   const V_START = 0.250; 
      const U_STEP = 0.048;   const V_STEP = 0.043; 
      
      const U_RIGHT = 0.540;
      
      const U_ID = 0.655;     const V_ID = 0.575;
      const U_ID_STEP = 0.048; const V_ID_STEP = 0.030;

      // 1. ตรวจคำตอบ (Q1-20)
      for (let q = 0; q < 20; q++) {
        const isLeft = q < 15;
        const baseU = isLeft ? U_LEFT : U_RIGHT;
        const v = isLeft ? V_START + (q * V_STEP) : V_START + ((q - 15) * V_STEP);

        let maxDensity = 0;
        let selectedOption = null;
        let selectedBox = null;

        for (let opt = 0; opt < 5; opt++) {
          const result = checkBubble(baseU + (opt * U_STEP), v);
          allExpectedPoints.push(result.center);

          if (result.density > maxDensity) {
            maxDensity = result.density;
            selectedOption = opt;
            selectedBox = result.box;
          }
        }

        // ต้องมีความดำอย่างน้อย 6% ของกรอบ จึงจะถือว่ามีการฝน (ลดจาก 10% เพื่อให้อ่านดินสออ่อนๆ ได้)
        if (maxDensity > 0.06) {
          detectedAnswers[q] = OPTIONS[selectedOption];
          detectedBoxes[q] = selectedBox;
        }
      }

      // 2. ตรวจรหัสนักเรียน
      for (let digit = 0; digit < 5; digit++) {
        const u = U_ID + (digit * U_ID_STEP);
        let maxDensity = 0;
        let selectedNumber = "?";
        
        for (let num = 0; num < 10; num++) {
          const result = checkBubble(u, V_ID + (num * V_ID_STEP));
          allExpectedPoints.push(result.center);

          if (result.density > maxDensity) {
            maxDensity = result.density;
            selectedNumber = num.toString();
          }
        }

        if (maxDensity > 0.06) {
          studentIdStr += selectedNumber;
        } else {
          studentIdStr += "?";
        }
      }

      // 3. คิดคะแนน
      let score = 0;
      const details = [];
      const keys = answerKeyRef.current;
      
      for (let i = 0; i < 20; i++) {
        const isCorrect = detectedAnswers[i] === keys[i];
        if (isCorrect) score++;
        details.push({
          qNumber: i + 1,
          studentAns: detectedAnswers[i],
          correctAns: keys[i],
          isCorrect,
          box: detectedBoxes[i] 
        });
      }

      setScanResult({
        studentId: studentIdStr.includes("?") ? "อ่านรหัสไม่ชัด" : studentIdStr,
        score,
        total: 20,
        details,
        radarPoints: allExpectedPoints // ส่งจุดทั้งหมดไปแสดง
      });
      setIsProcessing(false);
      setActiveTab('results');
      stopCamera(); 
    };

    setTimeout(analyzePixels, 100); 
  }, [stopCamera]);

  const captureAndProcess = useCallback(() => {
    if (!videoRef.current || isProcessingRef.current) return;
    
    const video = videoRef.current;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    
    canvas.width = 600; canvas.height = 800; 

    const vW = video.videoWidth; const vH = video.videoHeight;
    const vRatio = vW / vH; const targetRatio = canvas.width / canvas.height;

    let sX = 0, sY = 0, sW = vW, sH = vH;
    if (vRatio > targetRatio) {
      sW = vH * targetRatio; sX = (vW - sW) / 2;
    } else {
      sH = vW / targetRatio; sY = (vH - sH) / 2;
    }

    ctx.drawImage(video, sX, sY, sW, sH, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg');
    const markers = extractMarkers(ctx, canvas.width, canvas.height);
    
    if (markers.tl && markers.tr && markers.bl && markers.br) {
      processImageInternal(dataUrl, canvas.width, canvas.height, ctx, markers);
    } else {
      alert("ไม่พบจุดอ้างอิงมุมสีดำทั้ง 4 จุดอย่างชัดเจน กรุณาจัดกระดาษให้ตรงกรอบสีแดงแล้วกดถ่ายใหม่");
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
    
    const vW = video.videoWidth; const vH = video.videoHeight;
    const targetRatio = canvas.width / canvas.height;
    let sX = 0, sY = 0, sW = vW, sH = vH;
    if ((vW / vH) > targetRatio) {
      sW = vH * targetRatio; sX = (vW - sW) / 2;
    } else {
      sH = vW / targetRatio; sY = (vH - sH) / 2;
    }

    ctx.drawImage(video, sX, sY, sW, sH, 0, 0, canvas.width, canvas.height);
    const markers = extractMarkers(ctx, canvas.width, canvas.height);
    
    setAlignedStatus({
      tl: !!markers.tl, tr: !!markers.tr, bl: !!markers.bl, br: !!markers.br
    });

    if (markers.tl && markers.tr && markers.bl && markers.br) {
      stableFramesCount.current++;
      // นิ่ง 15 เฟรม (ประมาณ 0.5 วิ) ถึงจะถ่าย ป้องกันการลั่น
      if (stableFramesCount.current > 15 && !answerKeyRef.current.includes(null)) {
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
    if (imageSource === 'camera' && stream && videoRef.current) {
      videoRef.current.srcObject = stream;
      videoRef.current.play()
        .then(() => {
          stableFramesCount.current = 0;
          animationFrameId.current = requestAnimationFrame(checkAlignmentAndScan);
        })
        .catch(e => console.error("Play error:", e));
    }
    return () => {
      if (animationFrameId.current) cancelAnimationFrame(animationFrameId.current);
    };
  }, [imageSource, stream, checkAlignmentAndScan]);

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
          
          // ตัดหัวกระดาษทิ้ง 16% ให้สัดส่วนตรงกับกล้อง
          const cropY = img.height * 0.16;
          const cropHeight = img.height * 0.84;
          ctx.drawImage(img, 0, cropY, img.width, cropHeight, 0, 0, canvas.width, canvas.height);
          
          const markers = extractMarkers(ctx, canvas.width, canvas.height);
          if (markers.tl && markers.tr && markers.bl && markers.br) {
            setImageSource('file');
            processImageInternal(canvas.toDataURL('image/jpeg'), canvas.width, canvas.height, ctx, markers);
          } else {
            alert("ภาพไม่ชัดเจน ไม่พบสี่เหลี่ยมสีดำ 4 มุมเพื่อใช้เป็นจุดอ้างอิง");
            setImageSource(null);
            startCamera();
          }
        };
        img.src = event.target.result;
      };
      reader.readAsDataURL(file);
    }
  };

  // --- UI Components ---
  const renderKeysTab = () => (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto bg-white rounded-xl shadow-sm border border-gray-100">
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-2xl font-bold text-gray-800 flex items-center">
          <Settings className="w-6 h-6 mr-2 text-indigo-600" />ตั้งค่าเฉลย
        </h2>
        <button 
          onClick={() => setAnswerKey(Array(20).fill(null).map(() => OPTIONS[Math.floor(Math.random() * 5)]))}
          className="text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 py-2 px-4 rounded-lg transition"
        >
          สุ่มเฉลย (ทดสอบ)
        </button>
      </div>
      
      <div className="mb-6">
        <label className="block text-sm font-medium text-gray-700 mb-2">ชื่อวิชา</label>
        <input 
          type="text" value={subjectName} onChange={(e) => setSubjectName(e.target.value)}
          className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none"
        />
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
                      <button
                        key={opt}
                        onClick={() => {
                          const newKeys = [...answerKey];
                          newKeys[qNum] = opt;
                          setAnswerKey(newKeys);
                        }}
                        className={`w-10 h-10 rounded-full font-medium transition-all ${
                          answerKey[qNum] === opt ? 'bg-indigo-600 text-white scale-110 shadow-md' : 'bg-white border-2 border-gray-300 text-gray-600'
                        }`}
                      >
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
    <div className="p-4 sm:p-6 max-w-2xl mx-auto bg-white rounded-xl shadow-sm border border-gray-100 text-center">
      <h2 className="text-2xl font-bold text-gray-800 mb-2 flex items-center justify-center">
        <ScanLine className="w-6 h-6 mr-2 text-indigo-600" />ระบบตรวจอัตโนมัติ
      </h2>
      <p className="text-gray-500 mb-6 text-sm">วางกระดาษบนพื้นราบ เล็งสี่เหลี่ยมดำ 4 มุมให้เข้ากรอบสีแดง<br/>(ระบบจะถ่ายให้อัตโนมัติเมื่อนิ่ง)</p>

      {answerKey.includes(null) ? (
        <div className="bg-red-50 border border-red-200 text-red-700 p-6 rounded-lg mb-6">
          <AlertCircle className="w-12 h-12 mx-auto mb-3 text-red-500" />
          <p className="mb-4">กรุณาตั้งค่าเฉลยให้ครบทั้ง 20 ข้อก่อนใช้งาน</p>
          <button onClick={() => setActiveTab('keys')} className="bg-red-600 hover:bg-red-700 text-white py-2 px-6 rounded-lg">ไปตั้งค่าเฉลย</button>
        </div>
      ) : (
        <>
          <div className="relative bg-black rounded-xl overflow-hidden shadow-inner max-w-sm mx-auto mb-6 aspect-[3/4] flex items-center justify-center">
            
            {imageSource === 'camera' && stream ? (
              <>
                <video ref={videoRef} autoPlay playsInline muted className="absolute w-full h-full object-cover" />
                
                {/* 4 โซนตีกรอบ แนะนำตำแหน่ง */}
                <div className="absolute inset-0 pointer-events-none">
                  <div className={`absolute top-[8%] left-[4%] w-[18%] h-[14%] border-2 rounded-md transition-all ${alignedStatus.tl ? 'border-green-500 bg-green-500/30 shadow-[0_0_10px_rgba(34,197,94,0.5)]' : 'border-red-400 border-dashed bg-red-500/10'}`}></div>
                  <div className={`absolute top-[8%] right-[4%] w-[18%] h-[14%] border-2 rounded-md transition-all ${alignedStatus.tr ? 'border-green-500 bg-green-500/30 shadow-[0_0_10px_rgba(34,197,94,0.5)]' : 'border-red-400 border-dashed bg-red-500/10'}`}></div>
                  <div className={`absolute top-[77%] left-[4%] w-[18%] h-[14%] border-2 rounded-md transition-all ${alignedStatus.bl ? 'border-green-500 bg-green-500/30 shadow-[0_0_10px_rgba(34,197,94,0.5)]' : 'border-red-400 border-dashed bg-red-500/10'}`}></div>
                  <div className={`absolute top-[77%] right-[4%] w-[18%] h-[14%] border-2 rounded-md transition-all ${alignedStatus.br ? 'border-green-500 bg-green-500/30 shadow-[0_0_10px_rgba(34,197,94,0.5)]' : 'border-red-400 border-dashed bg-red-500/10'}`}></div>
                </div>

                <div className="absolute bottom-6 left-1/2 transform -translate-x-1/2 z-20">
                  <button 
                    onClick={captureAndProcess} 
                    className="bg-white/90 text-indigo-600 rounded-full p-4 shadow-xl border-4 border-indigo-200 hover:bg-white transition-all transform active:scale-95"
                    title="บังคับถ่ายรูป"
                  >
                    <CameraIcon size={32} />
                  </button>
                </div>

                {isProcessing && (
                  <div className="absolute inset-0 bg-indigo-900/80 flex flex-col items-center justify-center z-30 backdrop-blur-sm">
                    <RefreshCw className="w-12 h-12 text-white animate-spin mb-4" />
                    <p className="text-white font-bold text-lg">กำลังประมวลผลกระดาษ...</p>
                  </div>
                )}
              </>
            ) : (
              <div className="text-gray-400 flex flex-col items-center p-8 text-center">
                {cameraError ? (
                  <>
                    <XCircle className="w-16 h-16 mb-4 text-red-500 opacity-80" />
                    <p className="text-red-400 mb-4">{cameraError}</p>
                    <button onClick={startCamera} className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">เปิดกล้องใหม่</button>
                  </>
                ) : (
                  <>
                    <RefreshCw className="w-12 h-12 text-indigo-400 animate-spin mb-4" />
                    <p>กำลังเปิดกล้อง...</p>
                  </>
                )}
              </div>
            )}
          </div>

          <div className="flex flex-col justify-center max-w-sm mx-auto">
            <div className="relative w-full">
              <input type="file" accept="image/*" ref={fileInputRef} onChange={handleManualUpload} className="hidden" />
              <button onClick={() => fileInputRef.current.click()} className="w-full bg-white border-2 border-gray-300 hover:bg-gray-50 text-gray-700 font-bold py-3 px-8 rounded-lg transition flex items-center justify-center">
                <Upload className="w-5 h-5 mr-2" />นำเข้าจากแกลเลอรี่
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );

  const renderResultsTab = () => {
    if (!scanResult) return null;

    return (
      <div className="p-4 sm:p-6 max-w-5xl mx-auto bg-white rounded-xl shadow-sm border border-gray-100">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          
          <div className="order-2 lg:order-1 flex flex-col items-center">
            <h3 className="font-bold text-lg text-gray-800 mb-4 flex items-center">
              <ScanLine className="w-5 h-5 mr-2 text-indigo-600" /> ภาพที่ระบบอ่านได้
            </h3>
            <div className="relative border-2 border-gray-200 rounded-lg overflow-hidden max-w-sm w-full bg-gray-100 aspect-[3/4]">
              {scannedImageUrl && (
                <>
                  <img src={scannedImageUrl} alt="Scanned" className="absolute top-0 left-0 w-full h-full object-cover" />
                  
                  {/* จุดเรดาร์สีน้ำเงิน: แสดงตำแหน่ง "ทุกจุด" ที่ระบบคำนวณไว้ ช่วยให้รู้ว่าตำแหน่งตรงหรือไม่ */}
                  {scanResult.radarPoints && scanResult.radarPoints.map((pt, idx) => (
                    <div key={`radar-${idx}`} className="absolute w-1.5 h-1.5 bg-blue-400/50 rounded-full transform -translate-x-1/2 -translate-y-1/2" style={{ left: `${pt.x * 100}%`, top: `${pt.y * 100}%` }}></div>
                  ))}

                  {/* กรอบสี่เหลี่ยม: แสดงเฉพาะข้อที่มีการฝนเข้มพอ */}
                  {scanResult.details.map((item, idx) => {
                    if (!item.box) return null; 
                    return (
                      <div 
                        key={idx}
                        className={`absolute border-[3px] rounded-full shadow-sm ${item.isCorrect ? 'border-green-500 bg-green-500/20' : 'border-red-500 bg-red-500/30'}`}
                        style={{
                          left: `${item.box.x * 100}%`,
                          top: `${item.box.y * 100}%`,
                          width: `${item.box.w * 100}%`,
                          height: `${item.box.h * 100}%`,
                        }}
                      >
                        {!item.isCorrect && (
                          <span className="absolute -top-6 left-1/2 transform -translate-x-1/2 bg-red-600 text-white text-[10px] font-bold px-1.5 py-0.5 rounded">
                            {item.correctAns}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </>
              )}
            </div>
            <p className="text-xs text-gray-500 mt-2">* จุดสีน้ำเงิน คือตำแหน่งแกนกลางที่ระบบคำนวณได้</p>
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

            <button onClick={() => { setActiveTab('scan'); }} className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-4 px-8 rounded-lg shadow-md transition flex items-center justify-center text-lg">
              <CameraIcon className="w-6 h-6 mr-2" />สแกนแผ่นต่อไป
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
            <CheckCircle className="w-5 h-5 mr-2 text-indigo-200" /> OMR Auto-Grader
          </div>
          <nav className="flex space-x-1 bg-indigo-700 p-1 rounded-lg text-sm">
            <button onClick={() => setActiveTab('keys')} className={`px-3 py-1.5 rounded-md transition ${activeTab === 'keys' ? 'bg-white text-indigo-700 shadow' : 'text-indigo-100 hover:bg-indigo-600'}`}>เฉลย</button>
            <button onClick={() => setActiveTab('scan')} className={`px-3 py-1.5 rounded-md transition ${activeTab === 'scan' ? 'bg-white text-indigo-700 shadow' : 'text-indigo-100 hover:bg-indigo-600'}`}>สแกน</button>
            <button onClick={() => setActiveTab('results')} disabled={!scanResult} className={`px-3 py-1.5 rounded-md transition ${activeTab === 'results' ? 'bg-white text-indigo-700 shadow' : 'text-indigo-300 opacity-50 cursor-not-allowed'}`}>ผลลัพธ์</button>
          </nav>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-6">
        {activeTab === 'keys' && renderKeysTab()}
        {activeTab === 'scan' && renderScanTab()}
        {activeTab === 'results' && renderResultsTab()}
      </main>
    </div>
  );
}