// ===== zxing-wasm 初始化 =====
// wasmBinary 由 zxing_reader_wasm_b64.js 提供的 ZXingWasmBase64 变量解码而来
// 在 index.html 的 <script> 中已完成初始化

// ===== 状态 =====
let receivedChunks = new Map();  // index -> base64 data
let fileInfo = null;             // { fingerprint, filename, totalChunks, size }
let currentFileFingerprint = null;
let receivedFileName = '';

// 相机扫描状态
let isScanning = false;
let scanRafId = null;
let lastFrameTime = 0;
let lastDecodedText = '';
let lastScanTime = 0;

// 相机裁剪 / 降采样 canvas（复用，避免频繁分配）
let cropCanvas = null;
let cropCtx = null;
let scaleSrcCanvas = null;
let scaleSrcCtx = null;

// ZXing：默认关闭旋转/反色；连续未识别时再启用重模式
let zxingMissStreak = 0;
let zxingUseHardMode = false;

// 虚拟模式状态
let imageQueue = [];
let currentImageIndex = -1;

/** 高帧采样 + 多 Worker，尽量在 100ms 展示窗内完成多次尝试 */
const SCAN_FPS = 60;
const DECODE_MAX_EDGE = 720;
const DECODE_WORKER_COUNT = 3;
/** 相同内容去抖；100ms 连播时不同分片不受影响 */
const SAME_TEXT_DEBOUNCE_MS = 80;

const DB = localforage.createInstance({ name: 'qrcode-receiver-v2' });

// ===== Decode Worker 池 =====
let decodeWorkers = [];
let idleWorkers = [];
let decodeWorkerReady = false;
let decodeReqId = 0;
const pendingDecodes = new Map();

function createDecodeWorker(wasmBinary) {
    return new Promise((resolve) => {
        let worker;
        try {
            worker = new Worker('decode-worker.js');
        } catch (err) {
            console.warn('[decode-worker] 创建失败:', err.message);
            resolve(null);
            return;
        }

        let settled = false;
        const finish = (ok) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(ok ? worker : null);
        };
        const timer = setTimeout(() => finish(false), 12000);

        worker.onmessage = (event) => {
            const msg = event.data;
            if (!msg) return;
            if (msg.type === 'ready') {
                finish(true);
                return;
            }
            if (msg.type === 'result') {
                const pending = pendingDecodes.get(msg.id);
                if (!pending) return;
                pendingDecodes.delete(msg.id);
                idleWorkers.push(worker);
                pending.resolve(msg.text || null);
            }
        };
        worker.onerror = (err) => {
            console.warn('[decode-worker] 错误:', err.message);
            finish(false);
        };

        worker.postMessage({ type: 'init', wasmBinary }, [wasmBinary]);
    });
}

async function initDecodeWorker() {
    const copies = window.__QRSyncWasmBinaryCopies;
    window.__QRSyncWasmBinaryCopies = null;
    if (typeof Worker === 'undefined' || !copies || !copies.length) {
        return false;
    }

    const count = Math.min(DECODE_WORKER_COUNT, copies.length);
    const workers = await Promise.all(
        copies.slice(0, count).map((buf) => createDecodeWorker(buf))
    );
    decodeWorkers = workers.filter(Boolean);
    idleWorkers = decodeWorkers.slice();
    decodeWorkerReady = decodeWorkers.length > 0;
    if (decodeWorkerReady) {
        console.log('[decode-worker] ✅ 池已就绪 x' + decodeWorkers.length);
    } else {
        console.warn('[decode-worker] ⚠️ 全部失败，回退主线程解码');
    }
    return decodeWorkerReady;
}

function decodeOnWorker(imgData, options) {
    const id = ++decodeReqId;
    const copy = imgData.data.slice();
    const buffer = copy.buffer;

    return new Promise((resolve) => {
        const send = (worker) => {
            pendingDecodes.set(id, { resolve });
            try {
                worker.postMessage({
                    type: 'decode',
                    id,
                    width: imgData.width,
                    height: imgData.height,
                    buffer,
                    options
                }, [buffer]);
            } catch (_) {
                pendingDecodes.delete(id);
                idleWorkers.push(worker);
                resolve(null);
            }
        };

        const worker = idleWorkers.pop();
        if (worker) {
            send(worker);
            return;
        }

        // 短暂等待空闲 Worker（双通道打满时）
        const start = performance.now();
        const wait = () => {
            const w = idleWorkers.pop();
            if (w) {
                send(w);
                return;
            }
            if (performance.now() - start > 2000) {
                resolve(null);
                return;
            }
            setTimeout(wait, 0);
        };
        wait();
    });
}

