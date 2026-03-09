import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Camera, Upload, CheckCircle, XCircle, Settings, Play, RefreshCw, Save, AlertCircle, ScanLine, Camera as CameraIcon } from 'lucide-react';

export default function App() {
  const [activeTab, setActiveTab] = useState('scan'); 
  const [answerKey, setAnswerKey] = useState(Array(20).fill(null));
  const [subjectName, setSubjectName] = useState('วิชาการออกแบบและเทคโนโลยี ว33106');
  
  // Camera & Auto-Scan State
  const videoRef = useRef(null);
  const fileInputRef = useRef(null);
  const [stream, setStream] = useState(null);
  const [imageSource, setImageSource] = useState(null); 
  const [isProcessing, setIsProcessing] = useState(false);
  const [cameraError, setCameraError] = useState('');
  
  // Refs
  const isProcessingRef = useRef(false);
  const answerKeyRef = useRef(answerKey);
  const animationFrameId = useRef(null);
  const stableFramesCount = useRef(0);
  const isStartingCamera = useRef(false);
  
  // สถานะ 4 มุม (ใช้สำหรับแสดงผลกรอบบนหน้าจอ)
  const [alignedStatus, setAlignedStatus] = useState({ tl: false, tr: false, bl: false, br: false });

  // Result State
  const [scanResult, setScanResult] = useState(null);
  const [scannedImageUrl, setScannedImageUrl] = useState(null); 

  const OPTIONS = ['ก', 'ข', 'ค', 'ง', 'จ'];

  useEffect(() => { isProcessingRef.current = isProcessing; }, [isProcessing]);
  useEffect(() => { answerKeyRef.current = answerKey; }, [answerKey]);

  // --- เริ่มต้นกล้องอัตโนมัติเมื่ออยู่หน้าสแกน ---
  const startCamera = async () => {
    if (isStartingCamera.current) return;
    isStartingCamera.current = true;
    setCameraError('');
    try {
      if (stream) {
        stream.getTracks().forEach(track => track.stop());
      }
      const newStream = await navigator.mediaDevices.getUserMedia({ 
        video: { facingMode: 'environment', width: { ideal: 1080 }, height: { ideal: 1920 } } 
      });
      setStream(newStream);
      setImageSource('camera');
      setActiveTab('scan');
    } catch (err) {
      console.error(err);
      setCameraError("ไม่สามารถเข้าถึงกล้องได้ กรุณาอนุญาตการใช้งานกล้อง");
    } finally {
      isStartingCamera.current = false;
    }
  };

  const stopCamera = () => {
    if (stream) {
      stream.getTracks().forEach(track => track.stop());
      setStream(null);
    }
    if (animationFrameId.current) cancelAnimationFrame(animationFrameId.current);
  };

  useEffect(() => {
    if (activeTab === 'scan' && !stream && imageSource !== 'file') {
      startCamera();
    }
  }, [activeTab]);

  useEffect(() => {
    return () => stopCamera();
  }, [stream]);

  // --- ฟังก์ชันค้นหาจุดอ้างอิง 4 มุม (หาจุดศูนย์กลางของสีดำ) ---
  const extractMarkers = (ctx, w, h) => {
    const data = ctx.getImageData(0, 0, w, h).data;
    
    // ค้นหาในพื้นที่ที่กำหนด แล้วหาพิกัดเฉลี่ยของพิกเซลที่ดำที่สุด
    const getMarker = (xPct, yPct, wPct, hPct) => {
      const sx = Math.floor(xPct * w);
      const sy = Math.floor(yPct * h);
      const ew = Math.floor(wPct * w);
      const eh = Math.floor(hPct * h);
      
      let sumX = 0, sumY = 0, count = 0;
      
      // Step by 2 เพื่อให้ประมวลผลเร็วขึ้น
      for (let y = sy; y < sy + eh; y += 2) {
        for (let x = sx; x < sx + ew; x += 2) {
          const i = (y * w + x) * 4;
          const gray = data[i] * 0.299 + data[i+1] * 0.587 + data[i+2] * 0.114;
          if (gray < 90) { // เกณฑ์ความดำของสี่เหลี่ยมมุม
            sumX += x; 
            sumY += y; 
            count++;
          }
        }
      }
      // ถ้าพบกลุ่มก้อนสีดำใหญ่พอ (ประมาณ 1.5% ของพื้นที่ค้นหา)
      if (count > (ew * eh * 0.015) / 4) {
        return { x: sumX / count, y: sumY / count }; // คืนค่าพิกัดจุดศูนย์กลางที่แท้จริง
      }
      return null;
    };

    // ค้นหา 4 มุม ในรัศมี 35% ของแต่ละมุม (พื้นที่กว้างมาก วางเบี้ยวได้สบาย)
    return {
      tl: getMarker(0.0, 0.0, 0.35, 0.35),
      tr: getMarker(0.65, 0.0, 0.35, 0.35),
      bl: getMarker(0.0, 0.65, 0.35, 0.35),
      br: getMarker(0.65, 0.65, 0.35, 0.35)
    };
  };

  // --- Auto Scan Loop ---
  const checkAlignmentAndScan = useCallback(() => {
    if (!videoRef.current || isProcessingRef.current || !stream) {
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
    
    // ความละเอียดลดลงครึ่งหนึ่งเพื่อความรวดเร็วในการจับภาพสด
    canvas.width = 300;
    canvas.height = 400; 

    const vW = video.videoWidth;
    const vH = video.videoHeight;
    const vRatio = vW / vH;
    const targetRatio = canvas.width / canvas.height;

    let sX = 0, sY = 0, sW = vW, sH = vH;
    if (vRatio > targetRatio) {
      sW = vH * targetRatio;
      sX = (vW - sW) / 2;
    } else {
      sH = vW / targetRatio;
      sY = (vH - sH) / 2;
    }

    ctx.drawImage(video, sX, sY, sW, sH, 0, 0, canvas.width, canvas.height);
    
    // ตรวจหาจุด 4 มุม
    const markers = extractMarkers(ctx, canvas.width, canvas.height);
    
    setAlignedStatus({
      tl: !!markers.tl,
      tr: !!markers.tr,
      bl: !!markers.bl,
      br: !!markers.br
    });

    if (markers.tl && markers.tr && markers.bl && markers.br) {
      stableFramesCount.current++;
      // นิ่งแค่ 5 เฟรม ก็ถ่ายเลย เพราะระบบมีความแม่นยำสูงแล้ว
      if (stableFramesCount.current > 5 && !answerKeyRef.current.includes(null)) {
        stableFramesCount.current = 0;
        captureAndProcess(); 
        return; 
      }
    } else {
      stableFramesCount.current = 0;
    }

    animationFrameId.current = requestAnimationFrame(checkAlignmentAndScan);
  }, [stream]);

  // ฟังก์ชันถ่ายภาพและประมวลผล
  const captureAndProcess = useCallback(() => {
    if (!videoRef.current || isProcessingRef.current) return;
    
    const video = videoRef.current;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    
    // ตอนประมวลผลจริง ใช้ความละเอียดสูง
    canvas.width = 600;
    canvas.height = 800; 

    const vW = video.videoWidth;
    const vH = video.videoHeight;
    const vRatio = vW / vH;
    const targetRatio = canvas.width / canvas.height;

    let sX = 0, sY = 0, sW = vW, sH = vH;
    if (vRatio > targetRatio) {
      sW = vH * targetRatio;
      sX = (vW - sW) / 2;
    } else {
      sH = vW / targetRatio;
      sY = (vH - sH) / 2;
    }

    ctx.drawImage(video, sX, sY, sW, sH, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg');
    
    // หาจุดอ้างอิงบนภาพความละเอียดสูง
    const markers = extractMarkers(ctx, canvas.width, canvas.height);
    
    if (markers.tl && markers.tr && markers.bl && markers.br) {
      processImageInternal(dataUrl, canvas.width, canvas.height, ctx, markers);
    } else {
      alert("ไม่พบจุดอ้างอิงมุมสีดำทั้ง 4 จุด โปรดให้ทั้ง 4 มุมอยู่ในกรอบภาพแล้วลองใหม่");
    }
  }, []);

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

  // --- OMR Logic ด้วย Bilinear Interpolation ---
  const processImageInternal = (sourceUrl, canvasWidth, canvasHeight, ctx, markers) => {
    setIsProcessing(true);
    setScanResult(null);
    setScannedImageUrl(sourceUrl);

    if (answerKeyRef.current.includes(null)) {
      alert("กรุณาตั้งค่าเฉลยให้ครบทั้ง 20 ข้อก่อนทำการตรวจ");
      setActiveTab('keys');
      setIsProcessing(false);
      return;
    }

    // ฟังก์ชันช่วยหาตำแหน่งสมมติ (x, y) จากพิกัดเปอร์เซ็นต์ u, v โดยอิงจากจุด 4 มุมของจริง
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

      // รัศมีในการตรวจจับความดำรอบๆ จุดศูนย์กลาง
      const radius = Math.floor(canvasWidth * 0.018); 

      const checkBubble = (u, v) => {
        const center = getInterpolatedPoint(u, v);
        let darkPixels = 0;
        let totalPixels = 0;

        for (let i = Math.floor(center.y - radius); i < center.y + radius; i++) {
          for (let j = Math.floor(center.x - radius); j < center.x + radius; j++) {
            if (j >= 0 && j < canvasWidth && i >= 0 && i < canvasHeight) {
              const idx = (i * canvasWidth + j) * 4;
              const gray = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
              if (gray < 130) darkPixels++; // ความไวในการอ่านรอยดินสอ
              totalPixels++;
            }
          }
        }
        return {
          darkness: totalPixels > 0 ? darkPixels / totalPixels : 0,
          box: { // ใช้สำหรับวาดกรอบผลลัพธ์
            x: (center.x - radius) / canvasWidth,
            y: (center.y - radius) / canvasHeight,
            w: (radius * 2) / canvasWidth,
            h: (radius * 2) / canvasHeight
          }
        };
      };

      const detectedAnswers = Array(20).fill(null);
      const detectedBoxes = Array(20).fill(null);
      let studentIdStr = "";

      // ค่าความสัมพันธ์ U, V อิงจากไฟล์กระดาษคำตอบที่ให้มา 
      // (แม่นยำมากเพราะคำนวณจากระยะห่างระหว่างจุดอ้างอิง 4 มุมเสมอ)
      const U_LEFT = 0.145; 
      const V_START = 0.225; 
      const U_STEP = 0.052; 
      const V_STEP = 0.051; 

      const U_RIGHT = 0.490;

      const U_ID = 0.730;
      const V_ID = 0.550;
      const U_ID_STEP = 0.053;
      const V_ID_STEP = 0.046;

      // 1. ตรวจคำตอบ (Q1-20)
      for (let q = 0; q < 20; q++) {
        let maxDarkness = 0;
        let selectedOption = null;
        let selectedBox = null;
        
        const isLeft = q < 15;
        const baseU = isLeft ? U_LEFT : U_RIGHT;
        const v = isLeft ? V_START + (q * V_STEP) : V_START + ((q - 15) * V_STEP);

        for (let opt = 0; opt < 5; opt++) {
          const u = baseU + (opt * U_STEP);
          const result = checkBubble(u, v);
          
          if (result.darkness > maxDarkness && result.darkness > 0.10) { // 10% คือเกณฑ์ขั้นต่ำของการฝน
            maxDarkness = result.darkness;
            selectedOption = opt;
            selectedBox = result.box;
          }
        }
        detectedAnswers[q] = selectedOption !== null ? OPTIONS[selectedOption] : null;
        detectedBoxes[q] = selectedBox;
      }

      // 2. ตรวจรหัสนักเรียน
      for (let digit = 0; digit < 5; digit++) {
        let maxDarkness = 0;
        let selectedNumber = "?";
        
        const u = U_ID + (digit * U_ID_STEP);
        for (let num = 0; num < 10; num++) {
          const v = V_ID + (num * V_ID_STEP);
          const result = checkBubble(u, v);
          
          if (result.darkness > maxDarkness && result.darkness > 0.10) {
            maxDarkness = result.darkness;
            selectedNumber = num.toString();
          }
        }
        studentIdStr += selectedNumber;
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
        details
      });
      setIsProcessing(false);
      setActiveTab('results');
      stopCamera(); 
    };

    setTimeout(analyzePixels, 100); 
  };

  const handleManualUpload = (e) => {
    const file = e.target.files[0];
    if (file) {
      stopCamera();
      const reader = new FileReader();
      reader.onload = (event) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = 600;
          canvas.height = 800;
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          
          const cropY = img.height * 0.16;
          const cropHeight = img.height * 0.84;
          
          ctx.drawImage(img, 0, cropY, img.width, cropHeight, 0, 0, canvas.width, canvas.height);
          
          const markers = extractMarkers(ctx, canvas.width, canvas.height);
          if (markers.tl && markers.tr && markers.bl && markers.br) {
            processImageInternal(canvas.toDataURL('image/jpeg'), canvas.width, canvas.height, ctx, markers);
          } else {
            alert("รูปภาพที่อัปโหลดไม่พบจุดอ้างอิง 4 มุมที่ชัดเจน");
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
        <ScanLine className="w-6 h-6 mr-2 text-indigo-600" />ระบบตรวจอัตโนมัติ (AI อัจฉริยะ)
      </h2>
      <p className="text-gray-500 mb-6 text-sm">ไม่ต้องเล็งให้เป๊ะ! แค่ให้จุดสีดำ 4 มุม อยู่ภายในช่องสีแดงทั้ง 4 มุม<br/>(ระบบจะคำนวณและปรับความเอียงให้เองอัตโนมัติ)</p>

      {answerKey.includes(null) ? (
        <div className="bg-red-50 border border-red-200 text-red-700 p-6 rounded-lg mb-6">
          <AlertCircle className="w-12 h-12 mx-auto mb-3 text-red-500" />
          <p className="mb-4">กรุณาตั้งค่าเฉลยให้ครบทั้ง 20 ข้อก่อนใช้งาน</p>
          <button onClick={() => setActiveTab('keys')} className="bg-red-600 hover:bg-red-700 text-white py-2 px-6 rounded-lg">ไปตั้งค่าเฉลย</button>
        </div>
      ) : (
        <>
          <div className="relative bg-gray-900 rounded-xl overflow-hidden shadow-inner max-w-sm mx-auto mb-6 aspect-[3/4] flex items-center justify-center">
            
            {imageSource === 'camera' && stream ? (
              <>
                <video ref={videoRef} autoPlay playsInline muted className="absolute w-full h-full object-cover" />
                
                {/* 4 โซนตีกรอบกว้างๆ ให้ผู้ใช้เล็งเข้าไป */}
                <div className="absolute inset-0 pointer-events-none p-4">
                  {/* กล่องซ้ายบน */}
                  <div className={`absolute top-[4%] left-[4%] w-[25%] h-[25%] border-2 rounded-xl transition-all ${alignedStatus.tl ? 'border-green-500 bg-green-500/20 shadow-[0_0_15px_rgba(34,197,94,0.5)]' : 'border-red-400 border-dashed bg-red-500/5'}`}></div>
                  {/* กล่องขวาบน */}
                  <div className={`absolute top-[4%] right-[4%] w-[25%] h-[25%] border-2 rounded-xl transition-all ${alignedStatus.tr ? 'border-green-500 bg-green-500/20 shadow-[0_0_15px_rgba(34,197,94,0.5)]' : 'border-red-400 border-dashed bg-red-500/5'}`}></div>
                  {/* กล่องซ้ายล่าง */}
                  <div className={`absolute bottom-[4%] left-[4%] w-[25%] h-[25%] border-2 rounded-xl transition-all ${alignedStatus.bl ? 'border-green-500 bg-green-500/20 shadow-[0_0_15px_rgba(34,197,94,0.5)]' : 'border-red-400 border-dashed bg-red-500/5'}`}></div>
                  {/* กล่องขวาล่าง */}
                  <div className={`absolute bottom-[4%] right-[4%] w-[25%] h-[25%] border-2 rounded-xl transition-all ${alignedStatus.br ? 'border-green-500 bg-green-500/20 shadow-[0_0_15px_rgba(34,197,94,0.5)]' : 'border-red-400 border-dashed bg-red-500/5'}`}></div>
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
              <div className="text-gray-400 flex flex-col items-center">
                <CameraIcon className="w-16 h-16 mb-4 opacity-50" />
                <p>เปิดกล้องไม่สำเร็จ หรือถูกปิดไป</p>
                <button onClick={startCamera} className="mt-4 px-4 py-2 bg-indigo-600 text-white rounded-lg">เปิดกล้องใหม่</button>
              </div>
            )}
          </div>

          <div className="flex flex-col sm:flex-row justify-center space-y-3 sm:space-y-0 sm:space-x-4">
            <div className="relative w-full sm:w-auto">
              <input type="file" accept="image/*" ref={fileInputRef} onChange={handleManualUpload} className="hidden" />
              <button onClick={() => fileInputRef.current.click()} className="w-full bg-white border-2 border-gray-300 hover:bg-gray-50 text-gray-700 font-bold py-3 px-8 rounded-lg transition flex items-center justify-center">
                <Upload className="w-5 h-5 mr-2" />อัปโหลดจากเครื่อง
              </button>
            </div>
          </div>
          
          {cameraError && <p className="text-red-500 mt-4 text-sm">{cameraError}</p>}
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
            <p className="text-xs text-gray-400 mt-2">* ระบบจำลองพิกัดอัตโนมัติตามความเอียงของกระดาษ</p>
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

            <button onClick={() => { setActiveTab('scan'); startCamera(); }} className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-4 px-8 rounded-lg shadow-md transition flex items-center justify-center text-lg">
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