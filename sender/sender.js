// ===== 配置 =====
const CONFIG = {
    CHUNK_SIZE: 2200,
    QR_SIZE: 2000,
    QR_MAX_CAPACITY: 2953,
    AUTOPLAY_INTERVAL: 100,
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
    CONFIG.AUTOPLAY_INTERVAL = Math.max(100, Math.min(60000, isNaN(raw) ? 100 : raw));
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
        const qrText = packQ2DataChunk(i, totalChunks, fileFingerprint, chunkData);

        if (qrText.length > CONFIG.QR_MAX_CAPACITY) {
            const suggested = Math.max(200, Math.floor(CONFIG.CHUNK_SIZE / (qrText.length / CONFIG.QR_MAX_CAPACITY) * 0.8));
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
        qrText: packQ2FilenameChunk(
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
    showQRCode(0);

    generateBtn.disabled = false;
    generateBtn.innerHTML = '<span>生成二维码</span>';
    showToast('二维码生成完成');
    qrSection.scrollIntoView({ behavior: 'smooth' });
}

function updateJumpControls(index) {
    const total = qrCodes.length;
    chunkJumpInput.max = String(Math.max(total, 1));
    chunkJumpInput.value = String(index + 1);
}

function jumpToChunk() {
    const total = qrCodes.length;
    if (!total) return;
    const raw = parseInt(chunkJumpInput.value, 10);
    if (isNaN(raw) || raw < 1 || raw > total) return;
    stopAutoplay();
    showQRCode(raw - 1);
}

chunkJumpBtn.addEventListener('click', jumpToChunk);
chunkJumpInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') jumpToChunk();
});

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
    for (let d = -1; d <= QR_PRERENDER_AHEAD; d++) {
        keep.add((center + d + total) % total);
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
        const total = qrCodes.length;
        for (let d = 1; d <= QR_PRERENDER_AHEAD; d++) {
            const i = (index + d) % total;
            if (!qrCanvasCache.has(i)) {
                getCachedQRCanvas(i);
                if (d < QR_PRERENDER_AHEAD) {
                    prerenderScheduled = true;
                    setTimeout(run, 0);
                }
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

function showQRCode(index) {
    currentChunkIndex = index;
    const qrData = qrCodes[index];
    const isFilename = qrData.type === CONFIG.PACKET_TYPES.FILENAME;

    qrContainer.className = isFilename ? 'qr-container filename-qr' : 'qr-container data-qr';

    let qrEl = document.getElementById('qrcode');
    if (!qrEl) {
        qrContainer.innerHTML = '<div id="qrcode"></div>';
        qrEl = document.getElementById('qrcode');
    }

    const canvas = ensureQRCanvasReady(index);
    while (qrEl.firstChild) qrEl.removeChild(qrEl.firstChild);
    if (canvas) qrEl.appendChild(canvas);

    document.getElementById('qrCounter').textContent = `${index + 1} / ${qrCodes.length}`;

    const qrType = document.getElementById('qrType');
    if (isFilename) {
        qrType.textContent = '文件名分片';
    } else {
        const i = (qrData.data && qrData.data.i != null) ? qrData.data.i : index;
        const t = (qrData.data && qrData.data.t != null) ? qrData.data.t : chunks.length;
        qrType.textContent = `数据分片 ${i + 1}/${t}`;
    }
    qrType.className = 'qr-type ' + (isFilename ? 'filename' : 'data');
    document.getElementById('qrHint').textContent = isFilename ? '⚠️ 请最后扫描此二维码' : '请使用接收端扫描此二维码';

    updateJumpControls(index);
    pruneQRCanvasCache(index);
    schedulePrerenderAround(index);
}

// ===== 导航 =====
document.getElementById('prevBtn').addEventListener('click', () => {
    stopAutoplay();
    if (currentChunkIndex > 0) showQRCode(currentChunkIndex - 1);
});

document.getElementById('nextBtn').addEventListener('click', () => {
    stopAutoplay();
    if (currentChunkIndex < qrCodes.length - 1) showQRCode(currentChunkIndex + 1);
});

// ===== 自动播放 =====
const playBtn       = document.getElementById('playBtn');
const autoplayToggle = document.getElementById('autoplayToggle');
const autoplayStatus = document.getElementById('autoplayStatus');

playBtn.addEventListener('click', () => isPlaying ? stopAutoplay() : startAutoplay());
autoplayToggle.addEventListener('change', () => autoplayToggle.checked ? startAutoplay() : stopAutoplay());

function clearAutoplayTimer() {
    if (autoplayTimer !== null) {
        clearTimeout(autoplayTimer);
        autoplayTimer = null;
    }
}

/**
 * 自适应播放：固定展示 interval 后切换；
 * 若下一帧尚未预渲染完成，先生成再切，避免“空等 interval 却卡在编码”的双重等待。
 */
function scheduleNextAutoplay() {
    clearAutoplayTimer();
    if (!isPlaying || !qrCodes.length) return;

    const nextIndex = (currentChunkIndex + 1) % qrCodes.length;
    schedulePrerenderAround(currentChunkIndex);

    autoplayTimer = setTimeout(() => {
        autoplayTimer = null;
        if (!isPlaying || !qrCodes.length) return;

        // 就绪驱动：切换前确保下一帧 canvas 已就绪
        ensureQRCanvasReady(nextIndex);
        showQRCode(nextIndex);
        scheduleNextAutoplay();
    }, CONFIG.AUTOPLAY_INTERVAL);
}

function startAutoplay() {
    if (!qrCodes.length) return;
    isPlaying = true;
    playBtn.textContent = '⏸ 暂停';
    autoplayToggle.checked = true;
    autoplayStatus.textContent = '开启';
    // 启动时先预热后续几帧
    schedulePrerenderAround(currentChunkIndex);
    scheduleNextAutoplay();
}

function stopAutoplay() {
    isPlaying = false;
    playBtn.textContent = '▶ 播放';
    autoplayToggle.checked = false;
    autoplayStatus.textContent = '关闭';
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
    qrSection.classList.remove('show');
    downloadSection.classList.remove('show');
    generateBtn.disabled = true;

    chunkSizeSlider.value = 2200;
    chunkSizeValue.textContent = '2200 B';
    CONFIG.CHUNK_SIZE = 2200;

    document.getElementById('qrSizeSlider').value = 2000;
    document.getElementById('qrSizeValue').textContent = '2000 px';
    CONFIG.QR_SIZE = 2000;

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