// ===== 分辨率档位 =====
const RESOLUTION_PRESETS = {
    '2160': [{ width: 3840, height: 2160 }],
    '1440': [{ width: 2560, height: 1440 }],
    '1080': [{ width: 1920, height: 1080 }],
    '720':  [{ width: 1280, height: 720  }],
    'auto': [
        { width: 3840, height: 2160 },
        { width: 2560, height: 1440 },
        { width: 1920, height: 1080 },
        { width: 1280, height: 720  },
    ]
};

function ensureCropCanvas() {
    if (!cropCanvas) {
        cropCanvas = document.createElement('canvas');
        cropCtx = cropCanvas.getContext('2d', { willReadFrequently: true });
    }
}

function ensureScaleSrcCanvas() {
    if (!scaleSrcCanvas) {
        scaleSrcCanvas = document.createElement('canvas');
        scaleSrcCtx = scaleSrcCanvas.getContext('2d', { willReadFrequently: true });
    }
}

function resizeCanvas(canvas, width, height) {
    if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
    }
}

/** 将 ImageData 最长边限制在 DECODE_MAX_EDGE 以内 */
function prepareImageDataForDecode(imgData) {
    const maxDim = Math.max(imgData.width, imgData.height);
    if (maxDim <= DECODE_MAX_EDGE) return imgData;

    const scale = DECODE_MAX_EDGE / maxDim;
    const w = Math.max(1, Math.round(imgData.width * scale));
    const h = Math.max(1, Math.round(imgData.height * scale));

    ensureScaleSrcCanvas();
    resizeCanvas(scaleSrcCanvas, imgData.width, imgData.height);
    scaleSrcCtx.putImageData(imgData, 0, 0);

    ensureCropCanvas();
    resizeCanvas(cropCanvas, w, h);
    cropCtx.imageSmoothingEnabled = true;
    cropCtx.imageSmoothingQuality = 'medium';
    cropCtx.drawImage(scaleSrcCanvas, 0, 0, imgData.width, imgData.height, 0, 0, w, h);
    return cropCtx.getImageData(0, 0, w, h);
}

function getZXingOptions(forceHard) {
    // 连播场景优先快路径：慢选项会拖长单帧占用，反而漏扫
    if (forceHard) {
        return {
            formats: ['QRCode'],
            tryHarder: true,
            tryRotate: true,
            tryInvert: true,
            tryDownscale: false,
            maxNumberOfSymbols: 1,
            allowJsQR: true
        };
    }
    return {
        formats: ['QRCode'],
        tryHarder: true,
        tryRotate: false,
        tryInvert: false,
        tryDownscale: false,
        maxNumberOfSymbols: 1,
        allowJsQR: false
    };
}

function noteDecodeResult(ok) {
    // 相机连播不再自动切 hard mode（rotate/invert/jsQR 太慢，100ms 下会雪崩漏扫）
    if (ok) zxingMissStreak = 0;
    else zxingMissStreak++;
}

// ===== 统一解码函数 =====
// 优先走 Worker（不阻塞 UI）；Worker 不可用时再主线程 ZXing / jsQR
async function decodeImageData(imgData, { forceHard = false } = {}) {
    imgData = prepareImageDataForDecode(imgData);
    const options = getZXingOptions(forceHard);

    if (decodeWorkerReady) {
        try {
            return await decodeOnWorker(imgData, options);
        } catch (_) {
            // Worker 异常时回退主线程
        }
    }

    if (typeof ZXingWASM !== 'undefined' && ZXingWASM._wasmReady) {
        try {
            const results = await ZXingWASM.readBarcodesFromImageData(imgData, options);
            if (results.length > 0) return results[0].text;
        } catch (_) {}
    }
    const r = jsQR(imgData.data, imgData.width, imgData.height, { inversionAttempts: 'dontInvert' });
    return r ? r.data : null;
}

