// ===== 配置 =====
const DEFAULT_CHUNK_SIZE = 2900;
const DEFAULT_QR_SIZE = 1600;
const DEFAULT_AUTOPLAY_INTERVAL = 500;

const CONFIG = {
    /** Q3 二进制：20 字节头 + 载荷 ≤ 2953 → 载荷上限约 2933；默认拉满滑块 */
    CHUNK_SIZE: DEFAULT_CHUNK_SIZE,
    QR_SIZE: DEFAULT_QR_SIZE,
    QR_MAX_CAPACITY: typeof QR_MAX_BYTES_L40 === 'number' ? QR_MAX_BYTES_L40 : 2953,
    /** 同屏单码（可靠性优先） */
    AUTOPLAY_INTERVAL: DEFAULT_AUTOPLAY_INTERVAL,
    PACKET_TYPES: { DATA: 'data', FILENAME: 'fn' }
};

// ===== 状态 =====
let file = null;
let chunks = [];
let currentChunkIndex = 0;
let fileFingerprint = '';
let originalFileName = '';
let originalFileSize = 0;
let qrCodes = [];
let fileNameQrCode = null;
let autoplayTimer = null;
let isPlaying = false;
let hasGenerated = false;
/** index -> canvas；仅缓存当前附近几帧，避免大文件占满内存 */
const qrCanvasCache = new Map();
const QR_PRERENDER_AHEAD = 6;
let prerenderScheduled = false;

// ===== DOM 引用 =====
const uploadArea    = document.getElementById('uploadArea');
const fileInput     = document.getElementById('fileInput');
const fileInfo      = document.getElementById('fileInfo');
const generateBtn   = document.getElementById('generateBtn');
const resetBtn      = document.getElementById('resetBtn');
const qrSection     = document.getElementById('qrSection');
const qrContainer   = document.getElementById('qrContainer');
const downloadSection = document.getElementById('downloadSection');
const chunkJumpInput = document.getElementById('chunkJumpInput');
const chunkJumpBtn  = document.getElementById('chunkJumpBtn');

// ===== 파일 업로드 이벤트 =====
uploadArea.addEventListener('click', () => fileInput.click());

uploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadArea.classList.add('dragover');
});

uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('dragover'));

uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadArea.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) handleFile(e.dataTransfer.files[0]);
});

fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) handleFile(e.target.files[0]);
});

function handleFile(selectedFile) {
    file = selectedFile;
    originalFileName = file.name;
    originalFileSize = file.size;

    document.getElementById('fileName').textContent = originalFileName;
    document.getElementById('fileSize').textContent = formatFileSize(originalFileSize);
    document.getElementById('fileType').textContent = file.type || '未知类型';

    fileFingerprint = generateShortFileId();
    document.getElementById('fileFingerprint').textContent = fileFingerprint;

    uploadArea.classList.add('has-file');
    uploadArea.innerHTML = `
        <div class="upload-icon">✅</div>
        <div class="upload-text">文件已选择</div>
        <div class="upload-hint">${originalFileName}</div>
    `;

    fileInfo.style.display = 'block';
    generateBtn.disabled = false;
    hasGenerated = false;
    hideRegenerateHints();
    updateChunkEstimation();
    showStatus('status', '文件已选择，点击"生成二维码"开始', 'success');
    showToast('文件选择成功');
}

// ===== 设置滑块 =====
const chunkSizeSlider = document.getElementById('chunkSizeSlider');
const chunkSizeValue  = document.getElementById('chunkSizeValue');
const chunkSizeHint   = document.getElementById('chunkSizeHint');

chunkSizeSlider.addEventListener('input', function () {
    CONFIG.CHUNK_SIZE = parseInt(this.value);
    chunkSizeValue.textContent = CONFIG.CHUNK_SIZE + ' B';
    updateChunkEstimation();
    if (hasGenerated) chunkSizeHint.classList.add('show');
});

const qrSizeSlider = document.getElementById('qrSizeSlider');
const qrSizeValue  = document.getElementById('qrSizeSlider').parentElement.querySelector('.slider-value') ||
                     document.getElementById('qrSizeValue');
const qrSizeHint   = document.getElementById('qrSizeHint');

