/**
 * Origin Vault - 文件浏览器组件
 * 用于浏览 FVTT 数据目录中的文件
 */

import { MODULE_ID, FILE_TYPES } from '../constants.js';
import { browseFilePicker } from '../utils/filePicker.js';
import { t, tf } from '../utils/i18n.js';

export class FileBrowser {
  /**
   * @param {HTMLElement} container - 容器元素
   * @param {object} options - 配置选项
   */
  constructor(container, options = {}) {
    this.container = container;
    this.options = {
      onFileSelect: options.onFileSelect || (() => { }),
      onFileDrag: options.onFileDrag || (() => { }),
      showHidden: options.showHidden || false,
      fileFilter: options.fileFilter || null, // 文件类型过滤
      initialState: options.initialState || null,
      ...options
    };

    this.source = 'data'; // 默认源
    this.s3Buckets = [];
    this.currentPath = '';
    this.history = [];
    this.historyIndex = -1;
    this.selectedFiles = new Set();
    this.files = [];
    this.directories = [];

    this.isLoading = false;

    // UI State
    if (this.options.initialState) {
      const s = this.options.initialState;
      this.source = s.source || 'data';
      this.bucket = s.bucket || null;
      this.currentPath = s.currentPath || '';
      this.history = s.history || [];
      this.historyIndex = s.historyIndex || -1;
      this.viewMode = s.viewMode || 'grid';
      this.gridSize = s.gridSize || 100;
      this.initialScrollTop = s.scrollTop || 0; // Capture initial scroll position
    } else {
      this.viewMode = 'grid'; // grid, list
      this.gridSize = 100; // pixels
    }

    this.hoverTimer = null;
  }

  /**
   * 初始化文件浏览器
   */
  async init() {
    await this._loadS3Buckets();
    this.render();

    // 如果有初始路径，则浏览它，否则浏览根目录
    const initialPath = this.options.initialState?.currentPath || '';
    // 如果是从历史恢复，不需要重新 browse? 需要，因为 DOM 是新的。
    // 但是 browse 会把路径推入历史。
    // 如果我们已经恢复了历史，我们不希望再次推入。
    // 所以我们需要一个 browseWithoutHistory 或者手动处理。
    // 简单起见，如果 currentPath 存在，我们 browse 它，并修正 history。

    if (this.currentPath) {
      await this.browse(this.currentPath, false); // false = don't push to history
    } else {
      await this.browse('');
    }
  }

  async _loadS3Buckets() {
    try {
      const result = await browseFilePicker('s3', '');
      this.s3Buckets = result.dirs || [];
    } catch (e) {
      console.warn('Origin Vault | S3 not available or no buckets found');
    }
  }

