/**
 * Origin Vault - 缩略图管理器
 * 负责生成和管理素材缩略图
 * 
 * v3.0: 缩略图现在保存到每个资源的独立文件夹中
 */

import { MODULE_ID, SETTINGS, STORAGE, THUMBNAIL, FILE_TYPES, THUMBNAIL_PROFILES } from '../constants.js';
import { WaveformManager } from './WaveformManager.js';
import { SceneRenderer } from '../ui/SceneRenderer.js';
import { browseFilePicker, createFilePickerDirectory, uploadWithFilePicker } from './filePicker.js';
import { ovDebug, ovLog } from './logger.js';
import { getWorldSceneId } from './worldSceneBindings.js';
import { createThumbnailRevision } from './thumbnailUrl.js';
// AssetData no longer needed for thumbnail saving logic

export const AUDIO_WAVEFORM_THUMBNAIL_VERSION = 6;

export class ThumbnailManager {
  /** @type {ThumbnailManager} */
  static #instance = null;

  static getInstance() {
    if (!ThumbnailManager.#instance) {
      ThumbnailManager.#instance = new ThumbnailManager();
    }
    return ThumbnailManager.#instance;
  }

  constructor() {
    if (ThumbnailManager.#instance) {
      throw new Error('ThumbnailManager is a singleton. Use ThumbnailManager.getInstance()');
    }

    /** @type {Map<string, Promise>} 正在生成的缩略图 */
    this.pendingThumbnails = new Map();
    this._ensuredDirs = new Set(); // 已确认存在的目录缓存, 避免重复 HTTP 检查
    this._verifiedCache = false;
  }

  /**
   * 获取当前配置的缓存源 ('data' 或 's3')
   */
  get cacheSource() {
    return game.settings.get(MODULE_ID, SETTINGS.CACHE_SOURCE) || 'data';
  }

  /**
   * 获取当前质量配置
   */
  get qualityProfile() {
    const key = game.settings.get(MODULE_ID, SETTINGS.THUMBNAIL_QUALITY) || 'medium';
    return THUMBNAIL_PROFILES[key] || THUMBNAIL_PROFILES.medium;
  }

  /**
   * 获取缓存根目录 (固定)
   */
  get cacheRoot() {
    return STORAGE.CACHE.ROOT_DEFAULT;
  }

  /**
   * 获取配置的 S3 Bucket
   */
  get s3Bucket() {
    return game.settings.get(MODULE_ID, SETTINGS.S3_BUCKET) || '';
  }

  /**
   * 获取当期活跃库ID
   */
  get activeLibraryId() {
    return game.settings.get(MODULE_ID, SETTINGS.ACTIVE_LIBRARY_ID) || 'default';
  }

  /**
   * 获取资源的缩略图路径 (返回完整 URL 或 路径)
   * @param {string} itemId - 资源 ID
   * @param {string} [libraryId] - 库 ID (默认使用当前库)
   * @returns {string} S3 URL 或 Data 路径
   */
  getAssetThumbnailPath(itemId, libraryId) {
    const libId = libraryId || this.activeLibraryId;
    const bucket = itemId.substring(0, STORAGE.CACHE.BUCKET_DEPTH).toLowerCase();
    const fileName = `${itemId}.webp`;

    // 路径结构: {root}/{libId}/{bucket}/{itemId}.webp
    // 注意: S3 路径通常不需要开头的 /，但 Data 路径可能需要。FilePicker 会处理。
    // 如果是 Data 源，返回相对路径；如果是 S3，可能需要返回完整 URL (但这里只构建保存路径，显示时根据 FilePicker 规则)

    // 简化: 统一返回相对路径结构。
    return `${this.cacheRoot}/${libId}/${bucket}/${fileName}`;
  }

  /**
   * 验证缓存目录是否存在
   */
  async verifyDirectory() {
    if (this._verifiedCache) return;

    // 如果是 S3
    if (this.cacheSource === 's3') {
      const options = this.s3Bucket ? { bucket: this.s3Bucket } : {};
      try {
        // 尝试浏览根目录
        await browseFilePicker('s3', this.cacheRoot, options);
        this._verifiedCache = true;
      } catch (e) {
        try {
          // 尝试创建目录
          await createFilePickerDirectory('s3', this.cacheRoot, options);
          this._verifiedCache = true;
        } catch (e2) {
          console.warn(`${MODULE_ID} | S3 Cache directory check warning:`, e2);
        }
      }
      return;
    }

    try {
      const root = this.cacheRoot;
      await this.ensureFolder(root);
      this._verifiedCache = true;
      ovLog(`${MODULE_ID} | Verified cache directory: ${root}`);
    } catch (err) {
      console.error(`${MODULE_ID} | Failed to verify cache directory:`, err);
    }
  }

