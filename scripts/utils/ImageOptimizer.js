/**
 * Origin Vault - 图片格式优化器
 * 使用 Canvas API 将 PNG/JPEG/BMP 转换为 WebP 格式
 */

import { MODULE_ID } from '../constants.js';

// 可优化的图片格式
const OPTIMIZABLE_TYPES = [
    'image/png', 'image/jpeg', 'image/jpg', 'image/bmp', 'image/tiff'
];

// 不应转换的格式
const SKIP_TYPES = [
    'image/webp', 'image/svg+xml', 'image/gif' // GIF 可能含动画
];

export class ImageOptimizer {

    /**
     * 判断文件是否可优化
     * @param {File} file
     * @returns {boolean}
     */
    static canOptimize(file) {
        return OPTIMIZABLE_TYPES.includes(file.type);
    }

    /**
     * 判断文件是否为图片
     * @param {File} file
     * @returns {boolean}
     */
    static isImage(file) {
        return file.type?.startsWith('image/');
    }

    /**
     * 将图片文件转换为 WebP 格式
     * @param {File} file - 原始图片文件
     * @param {object} options
     * @param {number} options.quality - WebP 质量 (0-1), 默认 0.85
     * @param {number} options.maxWidth - 最大宽度 (0=不限制), 默认 0
     * @param {number} options.maxHeight - 最大高度 (0=不限制), 默认 0
     * @returns {Promise<{file: File, originalSize: number, optimizedSize: number, skipped: boolean}>}
     */
    static async optimize(file, options = {}) {
        const quality = options.quality ?? 0.85;
        const maxWidth = options.maxWidth ?? 0;
        const maxHeight = options.maxHeight ?? 0;

        // 不可优化的格式直接返回
        if (!this.canOptimize(file)) {
            return {
                file,
                originalSize: file.size,
                optimizedSize: file.size,
                skipped: true
            };
        }

        try {
            // 1. 加载图片到 ImageBitmap (比 Image 更高效)
            const bitmap = await createImageBitmap(file);

            // 2. 计算输出尺寸
            let { width, height } = bitmap;
            if (maxWidth > 0 && width > maxWidth) {
                height = Math.round(height * (maxWidth / width));
                width = maxWidth;
            }
            if (maxHeight > 0 && height > maxHeight) {
                width = Math.round(width * (maxHeight / height));
                height = maxHeight;
            }

            // 3. 绘制到 Canvas
            const canvas = new OffscreenCanvas(width, height);
            const ctx = canvas.getContext('2d');
            ctx.drawImage(bitmap, 0, 0, width, height);
            bitmap.close();

            // 4. 转换为 WebP Blob
            const blob = await canvas.convertToBlob({ type: 'image/webp', quality });

            // 5. 只有在优化后更小时才使用新文件
            if (blob.size >= file.size) {
                return {
                    file,
                    originalSize: file.size,
                    optimizedSize: file.size,
                    skipped: true
                };
            }

            // 6. 创建新 File 对象 (改扩展名为 .webp)
            const newName = file.name.replace(/\.[^.]+$/, '.webp');
            const newFile = new File([blob], newName, { type: 'image/webp' });

            return {
                file: newFile,
                originalSize: file.size,
                optimizedSize: newFile.size,
                skipped: false
            };
        } catch (error) {
            console.warn(`${MODULE_ID} | Image optimization failed for ${file.name}:`, error);
            return {
                file,
                originalSize: file.size,
                optimizedSize: file.size,
                skipped: true
            };
        }
    }

    /**
     * 批量优化
     * @param {File[]} files
     * @param {object} options
     * @param {function} onProgress - (current, total, fileName)
     * @returns {Promise<{files: Array, totalOriginal: number, totalOptimized: number}>}
     */
    static async optimizeBatch(files, options = {}, onProgress = () => { }) {
        const results = [];
        let totalOriginal = 0;
        let totalOptimized = 0;
        const CONCURRENCY = 3;

        for (let i = 0; i < files.length; i += CONCURRENCY) {
            const batch = files.slice(i, i + CONCURRENCY);
            const batchResults = await Promise.allSettled(
                batch.map(f => this.optimize(f, options))
            );

            for (const result of batchResults) {
                if (result.status === 'fulfilled') {
                    results.push(result.value);
                    totalOriginal += result.value.originalSize;
                    totalOptimized += result.value.optimizedSize;
                } else {
                    // 失败时返回原始文件
                    const originalFile = batch[results.length % batch.length];
                    results.push({
                        file: originalFile,
                        originalSize: originalFile.size,
                        optimizedSize: originalFile.size,
                        skipped: true
                    });
                }
            }

            onProgress(Math.min(i + CONCURRENCY, files.length), files.length);
        }

        return { files: results, totalOriginal, totalOptimized };
    }

    /**
     * 获取格式化的文件大小
     * @param {number} bytes
     * @returns {string}
     */
    static formatSize(bytes) {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    /**
     * 预估优化后的大小 (粗略估计)
     * @param {File} file
     * @returns {number} 预估字节数
     */
    static estimateOptimizedSize(file) {
        if (!this.canOptimize(file)) return file.size;
        // PNG → WebP 通常减少 60-80%
        if (file.type === 'image/png') return Math.round(file.size * 0.35);
        // JPEG → WebP 通常减少 25-35%
        if (file.type === 'image/jpeg' || file.type === 'image/jpg') return Math.round(file.size * 0.70);
        // BMP → WebP 大幅减少
        if (file.type === 'image/bmp') return Math.round(file.size * 0.1);
        return Math.round(file.size * 0.5);
    }
}