document.getElementById('qrSizeSlider').addEventListener('input', function () {
    CONFIG.QR_SIZE = parseInt(this.value);
    document.getElementById('qrSizeValue').textContent = CONFIG.QR_SIZE + ' px';
    clearQRCanvasCache();
    if (hasGenerated) qrSizeHint.classList.add('show');
});

function hideRegenerateHints() {
    chunkSizeHint.classList.remove('show');
    qrSizeHint.classList.remove('show');
}

function updateChunkEstimation() {
    if (!file) return;
    const estimated = Math.ceil(file.size * 0.6 / CONFIG.CHUNK_SIZE);
    document.getElementById('estimatedChunks').textContent = (estimated + 1) + ' 个';
    document.getElementById('estimationBar').style.width = Math.min(estimated, 100) + '%';
}

// ===== 播放间隔 =====
document.getElementById('intervalConfirmBtn').addEventListener('click', () => {
    const raw = parseInt(document.getElementById('intervalInput').value);
    CONFIG.AUTOPLAY_INTERVAL = Math.max(100, Math.min(60000, isNaN(raw) ? 500 : raw));
    document.getElementById('intervalInput').value = CONFIG.AUTOPLAY_INTERVAL;
    document.getElementById('intervalAppliedValue').textContent = CONFIG.AUTOPLAY_INTERVAL;
    document.getElementById('intervalAppliedHint').classList.add('show');
    setTimeout(() => document.getElementById('intervalAppliedHint').classList.remove('show'), 2500);
    if (isPlaying) restartAutoplay();
});

// ===== 生成二维码 =====
generateBtn.addEventListener('click', async () => {
    if (!file) { showStatus('status', '请先选择文件', 'error'); return; }
    if (typeof QRCode === 'undefined') { showStatus('status', 'QRCode 库未加载', 'error'); return; }

    try {
        generateBtn.disabled = true;
        generateBtn.innerHTML = '<span class="loading"></span> 处理中...';
        showStatus('status', '正在读取并压缩文件...', 'info');

        const fileBuffer = await readFileAsArrayBuffer(file);
        const compressed = pako.deflate(new Uint8Array(fileBuffer));

        showStatus('status', `压缩完成: ${formatFileSize(fileBuffer.byteLength)} → ${formatFileSize(compressed.length)}`, 'success');
        await processFileChunks(compressed);
    } catch (error) {
        showStatus('status', '处理文件时出错: ' + error.message, 'error');
        generateBtn.disabled = false;
        generateBtn.innerHTML = '<span>生成二维码</span>';
    }
});

async function processFileChunks(compressed) {
    chunks = [];
    qrCodes = [];

    const totalChunks = Math.ceil(compressed.length / CONFIG.CHUNK_SIZE);
    if (totalChunks <= 0) throw new Error('分片计算错误');

    showStatus('status', `正在分片处理... (共 ${totalChunks} 个数据分片)`, 'info');

    const compressedArray = new Uint8Array(compressed);

    for (let i = 0; i < totalChunks; i++) {
        const start = i * CONFIG.CHUNK_SIZE;
        const chunkData = compressedArray.slice(start, Math.min(start + CONFIG.CHUNK_SIZE, compressed.length));
        const qrText = packQ3DataChunk(i, totalChunks, fileFingerprint, chunkData);

        if (qrText.length > CONFIG.QR_MAX_CAPACITY) {
            const suggested = Math.max(200, Math.floor(CONFIG.CHUNK_SIZE / (qrText.length / CONFIG.QR_MAX_CAPACITY) * 0.9));
            showStatus('status', `分片 ${i+1} 数据过大，建议将分片大小调整为 ${suggested} B`, 'error');
            chunkSizeSlider.value = suggested;
            chunkSizeValue.textContent = suggested + ' B';
            CONFIG.CHUNK_SIZE = suggested;
            generateBtn.disabled = false;
            generateBtn.innerHTML = '<span>生成二维码</span>';
            return;
        }

        chunks.push({ qrText, i, t: totalChunks });

        if (i % Math.max(1, Math.floor(totalChunks / 10)) === 0) {
            showStatus('status', `分片进度: ${i+1}/${totalChunks}`, 'info');
            await new Promise(resolve => setTimeout(resolve, 10));
        }
    }

    // 计算最小安全 QR 尺寸（每模块至少 4px）
    const maxTextLen = Math.max(...chunks.map(c => c.qrText.length));
    const estimatedVersion = maxTextLen < 1000 ? 25 : maxTextLen < 1209 ? 30 : maxTextLen < 1520 ? 35 : 40;
    const minSafeSize = (17 + 4 * estimatedVersion) * 4;
    if (CONFIG.QR_SIZE < minSafeSize) {
        CONFIG.QR_SIZE = minSafeSize;
        document.getElementById('qrSizeSlider').value = Math.min(minSafeSize, parseInt(document.getElementById('qrSizeSlider').max));
        document.getElementById('qrSizeValue').textContent = CONFIG.QR_SIZE + ' px';
    }

    createFileNameQrCode(totalChunks);
    showStatus('status', `处理完成！共 ${totalChunks} 个数据分片 + 1 个文件名分片`, 'success');
    await generateQRCodeSequence();
    hasGenerated = true;
    hideRegenerateHints();
}