// ===== 相机模式 =====

async function tryOpenStream(deviceId, candidates) {
    for (const { width, height } of candidates) {
        try {
            const constraints = {
                video: {
                    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
                    width: { min: width, ideal: width },
                    height: { min: height, ideal: height }
                }
            };
            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            const track = stream.getVideoTracks()[0];
            return { stream, actual: track ? track.getSettings() : {} };
        } catch (_) {}
    }
    // 兜底：不指定分辨率
    const stream = await navigator.mediaDevices.getUserMedia(
        deviceId ? { video: { deviceId: { exact: deviceId } } } : { video: true }
    );
    const track = stream.getVideoTracks()[0];
    return { stream, actual: track ? track.getSettings() : {} };
}

function formatResolutionLabel(actual) {
    if (!actual.width || !actual.height) return '';
    const h = actual.height;
    const tag = h >= 2160 ? '(4K)' : h >= 1440 ? '(2K)' : h >= 1080 ? '(FHD)' : h >= 720 ? '(HD)' : '';
    return `${actual.width}×${actual.height} ${tag}`;
}

// 从视频帧裁出中心正方形并降采样，与 CSS object-fit:cover 的裁剪一致
function captureFrame(video) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const srcSize = Math.min(vw, vh);
    const sx = Math.round((vw - srcSize) / 2);
    const sy = Math.round((vh - srcSize) / 2);
    const dstSize = Math.min(srcSize, DECODE_MAX_EDGE);

    ensureCropCanvas();
    resizeCanvas(cropCanvas, dstSize, dstSize);
    cropCtx.imageSmoothingEnabled = dstSize < srcSize;
    cropCtx.imageSmoothingQuality = 'medium';
    cropCtx.drawImage(video, sx, sy, srcSize, srcSize, 0, 0, dstSize, dstSize);
    return cropCtx.getImageData(0, 0, dstSize, dstSize);
}

function startScanLoop(video) {
    /** 并行解码数上限 = Worker 数；忙时只保留最新帧，适配 100ms 连播 */
    const maxInflight = Math.max(1, decodeWorkers.length || 1);
    let inflight = 0;
    let queuedFrame = null;

    function runDecode(imgData) {
        inflight++;
        decodeImageData(imgData)
            .then((text) => {
                noteDecodeResult(!!text);
                if (text) handleScanResult(text);
            })
            .catch(() => noteDecodeResult(false))
            .finally(() => {
                inflight--;
                if (queuedFrame) {
                    const next = queuedFrame;
                    queuedFrame = null;
                    runDecode(next);
                }
            });
    }

    function tick(now) {
        if (!isScanning) return;
        scanRafId = requestAnimationFrame(tick);

        if (now - lastFrameTime < 1000 / SCAN_FPS) return;
        lastFrameTime = now;
        if (video.readyState < 2) return;
        if (!video.videoWidth || !video.videoHeight) return;

        let imgData;
        try {
            imgData = captureFrame(video);
        } catch (_) {
            return;
        }

        if (inflight >= maxInflight) {
            queuedFrame = imgData;
            return;
        }
        runDecode(imgData);
    }

    scanRafId = requestAnimationFrame(tick);
}

function stopScanLoop() {
    if (scanRafId !== null) {
        cancelAnimationFrame(scanRafId);
        scanRafId = null;
    }
    cropCanvas = null;
    cropCtx = null;
    scaleSrcCanvas = null;
    scaleSrcCtx = null;
    zxingMissStreak = 0;
    zxingUseHardMode = false;
}

async function initCameraList() {
    try {
        // 先请求权限，让 enumerateDevices 能拿到 label
        try { await navigator.mediaDevices.getUserMedia({ video: true }); } catch (_) {}

        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter(d => d.kind === 'videoinput');

        const select = document.getElementById('camera-select');
        select.innerHTML = '<option value="">请选择摄像头...</option>';

        videoDevices.forEach((device, index) => {
            const option = document.createElement('option');
            option.value = device.deviceId;
            let label = device.label || `摄像头 ${index + 1}`;
            const isRear = /rear|back|后置/i.test(label);
            if (isRear) { label += ' [后置]'; option.selected = true; }
            option.text = label;
            select.appendChild(option);
        });

        if (videoDevices.length === 0) {
            select.innerHTML = '<option value="">未找到摄像头设备</option>';
        }
    } catch (err) {
        document.getElementById('camera-select').innerHTML = '<option value="">检测失败</option>';
    }
}

