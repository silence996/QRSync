/**
 * QRSync 解码 Worker（同帧半幅解码）
 * - 主线程传入左半幅或右半幅 ImageData
 * - 每半幅期望最多 1 个 QR（maxNumberOfSymbols: 1）
 * - 返回 UTF-8 文本（JSON 协议）
 * - 兼容 file://：由 Blob Worker 源码加载（见 decode-worker-source.js）
 */
/* eslint-disable no-undef */

importScripts('../js/jsQR.js');
importScripts('../js/zxing-wasm-reader.js');

let wasmReady = false;
let initPromise = null;

function initZXing(wasmBinary) {
    if (initPromise) return initPromise;
    initPromise = (async () => {
        try {
            if (wasmBinary) {
                ZXingWASM.setZXingModuleOverrides({ wasmBinary: wasmBinary });
            }
            await ZXingWASM.readBarcodesFromImageData(
                { data: new Uint8ClampedArray(4), width: 1, height: 1 },
                { formats: ['QRCode'] }
            );
            wasmReady = true;
            self.postMessage({ type: 'ready' });
        } catch (e) {
            wasmReady = false;
            self.postMessage({ type: 'error', message: 'Worker zxing init failed: ' + (e && e.message) });
        }
    })();
    return initPromise;
}

async function decodeZXing(imageData, opts) {
    if (!wasmReady) return null;
    try {
        const results = await ZXingWASM.readBarcodesFromImageData(imageData, {
            tryHarder: opts.tryHarder !== false,
            tryRotate: !!opts.tryRotate,
            tryInvert: !!opts.tryInvert,
            tryDownscale: false,
            maxNumberOfSymbols: 1,
            formats: ['QRCode']
        });
        if (!results || !results.length) return null;
        const text = results[0] && results[0].text;
        return text || null;
    } catch (e) {
        return null;
    }
}

function decodeJsQR(imageData) {
    try {
        if (typeof jsQR !== 'function') return null;
        const code = jsQR(imageData.data, imageData.width, imageData.height, {
            inversionAttempts: 'attemptBoth'
        });
        return code && code.data ? code.data : null;
    } catch (e) {
        return null;
    }
}

async function decodeImageData(imageData, opts) {
    let text = await decodeZXing(imageData, opts);
    if (!text) text = decodeJsQR(imageData);
    return text;
}

self.onmessage = async (ev) => {
    const msg = ev.data || {};
    if (msg.type === 'init') {
        await initZXing(msg.wasmBinary);
        return;
    }
    if (msg.type !== 'decode') return;

    const { id, width, height, buffer, options } = msg;
    const opts = options || {};
    try {
        const data = new Uint8ClampedArray(buffer);
        const imageData = { data: data, width: width, height: height };
        const text = await decodeImageData(imageData, {
            tryHarder: opts.tryHarder !== false,
            tryRotate: !!opts.tryRotate,
            tryInvert: !!opts.tryInvert
        });
        // 归还 buffer，便于主线程复用
        self.postMessage({ type: 'result', id: id, text: text || null }, [buffer]);
    } catch (e) {
        try {
            self.postMessage({ type: 'result', id: id, text: null, error: String(e && e.message || e) }, [buffer]);
        } catch (_) {
            self.postMessage({ type: 'result', id: id, text: null, error: String(e && e.message || e) });
        }
    }
};