function createFileNameQrCode(totalChunks) {
    fileNameQrCode = {
        qrText: packQ3FilenameChunk(
            fileFingerprint,
            originalFileName,
            originalFileSize,
            totalChunks,
            Date.now() >>> 0
        )
    };
}

async function generateQRCodeSequence() {
    qrSection.classList.add('show');
    currentChunkIndex = 0;
    clearQRCanvasCache();
    qrCodes = chunks.map((c, i) => ({
        qrText: c.qrText,
        data: c,
        type: CONFIG.PACKET_TYPES.DATA,
        index: i
    }));
    qrCodes.push({
        qrText: fileNameQrCode.qrText,
        data: fileNameQrCode,
        type: CONFIG.PACKET_TYPES.FILENAME,
        index: chunks.length
    });

    const totalQR = qrCodes.length;
    document.getElementById('totalQrCount').textContent = totalQR;
    document.getElementById('dataQrCount').textContent = chunks.length;
    downloadSection.classList.add('show');

    updateJumpControls(0);
    showQRPage(0);

    generateBtn.disabled = false;
    generateBtn.innerHTML = '<span>生成二维码</span>';
    showToast('二维码生成完成；已进入整屏，Esc 退出');
    enterQrImmersive();
}

function updateJumpControls(index) {
    // 不覆盖用户正在输入的缺口列表；仅刷新可选范围提示
    if (!chunks.length) return;
    chunkJumpInput.setAttribute('data-max', String(chunks.length));
    if (!chunkJumpInput.value.trim() && index < chunks.length) {
        chunkJumpInput.placeholder = '如 ' + (index + 1) + ' 或 3,4,5-7（共 ' + chunks.length + '）';
    }
}

/** 解析分片号：5 / 3,4,5,6,7 / 3-7 / 3~7；fn=文件名页 */
function parseChunkRefs(str) {
    const raw = String(str || '').trim();
    if (!raw) return { nums: [], wantFn: false };
    if (/^(fn|文件名)$/i.test(raw)) return { nums: [], wantFn: true };

    const nums = [];
    let wantFn = false;
    const parts = raw.split(/[,，\s]+/).filter(Boolean);
    for (let p = 0; p < parts.length; p++) {
        const token = parts[p];
        if (/^(fn|文件名)$/i.test(token)) {
            wantFn = true;
            continue;
        }
        const range = token.match(/^(\d+)\s*[-~～—–到至]\s*(\d+)$/);
        if (range) {
            let a = parseInt(range[1], 10);
            let b = parseInt(range[2], 10);
            if (a > b) { const t = a; a = b; b = t; }
            for (let i = a; i <= b; i++) nums.push(i);
            continue;
        }
        const n = parseInt(token, 10);
        if (!isNaN(n)) nums.push(n);
    }

    const max = chunks.length;
    const uniq = [];
    const seen = new Set();
    for (let i = 0; i < nums.length; i++) {
        const n = nums[i];
        if (n < 1 || n > max || seen.has(n)) continue;
        seen.add(n);
        uniq.push(n);
    }
    return { nums: uniq, wantFn };
}

let gapList = [];
let gapCursor = -1;
let highlightChunk1 = 0; // 1-based；0=无

function updateGapStatus() {
    const el = document.getElementById('gapJumpStatus');
    if (!el) return;
    if (!gapList.length) {
        el.textContent = highlightChunk1 ? ('当前目标 #' + highlightChunk1) : '';
        return;
    }
    el.textContent =
        '缺口 ' + (gapCursor + 1) + '/' + gapList.length +
        ' → #' + gapList[gapCursor];
}