async function toggleCamera() {
    if (isScanning) await stopCamera();
    else await startCamera();
}

async function startCamera() {
    const deviceId = document.getElementById('camera-select').value;
    const resKey = document.getElementById('resolution-select').value;
    const candidates = RESOLUTION_PRESETS[resKey] || RESOLUTION_PRESETS['auto'];

    try {
        document.getElementById('btn-start').disabled = true;
        document.getElementById('scan-btn-text').textContent = '⏳ 启动中...';
        document.getElementById('resolution-actual').textContent = '';

        const { stream, actual } = await tryOpenStream(deviceId || null, candidates);

        const video = document.getElementById('video');
        video.srcObject = stream;
        await new Promise(resolve => { video.onloadedmetadata = resolve; });
        await video.play();

        isScanning = true;
        startScanLoop(video);

        document.getElementById('scan-section-wrapper').classList.add('active');
        document.getElementById('scan-btn-text').textContent = '⏹️ 停止扫描';
        document.getElementById('btn-start').disabled = false;

        const label = formatResolutionLabel(actual);
        if (label) document.getElementById('resolution-actual').textContent = '实际分辨率：' + label;

        showCameraStatus('扫描中... 请对准二维码', 'info');
        showFloatingMessage('📷 摄像头已启动' + (label ? '  ' + label : ''));
    } catch (err) {
        let msg = '启动失败';
        if (err.name === 'NotAllowedError')  msg = '请允许摄像头权限';
        else if (err.name === 'NotFoundError')   msg = '未找到摄像头';
        else if (err.name === 'NotReadableError') msg = '摄像头被占用';
        else msg = err.message;

        showCameraStatus('❌ ' + msg, 'error');
        showFloatingMessage('⚠️ ' + msg, true);
        await stopCamera();
    }
}

async function stopCamera() {
    isScanning = false;
    lastDecodedText = '';
    stopScanLoop();

    const video = document.getElementById('video');
    if (video.srcObject) {
        video.srcObject.getTracks().forEach(t => t.stop());
        video.srcObject = null;
    }

    document.getElementById('scan-section-wrapper').classList.remove('active');
    document.getElementById('scan-btn-text').textContent = '🚀 开始扫描';
    document.getElementById('btn-start').disabled = false;
    showCameraStatus('扫描已停止', 'info');
}

// ===== 扫描结果处理 =====

function handleScanResult(decodedText) {
    const now = Date.now();
    if (now - lastScanTime < SAME_TEXT_DEBOUNCE_MS && decodedText === lastDecodedText) return;
    lastScanTime = now;
    lastDecodedText = decodedText;

    const scanWindow = document.getElementById('scan-window');
    if (scanWindow) {
        scanWindow.classList.add('scan-success');
        setTimeout(() => scanWindow.classList.remove('scan-success'), 300);
    }

    processChunkData(decodedText);
}