  /**
   * 渲染文件浏览器
   */
  render() {
    this.container.innerHTML = `
      <div class="file-browser">
        <div class="browser-nav">
          <select class="source-select" title="${t('origin-vault.browser.selectSource')}">
            <option value="data">User Data</option>
            <option value="s3" ${this.s3Buckets.length ? '' : 'disabled'}>Amazon S3</option>
            ${this._renderS3Options()}
          </select>
          <div class="nav-divider"></div>
          <button class="nav-btn btn-back" title="${t('origin-vault.browser.back')}" disabled>
            <i class="fas fa-arrow-left"></i>
          </button>
          <button class="nav-btn btn-forward" title="${t('origin-vault.browser.forward')}" disabled>
            <i class="fas fa-arrow-right"></i>
          </button>
          <button class="nav-btn btn-up" title="${t('origin-vault.browser.up')}">
            <i class="fas fa-level-up-alt"></i>
          </button>
          <button class="nav-btn btn-home" title="${t('origin-vault.browser.root')}">
            <i class="fas fa-home"></i>
          </button>
          <button class="nav-btn btn-refresh" title="${t('origin-vault.browser.refresh')}">
            <i class="fas fa-sync-alt"></i>
          </button>
        </div>
        
        <div class="browser-path">
          <i class="fas fa-folder"></i>
          <input type="text" class="path-input" value="${this.currentPath}" placeholder="${t('origin-vault.browser.inputPath')}">
        </div>
        
        <div class="browser-toolbar">
           <div class="browser-view-controls">
             <button class="view-btn ${this.viewMode === 'list' ? 'active' : ''}" data-mode="list" title="${t('origin-vault.browser.listView')}">
               <i class="fas fa-list"></i>
             </button>
             <button class="view-btn ${this.viewMode === 'grid' ? 'active' : ''}" data-mode="grid" title="${t('origin-vault.browser.gridView')}">
               <i class="fas fa-th-large"></i>
             </button>
           </div>
           
           <div class="browser-size-control">
             <input type="range" class="size-slider" min="50" max="400" value="${this.gridSize}" title="${t('origin-vault.browser.iconSize')}">
           </div>
        </div>

        <div class="browser-files ${this.viewMode}-view" style="--browser-grid-size: ${this.gridSize}px">
          <div class="files-loading">
            <i class="fas fa-spinner fa-spin"></i>
            <span>${t('origin-vault.ui.loading')}</span>
          </div>
        </div>

        <div class="browser-preview">
          <div class="preview-content">
            <div class="preview-placeholder">
              <i class="fas fa-eye"></i>
              <span>${t('origin-vault.browser.selectToPreview')}</span>
            </div>
          </div>
        </div>
        
        <div class="browser-status">
          <span class="status-text"></span>
        </div>
      </div>
    `;

    // 设置下拉框值
    const sourceSelect = this.container.querySelector('.source-select');
    if (sourceSelect) {
      if (this.source === 's3' && this.bucket) {
        sourceSelect.value = `s3:${this.bucket}`;
      } else {
        sourceSelect.value = this.source;
      }
    }

    this._bindEvents();
  }

  _renderS3Options() {
    if (!this.s3Buckets.length) return '';
    return this.s3Buckets.map(b => {
      const bucketName = b.split('/').pop();
      return `<option value="s3:${bucketName}">S3: ${bucketName}</option>`;
    }).join('');
  }

