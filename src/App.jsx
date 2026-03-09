import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Camera, Upload, CheckCircle, XCircle, Settings, Play, RefreshCw, Save, AlertCircle } from 'lucide-react';

export default function App() {
  const [activeTab, setActiveTab] = useState('scan'); // 'scan', 'keys', 'results'
  const [answerKey, setAnswerKey] = useState(Array(20).fill(null));
  const [subjectName, setSubjectName] = useState('วิชาการออกแบบและเทคโนโลยี ว33106');
  
  // Camera & Image State
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const fileInputRef = useRef(null);
  const [stream, setStream] = useState(null);
  const [imageSource, setImageSource] = useState(null); // 'camera' or 'file'
  const [isProcessing, setIsProcessing] = useState(false);
  const [cameraError, setCameraError] = useState('');

  // Result State
  const [scanResult, setScanResult] = useState(null);

  const OPTIONS = ['ก', 'ข', 'ค', 'ง', 'จ'];
  const NUM_QUESTIONS = 20;

  // เพิ่ม useEffect ตัวนี้เข้าไป เพื่อรอให้แท็กวิดีโอสร้างเสร็จก่อนแล้วค่อยใส่ภาพจากกล้อง
  useEffect(() => {
    if (imageSource === 'camera' && stream && videoRef.current) {
      videoRef.current.srcObject = stream;
      videoRef.current.play().catch(e => console.error("Play error:", e));
    }
  }, [imageSource, stream]);

  // --- 1. Camera Handling ---
  const startCamera = async () => {
    setCameraError('');
    try {
      if (stream) {
        stream.getTracks().forEach(track => track.stop());
      }
      const newStream = await navigator.mediaDevices.getUserMedia({ 
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } } 
      });
      setStream(newStream);
      setImageSource('camera');
    } catch (err) {
      console.error("Error accessing camera:", err);
      setCameraError("ไม่สามารถเข้าถึงกล้องได้ กรุณาอนุญาตการใช้งานกล้อง หรืออัปโหลดรูปภาพแทน");
    }
  };

  const stopCamera = () => {
    if (stream) {
      stream.getTracks().forEach(track => track.stop());
      setStream(null);
    }
  };

  useEffect(() => {
    // Cleanup on unmount
    return () => stopCamera();
  }, [stream]);

  // --- 2. File Upload Handling ---
  const handleFileUpload = (e) => {
    const file = e.target.files[0];
    if (file) {
      stopCamera();
      const reader = new FileReader();
      reader.onload = (event) => {
        setImageSource(event.target.result);
        processImage(event.target.result);
      };
      reader.readAsDataURL(file);
    }
  };

  // --- 3. Image Processing (The OMR Logic) ---
  const processImage = (sourceUrl = null) => {
    setIsProcessing(true);
    setScanResult(null);

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    
    // Check if we have an answer key set
    if (answerKey.includes(null)) {
      alert("กรุณาตั้งค่าเฉลยให้ครบทั้ง 20 ข้อก่อนทำการตรวจ");
      setActiveTab('keys');
      setIsProcessing(false);
      return;
    }

    const analyzePixels = () => {
      // In a real robust system, we would use OpenCV to find corner markers and warp the image.
      // For this web approach, we assume the user aligns the paper with our guide.
      // We use approximate percentage coordinates based on the uploaded template.
      
      const width = canvas.width;
      const height = canvas.height;
      const imageData = ctx.getImageData(0, 0, width, height);
      const data = imageData.data;

      // Helper to calculate darkness of a specific bounding box
      const getDarkness = (xPct, yPct, wPct, hPct) => {
        const x = Math.floor(xPct * width);
        const y = Math.floor(yPct * height);
        const w = Math.floor(wPct * width);
        const h = Math.floor(hPct * height);
        
        let darkPixels = 0;
        let totalPixels = 0;

        for (let i = y; i < y + h; i++) {
          for (let j = x; j < x + w; j++) {
            // Check bounds to prevent errors
            if (j >= 0 && j < width && i >= 0 && i < height) {
              const index = (i * width + j) * 4;
              const r = data[index];
              const g = data[index + 1];
              const b = data[index + 2];
              
              // Convert to grayscale
              const gray = 0.299 * r + 0.587 * g + 0.114 * b;
              
              // Threshold for "darkness" (pencil mark)
              if (gray < 100) { 
                darkPixels++;
              }
              totalPixels++;
            }
          }
        }
        return totalPixels > 0 ? darkPixels / totalPixels : 0;
      };

      const detectedAnswers = Array(20).fill(null);
      let studentIdStr = "";

      // Configuration of grid positions based on the provided image template
      // Left Column (Q1-15)
      const leftColX = 0.18; // Start X
      const leftColY = 0.35; // Start Y
      const colWidth = 0.21 / 5; // Width per option (ก-จ)
      const rowHeight = 0.58 / 15; // Height per question

      // Right Column (Q16-20)
      const rightColX = 0.45;
      const rightColY = 0.35;

      // Student ID (5 columns, 10 rows)
      const idX = 0.65;
      const idY = 0.60;
      const idColWidth = 0.22 / 5;
      const idRowHeight = 0.35 / 10;

      // 1. Detect Answers
      for (let q = 0; q < 20; q++) {
        let maxDarkness = 0;
        let selectedOption = null;
        
        const isLeft = q < 15;
        const baseX = isLeft ? leftColX : rightColX;
        const baseY = isLeft ? leftColY + (q * rowHeight) : rightColY + ((q - 15) * rowHeight);

        for (let opt = 0; opt < 5; opt++) {
          const optX = baseX + (opt * colWidth);
          // Sample a slightly smaller box in the center of the expected bubble
          const darkness = getDarkness(optX + 0.005, baseY + 0.005, colWidth * 0.7, rowHeight * 0.7);
          
          if (darkness > maxDarkness && darkness > 0.15) { // 0.15 is the minimum threshold to be considered "filled"
            maxDarkness = darkness;
            selectedOption = opt;
          }
        }
        detectedAnswers[q] = selectedOption !== null ? OPTIONS[selectedOption] : null;
      }

      // 2. Detect Student ID
      for (let digit = 0; digit < 5; digit++) {
        let maxDarkness = 0;
        let selectedNumber = "?";
        
        for (let num = 0; num < 10; num++) {
          const numX = idX + (digit * idColWidth);
          const numY = idY + (num * idRowHeight);
          
          const darkness = getDarkness(numX + 0.005, numY + 0.005, idColWidth * 0.7, idRowHeight * 0.7);
          
          if (darkness > maxDarkness && darkness > 0.15) {
            maxDarkness = darkness;
            selectedNumber = num.toString();
          }
        }
        studentIdStr += selectedNumber;
      }

      // 3. Calculate Score
      let score = 0;
      const details = [];
      for (let i = 0; i < 20; i++) {
        const isCorrect = detectedAnswers[i] === answerKey[i];
        if (isCorrect) score++;
        details.push({
          qNumber: i + 1,
          studentAns: detectedAnswers[i] || '-',
          correctAns: answerKey[i],
          isCorrect
        });
      }

      setScanResult({
        studentId: studentIdStr.includes("?") ? "อ่านรหัสไม่ชัดเจน" : studentIdStr,
        score,
        total: 20,
        details
      });
      setIsProcessing(false);
      setActiveTab('results');
      stopCamera(); // Stop camera after successful scan
    };

    // Draw image to canvas before analyzing
    const img = new Image();
    img.onload = () => {
      // Force canvas size to a standard ratio (e.g., A4 proportion 1:1.414)
      canvas.width = 800;
      canvas.height = 1131;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      
      // Simulate slight processing delay for UX
      setTimeout(analyzePixels, 500); 
    };

    if (sourceUrl) {
      img.src = sourceUrl;
    } else if (videoRef.current) {
      // Capture from video
      canvas.width = videoRef.current.videoWidth || 800;
      canvas.height = videoRef.current.videoHeight || 1131;
      ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);
      img.src = canvas.toDataURL('image/jpeg'); // Re-trigger via onload to standardize size
    }
  };

  // --- 4. Answer Key Management ---
  const handleSetAnswer = (qIndex, option) => {
    const newKeys = [...answerKey];
    newKeys[qIndex] = option;
    setAnswerKey(newKeys);
  };

  const autoFillMockKeys = () => {
    // Fill random keys for testing
    const mockKeys = Array(20).fill(null).map(() => OPTIONS[Math.floor(Math.random() * OPTIONS.length)]);
    setAnswerKey(mockKeys);
  };


  // ==========================================
  // UI RENDERERS
  // ==========================================

  const renderKeysTab = () => (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto bg-white rounded-xl shadow-sm border border-gray-100">
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-2xl font-bold text-gray-800 flex items-center">
          <Settings className="w-6 h-6 mr-2 text-indigo-600" />
          ตั้งค่าเฉลย
        </h2>
        <button 
          onClick={autoFillMockKeys}
          className="text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 py-2 px-4 rounded-lg transition"
        >
          สุ่มเฉลย (เพื่อทดสอบ)
        </button>
      </div>

      <div className="mb-6">
        <label className="block text-sm font-medium text-gray-700 mb-2">ชื่อวิชา / รหัสวิชา</label>
        <input 
          type="text" 
          value={subjectName}
          onChange={(e) => setSubjectName(e.target.value)}
          className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none"
        />
      </div>

      <div className="bg-indigo-50 p-4 rounded-lg mb-6 flex items-start">
        <AlertCircle className="w-5 h-5 text-indigo-600 mr-2 flex-shrink-0 mt-0.5" />
        <p className="text-sm text-indigo-800">
          กรุณาคลิกเลือกตัวเลือกที่ถูกต้องสำหรับแต่ละข้อ ระบบจะใช้ข้อมูลนี้ในการตรวจคะแนน
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        {[0, 1].map(colIndex => (
          <div key={`col-${colIndex}`} className="space-y-4">
            {Array(10).fill(null).map((_, i) => {
              const qNum = (colIndex * 10) + i;
              return (
                <div key={qNum} className="flex items-center p-2 hover:bg-gray-50 rounded-lg transition border-b border-gray-50 last:border-0">
                  <span className="w-10 font-bold text-gray-700 text-right mr-4">{qNum + 1}.</span>
                  <div className="flex space-x-2 sm:space-x-3">
                    {OPTIONS.map(opt => (
                      <button
                        key={opt}
                        onClick={() => handleSetAnswer(qNum, opt)}
                        className={`w-10 h-10 rounded-full font-medium transition-all ${
                          answerKey[qNum] === opt 
                            ? 'bg-indigo-600 text-white shadow-md transform scale-110' 
                            : 'bg-white border-2 border-gray-300 text-gray-600 hover:border-indigo-400'
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

      <div className="mt-8 flex justify-end">
        <button 
          onClick={() => {
            if(answerKey.includes(null)) {
              alert("กรุณาเลือกเฉลยให้ครบทุกข้อ");
            } else {
              setActiveTab('scan');
            }
          }}
          className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3 px-8 rounded-lg shadow-md transition flex items-center"
        >
          <Save className="w-5 h-5 mr-2" />
          บันทึกเฉลยและไปที่หน้าตรวจ
        </button>
      </div>
    </div>
  );

  const renderScanTab = () => (
    <div className="p-4 sm:p-6 max-w-2xl mx-auto bg-white rounded-xl shadow-sm border border-gray-100 text-center">
      <h2 className="text-2xl font-bold text-gray-800 mb-2 flex items-center justify-center">
        <Camera className="w-6 h-6 mr-2 text-indigo-600" />
        ตรวจกระดาษคำตอบ
      </h2>
      <p className="text-gray-500 mb-6">{subjectName}</p>

      {answerKey.includes(null) ? (
        <div className="bg-red-50 border border-red-200 text-red-700 p-6 rounded-lg mb-6">
          <AlertCircle className="w-12 h-12 mx-auto mb-3 text-red-500" />
          <h3 className="text-lg font-bold mb-2">ยังไม่ได้ตั้งค่าเฉลย</h3>
          <p className="mb-4">กรุณาตั้งค่าเฉลยให้ครบทั้ง 20 ข้อก่อนใช้งานระบบตรวจ</p>
          <button 
            onClick={() => setActiveTab('keys')}
            className="bg-red-600 hover:bg-red-700 text-white font-bold py-2 px-6 rounded-lg transition"
          >
            ไปตั้งค่าเฉลย
          </button>
        </div>
      ) : (
        <>
          {/* Camera/Upload Area */}
          <div className="relative bg-black rounded-xl overflow-hidden shadow-inner aspect-[3/4] max-w-md mx-auto mb-6 flex items-center justify-center group">
            
            {imageSource === 'camera' && stream ? (
              <>
                <video 
                  ref={videoRef} 
                  autoPlay 
                  playsInline 
                  muted
                  className="w-full h-full object-cover"
                />
                {/* Alignment Guide Overlay */}
                <div className="absolute inset-0 pointer-events-none border-4 border-dashed border-indigo-400 opacity-50 m-4 rounded-lg"></div>
                <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 text-white/50 text-sm font-medium pointer-events-none">
                  จัดขอบกระดาษให้อยู่ในกรอบ
                </div>
              </>
            ) : typeof imageSource === 'string' ? (
              <img src={imageSource} alt="Uploaded sheet" className="w-full h-full object-contain bg-gray-900" />
            ) : (
              <div className="text-gray-400 flex flex-col items-center">
                <Camera className="w-16 h-16 mb-4 opacity-50" />
                <p>เปิดกล้องหรืออัปโหลดรูปภาพ</p>
                <p className="text-sm mt-2 opacity-70">(แนะนำให้ถ่ายในที่สว่างและวางกระดาษให้ตรง)</p>
              </div>
            )}

            {isProcessing && (
              <div className="absolute inset-0 bg-indigo-900/80 flex flex-col items-center justify-center z-10">
                <RefreshCw className="w-12 h-12 text-white animate-spin mb-4" />
                <p className="text-white font-bold text-lg">กำลังประมวลผล...</p>
              </div>
            )}
          </div>

          {/* Hidden Canvas for processing */}
          <canvas ref={canvasRef} className="hidden" />
          
          {cameraError && (
            <div className="text-red-500 text-sm mb-4 bg-red-50 p-3 rounded-lg border border-red-200">
              {cameraError}
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex flex-col sm:flex-row justify-center space-y-3 sm:space-y-0 sm:space-x-4">
            {imageSource === 'camera' && stream ? (
              <button 
                onClick={() => processImage()}
                disabled={isProcessing}
                className="bg-green-600 hover:bg-green-700 text-white font-bold py-3 px-8 rounded-lg shadow-md transition flex items-center justify-center disabled:opacity-50"
              >
                <Play className="w-5 h-5 mr-2" />
                ถ่ายและตรวจทันที
              </button>
            ) : (
              <button 
                onClick={startCamera}
                className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3 px-8 rounded-lg shadow-md transition flex items-center justify-center"
              >
                <Camera className="w-5 h-5 mr-2" />
                เปิดกล้องสแกน
              </button>
            )}

            <div className="relative">
              <input 
                type="file" 
                accept="image/*" 
                capture="environment"
                ref={fileInputRef}
                onChange={handleFileUpload}
                className="hidden"
              />
              <button 
                onClick={() => fileInputRef.current.click()}
                className="w-full bg-white border-2 border-gray-300 hover:bg-gray-50 text-gray-700 font-bold py-3 px-8 rounded-lg shadow-sm transition flex items-center justify-center"
              >
                <Upload className="w-5 h-5 mr-2" />
                อัปโหลดรูปภาพ
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
      <div className="p-4 sm:p-6 max-w-3xl mx-auto bg-white rounded-xl shadow-sm border border-gray-100">
        <div className="text-center mb-8 border-b border-gray-100 pb-6">
          <h2 className="text-3xl font-bold text-gray-800 mb-2">ผลการตรวจ</h2>
          <p className="text-gray-500 mb-4">{subjectName}</p>
          
          <div className="flex flex-col sm:flex-row justify-center items-center gap-6 mt-6">
            <div className="bg-indigo-50 p-4 rounded-xl border border-indigo-100 min-w-[200px]">
              <p className="text-sm text-indigo-600 font-medium mb-1">รหัสประจำตัวนักเรียน</p>
              <p className="text-2xl font-black text-indigo-900 tracking-wider">
                {scanResult.studentId}
              </p>
            </div>
            
            <div className={`p-4 rounded-xl border min-w-[200px] ${
              scanResult.score >= 10 ? 'bg-green-50 border-green-100' : 'bg-red-50 border-red-100'
            }`}>
              <p className={`text-sm font-medium mb-1 ${
                scanResult.score >= 10 ? 'text-green-600' : 'text-red-600'
              }`}>คะแนนที่ได้</p>
              <p className={`text-4xl font-black ${
                scanResult.score >= 10 ? 'text-green-700' : 'text-red-700'
              }`}>
                {scanResult.score} <span className="text-lg text-gray-500 font-medium">/ {scanResult.total}</span>
              </p>
            </div>
          </div>
        </div>

        <div className="mb-6">
          <h3 className="font-bold text-lg text-gray-800 mb-4">รายละเอียดรายข้อ</h3>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {scanResult.details.map((item, index) => (
              <div 
                key={index} 
                className={`p-3 rounded-lg flex items-center justify-between border ${
                  item.isCorrect 
                    ? 'bg-green-50 border-green-200' 
                    : 'bg-red-50 border-red-200'
                }`}
              >
                <div className="flex items-center">
                  <span className="font-bold text-gray-700 mr-2 w-5">{item.qNumber}.</span>
                  <span className="text-gray-600 font-medium">ตอบ: <span className="text-black">{item.studentAns}</span></span>
                </div>
                {item.isCorrect ? (
                  <CheckCircle className="w-5 h-5 text-green-500" />
                ) : (
                  <div className="flex items-center group relative">
                    <XCircle className="w-5 h-5 text-red-500" />
                    {/* Tooltip for wrong answer */}
                    <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-2 py-1 bg-gray-800 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition whitespace-nowrap">
                      เฉลย: {item.correctAns}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="flex justify-center space-x-4">
          <button 
            onClick={() => {
              setActiveTab('scan');
              setScanResult(null);
              setImageSource(null);
            }}
            className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3 px-8 rounded-lg shadow-md transition flex items-center"
          >
            <RefreshCw className="w-5 h-5 mr-2" />
            ตรวจแผ่นต่อไป
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-gray-50 font-sans text-gray-900 pb-12">
      {/* Header */}
      <header className="bg-indigo-600 text-white shadow-md">
        <div className="max-w-5xl mx-auto px-4 py-4 flex flex-col sm:flex-row items-center justify-between">
          <div className="flex items-center mb-4 sm:mb-0">
            <div className="bg-white p-2 rounded-lg mr-3">
              <CheckCircle className="w-6 h-6 text-indigo-600" />
            </div>
            <h1 className="text-xl font-bold tracking-wide">OMR Smart Grader</h1>
          </div>
          
          {/* Tabs Navigation */}
          <nav className="flex space-x-1 bg-indigo-700 p-1 rounded-lg">
            <button 
              onClick={() => setActiveTab('keys')}
              className={`px-4 py-2 rounded-md text-sm font-medium transition ${
                activeTab === 'keys' ? 'bg-white text-indigo-700 shadow' : 'text-indigo-100 hover:bg-indigo-600'
              }`}
            >
              ตั้งค่าเฉลย
            </button>
            <button 
              onClick={() => setActiveTab('scan')}
              className={`px-4 py-2 rounded-md text-sm font-medium transition ${
                activeTab === 'scan' ? 'bg-white text-indigo-700 shadow' : 'text-indigo-100 hover:bg-indigo-600'
              }`}
            >
              ตรวจข้อสอบ
            </button>
            <button 
              onClick={() => setActiveTab('results')}
              disabled={!scanResult}
              className={`px-4 py-2 rounded-md text-sm font-medium transition ${
                activeTab === 'results' ? 'bg-white text-indigo-700 shadow' : 
                !scanResult ? 'text-indigo-300 opacity-50 cursor-not-allowed' : 'text-indigo-100 hover:bg-indigo-600'
              }`}
            >
              ผลลัพธ์
            </button>
          </nav>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-5xl mx-auto px-4 py-8">
        {activeTab === 'keys' && renderKeysTab()}
        {activeTab === 'scan' && renderScanTab()}
        {activeTab === 'results' && renderResultsTab()}
      </main>
      
      {/* Footer Instructions */}
      <footer className="max-w-3xl mx-auto px-4 text-center text-gray-500 text-sm">
        <p><strong>คำแนะนำ:</strong> เพื่อความแม่นยำสูงสุด ควรวางกระดาษคำตอบบนพื้นเรียบ มีแสงสว่างเพียงพอ และถ่ายรูปให้ขอบกระดาษขนานกับขอบหน้าจอมากที่สุด หลีกเลี่ยงเงาสะท้อน</p>
      </footer>
    </div>
  );
}