async function processChunkData(data) {
    try {
        let trimmed = data.trim();

        // ===== Q2 紧凑协议 =====
        if (trimmed.startsWith('Q2')) {
            const packet = unpackQ2Packet(trimmed);
            if (!packet) throw new Error('Q2 解析失败');

            if (packet.type === 'fn') {
                if (currentFileFingerprint && packet.f !== currentFileFingerprint) {
                    showFloatingMessage('⚠️ 文件指纹不匹配', true);
                    return;
                }
                fileInfo = {
                    fingerprint: packet.f,
                    filename: packet.filename,
                    totalChunks: packet.tc,
                    size: packet.s
                };
                currentFileFingerprint = packet.f;
                receivedFileName = fileInfo.filename;
                showFingerprintDisplay(currentFileFingerprint);
                persistMeta();
                updateUI();
                showFloatingMessage('📄 文件名接收成功');
                showCameraStatus(`✅ 文件: ${receivedFileName}`, 'success');
            } else {
                if (!currentFileFingerprint) {
                    currentFileFingerprint = packet.f;
                    showFingerprintDisplay(currentFileFingerprint);
                } else if (packet.f !== currentFileFingerprint) {
                    showFloatingMessage('⚠️ 二维码不属于当前文件', true);
                    return;
                }
                if (receivedChunks.has(packet.i)) {
                    showFloatingMessage(`⚠️ 分片 ${packet.i + 1}/${packet.t} 已接收过`);
                    return;
                }
                if (!fileInfo) {
                    fileInfo = {
                        fingerprint: packet.f,
                        totalChunks: packet.t,
                        filename: '未知文件',
                        size: 0
                    };
                }
                // 存为 base64，复用既有重组逻辑
                const b64 = uint8ArrayToBase64(packet.payload);
                receivedChunks.set(packet.i, b64);
                persistChunk(packet.i, b64);
                updateUI();
                showFloatingMessage(`✅ 分片 ${packet.i + 1}/${packet.t}`);
                showCameraStatus(
                    `✅ 成功接收数据分片 ${packet.i + 1}/${fileInfo.totalChunks}`,
                    'success'
                );
            }

            if (fileInfo?.totalChunks > 0 &&
                receivedChunks.size >= fileInfo.totalChunks &&
                fileInfo.filename !== '未知文件') {
                document.getElementById('btn-reassemble').disabled = false;
                showFloatingMessage('🎉 接收完成！');
                setTimeout(() => stopCamera(), 500);
            }
            return;
        }

        // ===== 旧版 JSON 协议（兼容） =====
        if (!trimmed.startsWith('{') && trimmed.includes('{'))
            trimmed = trimmed.substring(trimmed.indexOf('{'));
        if (!trimmed.endsWith('}') && trimmed.includes('}'))
            trimmed = trimmed.substring(0, trimmed.lastIndexOf('}') + 1);
        if (!trimmed.startsWith('{') || !trimmed.endsWith('}'))
            throw new Error('数据格式错误');

        const chunk = JSON.parse(trimmed);

        if (chunk.t === 'fn') {
            // 文件名分片
            if (!chunk.f || !chunk.n || typeof chunk.s !== 'number' || !chunk.h)
                throw new Error('文件名数据字段错误');

            const crcCheck = calculateCRC32(JSON.stringify({
                t: chunk.t, f: chunk.f, n: chunk.n, s: chunk.s, ts: chunk.ts, tc: chunk.tc
            }));
            if (crcCheck !== chunk.h.toLowerCase()) {
                showFloatingMessage('❌ 文件名校验失败', true);
                return;
            }
            if (currentFileFingerprint && chunk.f !== currentFileFingerprint) {
                showFloatingMessage('⚠️ 文件指纹不匹配', true);
                return;
            }

            fileInfo = {
                fingerprint: chunk.f,
                filename: decodeFileName(chunk.n),
                totalChunks: chunk.tc,
                size: chunk.s
            };
            currentFileFingerprint = chunk.f;
            receivedFileName = fileInfo.filename;

            showFingerprintDisplay(currentFileFingerprint);
            persistMeta();
            updateUI();
            showFloatingMessage('📄 文件名接收成功');
            showCameraStatus(`✅ 文件: ${receivedFileName}`, 'success');
        } else {
            // 数据分片
            if (typeof chunk.i !== 'number' || !chunk.t || !chunk.d || !chunk.f || !chunk.h)
                throw new Error('数据二维码字段错误');

            if (!currentFileFingerprint) {
                currentFileFingerprint = chunk.f;
                showFingerprintDisplay(currentFileFingerprint);
            } else if (chunk.f !== currentFileFingerprint) {
                showFloatingMessage('⚠️ 二维码不属于当前文件', true);
                return;
            }

            if (calculateCRC32(chunk.d) !== chunk.h.toLowerCase()) {
                showFloatingMessage(`❌ 分片 ${chunk.i+1} 校验失败`, true);
                return;
            }

            if (receivedChunks.has(chunk.i)) {
                showFloatingMessage(`⚠️ 分片 ${chunk.i+1}/${chunk.t} 已接收过`);
                return;
            }

            if (!fileInfo) fileInfo = { fingerprint: chunk.f, totalChunks: chunk.t, filename: '未知文件', size: 0 };

            receivedChunks.set(chunk.i, chunk.d);
            // 异步落盘，不阻塞扫码主路径
            persistChunk(chunk.i, chunk.d);
            updateUI();
            showFloatingMessage(`✅ 分片 ${chunk.i+1}/${chunk.t}`);
            showCameraStatus(`✅ 成功接收数据分片 ${chunk.i+1}/${fileInfo.totalChunks}`, 'success');
        }

        // 检查是否完整
        if (fileInfo?.totalChunks > 0 &&
            receivedChunks.size >= fileInfo.totalChunks &&
            fileInfo.filename !== '未知文件') {
            document.getElementById('btn-reassemble').disabled = false;
            showFloatingMessage('🎉 接收完成！');
            setTimeout(() => stopCamera(), 500);
        }
    } catch (err) {
        showFloatingMessage('❌ ' + err.message, true);
    }
}

