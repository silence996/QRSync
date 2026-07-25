/* QRSync decode worker: ZXing-wasm + 可选 jsQR 兜底 */
/* global ZXingWASM, jsQR, importScripts */

importScripts('../js/jsQR.js');
importScripts('../js/zxing-wasm-reader.js');

let wasmReady = false;

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
        let text = null;
        const opts = options || { formats: ['QRCode'] };
        const allowJsQR = !!opts.allowJsQR;
        const zxingOpts = { ...opts };
        delete zxingOpts.allowJsQR;

        if (wasmReady) {
            try {
                const results = await ZXingWASM.readBarcodesFromImageData(
                    { data, width, height },
                    zxingOpts
                );
                if (results.length > 0) text = results[0].text;
            } catch (_) {}
        }

        // 相机连播默认跳过 jsQR：未识别帧上很慢，会占死 Worker 导致漏扫
        if (!text && allowJsQR) {
            text = decodeWithJsQR(data, width, height);
        }

        self.postMessage({ type: 'result', id, text }, [buffer]);
    }
};
