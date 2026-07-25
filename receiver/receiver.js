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

// ZXing 选项由 getZXingOptions(forceHard) 控制

// 虚拟模式状态
let imageQueue = [];
let currentImageIndex = -1;

/** 相机扫码可调参数（与发送端播放间隔解耦；也可运行时改 window.QRSyncScanTuning） */
const SCAN_TUNING = {
    /**
     * 同时解码路数。单张解码≈20–30ms 时 1 路通常足够；
     * 2 路容易在 HIT 后仍有 in-flight DUP。难扫可改为 2。
     */
    workerInflight: 1,
    /** 帧队列最大长度；4K 单帧约 33MB，队列宜短 */
    queueMax: 2,
    /** 入队采样间隔 ms（4K 解码更重，略放宽） */
    sampleIntervalMs: 40,
    /**
     * 指纹去重：
     * true = 仅抑制「上一张 HIT 成功」的同指纹（MISS 可重试同画面）
     * false = 完全不去重
     */
    frameDedupe: true,
    /**
     * 解码最长边上限。
     * 0 = 不降采样，按摄像头原生分辨率（4K 直接 3840×2160 解码）。
     * 需要降采样时可设为 1600 等。
     */
    decodeMaxEdge: 0
};
window.QRSyncScanTuning = SCAN_TUNING;

/** rAF 采帧上限；真正入队由 sampleIntervalMs 控制 */
const SCAN_FPS = 60;
/** Worker 池大小（需 ≤ index.html 里 wasm 副本数） */
const DECODE_WORKER_COUNT = 3;
/** 相同内容去抖；连播时不同分片不受影响 */
const SAME_TEXT_DEBOUNCE_MS = 80;

function getDecodeMaxEdge() {
    const v = SCAN_TUNING.decodeMaxEdge;
    // 0 / 负数 / 未设：不限制（原生分辨率）
    if (v == null || v <= 0) return 0;
    return v | 0;
}

const DB = localforage.createInstance({ name: 'qrcode-receiver-v2' });

// ===== Decode Worker 池 =====
let decodeWorkers = [];
let idleWorkers = [];
let decodeWorkerReady = false;
let decodeReqId = 0;
const pendingDecodes = new Map();

/** file:// 下缓存的 Blob Worker 脚本 URL；http(s) 则为 decode-worker.js */
let decodeWorkerScriptUrl = null;
let decodeWorkerScriptPromise = null;

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
 * file:// 无法 XHR/直接 Worker 本地脚本（Chrome CORS origin=null）。
 * 改为 <script src> 加载预生成的 decode-worker-source.js，再 Blob 创建 Worker。
 * http(s) 仍使用 decode-worker.js + importScripts。
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
            await loadScriptOnce('decode-worker-source.js?v=20260726-abc10');
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
                        pending.resolve({
                            text: msg.text || null,
                            texts: Array.isArray(msg.texts) && msg.texts.length
                                ? msg.texts
                                : (msg.text ? [msg.text] : [])
                        });
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

let wasmBinaryCopies = null;