// ===== 虚拟模式 =====

function switchMode(mode) {
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    document.querySelector(`[data-mode="${mode}"]`).classList.add('active');
    document.getElementById('camera-section').classList.toggle('active', mode === 'camera');
    document.getElementById('virtual-section').classList.toggle('active', mode === 'virtual');
    if (mode === 'virtual') stopCamera();
}

function handleDragOver(e) { e.preventDefault(); e.currentTarget.classList.add('drag-over'); }
function handleDragLeave(e) { e.currentTarget.classList.remove('drag-over'); }

function handleDrop(e) {
    e.preventDefault();
    e.currentTarget.classList.remove('drag-over');
    const files = [...e.dataTransfer.files].filter(f => f.type.startsWith('image/'));
    if (files.length) addToQueue(files);
}

async function addToQueue(files) {
    for (const file of files) {
        const url = URL.createObjectURL(file);
        imageQueue.push({ file, url, status: 'pending' });
    }
    updateQueueUI();
    if (currentImageIndex === -1 && imageQueue.length > 0) selectImage(0);
}

function selectImage(index) {
    currentImageIndex = index;
    displayImage(imageQueue[index]);
    updateQueueUI();
}

function displayImage(item) {
    const canvas = document.getElementById('preview-canvas');
    const ctx = canvas.getContext('2d');
    const img = new Image();
    img.onload = () => {
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        ctx.drawImage(img, 0, 0);
        document.getElementById('preview-container').style.display = 'block';
    };
    img.src = item.url;
}

function updateQueueUI() {
    const grid = document.getElementById('queue-grid');
    grid.innerHTML = '';
    imageQueue.forEach((item, i) => {
        const div = document.createElement('div');
        div.className = 'queue-item' + (i === currentImageIndex ? ' selected' : '') +
            (item.status === 'completed' ? ' completed' : item.status === 'error' ? ' error' : '');
        div.innerHTML = `<img src="${item.url}" alt="">`;
        div.onclick = () => selectImage(i);
        grid.appendChild(div);
    });
}

async function scanCurrent() {
    if (currentImageIndex === -1) return;
    const item = imageQueue[currentImageIndex];
    const scanBtn = document.getElementById('btn-scan');
    scanBtn.disabled = true;
    scanBtn.textContent = '⏳ 识别中...';

    try {
        const canvas = document.getElementById('preview-canvas');
        const ctx = canvas.getContext('2d');
        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);

        const text = await decodeImageData(imgData, { forceHard: true });
        if (text) {
            processChunkData(text);
            item.status = 'completed';
            setTimeout(() => {
                if (currentImageIndex < imageQueue.length - 1) selectImage(currentImageIndex + 1);
            }, 400);
        } else {
            item.status = 'error';
            showToast('未识别到二维码');
        }
    } catch (err) {
        item.status = 'error';
        showToast('识别失败: ' + err.message);
    }

    scanBtn.disabled = false;
    scanBtn.textContent = '🔍 识别';
    updateQueueUI();
}

