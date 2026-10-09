/**
 * Origin Vault - 声纹波形管理器
 * 负责生成和缓存音频文件的波形数据
 */

import { MODULE_ID } from '../constants.js';

const WAVEFORM_PEAK_COUNT = 4096;
const MAX_READS_PER_PEAK = 4096;
const MAX_WAVEFORM_CACHE_ENTRIES = 100;

export class WaveformManager {
    /** @type {WaveformManager} */
    static #instance = null;

    static getInstance() {
        if (!WaveformManager.#instance) {
            WaveformManager.#instance = new WaveformManager();
        }
        return WaveformManager.#instance;
    }

    constructor() {
        if (WaveformManager.#instance) {
            throw new Error('WaveformManager is a singleton. Use WaveformManager.getInstance()');
        }

        /** @type {AudioContext} */
        this.audioContext = null;

        /** @type {Map<string, Promise>} */
        this.pendingWaveforms = new Map();

        /** @type {Map<string, object>} 内存缓存 */
        this.cache = new Map();
    }

    /**
     * 初始化 AudioContext（由于浏览器策略，需要在用户交互后初始化）
     */
    _initAudioContext() {
        if (!this.audioContext) {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (this.audioContext.state === 'suspended') {
            this.audioContext.resume();
        }
    }

    /**
     * 获取音频波形数据
     * @param {string} url - 音频文件 URL
     * @param {string} itemId - 素材 ID
     * @returns {Promise<object>} 波形数据和音频时长
     */
    async getWaveform(url, itemId) {
        if (this.cache.has(itemId)) {
            const cached = this.cache.get(itemId);
            this._rememberWaveform(itemId, cached);
            return cached;
        }

        if (this.pendingWaveforms.has(itemId)) {
            return this.pendingWaveforms.get(itemId);
        }

        const promise = this._generateWaveform(url);
        this.pendingWaveforms.set(itemId, promise);

        try {
            const data = await promise;
            this._rememberWaveform(itemId, data);
            return data;
        } finally {
            this.pendingWaveforms.delete(itemId);
        }
    }

    _rememberWaveform(itemId, data) {
        if (!itemId || !data) return;

        // Map 的插入顺序就是 LRU 顺序，命中时删掉重插即可刷新位置。
        if (this.cache.has(itemId)) this.cache.delete(itemId);
        this.cache.set(itemId, data);

        while (this.cache.size > MAX_WAVEFORM_CACHE_ENTRIES) {
            const oldestKey = this.cache.keys().next().value;
            this.cache.delete(oldestKey);
        }
    }

    /**
     * 生成波形数据
     * @param {string} url 
     * @returns {Promise<object>}
     */
    async _generateWaveform(url) {
        try {
            this._initAudioContext();

            // 长音频先给网络读取多一点时间。真正重的是后面的解码和采样，
            // 这里太早超时只会生成一条假水平线。
            const FETCH_TIMEOUT_MS = 60000;
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

            let response;
            try {
                response = await fetch(url, { signal: controller.signal });
            } catch (e) {
                clearTimeout(timeoutId);
                if (e.name === 'AbortError') {
                    console.warn(`${MODULE_ID} | Waveform fetch timeout for ${url}`);
                    return { waveform: this._createEmptyPeakEnvelope(), duration: 0 };
                }
                throw e;
            }

            const arrayBuffer = await response.arrayBuffer();
            clearTimeout(timeoutId);

            const contentLength = Number(response.headers.get('Content-Length')) || arrayBuffer.byteLength || 0;
            const sizeMb = contentLength / (1024 * 1024);
            const decodeTimeoutMs = Math.min(180000, Math.max(30000, Math.round(sizeMb * 1500)));

            // decodeAudioData 对 1 小时 BGM 会明显慢，按文件大小给自适应超时。
            const audioBuffer = await Promise.race([
                this.audioContext.decodeAudioData(arrayBuffer),
                new Promise((_, reject) => setTimeout(() => reject(new Error('decode timeout')), decodeTimeoutMs))
            ]);

            const waveform = this._extractPeakEnvelope(audioBuffer, WAVEFORM_PEAK_COUNT);

            return {
                waveform,
                duration: audioBuffer.duration
            };

        } catch (error) {
            console.warn(`${MODULE_ID} | Failed to generate waveform for ${url}:`, error);
            return {
                waveform: this._createEmptyPeakEnvelope(),
                duration: 0
            };
        }
    }

    _createEmptyPeakEnvelope(samples = WAVEFORM_PEAK_COUNT) {
        return {
            format: 'minmax-peaks',
            length: samples,
            peaks: new Float32Array(samples * 2)
        };
    }

    _extractPeakEnvelope(audioBuffer, samples = WAVEFORM_PEAK_COUNT) {
        if (!audioBuffer?.length || !audioBuffer.numberOfChannels) {
            return this._createEmptyPeakEnvelope(samples);
        }

        const frameCount = audioBuffer.length;
        const channels = [];
        for (let channel = 0; channel < audioBuffer.numberOfChannels; channel++) {
            channels.push(audioBuffer.getChannelData(channel));
        }

        const rawPeaks = new Float32Array(samples * 2);
        const peakMagnitudes = new Float32Array(samples);

        for (let i = 0; i < samples; i++) {
            const start = Math.floor((i / samples) * frameCount);
            const end = Math.max(start + 1, Math.floor(((i + 1) / samples) * frameCount));
            const stride = Math.max(1, Math.floor((end - start) / MAX_READS_PER_PEAK));
            let min = 0;
            let max = 0;

            for (const channelData of channels) {
                for (let frame = start; frame < end; frame += stride) {
                    const value = channelData[frame] || 0;
                    if (value < min) min = value;
                    if (value > max) max = value;
                }
            }

            const peakIndex = i * 2;
            rawPeaks[peakIndex] = min;
            rawPeaks[peakIndex + 1] = max;
            peakMagnitudes[i] = Math.max(Math.abs(min), Math.abs(max));
        }

        const gain = this._calculateDisplayGain(peakMagnitudes);
        const peaks = new Float32Array(samples * 2);

        for (let i = 0; i < rawPeaks.length; i++) {
            peaks[i] = Math.max(-1, Math.min(1, rawPeaks[i] * gain));
        }

        return {
            format: 'minmax-peaks',
            length: samples,
            peaks
        };
    }

    _calculateDisplayGain(peakMagnitudes) {
        const values = Array.from(peakMagnitudes).filter(value => value > 0).sort((a, b) => a - b);
        if (!values.length) return 1;

        const referenceIndex = Math.min(values.length - 1, Math.floor(values.length * 0.995));
        const referencePeak = values[referenceIndex] || 1;
        if (referencePeak >= 0.62) return 1;

        // 只轻微拉起偏安静的素材，别把已经很满的 BGM 再归一化成一块实心砖。
        return Math.min(1.8, 0.62 / Math.max(referencePeak, 0.0001));
    }

    /**
     * 在 Canvas 上绘制波形
     * @param {HTMLCanvasElement} canvas 
     * @param {number[]|object} data - 可以是旧波形数组、min/max peaks 或包含 {waveform} 的对象
     * @param {string} color 
     */
    drawWaveform(canvas, data, color = '#5b9bd5', options = {}) {
        if (!canvas || !data) return;

        const waveform = this._resolveWaveformData(data);
        if (!waveform || waveform.length === 0) return;

        const ctx = canvas.getContext('2d');
        const width = canvas.width;

        const height = canvas.height;
        if (options.background) {
            ctx.fillStyle = options.background;
            ctx.fillRect(0, 0, width, height);
        } else {
            ctx.clearRect(0, 0, width, height);
        }
        const centerY = height / 2;
        const horizontalPadding = Math.min(Math.max(width * 0.025, 6), 18);
        const verticalPadding = Math.min(Math.max(height * 0.11, 8), 28);
        const drawWidth = Math.max(1, width - (horizontalPadding * 2));
        const amplitudeScale = Math.max(1, ((height - (verticalPadding * 2)) / 2) * 0.92);
        const columns = Math.max(1, Math.min(Math.round(drawWidth), waveform.length));

        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.globalAlpha = options.opacity ?? 0.9;
        ctx.beginPath();

        for (let column = 0; column < columns; column++) {
            const start = Math.floor((column / columns) * waveform.length);
            const end = Math.max(start + 1, Math.floor(((column + 1) / columns) * waveform.length));
            const range = this._getPeakRange(waveform, start, end);
            const x = horizontalPadding + ((column + 0.5) / columns) * drawWidth;
            let top = centerY - (Math.max(0, range.max) * amplitudeScale);
            let bottom = centerY - (Math.min(0, range.min) * amplitudeScale);

            if (bottom - top < 1) {
                top = centerY - 0.5;
                bottom = centerY + 0.5;
            }

            ctx.moveTo(x, top);
            ctx.lineTo(x, bottom);
        }

        ctx.stroke();
        ctx.restore();
    }

    _resolveWaveformData(data) {
        const source = data?.waveform ?? data;
        if (source?.format === 'minmax-peaks' && source.peaks) {
            return {
                type: 'minmax',
                peaks: source.peaks,
                length: source.length || Math.floor(source.peaks.length / 2)
            };
        }

        if (Array.isArray(source) || ArrayBuffer.isView(source)) {
            return {
                type: 'legacy',
                values: source,
                length: source.length
            };
        }

        return null;
    }

    _getPeakRange(waveform, start, end) {
        if (waveform.type === 'minmax') {
            let min = 0;
            let max = 0;
            const limit = Math.min(end, waveform.length);
            for (let i = start; i < limit; i++) {
                const peakIndex = i * 2;
                const lower = waveform.peaks[peakIndex] || 0;
                const upper = waveform.peaks[peakIndex + 1] || 0;
                if (lower < min) min = lower;
                if (upper > max) max = upper;
            }
            return { min, max };
        }

        let peak = 0;
        const limit = Math.min(end, waveform.length);
        for (let i = start; i < limit; i++) {
            peak = Math.max(peak, Math.abs(waveform.values[i] || 0));
        }
        return { min: -peak, max: peak };
    }

}
