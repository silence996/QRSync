/* QRSync decode worker: ZXing-wasm + 可选 jsQR 兜底 */
/* global ZXingWASM, jsQR, importScripts */

importScripts('../js/jsQR.js');
importScripts('../js/zxing-wasm-reader.js');

let wasmReady = false;

function bytesToLatin1(bytes) {
    if (!bytes || !bytes.length) return null;
    const CHUNK = 0x8000;
    let s = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
        const end = Math.min(i + CHUNK, bytes.length);
        const slice = bytes.subarray ? bytes.subarray(i, end) : bytes.slice(i, end);
        s += String.fromCharCode.apply(null, slice);
    }
    return s;
}

function zxingResultToLatin1(result) {
    if (!result) return null;
    if (result.bytes && result.bytes.length) return bytesToLatin1(result.bytes);
    return result.text || null;
}

function decodeWithJsQR(data, width, height) {
    if (typeof jsQR !== 'function') return null;
    const r = jsQR(data, width, height, { inversionAttempts: 'dontInvert' });
    return r ? r.data : null;
}

self.onmessage = async (event) => {
    const msg = event.data;
    if (!msg || !msg.type) return;

    if (msg.type === 'init') {
        try {
            if (msg.wasmBinary && typeof ZXingWASM !== 'undefined') {
                ZXingWASM.setZXingModuleOverrides({ wasmBinary: msg.wasmBinary });
                await ZXingWASM.readBarcodesFromImageData(
                    { data: new Uint8ClampedArray(4), width: 1, height: 1 },
                    { formats: ['QRCode'] }
                );
                wasmReady = true;
            }
        } catch (_) {
            wasmReady = false;
        }
        self.postMessage({ type: 'ready', wasmReady });
        return;
    }

    if (msg.type === 'decode') {
        const { id, width, height, buffer, options } = msg;
        const data = new Uint8ClampedArray(buffer);
        let texts = [];
        const opts = options || { formats: ['QRCode'] };
        const allowJsQR = !!opts.allowJsQR;
        const zxingOpts = { ...opts };
        delete zxingOpts.allowJsQR;
        if (!zxingOpts.characterSet) zxingOpts.characterSet = 'BINARY';

        if (wasmReady) {
            try {
                const results = await ZXingWASM.readBarcodesFromImageData(
                    { data, width, height },
                    zxingOpts
                );
                if (results && results.length) {
                    for (let i = 0; i < results.length; i++) {
                        const t = zxingResultToLatin1(results[i]);
                        if (t) texts.push(t);
                    }
                }
            } catch (_) {}
        }

        // 相机连播默认跳过 jsQR：未识别帧上很慢；仅在无结果且允许时兜底单码
        if (!texts.length && allowJsQR) {
            const one = decodeWithJsQR(data, width, height);
            if (one) texts = [one];
        }

        self.postMessage(
            { type: 'result', id, text: texts[0] || null, texts },
            [buffer]
        );
    }
};