  /**
   * 确保文件夹存在 (递归创建)
   * FilePicker.createDirectory 只能创建一层目录，所以需要逐层创建
   * @param {string} path 
   */
  async ensureFolder(path) {
    // 内存缓存: 已确认存在的目录直接跳过
    if (this._ensuredDirs.has(path)) return;

    // 先检查目录是否存在
    try {
      await browseFilePicker('data', path);
      this._ensuredDirs.add(path);
      return;
    } catch {
      // 目录不存在，需要创建
    }

    // 拆分路径，逐层创建
    const parts = path.split('/').filter(p => p);
    let currentPath = '';

    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;

      if (this._ensuredDirs.has(currentPath)) continue;

      try {
        await browseFilePicker('data', currentPath);
      } catch {
        try {
          await createFilePickerDirectory('data', currentPath);
        } catch (createError) {
          try {
            await browseFilePicker('data', currentPath);
          } catch {
            console.error(`${MODULE_ID} | Failed to create directory: ${currentPath}`, createError);
            throw createError;
          }
        }
      }
      this._ensuredDirs.add(currentPath);
    }

    this._ensuredDirs.add(path);
  }

  /**
   * 为素材生成缩略图
   * @param {object} item - 素材对象
   * @returns {Promise<string|null>} 缩略图路径/URL
   */
  async generateThumbnail(item, options = {}) {
    if (!item || typeof item.path !== 'string' || !item.path) return null;

    if (this.pendingThumbnails.has(item.id)) {
      return this.pendingThumbnails.get(item.id);
    }

    const promise = this._doGenerateThumbnail(item, options);
    this.pendingThumbnails.set(item.id, promise);

    try {
      return await promise;
    } finally {
      this.pendingThumbnails.delete(item.id);
    }
  }

  /**
   * 执行缩略图生成
   * @param {object} item 
   * @param {object} options - { skipFileSize: boolean }
   * @returns {Promise<string|null>}
   */
  async _doGenerateThumbnail(item, options = {}) {
    const ext = item.path.substring(item.path.lastIndexOf('.')).toLowerCase();
    const isVideo = FILE_TYPES.VIDEO.includes(ext);
    const isImage = FILE_TYPES.IMAGE.includes(ext);
    const isAudio = FILE_TYPES.AUDIO.includes(ext);

    // 检查是否为场景文件 (.json, .ov-scene) 或者是 Scene 类型
    const isScene = ext === '.json' || ext === '.ov-scene' || item.metadata?.type === 'scene' || !!item.metadata?.background?.src;

    if (!isVideo && !isImage && !isAudio && !isScene) {
      return null;
    }

    try {
      let thumbnailData;

      if (isImage) {
        thumbnailData = await this._generateImageThumbnail(item.path);
      } else if (isVideo) {
        thumbnailData = await this._generateVideoThumbnail(item.path);
      } else if (isAudio) {
        thumbnailData = await this._generateAudioThumbnail(item);
      } else if (isScene) {
        thumbnailData = await this._generateSceneThumbnail(item);
      }

      if (!thumbnailData) return null;

      const { data, width, height, duration, thumbnailVersion = 1 } = thumbnailData;

      // 批量模式下跳过文件大小获取 (节省 HTTP 调用)
      const fileSize = options.skipFileSize ? null : await this._getFileSize(item.path);

      // 保存缩略图
      const thumbnailPath = await this._saveThumbnail(item.id, data);

      return {
        path: thumbnailPath,
        width,
        height,
        duration: duration || null,
        fileSize: fileSize || null,
        thumbnailVersion,
        thumbnailRevision: createThumbnailRevision()
      };

    } catch (error) {
      console.error(`${MODULE_ID} | Failed to generate thumbnail for ${item.path}:`, error);
      return null;
    }
  }

  /**
   * 获取文件大小
   * @param {string} filePath
   * @returns {Promise<number|null>} 文件大小（字节）
   */
  async _getFileSize(filePath) {
    try {
      const response = await fetch(filePath, { method: 'HEAD' });
      if (response.ok) {
        const contentLength = response.headers.get('Content-Length');
        return contentLength ? parseInt(contentLength, 10) : null;
      }
      return null;
    } catch (error) {
      console.warn(`${MODULE_ID} | Failed to get file size for ${filePath}:`, error);
      return null;
    }
  }

  /**
   * 生成音频波形缩略图
   * @param {object} item
   * @returns {Promise<object>}
   */
  async _generateAudioThumbnail(item) {
    try {
      const waveformManager = WaveformManager.getInstance();
      const waveformResult = await waveformManager.getWaveform(item.path, item.id);

      // Handle both old (array) and new (object) return types
      const waveform = Array.isArray(waveformResult) ? waveformResult : (waveformResult?.waveform || []);
      const duration = waveformResult?.duration || 0;

      const quality = this.qualityProfile;
      const canvas = document.createElement('canvas');
      canvas.width = quality.width || 512;
      canvas.height = quality.height || 384;

      // 确保画布上有背景，即使波形为空
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#1a1a1a';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // 绘制波形 (使用 Eagle 风格的蓝色)
      if (waveform && waveform.length > 0) {
        waveformManager.drawWaveform(canvas, waveform, '#5b9bd5', { background: '#1a1a1a' });
      } else {
        // 如果波形为空，画一条水平线表示音频
        ctx.strokeStyle = '#5b9bd5';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(0, canvas.height / 2);
        ctx.lineTo(canvas.width, canvas.height / 2);
        ctx.stroke();
      }

      const data = canvas.toDataURL('image/webp', quality.quality);

      // 严格检查 dataURL
      if (!data || data === 'data:,' || data.length < 100) {
        throw new Error(`Invalid dataURL generated: ${data ? data.substring(0, 20) : 'empty'}`);
      }

      return {
        data,
        width: canvas.width,
        height: canvas.height,
        duration: duration,
        thumbnailVersion: AUDIO_WAVEFORM_THUMBNAIL_VERSION
      };
    } catch (error) {
      console.warn(`${MODULE_ID} | Failed to generate audio thumbnail for ${item.path}:`, error);
      return null;
    }
  }

  async _getSceneDataForThumbnail(item, ext) {
    const worldSceneId = item.worldSceneId || getWorldSceneId(item);
    if (worldSceneId) {
      const worldScene = game.scenes?.get(worldSceneId);
      if (worldScene) return worldScene.toObject();
    }

    if (ext === '.json' || ext === '.ov-scene') {
      const response = await fetch(item.path);
      if (response.ok) return response.json();
    }

    const uuid = item.uuid || item.metadata?.uuid;
    if (uuid) {
      try {
        const sceneDoc = await fromUuid(uuid);
        if (sceneDoc) return sceneDoc.toObject();
      } catch {
        // UUID 有时来自索引缓存，失败了还能继续用 packId + sceneId 兜底。
      }
    }

    const packId = item.folderId || item.metadata?.compendiumId || item.metadata?.folderId;
    const sceneId = item.sceneId || item.metadata?._id || item.metadata?.id || item.id;
    if (packId && sceneId) {
      try {
        const pack = game.packs?.get(packId);
        const sceneDoc = await pack?.getDocument(sceneId);
        if (sceneDoc) return sceneDoc.toObject();
      } catch {
        // 这里继续往下落到内联 sceneData，别让单个坏 pack 把缩略图任务打断。
      }
    }

    if (item.sceneData) return item.sceneData;
    if (item.metadata?.sceneData) return item.metadata.sceneData;

    if (item.metadata && (item.metadata.width || item.metadata.background || item.metadata.levels)) {
      return item.metadata;
    }

    return null;
  }

  /**
   * 生成场景缩略图 (完整渲染)
   * @param {object} item 
   * @returns {Promise<object>}
   */
  async _generateSceneThumbnail(item) {
    if (!item) return null;
    let container = null;
    let renderer = null;
    try {
      const ext = item.path.substring(item.path.lastIndexOf('.')).toLowerCase();
      const sceneData = await this._getSceneDataForThumbnail(item, ext);

      if (!sceneData) return null;

      // 2. 创建离屏容器 (必须在 DOM 中且有尺寸，否则 SceneRenderer 会跳过)
      container = document.createElement('div');
      container.className = 'thumbnail-generator-container';
      container.style.width = '100px';
      container.style.height = '100px';
      container.style.position = 'fixed';
      container.style.left = '-9999px';
      container.style.top = '-9999px';
      container.style.visibility = 'hidden';
      document.body.appendChild(container);

      // 3. 渲染
      const sceneLevelOptions = SceneRenderer.getDetailLevelOptions();
      renderer = new SceneRenderer(container, sceneData, {
        interactive: false,
        levelId: SceneRenderer.OVERVIEW_LEVEL_ID,
        ...sceneLevelOptions,
        mergeLegacyEntryRanges: !!sceneLevelOptions.includeLegacyLevels,
        minResolution: 400, // 确保最小 400px，SceneRenderer 会计算保持比例
        useSceneResolution: false
      });

      // 强制等待渲染完成
      await renderer.render(false);

      // 4. 捕获
      const canvas = renderer.canvas;
      if (!canvas || canvas.width === 0) throw new Error('Scene render failed (empty canvas)');

      const quality = this.qualityProfile;
      const data = canvas.toDataURL('image/webp', quality.quality);

      return {
        data,
        width: canvas.width,
        height: canvas.height
      };

    } catch (e) {
      console.warn(`${MODULE_ID} | Failed to generate scene thumbnail for ${item.path}:`, e);
      return null;
    } finally {
      renderer?.destroy();
      if (container && container.parentNode) {
        container.parentNode.removeChild(container);
      }
    }
  }

  /**
   * 生成图片缩略图
   * @param {string} imagePath 
   * @returns {Promise<string>} Base64 数据
   */
  async _generateImageThumbnail(imagePath) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';

      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d');

          // 计算目标尺寸，保持原始宽高比
          const quality = this.qualityProfile;
          const maxDim = Math.max(quality.width, quality.height);
          const scale = maxDim / Math.max(img.width, img.height);

          canvas.width = Math.round(img.width * scale);
          canvas.height = Math.round(img.height * scale);

          // 绘制图片 (充满画布，无白边)
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

          // 使用 image/webp 支持透明背景
          resolve({
            data: canvas.toDataURL('image/webp', quality.quality),
            width: img.width,
            height: img.height
          });
        } catch (error) {
          reject(error);
        }
      };

      img.onerror = () => {
        reject(new Error(`Failed to load image: ${imagePath}`));
      };

      img.src = imagePath;
    });
  }

  /**
   * 生成视频缩略图
   * @param {string} videoPath 
   * @returns {Promise<string>} Base64 数据
   */
  async _generateVideoThumbnail(videoPath) {
    return new Promise((resolve, reject) => {
      const video = document.createElement('video');
      // 只对外部 URL 设置 crossOrigin，本地文件不需要（会导致 canvas 污染）
      if (videoPath.startsWith('http://') || videoPath.startsWith('https://')) {
        video.crossOrigin = 'anonymous';
      }
      video.muted = true;
      video.playsInline = true;
      video.preload = 'auto';

      let timeoutId = null;
      let resolved = false;

      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        video.pause();
        video.onloadedmetadata = null;
        video.onloadeddata = null;
        video.onseeked = null;
        video.oncanplay = null;
        video.ontimeupdate = null;
        video.onerror = null;
        video.src = '';
        video.load();
      };

      timeoutId = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          cleanup();
          console.warn(`${MODULE_ID} | Timeout loading video for thumbnail: ${videoPath}`);
          reject(new Error(`Timeout loading video: ${videoPath}`));
        }
      }, 20000);

      const captureFrame = () => {
        if (resolved) return;

        try {
          if (video.videoWidth === 0 || video.videoHeight === 0) {
            console.warn(`${MODULE_ID} | Video dimensions are 0, cannot capture`);
            return;
          }

          video.pause();

          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d');

          const quality = this.qualityProfile;
          const maxDim = Math.max(quality.width, quality.height);
          const scale = maxDim / Math.max(video.videoWidth, video.videoHeight);

          canvas.width = Math.round(video.videoWidth * scale);
          canvas.height = Math.round(video.videoHeight * scale);

          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

          // 检查是否全黑 (采样中心像素)
          const centerX = Math.floor(canvas.width / 2);
          const centerY = Math.floor(canvas.height / 2);
          const pixel = ctx.getImageData(centerX, centerY, 1, 1).data;
          const isBlack = pixel[0] < 10 && pixel[1] < 10 && pixel[2] < 10;

          if (isBlack && video.currentTime < (video.duration || 10) * 0.9) {
            // 如果是黑屏且还没到结尾，尝试跳到更后面
            ovDebug(`${MODULE_ID} | Frame at ${video.currentTime}s is black, trying later...`);
            const nextTime = Math.min(video.currentTime + 2, (video.duration || 10) - 0.1);
            if (nextTime > video.currentTime) {
              video.currentTime = nextTime;
              return; // Will retry on next onseeked
            }
          }

          resolved = true;

          const result = {
            data: canvas.toDataURL('image/webp', quality.quality),
            width: video.videoWidth,
            height: video.videoHeight,
            duration: video.duration || 0
          };

          cleanup();
          resolve(result);
        } catch (error) {
          console.error(`${MODULE_ID} | Error capturing frame:`, error);
          resolved = true;
          cleanup();
          reject(error);
        }
      };

      video.onloadedmetadata = () => {
        if (resolved) return;

        let duration = video.duration;
        if (!Number.isFinite(duration)) duration = 10;

        // 计算 seek 目标时间
        const seekTime = Math.max(0.5, duration * 0.25);
        const targetTime = (duration < 1) ? 0.1 : Math.min(seekTime, duration - 0.5);

        ovDebug(`${MODULE_ID} | Video loaded: ${videoPath}, duration=${duration}, seeking to ${targetTime}s`);

        // 先播放一下，让浏览器解码
        video.play().then(() => {
          // 播放成功后暂停并 seek
          setTimeout(() => {
            if (resolved) return;
            video.pause();
            video.currentTime = targetTime;
          }, 100);
        }).catch(e => {
          // 自动播放被阻止，直接 seek
          ovLog(`${MODULE_ID} | Autoplay blocked, seeking directly`);
          video.currentTime = targetTime;
        });
      };

      video.onseeked = () => {
        if (resolved) return;
        ovDebug(`${MODULE_ID} | Seeked to ${video.currentTime}s`);

        // 等待一小段时间确保帧已解码
        setTimeout(() => {
          if (!resolved) captureFrame();
        }, 150);
      };

      video.onerror = (e) => {
        console.error(`${MODULE_ID} | Video error:`, video.error);
        if (!resolved) {
          resolved = true;
          cleanup();
          reject(new Error(`Failed to load video: ${videoPath}`));
        }
      };

      video.src = videoPath;
      video.load();
    });
  }

  /**
   * 绘制播放图标
   */
  _drawPlayIcon(ctx, centerX, centerY) {
    const radius = 20;

    // 圆形背景
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fill();

    // 播放三角形
    ctx.beginPath();
    ctx.moveTo(centerX - 6, centerY - 10);
    ctx.lineTo(centerX - 6, centerY + 10);
    ctx.lineTo(centerX + 10, centerY);
    ctx.closePath();
    ctx.fillStyle = 'white';
    ctx.fill();
  }

  /**
   * 在缩略图上绘制视频图标覆盖
   * @param {CanvasRenderingContext2D} ctx 
   * @param {number} width 
   * @param {number} height 
   */
  _drawVideoOverlay(ctx, width, height) {
    // 绘制半透明播放按钮
    const centerX = width / 2;
    const centerY = height / 2;
    const radius = 20;

    // 圆形背景
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fill();

    // 播放三角形
    ctx.fill();
  }

  /**
   * 保存缩略图到缓存
   * @param {string} itemId 
   * @param {string} dataUrl 
   * @returns {Promise<string>} 保存的文件路径 (相对路径或 URL)
   */
  async _saveThumbnail(itemId, dataUrl) {
    // 增加数据完整性检查
    if (!dataUrl || dataUrl === 'data:,' || typeof dataUrl !== 'string') {
      throw new Error(`Invalid data URL: ${dataUrl ? dataUrl.substring(0, 50) : 'empty'}`);
    }

    try {
      const targetPath = this.getAssetThumbnailPath(itemId);
      const fileName = targetPath.split('/').pop();
      const parentDir = targetPath.substring(0, targetPath.lastIndexOf('/'));

      // 1. 确保目录存在 (仅 Data 源)
      if (this.cacheSource !== 's3') {
        await this.ensureFolder(parentDir);
      }

      // 2. 用 fetch API 将 dataUrl 转为 Blob（比 atob + 逐字节循环快得多）
      const response = await fetch(dataUrl);
      const blob = await response.blob();
      const file = new File([blob], fileName, { type: blob.type });

      // Calculate options first
      const options = (this.cacheSource === 's3' && this.s3Bucket) ? { bucket: this.s3Bucket } : {};

      // 3. 上传文件
      const result = await uploadWithFilePicker(this.cacheSource, parentDir, file, options, { notify: false });

      // S3 upload returns {path: "https://..."}
      // Data upload returns {path: "origin-vault/_cache/..."}
      return result.path;
    } catch (error) {
      console.error(`${MODULE_ID} | Failed to save thumbnail:`, error);
      throw error;
    }
  }

  /**
   * 删除缩略图
   * @param {string} itemId 
   */
  async deleteThumbnail(itemId) {
    try {
      if (this.cacheSource === 's3') return;

      const path = this.getAssetThumbnailPath(itemId);
      const relativePath = path.replace(/^\//, '');

      // 尝试使用 fetch DELETE 请求删除文件
      const response = await fetch(`/${relativePath}`, { method: 'DELETE' });
      if (response.ok) {
        ovLog(`${MODULE_ID} | Deleted thumbnail: ${path}`);
      }
    } catch (e) {
      // 忽略删除失败，可能是文件不存在或权限问题
    }
  }

  /**
    * 清空缓存 (危险操作)
    */
  async clearCache() {
    // TODO: 实现清空逻辑
  }

  /**
   * 批量生成缩略图 (并行版本, 持久化元数据)
   * @param {object[]} items 
   * @param {function} onProgress - 进度回调 (current, total)
   * @param {LibraryData} library - 素材库实例 (用于持久化元数据)
   * @returns {Promise<number>} 成功生成的数量
   */
  async generateBatch(items, onProgress = () => { }, force = false, library = null) {
    let successCount = 0;
    const total = items.length;
    let processed = 0;
    const modifiedItems = [];

    // 分离音频和非音频: 音频解码极重, 需要低并发
    const audioExts = ['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac', '.wma'];
    const nonAudioItems = [];
    const audioItems = [];
    for (const item of items) {
      if (!force && item.thumbnailGenerated) {
        processed++;
        onProgress(processed, total);
        continue;
      }
      const ext = item.path?.substring(item.path.lastIndexOf('.')).toLowerCase() || '';
      if (audioExts.includes(ext)) {
        audioItems.push(item);
      } else {
        nonAudioItems.push(item);
      }
    }

    // 内部批处理函数
    const processBatch = async (batchItems, concurrency) => {
      for (let i = 0; i < batchItems.length; i += concurrency) {
        const batch = batchItems.slice(i, i + concurrency);

        const results = await Promise.allSettled(batch.map(async (item) => {
          try {
            const result = await this.generateThumbnail(item, { skipFileSize: true });
            if (result && result.path) {
              item.thumbnail = result.path;
              item.thumbnailGenerated = true;
              item.metadata = item.metadata || {};
              item.metadata.width = result.width;
              item.metadata.height = result.height;
              item.thumbnailVersion = result.thumbnailVersion || 1;
              item.thumbnailRevision = result.thumbnailRevision || createThumbnailRevision();
              modifiedItems.push(item);
              return 'generated';
            }
          } catch (error) {
            console.error(`${MODULE_ID} | Batch thumbnail error for ${item.id}:`, error);
          }
          return 'failed';
        }));

        for (const result of results) {
          processed++;
          if (result.status === 'fulfilled' && result.value === 'generated') {
            successCount++;
          }
        }

        onProgress(Math.min(processed, total), total);

        // 批量持久化元数据
        if (library && modifiedItems.length >= 10) {
          const toSave = modifiedItems.splice(0, modifiedItems.length);
          Promise.allSettled(toSave.map(it =>
            library._saveAssetMetadata(it.id, it).catch(() => { })
          ));
        }

        await new Promise(resolve => setTimeout(resolve, 0));
      }
    };

    // 先处理非音频项 (图片/视频/场景, 20并发, 缩略图文件很小)
    if (nonAudioItems.length > 0) {
      await processBatch(nonAudioItems, 20);
    }

    // 再处理音频项 (2并发, 避免内存爆炸)
    if (audioItems.length > 0) {
      await processBatch(audioItems, 2);
    }

    // 保存剩余未持久化的项
    if (library && modifiedItems.length > 0) {
      await Promise.allSettled(modifiedItems.map(it =>
        library._saveAssetMetadata(it.id, it).catch(() => { })
      ));
    }

    return successCount;
  }

  /**
   * 检查缩略图是否存在
   * @param {string} thumbnailPath 
   * @returns {Promise<boolean>}
   */
  async thumbnailExists(thumbnailPath) {
    if (!thumbnailPath) return false;

    try {
      const response = await fetch(thumbnailPath, { method: 'HEAD' });
      return response.ok;
    } catch {
      return false;
    }
  }
}
