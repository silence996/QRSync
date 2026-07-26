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

// 全幅取景 canvas（复用）
let frameCanvas = null;
let frameCtx = null;

// 连播：默认关 rotate/invert 以提速；连续未识别再升级（不影响 tryHarder）
let zxingMissStreak = 0;
const ZXING_HARD_AFTER_MISS = 2;

// 虚拟模式状态
let imageQueue = [];
let currentImageIndex = -1;

const SCAN_FPS = 12;

/** 同帧左右半幅并行：固定 2 个 Worker（非历史帧队列） */
const DECODE_WORKER_COUNT = 2;
/** 左右半幅中线重叠比例，避免 quiet zone 被切掉 */
const HALF_OVERLAP_RATIO = 0.04;

const DB = localforage.createInstance({ name: 'qrcode-receiver-v2' });

// ===== Decode Worker 池（同帧左/右各一路） =====
let decodeWorkers = [];
let idleWorkers = [];
let decodeWorkerReady = false;
let decodeReqId = 0;
const pendingDecodes = new Map();
let decodeWorkerScriptUrl = null;
let decodeWorkerScriptPromise = null;
let wasmBinaryCopies = null;

function loadScriptOnce(src) {
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('脚本加载失败: ' + src));
        document.head.appendChild(s);
    });
}

/**
 * file:// 无法直接 Worker(本地脚本)；用预生成 decode-worker-source.js + Blob。
 * http(s) 仍用 decode-worker.js + importScripts。
 */
async function ensureDecodeWorkerScriptUrl() {
    if (decodeWorkerScriptUrl) return decodeWorkerScriptUrl;
    if (decodeWorkerScriptPromise) return decodeWorkerScriptPromise;

    decodeWorkerScriptPromise = (async () => {
        if (location.protocol !== 'file:') {
            decodeWorkerScriptUrl = 'decode-worker.js';
            return decodeWorkerScriptUrl;
        }
        if (!window.__QRSyncDecodeWorkerSource) {
            await loadScriptOnce('decode-worker-source.js?v=20260726-dual1');
        }
        const source = window.__QRSyncDecodeWorkerSource;
        if (!source || typeof source !== 'string') {
            throw new Error(
                '缺少 __QRSyncDecodeWorkerSource。请确认存在 receiver/decode-worker-source.js，' +
                '或运行 tools/build-decode-worker-source.ps1 重新生成'
            );
        }
        const blob = new Blob([source], { type: 'application/javascript' });
        decodeWorkerScriptUrl = URL.createObjectURL(blob);
        return decodeWorkerScriptUrl;
    })();

    try {
        return await decodeWorkerScriptPromise;
    } catch (err) {
        decodeWorkerScriptPromise = null;
        throw err;
    }
}

function createDecodeWorker(wasmBinary) {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (ok, worker) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(ok ? worker : null);
        };
        const timer = setTimeout(() => finish(false, null), 20000);

        ensureDecodeWorkerScriptUrl()
            .then((scriptUrl) => {
                let worker;
                try {
                    worker = new Worker(scriptUrl);
                } catch (err) {
                    console.warn('[decode-worker] 创建失败:', err.message);
                    finish(false, null);
                    return;
                }

                worker.onmessage = (event) => {
                    const msg = event.data;
                    if (!msg) return;
                    if (msg.type === 'ready') {
                        finish(true, worker);
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
                    console.warn('[decode-worker] 错误:', err.message || err);
                    finish(false, null);
                };

                worker.postMessage({ type: 'init', wasmBinary }, [wasmBinary]);
            })
            .catch((err) => {
                console.warn('[decode-worker] 脚本准备失败:', err.message);
                finish(false, null);
            });
    });
}