async function scanAllQueued() {
    for (let i = 0; i < imageQueue.length; i++) {
        if (imageQueue[i].status !== 'completed') {
            selectImage(i);
            await scanCurrent();
            await new Promise(r => setTimeout(r, 100));
        }
    }
}

// ===== 粘贴处理 =====
async function handlePaste(e) {
    const items = [...(e.clipboardData?.items || [])];
    const imageItems = items.filter(item => item.type.startsWith('image/'));
    if (!imageItems.length) return;
    const files = imageItems.map(item => item.getAsFile()).filter(Boolean);
    if (files.length) addToQueue(files);
}

// ===== UI 更新 =====

function showFingerprintDisplay(fp) {
    const el = document.getElementById('fingerprint-display');
    document.getElementById('fingerprint-value').textContent = fp;
    el.style.display = 'block';
}

function showCameraStatus(message, type) {
    const el = document.getElementById('camera-status');
    el.textContent = message;
    el.className = 'status-message show status-' + type;
}

let _floatingEl = null;
let _floatingTimer = null;
let _floatingLastMsg = '';
let _floatingLastAt = 0;
const FLOATING_DEDUPE_MS = 1800;

function showFloatingMessage(message, isError = false) {
    const now = Date.now();
    // 相同文案短时去抖，避免已接收分片连扫时叠层/狂闪
    if (message === _floatingLastMsg && now - _floatingLastAt < FLOATING_DEDUPE_MS) {
        return;
    }
    _floatingLastMsg = message;
    _floatingLastAt = now;

    if (_floatingEl) {
        clearTimeout(_floatingTimer);
        _floatingEl.remove();
        _floatingEl = null;
    }

    const msg = document.createElement('div');
    msg.className = 'floating-message' + (isError ? ' floating-error' : '');
    msg.textContent = message;
    document.body.appendChild(msg);
    _floatingEl = msg;
    _floatingTimer = setTimeout(() => {
        if (_floatingEl === msg) {
            msg.remove();
            _floatingEl = null;
        }
    }, 2800);
}

function updateUI() {
    const total = fileInfo?.totalChunks || 0;
    const received = receivedChunks.size;

    document.getElementById('received-count').textContent = received;
    document.getElementById('total-count').textContent = total || '?';
    document.getElementById('missing-count').textContent = Math.max(0, total - received);

    const pct = total > 0 ? (received / total) * 100 : 0;
    document.getElementById('progress-fill-recv').style.width = pct + '%';
    document.getElementById('progress-pct').textContent = total > 0 ? pct.toFixed(0) + '%' : '--';

    if (fileInfo?.filename) {
        const fnEl = document.getElementById('filename-display');
        fnEl.querySelector('span').textContent = fileInfo.filename;
        fnEl.style.display = 'block';
    }

    // 缺失分片
    const missingEl = document.getElementById('missing-list');
    if (total > 0 && received < total) {
        const missing = [];
        for (let i = 0; i < total; i++) {
            if (!receivedChunks.has(i)) missing.push(i + 1);
        }
        missingEl.innerHTML = missing.slice(0, 50).map(n =>
            `<span class="missing-chip">${n}</span>`
        ).join('') + (missing.length > 50 ? `<span class="missing-chip">+${missing.length - 50}</span>` : '');
    } else {
        missingEl.innerHTML = '';
    }
}

// ===== 持久化（增量：单分片独立 key，避免整表重写） =====

async function persistMeta() {
    try {
        await DB.setItem('meta', {
            v: 2,
            fingerprint: currentFileFingerprint,
            fileInfo,
            indexes: Array.from(receivedChunks.keys())
        });
    } catch (_) {}
}

let metaPersistTimer = null;
function persistMetaDebounced() {
    clearTimeout(metaPersistTimer);
    metaPersistTimer = setTimeout(() => { persistMeta(); }, 150);
}

async function persistChunk(index, data) {
    try {
        await DB.setItem('c:' + index, data);
        persistMetaDebounced();
    } catch (_) {}
}

