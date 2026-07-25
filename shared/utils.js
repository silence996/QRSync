// ===== 共享工具函数 =====

// CRC32 查找表（模块加载时一次性建立，避免每次重建）
const CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) {
            c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        }
        table[i] = c;
    }
    return table;
})();

function calculateCRC32(str) {
    if (typeof pako !== 'undefined' && pako.crc32) {
        return pako.crc32(str).toString(36).padStart(5, '0').slice(-5).toLowerCase();
    }
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < str.length; i++) {
        crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ str.charCodeAt(i)) & 0xFF];
    }
    return ((crc ^ 0xFFFFFFFF) >>> 0).toString(36).padStart(5, '0').slice(-5).toLowerCase();
}

function crc32Bytes(u8) {
    if (typeof pako !== 'undefined' && pako.crc32) {
        return (pako.crc32(u8) >>> 0);
    }
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < u8.length; i++) {
        crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ u8[i]) & 0xFF];
    }
    return ((crc ^ 0xFFFFFFFF) >>> 0);
}

// ===== Z85（比 Base64 更省空间：4 字节 → 5 字符）=====
const Z85_ENC = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-:+=^!/*?&<>()[]{}@%$#';
const Z85_DEC = (() => {
    const map = new Int16Array(128).fill(-1);
    for (let i = 0; i < Z85_ENC.length; i++) map[Z85_ENC.charCodeAt(i)] = i;
    return map;
})();

function z85Encode(bytes) {
    const pad = (4 - (bytes.length % 4)) % 4;
    const src = pad ? new Uint8Array(bytes.length + pad) : bytes;
    if (pad) src.set(bytes);
    const view = new DataView(src.buffer, src.byteOffset, src.byteLength);
    let out = '';
    for (let i = 0; i < src.length; i += 4) {
        let value = view.getUint32(i);
        const chars = new Array(5);
        for (let j = 0; j < 5; j++) {
            chars[4 - j] = Z85_ENC[value % 85];
            value = Math.floor(value / 85);
        }
        out += chars.join('');
    }
    return out;
}

function z85Decode(str) {
    if (str.length % 5 !== 0) throw new Error('Z85 长度无效');
    const out = new Uint8Array((str.length / 5) * 4);
    const view = new DataView(out.buffer);
    for (let i = 0, o = 0; i < str.length; i += 5, o += 4) {
        let value = 0;
        for (let j = 0; j < 5; j++) {
            const code = str.charCodeAt(i + j);
            const d = code < 128 ? Z85_DEC[code] : -1;
            if (d < 0) throw new Error('Z85 字符无效');
            value = value * 85 + d;
        }
        view.setUint32(o, value >>> 0);
    }
    return out;
}

/** Q2：文本 = "Q2" + z85(二进制包)（旧版兼容） */
const Q2_PREFIX = 'Q2';
const Q2_TYPE_DATA = 0;
const Q2_TYPE_FILENAME = 1;
/** Version 40 / L 最大字节数 */
const QR_MAX_BYTES_L40 = 2953;

function normalizeFingerprint(fp) {
    const s = String(fp || '');
    if (s.length === 5) return s;
    return (s + '00000').slice(0, 5);
}

/** Uint8Array → Latin-1 字符串（QR byte 模式；需配合已 patch 的 qrcode 库） */
function bytesToLatin1String(u8) {
    const CHUNK = 0x8000;
    let s = '';
    for (let i = 0; i < u8.length; i += CHUNK) {
        s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + CHUNK, u8.length)));
    }
    return s;
}

function latin1StringToBytes(s) {
    const u8 = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i) & 0xff;
    return u8;
}

function buildQ2DataBytes(index, total, fingerprint, payload) {
    const fp = normalizeFingerprint(fingerprint);
    const buf = new Uint8Array(20 + payload.length);
    const dv = new DataView(buf.buffer);
    dv.setUint8(0, Q2_TYPE_DATA);
    dv.setUint32(1, index >>> 0);
    dv.setUint32(5, total >>> 0);
    for (let i = 0; i < 5; i++) buf[9 + i] = fp.charCodeAt(i) & 0xff;
    dv.setUint32(14, crc32Bytes(payload));
    dv.setUint16(18, payload.length);
    buf.set(payload, 20);
    return buf;
}

function buildQ2FilenameBytes(fingerprint, filename, size, totalChunks, timestamp) {
    const fp = normalizeFingerprint(fingerprint);
    const nameBytes = new TextEncoder().encode(filename);
    const bodyLen = 20 + nameBytes.length;
    const packet = new Uint8Array(bodyLen + 4);
    const dv = new DataView(packet.buffer);
    dv.setUint8(0, Q2_TYPE_FILENAME);
    for (let i = 0; i < 5; i++) packet[1 + i] = fp.charCodeAt(i) & 0xff;
    dv.setUint32(6, size >>> 0);
    dv.setUint32(10, timestamp >>> 0);
    dv.setUint32(14, totalChunks >>> 0);
    dv.setUint16(18, nameBytes.length);
    packet.set(nameBytes, 20);
    dv.setUint32(bodyLen, crc32Bytes(packet.subarray(0, bodyLen)));
    return packet;
}