function applyTargetHighlight() {
    const root = document.getElementById('qrcode');
    if (!root) return;
    const cell = root.querySelector('.qr-grid-cell');
    if (!cell) return;
    const q = qrCodes[currentChunkIndex];
    const match = !!(highlightChunk1 && q && q.data && (q.data.i + 1) === highlightChunk1);
    cell.classList.toggle('qr-target', match);
}

/** 按 1-based 数据分片号跳到对应页，并高亮所在侧 */
function jumpToDataChunk(n1based) {
    if (!chunks.length) return false;
    const n = n1based | 0;
    if (n < 1 || n > chunks.length) {
        showToast('分片号需在 1～' + chunks.length);
        return false;
    }
    stopAutoplay();
    highlightChunk1 = n;
    showQRPage(pageOfIndex(n - 1));
    applyTargetHighlight();
    updateGapStatus();
    return true;
}

function jumpToFilenamePage() {
    if (!qrCodes.length || qrCodes.length <= chunks.length) {
        showToast('没有文件名码');
        return false;
    }
    stopAutoplay();
    highlightChunk1 = 0;
    showQRPage(pageCount() - 1);
    updateGapStatus();
    return true;
}

function jumpToChunk() {
    if (!chunks.length && !qrCodes.length) return;
    const parsed = parseChunkRefs(chunkJumpInput.value);
    if (parsed.wantFn && !parsed.nums.length) {
        gapList = [];
        gapCursor = -1;
        jumpToFilenamePage();
        return;
    }
    if (!parsed.nums.length) {
        showToast('请输入分片号，例如 5 或 3,4,5-7');
        return;
    }
    gapList = parsed.nums;
    gapCursor = 0;
    jumpToDataChunk(gapList[0]);
    showToast('已跳到分片 #' + gapList[0] + (gapList.length > 1 ? '（共 ' + gapList.length + ' 个缺口，点「下一缺口」）' : ''));
}

function jumpNextGap() {
    if (!gapList.length) {
        jumpToChunk();
        return;
    }
    gapCursor = (gapCursor + 1) % gapList.length;
    jumpToDataChunk(gapList[gapCursor]);
}

chunkJumpBtn.addEventListener('click', jumpToChunk);
document.getElementById('chunkJumpNextBtn').addEventListener('click', jumpNextGap);
chunkJumpInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        jumpToChunk();
    }
});

/** 一码一页：页码 = qrCodes 下标 */
function pageCount() {
    return Math.max(1, qrCodes.length);
}

function pageOfIndex(index) {
    return Math.max(0, Math.min(index | 0, Math.max(0, qrCodes.length - 1)));
}

function clearQRCanvasCache() {
    qrCanvasCache.clear();
    prerenderScheduled = false;
}

function buildQRCanvas(qrEntry) {
    const holder = document.createElement('div');
    const text = qrEntry.qrText || JSON.stringify(qrEntry.data);
    new QRCode(holder, {
        text,
        width: CONFIG.QR_SIZE,
        height: CONFIG.QR_SIZE,
        colorDark: '#000000',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.L
    });
    const src = holder.querySelector('canvas');
    if (!src) return null;
    const canvas = document.createElement('canvas');
    canvas.width = src.width;
    canvas.height = src.height;
    canvas.getContext('2d').drawImage(src, 0, 0);
    return canvas;
}

function getCachedQRCanvas(index) {
    let canvas = qrCanvasCache.get(index);
    if (canvas) return canvas;
    if (!qrCodes[index]) return null;
    canvas = buildQRCanvas(qrCodes[index]);
    if (canvas) qrCanvasCache.set(index, canvas);
    return canvas;
}

function pruneQRCanvasCache(center) {
    const total = qrCodes.length;
    if (!total) {
        qrCanvasCache.clear();
        return;
    }
    const keep = new Set();
    const c = Math.max(0, center | 0);
    for (let i = c - 2; i <= c + QR_PRERENDER_AHEAD; i++) {
        if (i >= 0 && i < total) keep.add(i);
    }
    for (const key of [...qrCanvasCache.keys()]) {
        if (!keep.has(key)) qrCanvasCache.delete(key);
    }
}