async function migrateLegacyProgress(legacy) {
    currentFileFingerprint = legacy.fingerprint;
    fileInfo = legacy.fileInfo;
    receivedChunks = new Map(
        Object.entries(legacy.chunks || {}).map(([k, v]) => [parseInt(k, 10), v])
    );
    receivedFileName = fileInfo?.filename || '';
    for (const [i, d] of receivedChunks) {
        await DB.setItem('c:' + i, d);
    }
    await persistMeta();
    await DB.removeItem('progress');
}

async function loadProgress() {
    try {
        let meta = await DB.getItem('meta');
        if (!meta) {
            const legacy = await DB.getItem('progress');
            if (!legacy) return;
            await migrateLegacyProgress(legacy);
            meta = await DB.getItem('meta');
            if (!meta) return;
        }

        currentFileFingerprint = meta.fingerprint;
        fileInfo = meta.fileInfo;
        receivedChunks = new Map();
        const indexes = meta.indexes || [];
        for (const i of indexes) {
            const d = await DB.getItem('c:' + i);
            if (d != null) receivedChunks.set(Number(i), d);
        }
        receivedFileName = fileInfo?.filename || '';
        if (currentFileFingerprint) showFingerprintDisplay(currentFileFingerprint);
        updateUI();
        if (receivedChunks.size > 0) showFloatingMessage(`📂 已恢复 ${receivedChunks.size} 个分片`);
    } catch (_) {}
}

// ===== 重组文件 =====

async function reassembleFile() {
    if (!fileInfo || receivedChunks.size < fileInfo.totalChunks) {
        showToast('数据不完整，无法重组');
        return;
    }

    const btn = document.getElementById('btn-reassemble');
    btn.disabled = true;
    btn.textContent = '⏳ 重组中...';

    try {
        const sortedChunks = Array.from({ length: fileInfo.totalChunks }, (_, i) => {
            if (!receivedChunks.has(i)) throw new Error(`缺少分片 ${i+1}`);
            return receivedChunks.get(i);
        });

        const totalBytes = sortedChunks.reduce((sum, b64) => sum + Math.floor(b64.replace(/=+$/, '').length * 3 / 4), 0);
        const compressedData = new Uint8Array(totalBytes);
        let offset = 0;

        for (const b64 of sortedChunks) {
            const binary = atob(b64);
            for (let i = 0; i < binary.length; i++) {
                compressedData[offset++] = binary.charCodeAt(i);
            }
        }

        const decompressed = pako.inflate(compressedData.slice(0, offset));
        const blob = new Blob([decompressed]);
        saveFile(blob, fileInfo.filename);
        showToast(`✅ 文件 "${fileInfo.filename}" 下载成功`);
    } catch (err) {
        showToast('重组失败: ' + err.message);
        btn.disabled = false;
    }

    btn.textContent = '⬇️ 重组并下载';
}

// ===== 清除数据 =====

async function clearAllData() {
    if (!confirm('确定要清除所有接收数据吗？此操作不可恢复。')) return;
    try {
        if (isScanning) await stopCamera();
        receivedChunks.clear();
        fileInfo = null;
        currentFileFingerprint = null;
        receivedFileName = '';
        imageQueue = [];
        currentImageIndex = -1;
        await DB.clear();
        document.getElementById('fingerprint-display').style.display = 'none';
        document.getElementById('filename-display').style.display = 'none';
        document.getElementById('btn-reassemble').disabled = true;
        document.getElementById('preview-container').style.display = 'none';
        document.getElementById('queue-grid').innerHTML = '';
        updateUI();
        showToast('数据已清除');
    } catch (err) {
        showToast('清除失败: ' + err.message);
    }
}

// ===== 初始化 =====
document.addEventListener('DOMContentLoaded', async () => {
    const isMac = navigator.platform.includes('Mac');
    document.querySelectorAll('.kbd-cmd').forEach(el => { el.textContent = isMac ? '⌘' : 'Ctrl'; });
    document.addEventListener('paste', handlePaste);
    document.addEventListener('keydown', (e) => {
        const isMod = isMac ? e.metaKey : e.ctrlKey;
        if (isMod && e.key === 'v') return; // 让 paste 事件处理
    });

    await initDecodeWorker();
    await initCameraList();
    await loadProgress();
    showCameraStatus('等待扫描第一个二维码...', 'info');
});