  /**
   * 绑定事件
   */
  _bindEvents() {
    const container = this.container;

    // 导航按钮
    container.querySelector('.btn-back')?.addEventListener('click', () => this.goBack());
    container.querySelector('.btn-forward')?.addEventListener('click', () => this.goForward());
    container.querySelector('.btn-up')?.addEventListener('click', () => this.goUp());
    container.querySelector('.btn-home')?.addEventListener('click', () => this.browse(''));
    container.querySelector('.btn-refresh')?.addEventListener('click', () => this.refresh());

    // 源选择
    const sourceSelect = container.querySelector('.source-select');
    sourceSelect?.addEventListener('change', (e) => {
      const val = e.target.value;
      if (val.startsWith('s3:')) {
        this.source = 's3';
        this.bucket = val.split(':')[1];
      } else {
        this.source = val;
        this.bucket = null;
      }
      this.currentPath = ''; // 重置路径
      this.history = [];
      this.historyIndex = -1;
      this.browse('');
    });

    // 路径输入
    const pathInput = container.querySelector('.path-input');
    pathInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        this.browse(pathInput.value);
      }
    });

    // 视图切换
    container.querySelectorAll('.view-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.viewMode = btn.dataset.mode;
        this.render(); // 重新渲染以更新 UI 和类名
        if (!this.directories.length && !this.files.length) {
          this.browse(this.currentPath); // 确保有数据
        } else {
          // 如果已有数据，其实不需要重新 browse，_renderFiles 被 render 调用了
          // 但上面的 render() 已经重绘了整个 innerHTML，所以 _renderFiles 需要被调用。
          // 实际上 constructor 里 render() 只是画了框架? 不，render() 画了整个 innerHTML
          // 但 filesContainer 是空的，直到 browse 被调用?
          // 让我们检查 init(): render() -> browse() -> _renderFiles()
          // 这里的 render() 会清空 _renderFiles 的内容。
          // 所以我们需要重新 _renderFiles()
          this._renderFiles();
        }
      });
    });

    // 大小滑块
    const slider = container.querySelector('.size-slider');
    if (slider) {
      slider.addEventListener('input', (e) => {
        this.gridSize = e.target.value;
        const filesContainer = container.querySelector('.browser-files');
        if (filesContainer) {
          filesContainer.style.setProperty('--browser-grid-size', `${this.gridSize}px`);
        }
      });

      // Shift+Scroll to zoom
      container.querySelector('.browser-files')?.addEventListener('wheel', (e) => {
        if (e.shiftKey) {
          e.preventDefault();
          const delta = Math.sign(e.deltaY) * -10; // Scroll up to zoom in
          let newSize = parseInt(this.gridSize) + delta;

          // Clamp values
          const min = 50;
          const max = 400;
          if (newSize < min) newSize = min;
          if (newSize > max) newSize = max;

          this.gridSize = newSize;
          slider.value = newSize;

          const filesContainer = container.querySelector('.browser-files');
          if (filesContainer) {
            filesContainer.style.setProperty('--browser-grid-size', `${this.gridSize}px`);
          }
        }
      }, { passive: false });
    }
  }

  /**
   * 浏览指定路径
   * @param {string} path 
   * @param {boolean} pushHistory 是否推入历史
   */
  async browse(path, pushHistory = true) {
    if (this.isLoading) return;

    this.isLoading = true;
    this._showLoading(true);

    try {
      // 使用 FilePicker 浏览目录
      const options = this.bucket ? { bucket: this.bucket } : {};
      const result = await browseFilePicker(this.source, path, options);

      this.currentPath = result.target || '';
      this.directories = result.dirs || [];
      this.files = this._filterFiles(result.files || []);

      // 更新历史记录
      if (pushHistory) {
        if (this.historyIndex < this.history.length - 1) {
          this.history = this.history.slice(0, this.historyIndex + 1);
        }
        this.history.push(this.currentPath);
        this.historyIndex = this.history.length - 1;
      }

      this._renderFiles();
      this._updateNavButtons();
      this._updatePathInput();
      this._updateStatus();

    } catch (error) {
      console.error(`${MODULE_ID} | FileBrowser error: `, error);
      this._showError(t('origin-vault.browser.browseError'));
    } finally {
      this.isLoading = false;
      this._showLoading(false);
    }
  }

  /**
   * 过滤文件
   * @param {string[]} files 
   * @returns {string[]}
   */
  _filterFiles(files) {
    if (!this.options.fileFilter) return files;

    const allowedExtensions = [];

    if (this.options.fileFilter.includes('image')) {
      allowedExtensions.push(...FILE_TYPES.IMAGE);
    }
    if (this.options.fileFilter.includes('video')) {
      allowedExtensions.push(...FILE_TYPES.VIDEO);
    }
    if (this.options.fileFilter.includes('audio')) {
      allowedExtensions.push(...FILE_TYPES.AUDIO);
    }

    if (allowedExtensions.length === 0) return files;

    return files.filter(file => {
      const ext = file.substring(file.lastIndexOf('.')).toLowerCase();
      return allowedExtensions.includes(ext);
    });
  }

  /**
   * 渲染文件列表
   */
  _renderFiles() {
    const filesContainer = this.container.querySelector('.browser-files');
    if (!filesContainer) return;

    let html = '';

    // 渲染目录
    for (const dir of this.directories) {
      let dirName = dir.split('/').pop();
      try { dirName = decodeURIComponent(dirName); } catch (e) { }
      html += `
        <div class="browser-item directory" data-path="${dir}" draggable="true">
          <i class="fas fa-folder"></i>
          <span class="item-name">${dirName}</span>
        </div>
      `;
    }

    // 渲染文件
    for (const file of this.files) {
      let fileName = file.split('/').pop();
      try { fileName = decodeURIComponent(fileName); } catch (e) { }
      const ext = file.substring(file.lastIndexOf('.')).toLowerCase();
      const isImage = FILE_TYPES.IMAGE.includes(ext);
      const isVideo = FILE_TYPES.VIDEO.includes(ext);
      const isAudio = FILE_TYPES.AUDIO.includes(ext);

      let icon = 'fa-file';
      if (isImage) icon = 'fa-image';
      else if (isVideo) icon = 'fa-film';
      else if (isAudio) icon = 'fa-music';

      let previewHtml = '';
      if (this.viewMode === 'grid') {
        if (isImage) {
          previewHtml = `<div class="item-thumbnail"><img src="${file}" loading="lazy" draggable="false"></div>`;
        } else if (isVideo) {
          // Use placeholder initially, load video frame lazily via IntersectionObserver
          previewHtml = `
                <div class="item-thumbnail video-thumbnail" data-video-src="${file}">
                    <div class="video-placeholder"><i class="fas fa-film"></i></div>
                </div>`;
        } else {
          previewHtml = `<div class="item-thumbnail placeholder"><i class="fas ${icon}"></i></div>`;
        }
      }

      html += `
        <div class="browser-item file ${this.selectedFiles.has(file) ? 'selected' : ''}" 
             data-path="${file}" 
             draggable="true"
             title="${fileName}">
          ${previewHtml}
          ${this.viewMode === 'list' ? `<i class="fas ${icon} item-icon"></i>` : ''}
          <span class="item-name">${fileName}</span>
          ${this.viewMode === 'list' ? `<span class="item-size"></span>` : ''} 
        </div>
      `;
    }

    if (this.directories.length === 0 && this.files.length === 0) {
      html = `
        <div class="browser-empty">
          <i class="fas fa-folder-open"></i>
          <span>${t('origin-vault.empty.folder')}</span>
        </div>
      `;
    }

    filesContainer.innerHTML = html;

    // Restore scroll position if needed
    if (this.initialScrollTop && this.initialScrollTop > 0) {
      setTimeout(() => {
        filesContainer.scrollTop = this.initialScrollTop;
        this.initialScrollTop = 0; // Clear it so it doesn't affect subsequent browsing
      }, 0);
    }

    // 绑定文件/目录事件
    filesContainer.querySelectorAll('.browser-item.directory').forEach(el => {
      el.addEventListener('dblclick', () => {
        this.browse(el.dataset.path);
      });

      // 文件夹拖拽
      el.addEventListener('dragstart', (e) => {
        const path = el.dataset.path;
        const dataStr = JSON.stringify({
          type: 'origin-vault-browser-files',
          paths: [path],
          isDirectory: true,
          source: this.source,
          bucket: this.bucket
        });
        e.dataTransfer.setData('application/x-origin-vault-browser-files', dataStr);
        e.dataTransfer.setData('text/plain', dataStr); // Fallback
      });
    });

    filesContainer.querySelectorAll('.browser-item.file').forEach(el => {
      // 单击选择
      el.addEventListener('click', (e) => {
        const path = el.dataset.path;
        const isCtrl = e.ctrlKey || e.metaKey;

        if (isCtrl) {
          if (this.selectedFiles.has(path)) {
            this.selectedFiles.delete(path);
            el.classList.remove('selected');
          } else {
            this.selectedFiles.add(path);
            el.classList.add('selected');
          }
        } else {
          this.selectedFiles.clear();
          filesContainer.querySelectorAll('.browser-item.file').forEach(item => {
            item.classList.remove('selected');
          });
          this.selectedFiles.add(path);
          el.classList.add('selected');
        }

        this._updatePreview(path);
        this.options.onFileSelect(Array.from(this.selectedFiles));
      });

      // 悬停预览 (带防抖)
      el.addEventListener('mouseenter', () => {
        if (this.hoverTimer) clearTimeout(this.hoverTimer);
        this.hoverTimer = setTimeout(() => {
          this._updatePreview(el.dataset.path);
        }, 100); // Reduce delay for snappier feel
      });

      el.addEventListener('mouseleave', () => {
        if (this.hoverTimer) clearTimeout(this.hoverTimer);
        //恢复选中项预览
        if (this.selectedFiles.size > 0) {
          // 恢复选中项预览
          const selectedPath = Array.from(this.selectedFiles)[0];
          // Only restore if the preview was actually showing the hovered item
          // Because usually mouseleave fires before mouseenter of next item?
          // Yes. So this is safe.
          this._updatePreview(selectedPath);
        } else {
          this._updatePreview(null);
        }
      });

      // 双击添加到素材库
      el.addEventListener('dblclick', () => {
        const path = el.dataset.path;
        this.options.onFileSelect([path], true);
      });

      // 拖拽
      el.addEventListener('dragstart', (e) => {
        const paths = this.selectedFiles.has(el.dataset.path)
          ? Array.from(this.selectedFiles)
          : [el.dataset.path];

        const dataStr = JSON.stringify({
          type: 'origin-vault-browser-files',
          paths,
          source: this.source,
          bucket: this.bucket
        });
        e.dataTransfer.setData('application/x-origin-vault-browser-files', dataStr);
        e.dataTransfer.setData('text/plain', dataStr); // Fallback for broad compatibility

        // 设置拖拽图像
        const thumbnailImg = el.querySelector('.item-thumbnail img');
        if (thumbnailImg) {
          const dragImg = thumbnailImg.cloneNode(true);
          dragImg.style.width = '60px';
          dragImg.style.height = 'auto';
          dragImg.style.position = 'absolute';
          dragImg.style.left = '-9999px';
          dragImg.style.top = '-9999px';
          document.body.appendChild(dragImg);
          e.dataTransfer.setDragImage(dragImg, 30, 30);

          // Clean up when drag ends
          const cleanup = () => {
            if (dragImg.parentNode) {
              document.body.removeChild(dragImg);
            }
            el.removeEventListener('dragend', cleanup);
          };
          el.addEventListener('dragend', cleanup);
        }

        this.options.onFileDrag(paths);
      });
    });

    // Lazy-load video thumbnails using IntersectionObserver
    this._setupVideoLazyLoading(filesContainer);
  }

  /**
   * 设置视频缩略图懒加载
   */
  _setupVideoLazyLoading(container) {
    const videoThumbnails = container.querySelectorAll('.video-thumbnail[data-video-src]');
    if (!videoThumbnails.length) return;

    // Disconnect any existing observer
    if (this._videoObserver) {
      this._videoObserver.disconnect();
    }

    this._videoObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const thumbnail = entry.target;
          const videoSrc = thumbnail.dataset.videoSrc;
          if (!videoSrc || thumbnail.querySelector('video')) return;

          // Replace placeholder with video
          const video = document.createElement('video');
          video.src = videoSrc;
          video.muted = true;
          video.preload = 'metadata';
          video.draggable = false;
          video.onloadeddata = () => {
            video.currentTime = 0.5;
          };

          // Remove placeholder and add video
          const placeholder = thumbnail.querySelector('.video-placeholder');
          if (placeholder) placeholder.remove();
          thumbnail.appendChild(video);

          // Stop observing this element
          this._videoObserver.unobserve(thumbnail);
        }
      });
    }, {
      root: container,
      rootMargin: '100px', // Load slightly before visible
      threshold: 0.1
    });

    videoThumbnails.forEach(thumb => this._videoObserver.observe(thumb));
  }

  /**
   * 更新预览面板
   * @param {string|null} specificPath 指定预览路径，如果有则忽略选中项
   */
  _updatePreview(specificPath = null) {
    const previewContainer = this.container.querySelector('.browser-preview .preview-content');
    if (!previewContainer) return;

    let path = specificPath;
    let label = '';

    if (!path) {
      if (this.selectedFiles.size === 1) {
        path = Array.from(this.selectedFiles)[0];
      } else if (this.selectedFiles.size > 1) {
        previewContainer.innerHTML = `
                <div class="preview-placeholder">
                <i class="fas fa-layer-group"></i>
                <span>${tf('origin-vault.browser.filesSelected', { count: this.selectedFiles.size })}</span>
                </div>`;
        return;
      }
    }

    if (path) {
      const ext = path.substring(path.lastIndexOf('.')).toLowerCase();

      if (FILE_TYPES.IMAGE.includes(ext)) {
        previewContainer.innerHTML = `<img src="${path}" alt="preview">`;
      } else if (FILE_TYPES.VIDEO.includes(ext)) {
        previewContainer.innerHTML = `<video src="${path}" controls autoplay muted></video>`;
      } else if (FILE_TYPES.AUDIO.includes(ext)) {
        previewContainer.innerHTML = `
          <div class="audio-preview">
            <i class="fas fa-music"></i>
            <audio src="${path}" controls></audio>
          </div>`;
      } else {
        previewContainer.innerHTML = `
          <div class="preview-placeholder">
            <i class="fas fa-file"></i>
            <span>${t('origin-vault.browser.noPreview')}</span>
          </div>`;
      }
    } else if (this.selectedFiles.size > 1) {
      previewContainer.innerHTML = `
        <div class="preview-placeholder">
          <i class="fas fa-layer-group"></i>
          <span>${tf('origin-vault.browser.filesSelected', { count: this.selectedFiles.size })}</span>
        </div>`;
    } else {
      previewContainer.innerHTML = `
        <div class="preview-placeholder">
          <i class="fas fa-eye"></i>
          <span>${t('origin-vault.browser.selectToPreview')}</span>
        </div>`;
    }
  }

  /**
   * 后退
   */
  goBack() {
    if (this.historyIndex > 0) {
      this.historyIndex--;
      this._navigateToHistory();
    }
  }

  /**
   * 前进
   */
  goForward() {
    if (this.historyIndex < this.history.length - 1) {
      this.historyIndex++;
      this._navigateToHistory();
    }
  }

  /**
   * 上级目录
   */
  goUp() {
    if (!this.currentPath) return;

    const parts = this.currentPath.split('/');
    parts.pop();
    this.browse(parts.join('/'));
  }

  /**
   * 刷新
   */
  refresh() {
    this.browse(this.currentPath);
  }

  /**
   * 导航到历史记录
   */
  async _navigateToHistory() {
    const path = this.history[this.historyIndex];

    this.isLoading = true;
    this._showLoading(true);

    try {
      const options = this.bucket ? { bucket: this.bucket } : {};
      const result = await browseFilePicker(this.source, path, options);

      this.currentPath = result.target || '';
      this.directories = result.dirs || [];
      this.files = this._filterFiles(result.files || []);

      this._renderFiles();
      this._updateNavButtons();
      this._updatePathInput();
      this._updateStatus();

    } catch (error) {
      console.error(`${MODULE_ID} | FileBrowser error: `, error);
    } finally {
      this.isLoading = false;
      this._showLoading(false);
    }
  }

  /**
   * 更新导航按钮状态
   */
  _updateNavButtons() {
    const backBtn = this.container.querySelector('.btn-back');
    const forwardBtn = this.container.querySelector('.btn-forward');
    const upBtn = this.container.querySelector('.btn-up');

    if (backBtn) backBtn.disabled = this.historyIndex <= 0;
    if (forwardBtn) forwardBtn.disabled = this.historyIndex >= this.history.length - 1;
    if (upBtn) upBtn.disabled = !this.currentPath;
  }

  /**
   * 更新路径输入框
   */
  _updatePathInput() {
    const pathInput = this.container.querySelector('.path-input');
    if (pathInput) {
      pathInput.value = this.currentPath;
    }
  }

  /**
   * 更新状态栏
   */
  _updateStatus() {
    const statusText = this.container.querySelector('.status-text');
    if (statusText) {
      statusText.textContent = tf('origin-vault.browser.status', {
        dirs: this.directories.length,
        files: this.files.length
      });
    }
  }

  /**
   * 显示/隐藏加载状态
   * @param {boolean} show 
   */
  _showLoading(show) {
    const loading = this.container.querySelector('.files-loading');
    const files = this.container.querySelector('.browser-files');

    if (loading) {
      loading.style.display = show ? 'flex' : 'none';
    }
  }

  /**
   * 显示错误信息
   * @param {string} message 
   */
  _showError(message) {
    const filesContainer = this.container.querySelector('.browser-files');
    if (filesContainer) {
      if (filesContainer) {
        filesContainer.innerHTML = `
        <div class="browser-error">
          <i class="fas fa-exclamation-triangle"></i>
          <span>${message}</span>
        </div>
      `;
      }
    }
  }

  /**
   * 获取当前路径
   * @returns {string}
   */
  getCurrentPath() {
    return this.currentPath;
  }

  /**
   * 获取选中的文件
   * @returns {string[]}
   */
  getSelectedFiles() {
    return Array.from(this.selectedFiles);
  }

  /**
   * 清除选择
   */
  clearSelection() {
    this.selectedFiles.clear();
    this.container.querySelectorAll('.browser-item.file.selected').forEach(el => {
      el.classList.remove('selected');
    });
  }
}
