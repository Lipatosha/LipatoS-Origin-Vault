// 未来的我：别再用 jQuery ($) 了！所有 DOM 操作用原生 API
// 现有的 $() 调用是历史债务，重构时逐步干掉
/**
 * MediaPreviewMixin - 媒体预览/悬停预览系统
 * 从 MainWindow 提取的媒体播放、音频波形、悬停放大等方法
 * 
 * 包含：视频/音频预览、波形绘制、悬停缩放、场景渲染器
 * 混入后通过 this 访问 MainWindow 实例状态
 */

import { MODULE_ID, FILE_TYPES, RARITY_COLORS } from '../../constants.js';
import { WaveformManager } from '../../utils/WaveformManager.js';
import { hasTranslation, t } from '../../utils/i18n.js';
import { SceneRenderer } from '../SceneRenderer.js';
import { escapeActorDisplayText, getActorPreviewMeta } from '../../utils/actorDisplay.js';

/**
 * 将媒体预览方法混入目标类
 * @param {Function} cls - 目标类 (MainWindow)
 */
export function applyMediaPreviewMixin(cls) {

  cls.prototype._bindAssetPreviewBadges = function (cards, {
    resolveItem = id => this.library.getItem(id),
    onOpen = item => this._openQuickLook(item.id, item),
    tags = () => this.library.getAllTags()
  } = {}) {
    cards.find('.ov-preview-badge').off('.ovCardPreview')
      .on('click.ovCardPreview', event => {
        event.stopPropagation();
        const item = resolveItem(event.currentTarget.closest('.asset-card').dataset.itemId);
        if (item) onOpen(item);
      })
      .on('mouseenter.ovCardPreview', event => {
        const item = resolveItem(event.currentTarget.closest('.asset-card').dataset.itemId);
        if (item) {
          this._showHoverZoom(item.id, item, tags(item));
          this._updateHoverZoomPosition(event);
        }
      })
      .on('mousemove.ovCardPreview', event => this._updateHoverZoomPosition(event))
      .on('mouseleave.ovCardPreview', () => this._hideHoverZoom());
  };

  cls.prototype._initHoverScrubbing = function (html, { resolveItem = id => this.library.getItem(id), onSelect = (...args) => this._onItemClick(...args), comparison = false } = {}) {
    let currentMedia = null; // Video or Audio element
    const cards = html.find(comparison ? '.ov-compare-card' : '.asset-card:not(.ov-compare-card)');
    cards.off('.scrub');

    cards.on('mouseenter.scrub', (e) => {
      const card = e.currentTarget;
      const itemId = card.dataset.itemId;
      const item = resolveItem(itemId);
      if (!item) return;

      const ext = item.path.substring(item.path.lastIndexOf('.')).toLowerCase();
      const isVideo = FILE_TYPES.VIDEO.includes(ext);
      const isAudio = FILE_TYPES.AUDIO.includes(ext);

      if (!isVideo && !isAudio) return;

      // 立即显示 (移除延迟)
      const thumbnail = card.querySelector('.asset-thumbnail');
      if (!thumbnail) return;
      if (card.querySelector('.asset-hover-media')) return; // Already exists

      let mediaEl;
      let hud;
      let playhead; // Audio: Current playback position
      let hoverLine; // Audio: Mouse hover position
      let progressBar; // Video: Progress bar
      let unplayedOverlay; // Audio: Gray overlay for unplayed part
      let scrubEnabled = false; // 视频播放后才允许拖动进度

      // VIDEO Logic
      if (isVideo) {
        mediaEl = document.createElement('video');
        mediaEl.className = 'asset-hover-media asset-hover-video'; // unified class
        mediaEl.src = item.path;
        mediaEl.muted = true;
        mediaEl.loop = true;
        mediaEl.preload = 'metadata'; // 只预加载元数据，减少性能开销
        mediaEl.currentTime = 0; // 强制从头开始
        mediaEl.style.opacity = '0'; // 初始隐藏，避免闪烁
        mediaEl.style.transition = 'opacity 0.15s ease'; // 平滑过渡

        // 保存引用用于检查
        const videoRef = mediaEl;

        // 视频准备好后再显示（避免闪烁）
        mediaEl.addEventListener('canplay', () => {
          // 检查视频是否仍在 DOM 中（防止鼠标已离开时触发）
          if (!document.body.contains(videoRef)) return;

          // 强制从头开始
          videoRef.currentTime = 0;
          videoRef.style.opacity = '1';
          // 隐藏缩略图，避免透明视频穿帮
          const thumbImg = thumbnail.querySelector('img');
          if (thumbImg) thumbImg.style.visibility = 'hidden';

          // 延迟启用拖动进度（300ms后才允许拖动）
          setTimeout(() => { scrubEnabled = true; }, 300);
        }, { once: true });

        thumbnail.appendChild(mediaEl);

        // Progress Bar
        progressBar = document.createElement('div');
        progressBar.className = 'ov-video-progress';
        progressBar.innerHTML = '<div class="ov-video-progress-fill"></div>';
        thumbnail.appendChild(progressBar);

        // Real-time progress update for Video
        mediaEl.addEventListener('timeupdate', () => {
          if (!mediaEl.duration || isNaN(mediaEl.duration)) return;
          const pct = (mediaEl.currentTime / mediaEl.duration) * 100;

          const fill = progressBar.querySelector('.ov-video-progress-fill');
          if (fill) fill.style.width = pct + '%';

          // Update HUD
          if (hud) {
            const timeSpan = hud.querySelector('.ov-time');
            if (timeSpan) timeSpan.textContent = this._formatVideoTime(mediaEl.currentTime);
          }
        });
      }
      // AUDIO Logic
      else if (isAudio) {
        mediaEl = document.createElement('audio');
        mediaEl.className = 'asset-hover-media'; // Hidden by default CSS or style
        mediaEl.style.display = 'none';
        mediaEl.src = item.path;
        mediaEl.loop = true;
        thumbnail.appendChild(mediaEl);

        // 1. Playhead (Current Time) - White solid line
        playhead = document.createElement('div');
        playhead.className = 'ov-audio-playhead';
        playhead.style.left = '0%';
        thumbnail.appendChild(playhead);

        // 2. Hover Line (Mouse Position) - Faint dashed line
        hoverLine = document.createElement('div');
        hoverLine.className = 'ov-audio-hover-line';
        hoverLine.style.left = '0%';
        thumbnail.appendChild(hoverLine);

        // 3. Unplayed Overlay - Gray mask over unplayed part
        unplayedOverlay = document.createElement('div');
        unplayedOverlay.className = 'ov-audio-unplayed-overlay';
        unplayedOverlay.style.left = '0%'; // Initially covers everything
        thumbnail.appendChild(unplayedOverlay);
      }

      currentMedia = mediaEl;

      // HUD (Common)
      hud = document.createElement('div');
      hud.className = 'ov-video-hud'; // Reuse video HUD style
      hud.innerHTML = `<span class="ov-time">0:00.00</span>`;
      thumbnail.appendChild(hud);

      // Real-time progress update for Audio
      if (isAudio && playhead) {
        mediaEl.addEventListener('timeupdate', () => {
          if (!mediaEl.duration || isNaN(mediaEl.duration)) return;
          const pct = (mediaEl.currentTime / mediaEl.duration) * 100;

          // Update Playhead
          playhead.style.left = pct + '%';

          // Update Unplayed Overlay (reveals blue waveform as it moves right)
          if (unplayedOverlay) unplayedOverlay.style.left = pct + '%';

          // Update HUD with current time
          const timeSpan = thumbnail.querySelector('.ov-time');
          if (timeSpan) timeSpan.textContent = this._formatVideoTime(mediaEl.currentTime);
        });
      }

      // Play
      // Play (视频显示由 canplaythrough 事件处理)
      const playPromise = mediaEl.play();
      if (playPromise) {
        playPromise.catch(() => { /* Auto-play blocked */ });
      }

      // Mouse Move Interaction
      $(card).on('mousemove.scrub', (ev) => {
        if (!currentMedia || isNaN(currentMedia.duration)) return;

        // 视频：在启用前完全跳过处理
        if (isVideo && !scrubEnabled) return;

        const rect = card.getBoundingClientRect();
        const x = ev.clientX - rect.left;
        const pct = Math.max(0, Math.min(1, x / rect.width));
        const hoverTime = currentMedia.duration * pct;

        // UI Updates
        if (isVideo) {
          // For video, we seek immediately (scrubbing)
          if (Math.abs(currentMedia.currentTime - hoverTime) > 0.1) {
            currentMedia.currentTime = hoverTime;
          }
          const timeSpan = hud.querySelector('.ov-time');
          if (timeSpan) timeSpan.textContent = this._formatVideoTime(hoverTime);
        }
        else if (isAudio) {
          // Audio: Move hover line ONLY
          if (hoverLine) {
            hoverLine.style.display = 'block';
            hoverLine.style.left = (pct * 100) + '%';
          }
          const timeSpan = hud.querySelector('.ov-time');
          if (timeSpan) timeSpan.textContent = this._formatVideoTime(hoverTime);
        }
      });

      // Click interaction for Audio (Jump to position)
      if (isAudio) {
        $(thumbnail).on('click.scrub', (ev) => {
          // Trigger item selection before stopping propagation,
          // so clicking an audio card also selects it.
          const cardEl = ev.currentTarget.closest('.asset-card');
          if (cardEl && typeof this._onItemClick === 'function') {
            const clickItemId = cardEl.dataset.itemId;
            if (clickItemId) {
              onSelect(clickItemId, ev.ctrlKey || ev.metaKey, ev.shiftKey);
            }
          }

          ev.stopPropagation();
          ev.preventDefault();

          if (!currentMedia || isNaN(currentMedia.duration)) return;

          const rect = thumbnail.getBoundingClientRect();
          const x = ev.clientX - rect.left;
          const pct = Math.max(0, Math.min(1, x / rect.width));
          const seekTime = currentMedia.duration * pct;

          currentMedia.currentTime = seekTime;
          if (playhead) playhead.style.left = (pct * 100) + '%';
        });

        $(card).on('mouseleave.hoverline', () => {
          if (hoverLine) hoverLine.style.display = 'none';
        });
      }

    }).on('mouseleave.scrub', (e) => {
      const card = e.currentTarget;
      const thumbnail = card.querySelector('.asset-thumbnail');

      $(card).off('mousemove.scrub');
      // Unbind from thumbnail if it exists
      if (thumbnail) $(thumbnail).off('click.scrub');

      $(card).off('click.scrub'); // Legacy cleanup
      $(card).off('mouseleave.hoverline');

      // Cleanup elements
      const toRemove = [
        '.asset-hover-media',
        '.ov-video-hud',
        '.ov-video-progress',
        '.ov-audio-playhead',
        '.ov-audio-hover-line',
        '.ov-audio-unplayed-overlay',
        '.ov-audio-scrubber',
        '.ov-audio-progress-fill'
      ];

      toRemove.forEach(selector => {
        const el = card.querySelector(selector);
        if (el) {
          if (el.tagName === 'AUDIO' || el.tagName === 'VIDEO') el.pause();
          el.remove();
        }
      });

      // 恢复缩略图可见性
      const thumbImg = thumbnail?.querySelector('img');
      if (thumbImg) thumbImg.style.visibility = '';

      currentMedia = null;
    });
  }

  // [已移至文件末尾，此处为早期重复定义，已清理]

  /**
   * 初始化视频预加载系统
   * 使用 IntersectionObserver 预加载可见视频卡片
   */
  cls.prototype._initVideoPreloading = function (html) {
    // 清理旧的观察器
    if (this.videoPreloadObserver) {
      this.videoPreloadObserver.disconnect();
    }

    // 清理旧的缓存（保留最近 20 个）
    if (this.videoPreloadCache.size > 20) {
      const keys = Array.from(this.videoPreloadCache.keys());
      for (let i = 0; i < keys.length - 20; i++) {
        const video = this.videoPreloadCache.get(keys[i]);
        if (video) {
          video.src = '';
          video.load();
        }
        this.videoPreloadCache.delete(keys[i]);
      }
    }

    // 创建观察器
    this.videoPreloadObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const card = entry.target;
          const itemId = card.dataset.itemId;
          const item = this.library.getItem(itemId);
          if (!item) return;

          const ext = item.path.substring(item.path.lastIndexOf('.')).toLowerCase();
          const isVideo = FILE_TYPES.VIDEO.includes(ext);

          if (isVideo && !this.videoPreloadCache.has(itemId)) {
            // 创建隐藏的预加载视频元素
            const preloadVideo = document.createElement('video');
            preloadVideo.src = item.path;
            preloadVideo.preload = 'metadata';
            preloadVideo.muted = true;
            preloadVideo.style.display = 'none';

            // 存入缓存
            this.videoPreloadCache.set(itemId, preloadVideo);

            // 开始加载
            preloadVideo.load();
          }
        }
      });
    }, {
      root: html.find('.asset-grid')[0],
      rootMargin: '200px', // 提前 200px 开始预加载
      threshold: 0
    });

    // 观察所有视频卡片
    html.find('.asset-card:not(.ov-compare-card)').each((i, card) => {
      const itemId = card.dataset.itemId;
      const item = this.library.getItem(itemId);
      if (!item || typeof item.path !== 'string' || !item.path) return;

      const ext = item.path.substring(item.path.lastIndexOf('.')).toLowerCase();
      if (FILE_TYPES.VIDEO.includes(ext)) {
        this.videoPreloadObserver.observe(card);
      }
    });
  }

  // ==================== 媒体预览逻辑 ====================

  cls.prototype._playMediaPreview = function (cardEl, path, type) {
    let mediaEl = cardEl.querySelector(type);

    if (!mediaEl) {
      // 动态创建媒体元素
      const container = cardEl.querySelector('.asset-thumbnail');

      // 隐藏缩略图（防止重叠）
      const thumbnail = container.querySelector('img');
      if (thumbnail) {
        thumbnail.style.opacity = '0';
      }
      const placeholder = container.querySelector('.thumbnail-placeholder');
      if (placeholder) {
        placeholder.style.opacity = '0';
      }

      mediaEl = document.createElement(type);
      mediaEl.src = path;
      mediaEl.muted = true;
      mediaEl.autoplay = true;
      mediaEl.loop = true;
      mediaEl.style.position = 'absolute';
      mediaEl.style.top = '0';
      mediaEl.style.left = '0';
      mediaEl.style.width = '100%';
      mediaEl.style.height = '100%';
      mediaEl.style.objectFit = 'contain'; // 视频使用 contain
      mediaEl.style.zIndex = '10';
      mediaEl.style.background = '#000';

      if (type === 'audio') {
        mediaEl.style.visibility = 'hidden'; // 音频不可见，只播放
      }

      container.appendChild(mediaEl);
    } else {
      mediaEl.play().catch(() => { });
    }
  }

  cls.prototype._stopMediaPreview = function (cardEl, type) {
    const mediaEl = cardEl.querySelector(type);
    if (mediaEl) {
      mediaEl.pause();
      mediaEl.currentTime = 0;
      // 移除动态创建的元素
      mediaEl.remove();

      // 恢复缩略图显示
      const container = cardEl.querySelector('.asset-thumbnail');
      const thumbnail = container?.querySelector('img');
      if (thumbnail) {
        thumbnail.style.opacity = '1';
      }
      const placeholder = container?.querySelector('.thumbnail-placeholder');
      if (placeholder) {
        placeholder.style.opacity = '1';
      }

      // 隐藏进度条
      const progress = cardEl.querySelector('.ov-inline-progress-bar');
      if (progress) progress.style.width = '0%';
    }
  }

  cls.prototype._scrubMediaPreview = function (cardEl, event) {
    const mediaEl = cardEl.querySelector('video') || cardEl.querySelector('audio');
    if (!mediaEl || !mediaEl.duration) return;

    const rect = cardEl.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const percent = Math.min(Math.max(x / rect.width, 0), 1);

    mediaEl.currentTime = percent * mediaEl.duration;

    // 更新进度条
    const progressBar = cardEl.querySelector('.ov-inline-progress-bar');
    if (progressBar) {
      progressBar.style.width = `${percent * 100}%`;
    }
  }

  cls.prototype._drawWaveforms = async function (root = this.element, resolveItem = id => this.library.getItem(id)) {
    const containers = $(root).find('.ov-waveform-container').filter((i, node) => root !== this.element || !node.closest('.ov-compare-card'));
    const manager = WaveformManager.getInstance();
    const dpr = window.devicePixelRatio || 1;

    for (const container of containers) {
      const itemId = container.dataset.itemId;
      const canvas = container.querySelector('.ov-waveform-canvas');
      const item = resolveItem(itemId);

      if (item && canvas) {
        const rect = container.getBoundingClientRect();
        // 确保最小尺寸，防止窗口模式下容器太小导致 canvas 消失
        const cssWidth = Math.max(Math.round(rect.width), 60);
        const cssHeight = Math.max(Math.round(rect.height), 30);
        // 使用 devicePixelRatio 缩放，确保高分屏不模糊
        const targetWidth = Math.round(cssWidth * dpr);
        const targetHeight = Math.round(cssHeight * dpr);
        const needsResize = canvas.width !== targetWidth || canvas.height !== targetHeight;

        // 尺寸未变化且该 item 已绘制，跳过重复绘制
        if (!needsResize && canvas.dataset.waveformDrawnFor === itemId) {
          continue;
        }

        if (needsResize) {
          canvas.width = targetWidth;
          canvas.height = targetHeight;
          // CSS 尺寸保持原始像素，canvas 内部分辨率更高
          canvas.style.width = `${cssWidth}px`;
          canvas.style.height = `${cssHeight}px`;
        }

        try {
          const result = await manager.getWaveform(item.path, itemId);
          const data = Array.isArray(result) ? result : result.waveform;
          manager.drawWaveform(canvas, data);
          canvas.dataset.waveformDrawnFor = itemId;
        } catch (e) {
          console.warn('Waveform draw failed:', e);
        }
      }
    }
  }

  cls.prototype._drawDetailsWaveform = async function () {
    const container = $(this.element).find('.audio-details-player .ov-waveform-container')[0];
    if (!container) return;

    const canvas = container.querySelector('canvas');
    const itemId = container.dataset.itemId;
    const item = this.library.getItem(itemId);

    if (!item || !canvas) return;

    // Setup Canvas
    const rect = container.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;

    const manager = WaveformManager.getInstance();

    try {
      // Get Waveform & Duration
      const result = await manager.getWaveform(item.path, itemId);
      const data = Array.isArray(result) ? result : result.waveform;

      // Draw blue waveform
      manager.drawWaveform(canvas, data, '#5b9bd5');

      // Setup Interactive Elements (Playhead, Overlay)
      // Ensure they exist
      let playhead = container.querySelector('.ov-audio-playhead');
      if (!playhead) {
        playhead = document.createElement('div');
        playhead.className = 'ov-audio-playhead';
        playhead.style.left = '0%';
        container.appendChild(playhead);
      }

      let unplayedOverlay = container.querySelector('.ov-audio-unplayed-overlay');
      if (!unplayedOverlay) {
        unplayedOverlay = document.createElement('div');
        unplayedOverlay.className = 'ov-audio-unplayed-overlay';
        unplayedOverlay.style.left = '0%';
        container.appendChild(unplayedOverlay);
      }

      // Init Player Logic
      this._initAudioPlayerLogic(container, item);

    } catch (e) {
      console.warn('Details waveform draw failed:', e);
    }
  }

  cls.prototype._initAudioPlayerLogic = function (container, item) {
    const playerContainer = container.closest('.audio-details-player');
    const audioEl = playerContainer.querySelector('.details-audio-el');
    const playBtn = playerContainer.querySelector('.btn-audio-play');
    const timeDisplay = playerContainer.querySelector('.audio-time');
    const playhead = container.querySelector('.ov-audio-playhead');
    const unplayedOverlay = container.querySelector('.ov-audio-unplayed-overlay');

    if (!audioEl) return;

    // 1. Play/Pause Click
    $(playBtn).off('click').on('click', () => {
      if (audioEl.paused) {
        audioEl.play();
        playBtn.innerHTML = '<i class="fas fa-pause"></i>';
      } else {
        audioEl.pause();
        playBtn.innerHTML = '<i class="fas fa-play"></i>';
      }
    });

    // 2. Time Update
    $(audioEl).off('timeupdate').on('timeupdate', () => {
      if (!audioEl.duration) return;
      const pct = (audioEl.currentTime / audioEl.duration) * 100;

      if (playhead) playhead.style.left = `${pct}%`;
      if (unplayedOverlay) unplayedOverlay.style.left = `${pct}%`;

      const cur = this._formatVideoTime(audioEl.currentTime);
      const total = this._formatVideoTime(audioEl.duration);
      if (timeDisplay) timeDisplay.textContent = `${cur} / ${total}`;
    });

    // 3. Ended
    $(audioEl).off('ended').on('ended', () => {
      playBtn.innerHTML = '<i class="fas fa-play"></i>';
      audioEl.currentTime = 0;
      // Reset visuals? Or keep at end? usually correct to reset visual if loop is off. 
      // If loop is on (default for preview often), it won't fire ended usually.
      // Let's assume loop off for details player or handle it. 
      // Template didn't specify loop. 
    });

    // 4. Scrubbing (Click on waveform)
    $(container).off('click').on('click', (ev) => {
      ev.stopPropagation(); // prevent closing or other issues
      const rect = container.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const pct = Math.max(0, Math.min(1, x / rect.width));

      if (audioEl.duration) {
        audioEl.currentTime = audioEl.duration * pct;
      }

      // Immediate visual update
      if (playhead) playhead.style.left = `${pct * 100}%`;
      if (unplayedOverlay) unplayedOverlay.style.left = `${pct * 100}%`;
    });
  }

  cls.prototype._drawPreviewWaveform = async function (container) {
    if (!container) return;
    const canvas = container.querySelector('.audio-fullscreen-waveform');
    const itemId = container.dataset.itemId;
    const item = this.library.getItem(itemId);

    if (!item || !canvas) return;

    // Set canvas size to fill container
    const rect = container.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height - 60; // 60px for controls bar

    const manager = WaveformManager.getInstance();
    try {
      const result = await manager.getWaveform(item.path, itemId);
      const data = Array.isArray(result) ? result : result.waveform;
      manager.drawWaveform(canvas, data, '#5b9bd5');

      // Setup Audio Logic for Fullscreen Preview
      this._initAudioPreviewLogic(container, item);
    } catch (e) {
      console.warn('Error drawing preview waveform:', e);
    }
  }

  cls.prototype._initAudioPreviewLogic = function (container, item) {
    const audioEl = container.querySelector('.audio-fullscreen-el');
    const playBtn = container.querySelector('.btn-audio-play-fullscreen');
    const timeDisplay = container.querySelector('.audio-fullscreen-time');
    const playhead = container.querySelector('.audio-fullscreen-playhead');
    const unplayedOverlay = container.querySelector('.audio-fullscreen-unplayed');
    const canvas = container.querySelector('.audio-fullscreen-waveform');

    if (!audioEl) return;

    // 1. Play/Pause Click
    $(playBtn).off('click').on('click', () => {
      if (audioEl.paused) {
        audioEl.play();
        playBtn.innerHTML = '<i class="fas fa-pause"></i>';
      } else {
        audioEl.pause();
        playBtn.innerHTML = '<i class="fas fa-play"></i>';
      }
    });

    // 2. Time Update & Visual Progress
    $(audioEl).off('timeupdate').on('timeupdate', () => {
      if (!audioEl.duration) return;
      const pct = (audioEl.currentTime / audioEl.duration) * 100;

      // Update playhead position
      if (playhead) playhead.style.left = `${pct}%`;
      // Update unplayed overlay (everything after current position)
      if (unplayedOverlay) unplayedOverlay.style.left = `${pct}%`;

      // Update time display
      const cur = this._formatVideoTime(audioEl.currentTime);
      const total = this._formatVideoTime(audioEl.duration);
      if (timeDisplay) timeDisplay.textContent = `${cur} / ${total}`;
    });

    // 3. Ended - Reset to beginning
    $(audioEl).off('ended').on('ended', () => {
      playBtn.innerHTML = '<i class="fas fa-play"></i>';
      audioEl.currentTime = 0;
      if (playhead) playhead.style.left = '0%';
      if (unplayedOverlay) unplayedOverlay.style.left = '0%';
    });

    // 4. Click on waveform to seek
    $(canvas).off('click').on('click', (ev) => {
      ev.stopPropagation();
      const rect = canvas.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const pct = Math.max(0, Math.min(1, x / rect.width));

      if (audioEl.duration) {
        audioEl.currentTime = audioEl.duration * pct;
      }

      // Immediate visual update
      if (playhead) playhead.style.left = `${pct * 100}%`;
      if (unplayedOverlay) unplayedOverlay.style.left = `${pct * 100}%`;
    });

    // 5. Loaded metadata - update total time
    $(audioEl).off('loadedmetadata').on('loadedmetadata', () => {
      const total = this._formatVideoTime(audioEl.duration);
      if (timeDisplay) timeDisplay.textContent = `0:00 / ${total}`;
    });
  }

  // ==================== 悬停放大 (Hover Zoom) ====================

  cls.prototype._showHoverZoom = function (itemId, item = this.library.getItem(itemId), tags = this.library.getAllTags()) {
    if (!item) return;

    const ext = '.' + item.path.split('.').pop().toLowerCase();
    const isScene = ext === '.ov-scene' || item.metadata?.type === 'scene';
    const isItemType = item.metadata?.type === 'item';
    const isActorType = item.metadata?.type === 'actor';

    // 支持图片、场景、物品和角色
    if (!isScene && !isItemType && !isActorType && !FILE_TYPES.IMAGE.includes(ext)) return;

    clearTimeout(this._hoverZoomRemoveTimer);
    // 创建或获取容器
    let zoomer = document.querySelector('.ov-hover-zoomer');
    if (!zoomer) {
      zoomer = document.createElement('div');
      zoomer.className = 'ov-hover-zoomer';
      document.body.appendChild(zoomer);
    }

    zoomer._ovAsset = item;
    // 销毁旧的悬停渲染器
    if (this._hoverSceneRenderer) {
      this._hoverSceneRenderer.destroy();
      this._hoverSceneRenderer = null;
    }

    if (isScene) {
      // 场景类型：使用 Canvas 渲染
      zoomer.innerHTML = '<div class="hover-scene-container" style="width: 100%; height: 100%;"></div>';
      zoomer.classList.add('active');

      // 异步初始化场景渲染器
      this._initHoverSceneRenderer(zoomer.querySelector('.hover-scene-container'), item);
    } else if (isActorType) {
      // 角色悬停只看立绘，别把原生角色卡再做一遍。
      zoomer.innerHTML = '<div style="padding: 16px; color: #999;"><i class="fas fa-spinner fa-spin"></i> Loading...</div>';
      zoomer.style.width = 'auto';
      zoomer.style.maxWidth = '70vw';
      zoomer.style.maxHeight = '80vh';
      zoomer.style.overflow = 'hidden';
      zoomer.style.overflowY = '';
      zoomer.style.pointerEvents = 'none';
      zoomer.classList.add('active');

      this._renderHoverActorCard(zoomer, item);
    } else if (isItemType) {
      // 物品类型：渲染小卡片
      zoomer.innerHTML = '<div style="padding: 16px; color: #999;"><i class="fas fa-spinner fa-spin"></i> Loading...</div>';
      zoomer.style.width = '480px';
      zoomer.style.maxHeight = '80vh';
      zoomer.style.overflow = 'hidden';
      zoomer.style.overflowY = 'auto';
      zoomer.style.pointerEvents = 'auto'; // 允许滚轮滚动长描述
      zoomer.classList.add('active');

      // 异步加载物品卡片
      this._renderHoverItemCard(zoomer, item, tags);
    } else {
      // 图片类型
      zoomer.innerHTML = `<img src="${item.path}" alt="${item.displayName}">`;
      zoomer.offsetHeight; // 强制重绘
      zoomer.classList.add('active');
    }
  }

  /**
   * 异步渲染悬停预览的物品卡片
   */
  cls.prototype._renderHoverItemCard = async function (zoomer, item, allTags = this.library.getAllTags()) {
    try {
      const uuid = item.metadata?.uuid || item.uuid;
      let description = '';
      let itemName = item.displayName || item.name;
      let itemType = item.metadata?.itemType || 'item';
      let imgSrc = item.path || item.thumbnail;

      if (uuid) {
        const worldItem = game.items?.find(i =>
          i.flags?.core?.sourceId === uuid ||
          i._stats?.compendiumSource === uuid
        );
        if (worldItem) {
          description = worldItem.system?.description?.value || '';
          itemName = worldItem.name || itemName;
          if (worldItem.img) imgSrc = worldItem.img;
        } else {
          const doc = await fromUuid(uuid);
          if (doc) {
            description = doc.system?.description?.value || '';
            itemName = doc.name || itemName;
            if (doc.img) imgSrc = doc.img;
          }
        }
      }

      let enrichedDesc = description;
      if (typeof TextEditor !== 'undefined' && TextEditor.enrichHTML) {
        enrichedDesc = await TextEditor.enrichHTML(description, { async: true });
      }

      const typeLabel = hasTranslation(`TYPES.Item.${itemType}`)
        ? t(`TYPES.Item.${itemType}`)
        : itemType.charAt(0).toUpperCase() + itemType.slice(1);

      // 切换卡片后，不让先前文档的异步结果盖住当前预览。
      if (!zoomer.classList.contains('active') || zoomer._ovAsset !== item) return;

      // 获取该物品的 OV 标签
      const itemTagIds = item.tags || [];
      let tagsHtml = '';
      if (itemTagIds.length > 0) {
        const tagPills = itemTagIds.map(tagId => {
          const tag = allTags[tagId];
          if (!tag) return '';
          return `<span style="display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 10px;
            font-weight: 600; background: ${tag.color}22; color: ${tag.color}; border: 1px solid ${tag.color}44;
            margin: 2px 3px 2px 0;">${tag.name}</span>`;
        }).filter(Boolean).join('');
        tagsHtml = `<div style="margin-top: 8px; display: flex; flex-wrap: wrap;">${tagPills}</div>`;
      }

      // 稀有度角标颜色（从 metadata 读取，不依赖系统类型）
      let hoverBadgeBg = 'rgba(138, 92, 246, 0.3)';
      let hoverBadgeColor = '#b88cff';
      const rarity = item.metadata?.rarity || '';
      const rarityColor = rarity ? (RARITY_COLORS[rarity] || '') : '';
      if (rarityColor) {
        hoverBadgeBg = rarityColor + '40';
        hoverBadgeColor = rarityColor;
      }

      zoomer.innerHTML = `
        <div style="padding: 16px;">
          <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px;">
            <img src="${imgSrc}" alt="${itemName}"
              style="width: 48px; height: 48px; border-radius: 6px; object-fit: cover; border: 1px solid rgba(255,255,255,0.1);" />
            <div>
              <div style="font-size: 15px; font-weight: 700; color: #eee;">${itemName}</div>
              <span style="display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px;
                font-weight: 600; background: ${hoverBadgeBg}; color: ${hoverBadgeColor}; margin-top: 2px;">${typeLabel}</span>
            </div>
          </div>
          ${tagsHtml}
          ${enrichedDesc ? `
          <div style="padding: 12px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.06);
            border-radius: 6px; font-size: 13px; line-height: 1.6; color: #ccc; margin-top: 8px;
            max-height: calc(80vh - 140px); overflow-y: auto;">
            ${enrichedDesc}
          </div>` : ''}
        </div>
      `;
    } catch (err) {
      console.warn('Hover item card render failed:', err);
      zoomer.innerHTML = `<div style="padding: 16px; text-align: center; color: #999;">
        <i class="fas fa-scroll fa-2x"></i>
        <p style="margin-top: 8px;">${item.displayName || item.name}</p>
      </div>`;
    }
  }

  /**
   * 异步渲染悬停预览的角色立绘
   */
  cls.prototype._renderHoverActorCard = async function (zoomer, item) {
    try {
      const uuid = item.metadata?.uuid || item.uuid;
      let actorDoc = null;

      if (uuid) {
        const worldActor = game.actors?.find(a =>
          a.flags?.core?.sourceId === uuid ||
          a._stats?.compendiumSource === uuid
        );
        if (worldActor) {
          actorDoc = worldActor;
        } else {
          actorDoc = await fromUuid(uuid);
        }
      }

      if (!zoomer.classList.contains('active')) return;

      if (zoomer._ovAsset !== item) return;
      const actorMeta = getActorPreviewMeta(item, actorDoc);
      const actorName = escapeActorDisplayText(actorMeta.name);
      const actorImage = escapeActorDisplayText(actorMeta.imgSrc);
      const actorRace = escapeActorDisplayText(actorMeta.race);
      const actorCr = escapeActorDisplayText(actorMeta.cr);
      const dndMetaHtml = actorMeta.isDnd5e && (actorMeta.race || actorMeta.cr)
        ? `<div style="position: absolute; left: 10px; top: 10px; display: flex; gap: 5px; flex-wrap: wrap;">
            ${actorMeta.race ? `<span style="display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 700; background: rgba(0,0,0,0.62); color: #f2e7d2;">${actorRace}</span>` : ''}
            ${actorMeta.cr ? `<span style="display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 700; background: rgba(0,0,0,0.62); color: #f2e7d2;">CR ${actorCr}</span>` : ''}
          </div>`
        : '';

      zoomer.innerHTML = `
        <div style="position: relative;">
          <img src="${actorImage}" alt="${actorName}"
            style="display: block; max-width: 70vw; max-height: 80vh; object-fit: contain; border-radius: 8px; border: 1px solid rgba(255,255,255,0.12);" />
          ${dndMetaHtml}
        </div>
      `;
    } catch (err) {
      console.warn('Hover actor card render failed:', err);
      zoomer.innerHTML = `<div style="padding: 16px; text-align: center; color: #999;">
        <i class="fas fa-users fa-2x"></i>
        <p style="margin-top: 8px;">${item.displayName || item.name}</p>
      </div>`;
    }
  }

  /**
   * 初始化悬停预览的场景渲染器
   * 使用固定的最大尺寸，根据场景比例自适应
   */
  cls.prototype._initHoverSceneRenderer = async function (container, item) {
    if (!container) return;

    try {
      const sceneDetail = {
        uuid: item.metadata?.uuid,
        id: item.id,
        folderId: item.metadata?.compendiumId,
        sceneData: item.sceneData,
        metadata: item.metadata
      };

      const sceneData = await this._getFullSceneData(sceneDetail);
      if (!container.isConnected || !container.closest('.active')) return;
      if (!sceneData) {
        container.innerHTML = '<div style="color: #999; text-align: center; padding: 20px;">Failed to load scene</div>';
        return;
      }

      // 使用最大边长逻辑：限制最长边为 MAX_EDGE，保持场景比例
      const MAX_EDGE = 1260; // 最大边长（可在未来添加设置让用户自定义）
      const sceneWidth = sceneData.width || 1000;
      const sceneHeight = sceneData.height || 1000;
      const aspectRatio = sceneWidth / sceneHeight;

      let containerWidth, containerHeight;
      if (sceneWidth >= sceneHeight) {
        // 宽图：宽边受限
        containerWidth = Math.min(MAX_EDGE, sceneWidth);
        containerHeight = Math.round(containerWidth / aspectRatio);
      } else {
        // 高图：高边受限
        containerHeight = Math.min(MAX_EDGE, sceneHeight);
        containerWidth = Math.round(containerHeight * aspectRatio);
      }

      // 确保不超过视口的 85%
      const maxViewportWidth = window.innerWidth * 0.85;
      const maxViewportHeight = window.innerHeight * 0.85;
      if (containerWidth > maxViewportWidth) {
        const scale = maxViewportWidth / containerWidth;
        containerWidth = Math.round(containerWidth * scale);
        containerHeight = Math.round(containerHeight * scale);
      }
      if (containerHeight > maxViewportHeight) {
        const scale = maxViewportHeight / containerHeight;
        containerWidth = Math.round(containerWidth * scale);
        containerHeight = Math.round(containerHeight * scale);
      }

      // 直接设置容器尺寸（覆盖 CSS）
      container.style.width = `${containerWidth}px`;
      container.style.height = `${containerHeight}px`;

      // 创建渲染器 - 不使用 useSceneResolution，使用容器尺寸
      const renderer = new SceneRenderer(container, sceneData, {
        interactive: false,
        showWalls: false,
        showLights: false,
        levelId: SceneRenderer.getDefaultLevelId(sceneData)
        // 不设置 useSceneResolution，使用默认的容器尺寸 * dpr
      });

      this._hoverSceneRenderer = renderer;
      // 延迟一帧确保 DOM 更新
      await new Promise(r => requestAnimationFrame(r));

      const rect = container.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 && this._hoverSceneRenderer === renderer) {
        await renderer.render();
      }
      // 鼠标离开时资源可能还在加载，完成后仍要释放旧预览。
      if (this._hoverSceneRenderer !== renderer || !container.isConnected) renderer.destroy();
    } catch (error) {
      console.error(`${MODULE_ID} | Failed to init hover scene renderer:`, error);
      container.innerHTML = '<div style="color: #f66; text-align: center;">Error</div>';
    }
  }

  cls.prototype._updateHoverZoomPosition = function (event) {
    const zoomer = document.querySelector('.ov-hover-zoomer');
    if (!zoomer) return;

    const offset = 20;
    let left = event.clientX + offset;
    let top = event.clientY + offset;

    // 边界检查
    const rect = zoomer.getBoundingClientRect();
    const winWidth = window.innerWidth;
    const winHeight = window.innerHeight;

    // 如果右侧溢出，显示在左侧
    if (left + rect.width > winWidth) {
      left = event.clientX - rect.width - offset;
    }

    // 如果底部溢出，显示在上方
    if (top + rect.height > winHeight) {
      top = event.clientY - rect.height - offset;
    }

    // 确保不超出顶部和左侧
    left = Math.max(0, left);
    top = Math.max(0, top);

    zoomer.style.left = `${left}px`;
    zoomer.style.top = `${top}px`;
  }

  cls.prototype._hideHoverZoom = function () {
    this._hoverSceneRenderer?.destroy();
    this._hoverSceneRenderer = null;
    const zoomer = document.querySelector('.ov-hover-zoomer');
    if (zoomer) {
      zoomer.classList.remove('active');
      clearTimeout(this._hoverZoomRemoveTimer);
      this._hoverZoomRemoveTimer = setTimeout(() => {
        if (!zoomer.classList.contains('active')) zoomer.remove();
      }, 200);
    }
  }

  cls.prototype._formatVideoTime = function (seconds) {
    if (isNaN(seconds)) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')} `;
  }

}