async function initDecodeWorker() {
    if (decodeWorkerReady && decodeWorkers.length > 0) {
        return true;
    }

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

    const want = Math.max(1, SCAN_TUNING.workerInflight | 0);
    const count = Math.min(DECODE_WORKER_COUNT, want, copies.length);

    const workers = await Promise.all(
        copies.slice(0, count).map((buf) => createDecodeWorker(buf))
    );
    // 已 transfer 的副本不能复用
    wasmBinaryCopies = copies.length > count ? copies.slice(count) : null;

    decodeWorkers = workers.filter(Boolean);
    idleWorkers = decodeWorkers.slice();
    decodeWorkerReady = decodeWorkers.length > 0;
    if (!decodeWorkerReady) {
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
                resolve({ text: null, texts: [] });
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
                resolve({ text: null, texts: [] });
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

/** 按 decodeMaxEdge 可选降采样；0 表示不降采样 */
function prepareImageDataForDecode(imgData) {
    const maxEdge = getDecodeMaxEdge();
    if (!maxEdge) return imgData;

    const maxDim = Math.max(imgData.width, imgData.height);
    if (maxDim <= maxEdge) return imgData;

    const scale = maxEdge / maxDim;
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
    // 连播场景优先快路径；横向双码最多 2；BINARY 避免把载荷当 UTF-8
    if (forceHard) {
        return {
            formats: ['QRCode'],
            tryHarder: true,
            tryRotate: true,
            tryInvert: true,
            tryDownscale: false,
            maxNumberOfSymbols: 2,
            characterSet: 'BINARY',
            allowJsQR: true
        };
    }
    return {
        formats: ['QRCode'],
        tryHarder: true,
        tryRotate: false,
        tryInvert: false,
        tryDownscale: false,
        maxNumberOfSymbols: 2,
        characterSet: 'BINARY',
        allowJsQR: false
    };
}

/** ZXing ReadResult → Latin-1 字符串（优先 bytes，避免 UTF-8 损坏二进制包） */
function zxingResultToLatin1(result) {
    if (!result) return null;
    const bytes = result.bytes;
    if (bytes && bytes.length) {
        const CHUNK = 0x8000;
        let s = '';
        for (let i = 0; i < bytes.length; i += CHUNK) {
            const end = Math.min(i + CHUNK, bytes.length);
            const slice = bytes.subarray ? bytes.subarray(i, end) : bytes.slice(i, end);
            s += String.fromCharCode.apply(null, slice);
        }
        return s;
    }
    return result.text || null;
}

function zxingResultsToTexts(results) {
    if (!results || !results.length) return [];
    const out = [];
    for (let i = 0; i < results.length; i++) {
        const t = zxingResultToLatin1(results[i]);
        if (t) out.push(t);
    }
    return out;
}

// ===== 统一解码函数 =====
// 优先走 Worker（不阻塞 UI）；Worker 不可用时再主线程 ZXing / jsQR

async function decodeImageData(imgData, { forceHard = false } = {}) {
    imgData = prepareImageDataForDecode(imgData);
    const options = getZXingOptions(forceHard);
    let texts = [];

    if (decodeWorkerReady) {
        try {
            const res = await decodeOnWorker(imgData, options);
            return (res && res.texts) || [];
        } catch (_) {
            // Worker 异常时回退主线程
        }
    }

    if (typeof ZXingWASM !== 'undefined' && ZXingWASM._wasmReady) {
        try {
            const results = await ZXingWASM.readBarcodesFromImageData(imgData, options);
            texts = zxingResultsToTexts(results);
        } catch (_) {}
    }
    if (!texts.length) {
        const r = jsQR(imgData.data, imgData.width, imgData.height, { inversionAttempts: 'dontInvert' });
        if (r && r.data) texts = [r.data];
    }

    return texts;
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

// 全幅采帧（保留横向双码）；decodeMaxEdge=0 时按摄像头原生分辨率，不降采样
function captureFrame(video) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) {
        return new ImageData(1, 1);
    }

    const maxEdge = getDecodeMaxEdge();
    let dw = vw;
    let dh = vh;
    if (maxEdge > 0) {
        const scale = Math.min(1, maxEdge / Math.max(vw, vh));
        dw = Math.max(1, Math.round(vw * scale));
        dh = Math.max(1, Math.round(vh * scale));
    }

    ensureCropCanvas();
    resizeCanvas(cropCanvas, dw, dh);
    const scaled = dw !== vw || dh !== vh;
    cropCtx.imageSmoothingEnabled = scaled;
    if (scaled) cropCtx.imageSmoothingQuality = 'high';
    cropCtx.drawImage(video, 0, 0, vw, vh, 0, 0, dw, dh);
    return cropCtx.getImageData(0, 0, dw, dh);
}

/** 廉价帧指纹，用于入队去重（粗量化，抑制相机噪声假换码） */
function frameFingerprint(imgData) {
    const d = imgData.data;
    const len = d.length;
    const step = Math.max(256, ((len / 48) | 0) & ~3);
    let h = (imgData.width * 73856093) ^ (imgData.height * 19349663);
    for (let i = 0; i < len; i += step) {
        // >>3：约 32 级亮度，忽略低位噪声
        h = (Math.imul(h, 31) + (d[i] >> 3)) | 0;
    }
    return h;
}

/** 轻量：判断本包是否尚未入库（用于双码页部分命中时是否允许同画面重扫） */
function isNewPacketForScan(text) {
    if (!text) return false;
    try {
        const p = unpackQRPacket(text);
        if (p) {
            if (p.type === 'fn') {
                return !fileInfo || fileInfo.filename === '未知文件';
            }
            return !receivedChunks.has(p.i);
        }
        const chunk = JSON.parse(text.trim());
        if (chunk.t === 'fn') return !fileInfo || fileInfo.filename === '未知文件';
        if (typeof chunk.i === 'number') return !receivedChunks.has(chunk.i);
    } catch (_) {}
    return true;
}

function startScanLoop(video) {
    /**
     * 帧队列 + N Worker 并行消费不同历史帧。
     * 参数见 SCAN_TUNING / window.QRSyncScanTuning（运行时可改，无需重载，除 worker 池大小）。
     */
    const frameQueue = [];
    let inflight = 0;
    let frameIdSeq = 0;
    let lastSampleAt = 0;
    /** 仅在 HIT 后抑制同指纹；MISS 允许同画面再入队重试 */
    let lastHitFp = null;
    let lastHitFrameKey = null;

    function currentInflightLimit() {
        const want = Math.max(1, SCAN_TUNING.workerInflight | 0);
        if (decodeWorkers.length > 0) {
            return Math.min(want, decodeWorkers.length);
        }
        return want;
    }

    function pumpDecode() {
        const limit = currentInflightLimit();
        while (inflight < limit && frameQueue.length > 0) {
            const item = frameQueue.shift();
            inflight++;
            decodeImageData(item.imgData)
                .then((texts) => {
                    if (!texts || !texts.length) {
                        return;
                    }

                    const uniq = [];
                    const seenTxt = new Set();
                    for (let i = 0; i < texts.length; i++) {
                        const t = texts[i];
                        if (!t || seenTxt.has(t)) continue;
                        seenTxt.add(t);
                        uniq.push(t);
                    }
                    const frameKey = uniq.slice().sort().join('\0');
                    if (lastHitFrameKey && frameKey === lastHitFrameKey) {
                        lastHitFp = item.fp;
                        frameQueue.length = 0;
                        return;
                    }

                    let anyNew = false;
                    for (let i = 0; i < uniq.length; i++) {
                        if (isNewPacketForScan(uniq[i])) anyNew = true;
                        handleScanResult(uniq[i]);
                    }

                    lastHitFrameKey = frameKey;

                    // 双码页：收齐 2 或本帧无新分片时抑制同画面，避免漏码后无法重扫
                    if (uniq.length >= 2 || !anyNew) {
                        lastHitFp = item.fp;
                        frameQueue.length = 0;
                    } else {
                        lastHitFp = null;
                    }
                })
                .catch(() => {})
                .finally(() => {
                    inflight--;
                    pumpDecode();
                });
        }
    }

    function tryEnqueue(imgData, now) {
        const sampleMs = Math.max(16, SCAN_TUNING.sampleIntervalMs | 0);
        if (now - lastSampleAt < sampleMs) {
            return;
        }
        lastSampleAt = now;

        const queueMax = Math.max(1, SCAN_TUNING.queueMax | 0);
        if (frameQueue.length >= queueMax) {
            return;
        }

        const fp = frameFingerprint(imgData);
        if (SCAN_TUNING.frameDedupe && lastHitFp !== null && fp === lastHitFp) {
            return;
        }

        frameQueue.push({ id: ++frameIdSeq, imgData, at: now, fp });
        pumpDecode();
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

        tryEnqueue(imgData, now);
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

let _uiRafPending = false;
function scheduleUpdateUI() {
    if (_uiRafPending) return;
    _uiRafPending = true;
    requestAnimationFrame(() => {
        _uiRafPending = false;
        updateUI();
    });
}

let _feedbackRafPending = false;
let _pendingFeedback = null;
/** 成功反馈合并到下一帧，避免连扫时 DOM 更新堵住采帧 */
function scheduleSuccessFeedback(floatingMsg, statusMsg, statusType = 'success') {
    _pendingFeedback = { floatingMsg, statusMsg, statusType };
    if (_feedbackRafPending) return;
    _feedbackRafPending = true;
    requestAnimationFrame(() => {
        _feedbackRafPending = false;
        const f = _pendingFeedback;
        _pendingFeedback = null;
        if (!f) return;
        if (f.floatingMsg) showFloatingMessage(f.floatingMsg);
        if (f.statusMsg) showCameraStatus(f.statusMsg, f.statusType);
    });
}

let _scanFlashTimer = null;
function flashScanSuccess() {
    const scanWindow = document.getElementById('scan-window');
    if (!scanWindow) return;
    scanWindow.classList.add('scan-success');
    clearTimeout(_scanFlashTimer);
    _scanFlashTimer = setTimeout(() => scanWindow.classList.remove('scan-success'), 200);
}

function handleScanResult(decodedText) {
    const now = Date.now();
    if (now - lastScanTime < SAME_TEXT_DEBOUNCE_MS && decodedText === lastDecodedText) return;
    lastScanTime = now;
    lastDecodedText = decodedText;

    requestAnimationFrame(flashScanSuccess);
    processChunkData(decodedText);
}

async function processChunkData(data) {
    try {
        // ===== Q3 二进制 / Q2 文本协议 =====
        const packet = typeof unpackQRPacket === 'function' ? unpackQRPacket(data) : null;
        if (packet) {
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
                scheduleUpdateUI();
                scheduleSuccessFeedback('📄 文件名接收成功', `✅ 文件: ${receivedFileName}`);
            } else {
                if (!currentFileFingerprint) {
                    currentFileFingerprint = packet.f;
                    showFingerprintDisplay(currentFileFingerprint);
                } else if (packet.f !== currentFileFingerprint) {
                    showFloatingMessage('⚠️ 二维码不属于当前文件', true);
                    return;
                }
                if (receivedChunks.has(packet.i)) {
                    // 已接收：静默跳过，避免连扫时频繁刷 UI
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
                scheduleUpdateUI();
                scheduleSuccessFeedback(
                    `✅ 分片 ${packet.i + 1}/${packet.t}`,
                    `✅ 成功接收数据分片 ${packet.i + 1}/${fileInfo.totalChunks}`
                );
            }

            if (fileInfo?.totalChunks > 0 &&
                receivedChunks.size >= fileInfo.totalChunks &&
                fileInfo.filename !== '未知文件') {
                document.getElementById('btn-reassemble').disabled = false;
                scheduleSuccessFeedback('🎉 接收完成！', '🎉 接收完成！');
                setTimeout(() => stopCamera(), 500);
            }
            return;
        }

        let trimmed = data.trim();

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
            scheduleUpdateUI();
            scheduleSuccessFeedback('📄 文件名接收成功', `✅ 文件: ${receivedFileName}`);
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
                return;
            }

            if (!fileInfo) fileInfo = { fingerprint: chunk.f, totalChunks: chunk.t, filename: '未知文件', size: 0 };

            receivedChunks.set(chunk.i, chunk.d);
            // 异步落盘，不阻塞扫码主路径
            persistChunk(chunk.i, chunk.d);
            scheduleUpdateUI();
            scheduleSuccessFeedback(
                `✅ 分片 ${chunk.i+1}/${chunk.t}`,
                `✅ 成功接收数据分片 ${chunk.i+1}/${fileInfo.totalChunks}`
            );
        }

        // 检查是否完整
        if (fileInfo?.totalChunks > 0 &&
            receivedChunks.size >= fileInfo.totalChunks &&
            fileInfo.filename !== '未知文件') {
            document.getElementById('btn-reassemble').disabled = false;
            scheduleSuccessFeedback('🎉 接收完成！', '🎉 接收完成！');
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

        const texts = await decodeImageData(imgData, { forceHard: true });
        if (texts && texts.length) {
            for (let i = 0; i < texts.length; i++) {
                processChunkData(texts[i]);
            }
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