async function initDecodeWorker() {
    if (decodeWorkerReady && decodeWorkers.length > 0) return true;

    if (!wasmBinaryCopies) {
        wasmBinaryCopies = window.__QRSyncWasmBinaryCopies || null;
        window.__QRSyncWasmBinaryCopies = null;
    }
    const copies = wasmBinaryCopies;

    if (typeof Worker === 'undefined') {
        console.warn('[decode-worker] ⚠️ 环境不支持 Worker，回退主线程');
        return false;
    }
    if (!copies || !copies.length) {
        console.warn('[decode-worker] ⚠️ 无 wasm 副本，回退主线程（请硬刷新页面）');
        return false;
    }

    const count = Math.min(DECODE_WORKER_COUNT, copies.length);
    const workers = await Promise.all(
        copies.slice(0, count).map((buf) => createDecodeWorker(buf))
    );
    wasmBinaryCopies = copies.length > count ? copies.slice(count) : null;

    decodeWorkers = workers.filter(Boolean);
    idleWorkers = decodeWorkers.slice();
    decodeWorkerReady = decodeWorkers.length > 0;
    if (!decodeWorkerReady) {
        console.warn('[decode-worker] ⚠️ 全部失败，回退主线程解码');
    } else {
        console.log(`[decode-worker] ✅ 已就绪 ${decodeWorkers.length} 路（同帧左右并行）`);
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
            setTimeout(wait, 8);
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

function getZXingOptions(forceHard) {
    // tryHarder 始终开启，保证成功率；rotate/invert 仅难扫时开启
    const hard = !!forceHard || zxingMissStreak >= ZXING_HARD_AFTER_MISS;
    return {
        formats: ['QRCode'],
        tryHarder: true,
        tryRotate: hard,
        tryInvert: hard,
        tryDownscale: false,
        maxNumberOfSymbols: 1
    };
}

function noteDecodeResult(ok) {
    if (ok) zxingMissStreak = 0;
    else zxingMissStreak++;
}

/** 主线程单幅解码（Worker 不可用或虚拟模式兜底） */
async function decodeImageDataMain(imgData, { forceHard = false } = {}) {
    let text = null;
    if (typeof ZXingWASM !== 'undefined' && ZXingWASM._wasmReady) {
        try {
            const results = await ZXingWASM.readBarcodesFromImageData(
                imgData,
                getZXingOptions(forceHard)
            );
            if (results.length > 0) text = results[0].text;
        } catch (_) {}
    }
    if (!text && (forceHard || zxingMissStreak >= ZXING_HARD_AFTER_MISS)) {
        const r = jsQR(imgData.data, imgData.width, imgData.height, {
            inversionAttempts: forceHard ? 'attemptBoth' : 'dontInvert'
        });
        text = r ? r.data : null;
    }
    return text;
}

/** 对外单幅接口：优先 Worker，否则主线程 */
async function decodeImageData(imgData, { forceHard = false } = {}) {
    const options = getZXingOptions(forceHard);
    let text = null;
    if (decodeWorkerReady) {
        try {
            text = await decodeOnWorker(imgData, options);
        } catch (_) {}
    }
    if (!text) text = await decodeImageDataMain(imgData, { forceHard });
    noteDecodeResult(!!text);
    return text;
}

/**
 * 同帧左右半幅并行解码：
 * - Worker A ← 左半幅（奇数码）
 * - Worker B ← 右半幅（偶数码）
 * 不是并行解码历史帧队列。
 */
async function decodeDualHalves(left, right, { forceHard = false } = {}) {
    const options = getZXingOptions(forceHard);
    let leftText = null;
    let rightText = null;

    if (decodeWorkerReady && decodeWorkers.length >= 2) {
        [leftText, rightText] = await Promise.all([
            decodeOnWorker(left, options),
            decodeOnWorker(right, options)
        ]);
    } else if (decodeWorkerReady && decodeWorkers.length === 1) {
        leftText = await decodeOnWorker(left, options);
        rightText = await decodeOnWorker(right, options);
    } else {
        [leftText, rightText] = await Promise.all([
            decodeImageDataMain(left, { forceHard }),
            decodeImageDataMain(right, { forceHard })
        ]);
    }

    const hit = !!(leftText || rightText);
    return { leftText, rightText, hit };
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

/** 全幅取景（不中心裁方、不降采样），适配横向双码 */
function captureFullFrame(video) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;

    if (!frameCanvas) {
        frameCanvas = document.createElement('canvas');
        frameCtx = frameCanvas.getContext('2d', { willReadFrequently: true });
    }
    if (frameCanvas.width !== vw || frameCanvas.height !== vh) {
        frameCanvas.width = vw;
        frameCanvas.height = vh;
    }
    frameCtx.imageSmoothingEnabled = false;
    frameCtx.drawImage(video, 0, 0, vw, vh);
    return frameCtx.getImageData(0, 0, vw, vh);
}

/** 切左右半幅；中线略重叠，避免 quiet zone 被切断 */
function splitFrameHalves(imgData) {
    const { width, height, data } = imgData;
    const overlap = Math.max(2, Math.round(width * HALF_OVERLAP_RATIO));
    const mid = Math.floor(width / 2);
    const leftW = Math.min(width, mid + overlap);
    const rightX = Math.max(0, mid - overlap);
    const rightW = width - rightX;

    const left = new ImageData(leftW, height);
    const right = new ImageData(rightW, height);

    for (let y = 0; y < height; y++) {
        const row = y * width * 4;
        left.data.set(data.subarray(row, row + leftW * 4), y * leftW * 4);
        right.data.set(data.subarray(row + rightX * 4, row + (rightX + rightW) * 4), y * rightW * 4);
    }
    return { left, right };
}

function startScanLoop(video) {
    let decoding = false;

    async function tick(now) {
        if (!isScanning) return;
        scanRafId = requestAnimationFrame(tick);

        if (now - lastFrameTime < 1000 / SCAN_FPS) return;
        lastFrameTime = now;
        if (decoding || video.readyState < 2) return;
        decoding = true;

        try {
            if (!video.videoWidth || !video.videoHeight) return;
            const full = captureFullFrame(video);
            if (!full) return;
            const { left, right } = splitFrameHalves(full);
            const { leftText, rightText, hit } = await decodeDualHalves(left, right);
            // 两路结果都处理（不同分片）；同文去抖在 handleScanResult
            if (leftText) handleScanResult(leftText);
            if (rightText) handleScanResult(rightText);
            // 文件名单页居中时左右切开会失败 → 全幅兜底
            if (!hit) {
                const options = getZXingOptions(false);
                let text = null;
                if (decodeWorkerReady) {
                    try { text = await decodeOnWorker(full, options); } catch (_) {}
                }
                if (!text) text = await decodeImageDataMain(full, { forceHard: false });
                if (text) handleScanResult(text);
                noteDecodeResult(!!text);
            } else {
                noteDecodeResult(true);
            }
        } catch (_) {
        } finally {
            decoding = false;
        }
    }

    scanRafId = requestAnimationFrame(tick);
}

function stopScanLoop() {
    if (scanRafId !== null) {
        cancelAnimationFrame(scanRafId);
        scanRafId = null;
    }
    frameCanvas = null;
    frameCtx = null;
    zxingMissStreak = 0;
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

        if (!decodeWorkerReady) {
            await initDecodeWorker();
        }

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
    if (now - lastScanTime < 800 && decodedText === lastDecodedText) return;
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
            await saveProgress();
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
            await saveProgress();
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

function showFloatingMessage(message, isError = false) {
    const msg = document.createElement('div');
    msg.className = 'floating-message' + (isError ? ' floating-error' : '');
    msg.textContent = message;
    document.body.appendChild(msg);
    setTimeout(() => msg.remove(), 2800);
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

// ===== 持久化 =====

async function saveProgress() {
    try {
        const data = {
            fingerprint: currentFileFingerprint,
            fileInfo,
            chunks: Object.fromEntries(receivedChunks)
        };
        await DB.setItem('progress', data);
    } catch (_) {}
}

async function loadProgress() {
    try {
        const data = await DB.getItem('progress');
        if (!data) return;
        currentFileFingerprint = data.fingerprint;
        fileInfo = data.fileInfo;
        receivedChunks = new Map(Object.entries(data.chunks || {}).map(([k, v]) => [parseInt(k), v]));
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