function schedulePrerenderAround(index) {
    if (prerenderScheduled || !qrCodes.length) return;
    prerenderScheduled = true;

    const run = () => {
        prerenderScheduled = false;
        if (!qrCodes.length) return;
        const start = Math.max(0, (index | 0) + 1);
        for (let i = start; i < Math.min(start + QR_PRERENDER_AHEAD, qrCodes.length); i++) {
            if (!qrCanvasCache.has(i)) {
                getCachedQRCanvas(i);
                prerenderScheduled = true;
                setTimeout(run, 0);
                return;
            }
        }
    };
    setTimeout(run, 0);
}

/** 确保指定帧已渲染；未命中缓存时同步生成，避免播放时卡顿 */
function ensureQRCanvasReady(index) {
    if (!qrCodes[index]) return null;
    return getCachedQRCanvas(index);
}

/** 展示单个二维码（一码一页） */
function showQRPage(pageIndex) {
    const pages = pageCount();
    const page = Math.max(0, Math.min(pageIndex, pages - 1));
    currentChunkIndex = page;

    let qrEl = document.getElementById('qrcode');
    if (!qrEl) {
        qrContainer.innerHTML = '<div id="qrcode"></div>';
        qrEl = document.getElementById('qrcode');
    }
    qrEl.className = 'qr-single';
    qrEl.style.gridTemplateColumns = '';
    while (qrEl.firstChild) qrEl.removeChild(qrEl.firstChild);

    const q = qrCodes[page];
    const isFn = q && q.type === CONFIG.PACKET_TYPES.FILENAME;
    qrContainer.className = isFn
        ? 'qr-container filename-qr'
        : 'qr-container data-qr';

    const cell = document.createElement('div');
    cell.className = 'qr-grid-cell';
    if (q) {
        const canvas = ensureQRCanvasReady(page);
        if (canvas) {
            const clone = document.createElement('canvas');
            clone.width = canvas.width;
            clone.height = canvas.height;
            clone.getContext('2d').drawImage(canvas, 0, 0);
            cell.appendChild(clone);
        }
    } else {
        cell.classList.add('empty');
    }
    qrEl.appendChild(cell);

    document.getElementById('qrCounter').textContent = `${page + 1} / ${pages}`;

    // 跳转高亮：当前数据分片匹配目标时描边
    if (isFn || !q || !q.data || (q.data.i + 1) !== highlightChunk1) {
        if (isFn) highlightChunk1 = 0;
    }

    updateJumpControls(currentChunkIndex);
    pruneQRCanvasCache(currentChunkIndex);
    schedulePrerenderAround(currentChunkIndex);
    applyTargetHighlight();
}

function showQRCode(index) {
    showQRPage(pageOfIndex(index));
}

// ===== 导航（按页） =====
function goPrevPage() {
    stopAutoplay();
    const p = pageOfIndex(currentChunkIndex);
    if (p > 0) showQRPage(p - 1);
}

function goNextPage() {
    stopAutoplay();
    const p = pageOfIndex(currentChunkIndex);
    if (p + 1 < pageCount()) showQRPage(p + 1);
}

document.getElementById('prevBtn').addEventListener('click', goPrevPage);
document.getElementById('nextBtn').addEventListener('click', goNextPage);
document.getElementById('stagePrevBtn').addEventListener('click', goPrevPage);
document.getElementById('stageNextBtn').addEventListener('click', goNextPage);

// ===== 整屏沉浸（占满显示器） =====
let qrImmersive = false;

function syncPlayButtons() {
    const label = isPlaying ? '⏸ 暂停' : '▶ 播放';
    playBtn.textContent = label;
    const stagePlay = document.getElementById('stagePlayBtn');
    if (stagePlay) stagePlay.textContent = isPlaying ? '⏸' : '▶';
    const fsBtn = document.getElementById('fullscreenBtn');
    if (fsBtn) fsBtn.textContent = qrImmersive ? '⛶ 退出整屏' : '⛶ 整屏展示';
}

async function enterQrImmersive() {
    if (!qrCodes.length) return;
    qrImmersive = true;
    document.body.classList.add('qr-immersive');
    syncPlayButtons();
    const stage = document.getElementById('qrStage');
    try {
        const req = stage && (stage.requestFullscreen || stage.webkitRequestFullscreen);
        if (req && !document.fullscreenElement) {
            await Promise.resolve(req.call(stage)).catch(() => {});
        }
    } catch (_) {}
}