/** Q3：二进制包直接进 QR（Latin-1 往返） */
function packQ3DataChunk(index, total, fingerprint, payload) {
    return bytesToLatin1String(buildQ2DataBytes(index, total, fingerprint, payload));
}

function packQ3FilenameChunk(fingerprint, filename, size, totalChunks, timestamp) {
    return bytesToLatin1String(
        buildQ2FilenameBytes(fingerprint, filename, size, totalChunks, timestamp)
    );
}

function packQ2DataChunk(index, total, fingerprint, payload) {
    return Q2_PREFIX + z85Encode(buildQ2DataBytes(index, total, fingerprint, payload));
}

function packQ2FilenameChunk(fingerprint, filename, size, totalChunks, timestamp) {
    return Q2_PREFIX + z85Encode(
        buildQ2FilenameBytes(fingerprint, filename, size, totalChunks, timestamp)
    );
}

function unpackQ2Binary(raw) {
    if (!raw || raw.length < 1) throw new Error('Q2 包过短');
    const type = raw[0];
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);

    if (type === Q2_TYPE_DATA) {
        if (raw.length < 20) throw new Error('Q2 数据包过短');
        const index = dv.getUint32(1);
        const total = dv.getUint32(5);
        let fp = '';
        for (let i = 0; i < 5; i++) fp += String.fromCharCode(raw[9 + i]);
        const crc = dv.getUint32(14);
        const payloadLen = dv.getUint16(18);
        if (raw.length < 20 + payloadLen) throw new Error('Q2 载荷长度不匹配');
        const payload = raw.subarray(20, 20 + payloadLen);
        if (crc32Bytes(payload) !== crc) throw new Error('Q2 校验失败');
        return { type: 'data', i: index, t: total, f: fp, payload };
    }

    if (type === Q2_TYPE_FILENAME) {
        if (raw.length < 24) throw new Error('Q2 文件名包过短');
        let fp = '';
        for (let i = 0; i < 5; i++) fp += String.fromCharCode(raw[1 + i]);
        const size = dv.getUint32(6);
        const ts = dv.getUint32(10);
        const tc = dv.getUint32(14);
        const nameLen = dv.getUint16(18);
        const bodyLen = 20 + nameLen;
        if (raw.length < bodyLen + 4) throw new Error('Q2 文件名长度不匹配');
        const crc = dv.getUint32(bodyLen);
        if (crc32Bytes(raw.subarray(0, bodyLen)) !== crc) throw new Error('Q2 文件名校验失败');
        const nameBytes = raw.subarray(20, bodyLen);
        const filename = new TextDecoder('utf-8').decode(nameBytes);
        return { type: 'fn', f: fp, s: size, ts, tc, filename };
    }

    throw new Error('未知 Q2 类型');
}

function unpackQ2Packet(text) {
    if (!text || !text.startsWith(Q2_PREFIX)) return null;
    return unpackQ2Binary(z85Decode(text.slice(Q2_PREFIX.length)));
}

/** 自动识别 Q2 文本 / Q3 二进制 */
function unpackQRPacket(text) {
    if (!text) return null;
    if (text.startsWith(Q2_PREFIX)) return unpackQ2Packet(text.trim());
    try {
        return unpackQ2Binary(latin1StringToBytes(text));
    } catch (_) {
        return null;
    }
}

// 分块 base64 编码，避免大数组展开导致调用栈溢出
function uint8ArrayToBase64(uint8Array) {
    const CHUNK = 8192;
    let result = '';
    for (let i = 0; i < uint8Array.length; i += CHUNK) {
        result += String.fromCharCode(...uint8Array.subarray(i, i + CHUNK));
    }
    return btoa(result);
}

function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function generateShortFileId() {
    const timestamp = Date.now();
    const random = Math.floor(Math.random() * 46656);
    const combined = (timestamp % 60466176) * 1000 + random;
    return combined.toString(36).padStart(5, '0').slice(-5).toUpperCase();
}

function encodeFileName(filename) {
    try {
        return btoa(String.fromCharCode(...new TextEncoder().encode(filename)));
    } catch (e) {
        return btoa(unescape(encodeURIComponent(filename)));
    }
}

function decodeFileName(base64Name) {
    try {
        const binaryStr = atob(base64Name);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
        return new TextDecoder('utf-8').decode(bytes);
    } catch (e) {
        try { return decodeURIComponent(atob(base64Name)); } catch { return base64Name; }
    }
}

function readFileAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsArrayBuffer(file);
    });
}

function saveFile(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 100);
}

let _toastTimer = null;
function showToast(message, duration = 3000) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => toast.classList.remove('show'), duration);
}

function showStatus(elementId, message, type = 'info') {
    const el = document.getElementById(elementId);
    if (!el) return;
    el.textContent = message;
    el.className = 'status show ' + type;
}