async function exitQrImmersive() {
    qrImmersive = false;
    document.body.classList.remove('qr-immersive');
    syncPlayButtons();
    try {
        if (document.fullscreenElement && document.exitFullscreen) {
            await document.exitFullscreen().catch(() => {});
        }
    } catch (_) {}
}

function toggleQrImmersive() {
    if (qrImmersive) exitQrImmersive();
    else enterQrImmersive();
}

document.getElementById('fullscreenBtn').addEventListener('click', toggleQrImmersive);
document.getElementById('exitFullscreenBtn').addEventListener('click', exitQrImmersive);

document.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    const typing = tag === 'INPUT' || tag === 'TEXTAREA';
    if (e.key === 'Escape' && qrImmersive) {
        e.preventDefault();
        exitQrImmersive();
        return;
    }
    if (typing) return;
    if ((e.key === 'n' || e.key === 'N' || e.key === ']') && gapList.length) {
        e.preventDefault();
        jumpNextGap();
    }
});

document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && qrImmersive) {
        // 用户用系统 Esc 退出浏览器全屏时，同步退出沉浸样式
        qrImmersive = false;
        document.body.classList.remove('qr-immersive');
        syncPlayButtons();
    }
});

// ===== 自动播放 =====
const playBtn       = document.getElementById('playBtn');
const autoplayToggle = document.getElementById('autoplayToggle');
const autoplayStatus = document.getElementById('autoplayStatus');

playBtn.addEventListener('click', () => isPlaying ? stopAutoplay() : startAutoplay());
document.getElementById('stagePlayBtn').addEventListener('click', () => {
    isPlaying ? stopAutoplay() : startAutoplay();
});
autoplayToggle.addEventListener('change', () => autoplayToggle.checked ? startAutoplay() : stopAutoplay());

function clearAutoplayTimer() {
    if (autoplayTimer !== null) {
        clearTimeout(autoplayTimer);
        autoplayTimer = null;
    }
}

/** 按码播放：每间隔翻一个二维码 */
function scheduleNextAutoplay() {
    clearAutoplayTimer();
    if (!isPlaying || !qrCodes.length) return;

    schedulePrerenderAround(currentChunkIndex);

    autoplayTimer = setTimeout(() => {
        autoplayTimer = null;
        if (!isPlaying || !qrCodes.length) return;
        const next = currentChunkIndex + 1;
        if (next >= qrCodes.length) {
            stopAutoplay();
            showToast('播放完成');
            return;
        }
        ensureQRCanvasReady(next);
        showQRPage(next);
        scheduleNextAutoplay();
    }, CONFIG.AUTOPLAY_INTERVAL);
}

function startAutoplay() {
    if (!qrCodes.length) return;
    isPlaying = true;
    autoplayToggle.checked = true;
    autoplayStatus.textContent = '开启';
    syncPlayButtons();
    schedulePrerenderAround(currentChunkIndex);
    scheduleNextAutoplay();
}

function stopAutoplay() {
    isPlaying = false;
    autoplayToggle.checked = false;
    autoplayStatus.textContent = '关闭';
    syncPlayButtons();
    clearAutoplayTimer();
}

function restartAutoplay() {
    if (!isPlaying) return;
    scheduleNextAutoplay();
}

// ===== 下载 =====
document.getElementById('downloadCurrentBtn').addEventListener('click', () => {
    const canvas = qrContainer.querySelector('canvas');
    if (!canvas) { showToast('没有可下载的二维码'); return; }
    const isLast = currentChunkIndex === qrCodes.length - 1;
    const filename = isLast
        ? `qrcode_${fileFingerprint}_filename.png`
        : `qrcode_${fileFingerprint}_${String(currentChunkIndex + 1).padStart(3, '0')}.png`;
    canvas.toBlob(blob => { saveFile(blob, filename); showToast('已开始下载当前二维码'); }, 'image/png');
});

document.getElementById('downloadAllBtn').addEventListener('click', async () => {
    if (!qrCodes.length) return;
    if (typeof JSZip === 'undefined') { showStatus('status', 'ZIP 库未加载', 'error'); return; }

    const btn = document.getElementById('downloadAllBtn');
    const originalText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="loading"></span> 打包中...';
    showStatus('status', '正在打包所有二维码，请稍候...', 'info');

    try {
        const zip = new JSZip();
        const folder = zip.folder(`qrcodes_${fileFingerprint}`);

        // 用离屏 canvas 批量生成，不插入 DOM
        const offCanvas = document.createElement('canvas');
        offCanvas.width = CONFIG.QR_SIZE;
        offCanvas.height = CONFIG.QR_SIZE;

        for (let i = 0; i < qrCodes.length; i++) {
            const qr = qrCodes[i];
            const isFilename = qr.type === CONFIG.PACKET_TYPES.FILENAME;
            const tempDiv = document.createElement('div');

            new QRCode(tempDiv, {
                text: qr.qrText || JSON.stringify(qr.data),
                width: CONFIG.QR_SIZE,
                height: CONFIG.QR_SIZE,
                colorDark: '#000000',
                colorLight: '#ffffff',
                correctLevel: QRCode.CorrectLevel.L
            });

            await new Promise(resolve => setTimeout(resolve, 30));

            const cvs = tempDiv.querySelector('canvas');
            if (cvs) {
                const blob = await new Promise(resolve => cvs.toBlob(resolve, 'image/png'));
                const fname = isFilename
                    ? 'qrcode_filename.png'
                    : `qrcode_data_${String(qr.data.i + 1).padStart(3, '0')}.png`;
                folder.file(fname, blob);
            }

            if (i % 10 === 0) showStatus('status', `打包进度: ${i+1}/${qrCodes.length}`, 'info');
        }

        const content = await zip.generateAsync({ type: 'blob' });
        saveFile(content, `qrcodes_${fileFingerprint}.zip`);
        showStatus('status', `✅ 已生成 ${qrCodes.length} 个二维码`, 'success');
        showToast('ZIP 文件下载已开始');
    } catch (error) {
        showStatus('status', '打包失败: ' + error.message, 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = originalText;
    }
});

// ===== 重置 =====
resetBtn.addEventListener('click', () => {
    stopAutoplay();
    file = null; chunks = []; qrCodes = []; currentChunkIndex = 0;
    fileFingerprint = ''; originalFileName = ''; originalFileSize = 0;
    fileNameQrCode = null; hasGenerated = false;
    clearQRCanvasCache();

    fileInput.value = '';
    uploadArea.classList.remove('has-file');
    uploadArea.innerHTML = `
        <div class="upload-icon">📂</div>
        <div class="upload-text">点击或拖拽文件到此处</div>
        <div class="upload-hint">支持任意类型文件</div>
    `;

    fileInfo.style.display = 'none';
    exitQrImmersive();
    qrSection.classList.remove('show');
    downloadSection.classList.remove('show');
    generateBtn.disabled = true;

    chunkSizeSlider.value = DEFAULT_CHUNK_SIZE;
    chunkSizeValue.textContent = DEFAULT_CHUNK_SIZE + ' B';
    CONFIG.CHUNK_SIZE = DEFAULT_CHUNK_SIZE;

    document.getElementById('qrSizeSlider').value = DEFAULT_QR_SIZE;
    document.getElementById('qrSizeValue').textContent = DEFAULT_QR_SIZE + ' px';
    CONFIG.QR_SIZE = DEFAULT_QR_SIZE;

    document.getElementById('intervalInput').value = DEFAULT_AUTOPLAY_INTERVAL;
    document.getElementById('intervalAppliedValue').textContent = String(DEFAULT_AUTOPLAY_INTERVAL);
    CONFIG.AUTOPLAY_INTERVAL = DEFAULT_AUTOPLAY_INTERVAL;

    hideRegenerateHints();
    document.getElementById('estimatedChunks').textContent = '-- 个';
    document.getElementById('estimationBar').style.width = '0%';
    showStatus('status', '请选择一个文件开始', 'info');
    showToast('已重置');
});

// ===== 初始化 =====
window.addEventListener('load', () => {
    if (typeof QRCode === 'undefined') showStatus('status', 'QRCode 库未加载', 'error');
    if (typeof pako === 'undefined') showStatus('status', '压缩库未加载', 'error');
    showStatus('status', '请选择一个文件开始', 'info');
});
