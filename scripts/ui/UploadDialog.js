import { ovText } from '../utils/locale.js';
/**
 * Origin Vault - 文件上传对话框
 * 支持从本地电脑上传文件到 Origin Vault 库
 * 可选自动优化图片格式 (PNG/JPEG → WebP)
 */

import { MODULE_ID, FILE_TYPES, STORAGE, SETTINGS, OV_LAYERS } from '../constants.js';
import { ImageOptimizer } from '../utils/ImageOptimizer.js';
import { ThumbnailManager } from '../utils/ThumbnailManager.js';
import {
    browseFilePicker,
    createFilePickerApp,
    createFilePickerDirectory,
    uploadWithFilePicker
} from '../utils/filePicker.js';
import { t, tf } from '../utils/i18n.js';
import { ovLog } from '../utils/logger.js';

// 支持上传的全部类型
const SUPPORTED_EXTENSIONS = [
    ...FILE_TYPES.IMAGE,
    ...FILE_TYPES.VIDEO,
    ...FILE_TYPES.AUDIO,
    ...FILE_TYPES.SCENE
];

const URL_MIME_EXTENSION_MAP = {
    'image/apng': '.png',
    'image/avif': '.avif',
    'image/bmp': '.bmp',
    'image/gif': '.gif',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/svg+xml': '.svg',
    'image/webp': '.webp'
};

const URL_EXTENSION_MIME_MAP = {
    '.avif': 'image/avif',
    '.bmp': 'image/bmp',
    '.gif': 'image/gif',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp'
};

const UPLOAD_DIALOG_CLIPBOARD_FALLBACK_STYLE_ID = `${MODULE_ID}-upload-dialog-clipboard-fallback-styles`;
const NATIVE_PICKER_WINDOW_QUERY = '.application, .app, .window-app, .window-app-v2';

export class UploadDialog {

    static ensureClipboardFallbackStyles() {
        if (document.getElementById(UPLOAD_DIALOG_CLIPBOARD_FALLBACK_STYLE_ID)) return;

        // 这里只补最容易炸版的骨架样式。
        // 真正的视觉细节仍然以 dialogs.css 为准，避免以后出现两份完整样式长期漂移。
        const style = document.createElement('style');
        style.id = UPLOAD_DIALOG_CLIPBOARD_FALLBACK_STYLE_ID;
        style.textContent = `
            .ov-upload-dialog #ov-upload-clipboard-body {
                margin-top: 10px;
            }

            .ov-upload-dialog .ov-upload-clipboard-scroller {
                max-height: 320px;
                overflow-y: auto;
            }

            .ov-upload-dialog #ov-upload-clipboard-grid {
                display: grid;
                grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
                gap: 10px;
            }

            .ov-upload-dialog .ov-upload-clipboard-card {
                position: relative;
                display: flex;
                flex-direction: column;
                gap: 8px;
                min-width: 0;
                padding: 8px;
                border-radius: var(--ov-radius-sm);
                border: 1px solid rgba(255, 255, 255, 0.08);
                background: rgba(255, 255, 255, 0.04);
            }

            .ov-upload-dialog .ov-upload-clipboard-preview {
                width: 100%;
                aspect-ratio: 1 / 1;
                border-radius: var(--ov-radius-sm);
                overflow: hidden;
                background: rgba(0, 0, 0, 0.22);
            }

            .ov-upload-dialog .ov-upload-clipboard-preview img {
                display: block;
                width: 100%;
                height: 100%;
                object-fit: cover;
            }

            .ov-upload-dialog .ov-upload-clipboard-fallback {
                width: 100%;
                height: 100%;
                display: flex;
                align-items: center;
                justify-content: center;
                color: var(--ov-text-tertiary);
                font-size: 24px;
            }

            .ov-upload-dialog .ov-upload-clipboard-meta {
                min-width: 0;
            }

            .ov-upload-dialog .ov-upload-clipboard-name {
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }

            .ov-upload-dialog .ov-upload-clipboard-remove {
                position: absolute;
                top: 6px;
                right: 6px;
                width: 24px;
                height: 24px;
                display: inline-flex;
                align-items: center;
                justify-content: center;
            }
        `;

        document.head.appendChild(style);
    }

    /**
     * @param {LibraryData} library - 素材库实例
     * @param {object} options
     * @param {string} options.targetFolderId - 目标文件夹 ID
     * @param {HTMLElement} options.parentElement - 父容器 (用于显示 overlay)
     */
    constructor(library, options = {}) {
        this.library = library;
        this.targetFolderId = options.targetFolderId || 'root';
        this.parentElement = options.parentElement;

        /** @type {Array<{file: File, relativePath: string, signature: string|null, source: string, previewUrl: string|null, canOptimize: boolean, estimatedSize: number}>} */
        this.pendingFiles = [];
        this.optimizeImages = true;
        this.webpQuality = 0.85;

        this._overlay = null;
        this._isUploading = false;
        this._isFetchingRemote = false;
        this._didUpload = false;
        this._boundPasteHandler = null;
        this._nativePickerLayerSession = null;

        // 自定义上传路径（本次上传，null = 使用默认）
        this._customUploadPath = null;
        this._useCustomPath = false;

        // 上传存储源（从设置读取默认值）
        this._loadUploadTargetFromSettings();

        // 上传时附加的标签
        this._uploadTags = [];
    }

    _loadUploadTargetFromSettings() {
        let uploadSource = 'data';
        let uploadBucket = '';
        const configuredPath = game.settings.get(MODULE_ID, SETTINGS.UPLOAD_PATH) || '';
        const lastSelection = globalThis._ovLastFilePickerSelection;

        try {
            uploadSource = game.settings.get(MODULE_ID, SETTINGS.UPLOAD_SOURCE) || 'data';
        } catch {
            uploadSource = 'data';
        }

        try {
            uploadBucket = game.settings.get(MODULE_ID, SETTINGS.S3_BUCKET) || '';
        } catch {
            uploadBucket = '';
        }

        if (configuredPath && lastSelection?.path === configuredPath) {
            uploadSource = lastSelection.source || uploadSource;
            if (uploadSource === 's3' && lastSelection.bucket) {
                uploadBucket = lastSelection.bucket;
            }
        }

        // 兼容旧世界里残留的非法状态：source 还是 s3，但 bucket 已被清空。
        if (uploadSource === 's3' && !uploadBucket) {
            console.warn(`${MODULE_ID} | Upload source is s3 but no bucket is configured. Falling back to data.`);
            uploadSource = 'data';
        }

        this._uploadSource = uploadSource;
        this._uploadBucket = uploadSource === 's3' ? uploadBucket : '';
    }

    _reserveDialogZIndex() {
        const base = OV_LAYERS.DIALOG_OVERLAY_BASE;
        const managed = Number(window._ovWindowZ) || 0;
        const windowLayers = Array.from(document.querySelectorAll(NATIVE_PICKER_WINDOW_QUERY))
            .map((el) => Number.parseInt(window.getComputedStyle(el).zIndex, 10))
            .filter(Number.isFinite);

        const next = Math.max(base, managed, ...windowLayers) + 1;
        window._ovWindowZ = next;
        return String(next);
    }

    _getOverlayZIndex() {
        const zIndex = Number.parseInt(this._overlay?.style?.zIndex, 10);
        return Number.isFinite(zIndex) ? zIndex : OV_LAYERS.DIALOG_OVERLAY_BASE;
    }

    _getWindowElement(target) {
        const element = target?.element ?? target;
        if (!element) return null;
        if (globalThis.jQuery && element instanceof globalThis.jQuery) return element[0] || null;
        return element instanceof HTMLElement ? element : null;
    }

    _isNativePickerLayerCandidate(el, session) {
        if (!(el instanceof HTMLElement)) return false;
        if (!el.matches(NATIVE_PICKER_WINDOW_QUERY)) return false;
        if (session.existingWindows.has(el)) return false;
        if (this._overlay?.contains(el)) return false;
        return true;
    }

    _collectNativePickerWindow(el, session) {
        if (!this._isNativePickerLayerCandidate(el, session)) return;
        session.windows.add(el);
    }

    _boostNativePickerWindow(el) {
        if (!(el instanceof HTMLElement) || !el.isConnected) return;

        const overlayZ = this._getOverlayZIndex();
        const currentZ = Number.parseInt(window.getComputedStyle(el).zIndex, 10);
        if (Number.isFinite(currentZ) && currentZ > overlayZ) return;

        el.classList.add('ov-above-vault');
        el.style.setProperty('z-index', this._reserveDialogZIndex(), 'important');
    }

    _syncNativePickerLayerSession(session = this._nativePickerLayerSession) {
        if (!session || session !== this._nativePickerLayerSession) return;

        this._collectNativePickerWindow(this._getWindowElement(session.picker), session);
        document.querySelectorAll(NATIVE_PICKER_WINDOW_QUERY).forEach((el) => {
            this._collectNativePickerWindow(el, session);
        });

        for (const el of Array.from(session.windows)) {
            if (!el.isConnected) {
                session.windows.delete(el);
                continue;
            }
            this._boostNativePickerWindow(el);
        }
    }

    _startNativePickerLayerSession(picker, existingWindows = new Set()) {
        this._stopNativePickerLayerSession();

        const session = {
            picker,
            existingWindows,
            windows: new Set(),
            observer: null,
            intervalId: null,
            originalClose: null,
            closeWrapper: null,
            pointerHandler: null
        };
        this._nativePickerLayerSession = session;

        session.observer = new MutationObserver((records) => {
            for (const record of records) {
                for (const node of record.addedNodes) {
                    if (!(node instanceof HTMLElement)) continue;
                    this._collectNativePickerWindow(node, session);
                    node.querySelectorAll?.(NATIVE_PICKER_WINDOW_QUERY).forEach((el) => {
                        this._collectNativePickerWindow(el, session);
                    });
                }
            }
            requestAnimationFrame(() => this._syncNativePickerLayerSession(session));
        });
        session.observer.observe(document.body, { childList: true, subtree: true });

        session.pointerHandler = (event) => {
            const target = event.target instanceof HTMLElement ? event.target : null;
            if (!target || !Array.from(session.windows).some((el) => el.contains(target))) return;

            this._syncNativePickerLayerSession(session);
            requestAnimationFrame(() => this._syncNativePickerLayerSession(session));
            setTimeout(() => this._syncNativePickerLayerSession(session), 80);
        };
        document.addEventListener('pointerdown', session.pointerHandler, true);

        if (picker && typeof picker.close === 'function') {
            session.originalClose = picker.close;
            session.closeWrapper = (...args) => {
                let result;
                try {
                    result = session.originalClose.apply(picker, args);
                    return result;
                } finally {
                    void Promise.resolve(result)
                        .catch(() => {})
                        .finally(() => {
                            if (this._nativePickerLayerSession === session) {
                                this._stopNativePickerLayerSession();
                            }
                        });
                }
            };
            picker.close = session.closeWrapper;
        }

        // FilePicker 里“新建文件夹”会再开一个原生窗口，别只抬第一个 picker。
        this._syncNativePickerLayerSession(session);
        requestAnimationFrame(() => this._syncNativePickerLayerSession(session));
        setTimeout(() => this._syncNativePickerLayerSession(session), 200);
        session.intervalId = setInterval(() => this._syncNativePickerLayerSession(session), 350);
    }

    _stopNativePickerLayerSession() {
        const session = this._nativePickerLayerSession;
        if (!session) return;
        this._nativePickerLayerSession = null;

        session.observer?.disconnect();
        if (session.intervalId) clearInterval(session.intervalId);
        if (session.pointerHandler) {
            document.removeEventListener('pointerdown', session.pointerHandler, true);
        }
        if (session.picker?.close === session.closeWrapper && session.originalClose) {
            session.picker.close = session.originalClose;
        }
    }

    /**
     * 显示上传对话框
     */
    show() {
        if (this._overlay) return;
        this._buildUI();
    }

    /**
     * 直接添加文件 (从外部拖放)
     * @param {FileList|File[]} files
     */
    async addFiles(files) {
        if (!this._overlay) this._buildUI();
        await this._processFileList(files);
        this._renderFileList();
    }

    /**
     * 直接添加 DataTransfer 项 (支持文件夹)
     * @param {DataTransferItemList} items
     */
    async addDataTransferItems(items) {
        if (!this._overlay) this._buildUI();
        const files = await this._readDataTransferItems(items);
        this.pendingFiles.push(...files);
        this._renderFileList();
    }

    // ─── UI 构建 ───

    _buildUI() {
        UploadDialog.ensureClipboardFallbackStyles();

        const html = `
    <div class="ov-overlay-backdrop upload-dialog">
      <div class="ov-dialog-card ov-upload-dialog">
        <div class="ov-dialog-header">
          <div class="ov-dialog-title">
            <i class="fas fa-cloud-upload-alt"></i>
            ${t('origin-vault.upload.title')}
          </div>
          <button class="ov-dialog-close"><i class="fas fa-times"></i></button>
        </div>
        <div class="ov-dialog-body">
          <!-- 拖放区域 -->
          <div class="ov-upload-dropzone" id="ov-upload-dropzone">
            <i class="fas fa-cloud-upload-alt"></i>
            <p>${t('origin-vault.upload.dropHere')}</p>
            <div class="ov-upload-buttons">
              <button class="ov-btn ov-btn-primary" id="ov-upload-select-files">
                <i class="fas fa-file"></i> ${t('origin-vault.upload.selectFiles')}
              </button>
              <button class="ov-btn ov-btn-secondary" id="ov-upload-select-folder">
                <i class="fas fa-folder-open"></i> ${t('origin-vault.upload.selectFolder')}
              </button>
            </div>
            <div class="ov-upload-paste-hint">${t('origin-vault.upload.pasteHint')}</div>
            <div class="ov-upload-clipboard-section" id="ov-upload-clipboard-section">
              <div class="ov-upload-clipboard-label">${t('origin-vault.upload.clipboardSection')}</div>
              <div
                class="ov-upload-clipboard-pastebox"
                id="ov-upload-clipboard-pastebox"
                tabindex="0"
                role="textbox"
                aria-label="${t('origin-vault.upload.clipboardPasteTarget')}"
              >
                <i class="fas fa-paste"></i>
                <div class="ov-upload-clipboard-pastecopy">
                  <div class="ov-upload-clipboard-pasteplaceholder">${t('origin-vault.upload.clipboardPasteTarget')}</div>
                  <div class="ov-upload-clipboard-pastesubhint">${t('origin-vault.upload.clipboardPasteHint')}</div>
                </div>
              </div>
              <div class="ov-upload-clipboard-body" id="ov-upload-clipboard-body" style="display:none">
                <div class="ov-upload-clipboard-header">
                  <div class="ov-upload-clipboard-title">
                    <span>${t('origin-vault.upload.clipboardSection')}</span>
                    <span class="ov-upload-clipboard-summary" id="ov-upload-clipboard-summary"></span>
                  </div>
                  <button class="ov-upload-clipboard-clear" id="ov-upload-clear-clipboard" type="button">
                    ${t('origin-vault.upload.clearClipboard')}
                  </button>
                </div>
                <div class="ov-upload-clipboard-scroller">
                  <div class="ov-upload-clipboard-grid" id="ov-upload-clipboard-grid"></div>
                </div>
              </div>
            </div>
            <div class="ov-upload-url-divider">
              <span>${t('origin-vault.upload.urlDivider')}</span>
            </div>
            <div class="ov-upload-url-row">
              <input
                type="url"
                id="ov-upload-url-input"
                class="ov-upload-url-input"
                placeholder="${t('origin-vault.upload.urlPlaceholder')}"
                autocomplete="off"
                spellcheck="false"
              >
              <button class="ov-btn ov-btn-secondary" id="ov-upload-add-url">
                <i class="fas fa-link"></i> ${t('origin-vault.upload.addUrl')}
              </button>
            </div>
            <div class="ov-upload-url-hint">${t('origin-vault.upload.urlHint')}</div>
            <input type="file" id="ov-upload-file-input" multiple accept="image/*,video/*,audio/*,.ov-scene" style="display:none">
            <input type="file" id="ov-upload-folder-input" webkitdirectory style="display:none">
          </div>

          <!-- 优化选项 -->
          <div class="ov-upload-options">
            <label class="ov-checkbox-label">
              <input type="checkbox" id="ov-upload-optimize" checked>
              <span>${t('origin-vault.upload.optimizeImages')}</span>
            </label>
            <div class="ov-quality-slider" id="ov-quality-slider-container">
              <span>WebP ${t('origin-vault.upload.quality')}:</span>
              <input type="range" id="ov-upload-quality" min="50" max="100" value="85" step="5">
              <span id="ov-upload-quality-value">85%</span>
            </div>
          </div>

          <!-- 上传路径选择 -->
          <div class="ov-upload-path-section">
            <div class="ov-upload-path-buttons">
              <button class="ov-path-btn active" id="ov-path-default" title="${t('origin-vault.upload.defaultPathHint')}">
                <i class="fas fa-folder"></i> ${t('origin-vault.upload.defaultPath')}
              </button>
              <button class="ov-path-btn" id="ov-path-custom" title="${t('origin-vault.upload.customPathHint')}">
                <i class="fas fa-folder-open"></i> ${t('origin-vault.upload.customPath')}
              </button>
            </div>
            <div class="ov-upload-path-display" id="ov-upload-path-display">
              <i class="fas fa-map-marker-alt"></i>
              <span id="ov-upload-path-text">${this._getDefaultUploadPath()}</span>
            </div>
          </div>

          <!-- 上传标签 -->
          <div class="ov-upload-tags-section">
            <div class="ov-upload-tags-header">
              <span><i class="fas fa-tags"></i> ${t('origin-vault.upload.uploadTags')}</span>
              <button class="ov-tag-add-btn" id="ov-upload-add-tags">
                <i class="fas fa-plus"></i> ${t('origin-vault.upload.addTags')}
              </button>
            </div>
            <div class="ov-upload-tags-chips" id="ov-upload-tags-chips"></div>
          </div>

          <!-- 文件列表 -->
          <div class="ov-upload-file-list-container" id="ov-upload-file-list-container" style="display:none">
            <div class="ov-upload-summary" id="ov-upload-summary"></div>
            <div class="ov-upload-file-list" id="ov-upload-file-list"></div>
          </div>

          <!-- 进度 -->
          <div class="ov-upload-progress" id="ov-upload-progress" style="display:none">
            <div class="ov-upload-progress-status" id="ov-upload-progress-status"></div>
            <div class="ov-progress-track">
              <div class="ov-progress-fill" id="ov-upload-progress-fill" style="width:0%"></div>
            </div>
            <div class="ov-upload-progress-detail" id="ov-upload-progress-detail"></div>
          </div>
        </div>

        <div class="ov-dialog-footer">
          <button class="ov-btn ov-btn-default" id="ov-upload-cancel">
            ${t('origin-vault.upload.cancel')}
          </button>
          <button class="ov-btn ov-btn-primary" id="ov-upload-start" disabled>
            <i class="fas fa-upload"></i> ${t('origin-vault.upload.start')}
          </button>
        </div>
      </div>
    </div>`;

        // 上传弹窗必须脱离 OV 主容器，否则窗口模式下会被容器的 overflow 裁掉。
        // 这里直接挂到 body，避免再次落回 overlay host 的相对定位坐标系里。
        const template = document.createElement('template');
        template.innerHTML = html.trim();
        this._overlay = template.content.firstElementChild;
        document.body.appendChild(this._overlay);
        this._overlay.style.zIndex = this._reserveDialogZIndex();
        setTimeout(() => this._overlay.classList.add('active'), 10);

        this._bindEvents();
    }

    _bindEvents() {
        const overlay = this._overlay;
        if (!overlay) return;

        // 关闭
        overlay.querySelector('.ov-dialog-close').addEventListener('click', () => this.close());
        overlay.querySelector('#ov-upload-cancel').addEventListener('click', () => this.close());

        // 选择文件
        overlay.querySelector('#ov-upload-select-files').addEventListener('click', () => {
            overlay.querySelector('#ov-upload-file-input').click();
        });

        overlay.querySelector('#ov-upload-select-folder').addEventListener('click', () => {
            overlay.querySelector('#ov-upload-folder-input').click();
        });

        const submitUrlImport = async () => {
            const input = overlay.querySelector('#ov-upload-url-input');
            const rawUrl = String(input?.value || '').trim();
            if (!rawUrl) {
                ui.notifications.warn(t('origin-vault.upload.urlInvalid'));
                return;
            }

            const file = await this._fetchRemoteImageAsFile(rawUrl);
            if (!file) return;

            const preparedFiles = await this._prepareFilesForPending([file]);
            const result = await this._appendPreparedPendingFiles(preparedFiles);

            if (result.added > 0) {
                if (input) input.value = '';
                ui.notifications.info(tf('origin-vault.upload.urlAdded', { name: file.name }));
            } else {
                ui.notifications.warn(t('origin-vault.upload.urlNoNew'));
            }
        };

        overlay.querySelector('#ov-upload-add-url').addEventListener('click', () => {
            void submitUrlImport();
        });

        overlay.querySelector('#ov-upload-url-input').addEventListener('keydown', (event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            void submitUrlImport();
        });

        // 文件 input 变化
        overlay.querySelector('#ov-upload-file-input').addEventListener('change', async (e) => {
            if (e.target.files.length > 0) {
                await this._processFileList(e.target.files);
                this._renderFileList();
            }
        });

        overlay.querySelector('#ov-upload-folder-input').addEventListener('change', async (e) => {
            if (e.target.files.length > 0) {
                await this._processFileListWithPaths(e.target.files);
                this._renderFileList();
            }
        });

        // 拖放
        const dropzone = overlay.querySelector('#ov-upload-dropzone');
        dropzone.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropzone.classList.add('dragover');
        });
        dropzone.addEventListener('dragleave', (e) => {
            e.preventDefault();
            dropzone.classList.remove('dragover');
        });
        dropzone.addEventListener('drop', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropzone.classList.remove('dragover');

            if (e.dataTransfer.items) {
                const files = await this._readDataTransferItems(e.dataTransfer.items);
                this.pendingFiles.push(...files);
                this._renderFileList();
            } else if (e.dataTransfer.files.length > 0) {
                await this._processFileList(e.dataTransfer.files);
                this._renderFileList();
            }
        });

        // 优化复选框
        overlay.querySelector('#ov-upload-optimize').addEventListener('change', (e) => {
            this.optimizeImages = e.target.checked;
            overlay.querySelector('#ov-quality-slider-container').style.display =
                e.target.checked ? '' : 'none';
            this._renderFileList();
        });

        // 质量滑块 (实时更新预估体积)
        overlay.querySelector('#ov-upload-quality').addEventListener('input', (e) => {
            this.webpQuality = parseInt(e.target.value) / 100;
            overlay.querySelector('#ov-upload-quality-value').textContent = `${e.target.value}%`;
            this._recalcEstimates();
            this._renderFileList();
        });

        // 开始上传
        overlay.querySelector('#ov-upload-start').addEventListener('click', () => this._startUpload());

        // 路径选择
        overlay.querySelector('#ov-path-default').addEventListener('click', () => {
            this._useCustomPath = false;
            this._customUploadPath = null;
            // 恢复默认上传源和桶设置
            this._loadUploadTargetFromSettings();
            overlay.querySelector('#ov-path-default').classList.add('active');
            overlay.querySelector('#ov-path-custom').classList.remove('active');
            overlay.querySelector('#ov-upload-path-text').textContent = this._getDefaultUploadPath();
        });

        overlay.querySelector('#ov-path-custom').addEventListener('click', () => {
            this._openPathPicker();
        });

        // 标签
        overlay.querySelector('#ov-upload-add-tags').addEventListener('click', () => {
            this._openUploadTagPicker();
        });

        overlay.querySelector('#ov-upload-clear-clipboard').addEventListener('click', (event) => {
            event.preventDefault();
            this._clearClipboardPendingFiles();
        });

        overlay.querySelector('#ov-upload-clipboard-pastebox').addEventListener('click', (event) => {
            event.preventDefault();
            event.currentTarget.focus();
        });

        overlay.querySelector('#ov-upload-clipboard-grid').addEventListener('click', (event) => {
            const button = event.target.closest('[data-clipboard-signature]');
            if (!button) return;

            event.preventDefault();
            this._removeClipboardPendingFile(button.dataset.clipboardSignature || '');
        });

        this._boundPasteHandler = async (event) => {
            if (!this._overlay || this._isUploading) return;

            const files = this._extractClipboardFilesFromPasteEvent(event.clipboardData);
            if (!files.length) return;

            event.preventDefault();
            event.stopPropagation();
            await this._importClipboardFiles(files);
        };

        document.addEventListener('paste', this._boundPasteHandler, true);
    }

    // ─── 文件处理 ───

    /**
     * 处理 FileList (平铺文件)
     */
    async _processFileList(fileList) {
        for (const file of fileList) {
            if (!this._isSupportedFile(file.name)) continue;
            this.pendingFiles.push(this._createPendingFileEntry(file));
        }
    }

    /**
     * 处理 webkitdirectory 文件list (保留路径)
     */
    async _processFileListWithPaths(fileList) {
        for (const file of fileList) {
            if (!this._isSupportedFile(file.name)) continue;
            // webkitRelativePath 格式: "folder/subfolder/file.png"
            const relativePath = file.webkitRelativePath || file.name;
            this.pendingFiles.push(this._createPendingFileEntry(file, relativePath));
        }
    }

    /**
     * 递归读取 DataTransfer 项 (支持文件夹拖放)
     */
    async _readDataTransferItems(items) {
        const result = [];
        const entries = [];

        for (const item of items) {
            const entry = item.webkitGetAsEntry?.();
            if (entry) entries.push(entry);
        }

        const readEntry = async (entry, basePath = '') => {
            if (entry.isFile) {
                const file = await new Promise((resolve, reject) => {
                    entry.file(resolve, reject);
                });
                if (this._isSupportedFile(file.name)) {
                    const relativePath = basePath ? `${basePath}/${file.name}` : file.name;
                    result.push(this._createPendingFileEntry(file, relativePath));
                }
            } else if (entry.isDirectory) {
                const dirReader = entry.createReader();
                const dirEntries = await new Promise((resolve, reject) => {
                    const allEntries = [];
                    const readBatch = () => {
                        dirReader.readEntries((batch) => {
                            if (batch.length === 0) {
                                resolve(allEntries);
                            } else {
                                allEntries.push(...batch);
                                readBatch();
                            }
                        }, reject);
                    };
                    readBatch();
                });
                const dirPath = basePath ? `${basePath}/${entry.name}` : entry.name;
                for (const dirEntry of dirEntries) {
                    await readEntry(dirEntry, dirPath);
                }
            }
        };

        for (const entry of entries) {
            await readEntry(entry);
        }
        return result;
    }

    _createPendingFileEntry(file, relativePath = file.name, signature = null, options = {}) {
        const canOptimize = ImageOptimizer.canOptimize(file);
        return {
            file,
            relativePath,
            signature,
            source: options.source || 'file',
            previewUrl: options.previewUrl || null,
            canOptimize,
            estimatedSize: canOptimize ? ImageOptimizer.estimateOptimizedSize(file) : file.size
        };
    }

    _isSupportedFile(name) {
        const ext = name.substring(name.lastIndexOf('.')).toLowerCase();
        return SUPPORTED_EXTENSIONS.includes(ext);
    }

    async _appendPreparedPendingFiles(preparedEntries) {
        if (!Array.isArray(preparedEntries) || preparedEntries.length === 0) {
            return { added: 0, skipped: 0 };
        }

        let added = 0;
        let skipped = 0;

        for (const entry of preparedEntries) {
            if (this._hasPendingDuplicate(entry)) {
                this._revokePreviewUrl(entry.previewUrl);
                skipped++;
                continue;
            }

            this.pendingFiles.push(this._createPendingFileEntry(
                entry.file,
                entry.relativePath || entry.file.name,
                entry.signature || null,
                {
                    source: entry.source,
                    previewUrl: entry.previewUrl
                }
            ));
            added++;
        }

        if (added > 0) {
            this._renderFileList();
        } else {
            this._updateStartButtonState();
        }

        return { added, skipped };
    }

    _hasPendingDuplicate(entry) {
        const targetPath = entry.relativePath || entry.file?.name || '';
        const targetSignature = entry.signature || null;
        const targetSize = Number(entry.file?.size || 0);
        const targetType = String(entry.file?.type || '');

        return this.pendingFiles.some(item => {
            if (targetSignature && item.signature && item.signature === targetSignature) return true;
            return item.relativePath === targetPath
                && Number(item.file?.size || 0) === targetSize
                && String(item.file?.type || '') === targetType;
        });
    }

    async _prepareFilesForPending(files, {
        renameUnnamedPrefix = null,
        forceStableNamePrefix = null,
        source = 'file',
        attachPreview = false
    } = {}) {
        const prepared = [];
        let unnamedIndex = 1;

        for (const file of files) {
            const signature = await this._getFileSignature(file);
            let finalFile = file;

            if (forceStableNamePrefix) {
                finalFile = this._renameFile(finalFile, this._buildStableImportedFileName(
                    finalFile,
                    forceStableNamePrefix,
                    signature,
                    unnamedIndex
                ));
                unnamedIndex++;
            } else if (!finalFile?.name && renameUnnamedPrefix) {
                finalFile = this._renameFile(finalFile, this._buildStableImportedFileName(
                    finalFile,
                    renameUnnamedPrefix,
                    signature,
                    unnamedIndex
                ));
                unnamedIndex++;
            }

            prepared.push({
                file: finalFile,
                relativePath: finalFile.name,
                signature,
                source,
                previewUrl: attachPreview ? this._createPendingPreviewUrl(finalFile) : null
            });
        }

        return prepared;
    }

    async _getFileSignature(file) {
        const buffer = await file.arrayBuffer();
        const digest = await crypto.subtle.digest('SHA-256', buffer);
        const hashBytes = Array.from(new Uint8Array(digest))
            .slice(0, 8)
            .map(byte => byte.toString(16).padStart(2, '0'))
            .join('');
        return `${file.type || 'application/octet-stream'}:${file.size}:${hashBytes}`;
    }

    _renameFile(file, fileName) {
        return new File([file], fileName, {
            type: file?.type || 'application/octet-stream',
            lastModified: file?.lastModified || Date.now()
        });
    }

    _buildStableImportedFileName(file, prefix, signature, index = 1) {
        const rawName = String(file?.name || '').trim();
        const extensionFromName = rawName.includes('.')
            ? rawName.substring(rawName.lastIndexOf('.')).toLowerCase()
            : '';
        const extension = this._getMimeTypeFromExtension(extensionFromName)
            ? extensionFromName
            : (this._getExtensionFromMimeType(file?.type) || '.png');
        const token = String(signature || '').split(':').pop() || `image-${index}`;
        const stem = rawName
            ? this._sanitizeRemoteFileName(rawName.replace(/\.[^.]+$/, ''))
            : prefix;
        const safeStem = stem || prefix;
        return `${safeStem}-${token}${extension}`;
    }

    _createPendingPreviewUrl(file) {
        if (!this._isImageFile(file)) return null;

        try {
            return URL.createObjectURL(file);
        } catch {
            return null;
        }
    }

    _revokePreviewUrl(previewUrl) {
        if (!previewUrl) return;

        try {
            URL.revokeObjectURL(previewUrl);
        } catch {
            // Object URL may already be gone; that is safe to ignore.
        }
    }

    _revokeAllPendingPreviewUrls() {
        for (const item of this.pendingFiles) {
            this._revokePreviewUrl(item.previewUrl);
            item.previewUrl = null;
        }
    }

    _escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    _getClipboardPendingFiles() {
        return this.pendingFiles.filter(item => item.source === 'clipboard');
    }

    _getRegularPendingFiles() {
        return this.pendingFiles.filter(item => item.source !== 'clipboard');
    }

    _removeClipboardPendingFile(signature) {
        let removed = false;

        this.pendingFiles = this.pendingFiles.filter(item => {
            if (removed || item.source !== 'clipboard' || item.signature !== signature) return true;
            removed = true;
            this._revokePreviewUrl(item.previewUrl);
            return false;
        });

        if (removed) {
            this._renderFileList();
        } else {
            this._updateStartButtonState();
        }
    }

    _clearClipboardPendingFiles() {
        let removedCount = 0;

        this.pendingFiles = this.pendingFiles.filter(item => {
            if (item.source !== 'clipboard') return true;
            removedCount++;
            this._revokePreviewUrl(item.previewUrl);
            return false;
        });

        if (removedCount > 0) {
            this._renderFileList();
        } else {
            this._updateStartButtonState();
        }
    }

    _isImageFile(file) {
        if (!file) return false;

        const type = String(file.type || '').toLowerCase();
        if (type.startsWith('image/')) return true;

        const name = String(file.name || '');
        const dotIndex = name.lastIndexOf('.');
        const extension = dotIndex >= 0 ? name.substring(dotIndex).toLowerCase() : '';
        return FILE_TYPES.IMAGE.includes(extension);
    }

    _collectUniqueClipboardFiles(files) {
        const uniqueFiles = [];
        const seen = new Set();

        for (const file of Array.from(files || [])) {
            if (!this._isImageFile(file)) continue;

            const key = [
                String(file.name || ''),
                Number(file.size || 0),
                String(file.type || ''),
                Number(file.lastModified || 0)
            ].join('::');

            if (seen.has(key)) continue;
            seen.add(key);
            uniqueFiles.push(file);
        }

        return uniqueFiles;
    }

    _extractClipboardFilesFromPasteEvent(clipboardData) {
        const items = Array.from(clipboardData?.items || []);
        const itemFiles = [];

        for (const item of items) {
            if (item?.kind !== 'file') continue;

            const file = item.getAsFile?.();
            if (file) itemFiles.push(file);
        }

        // Browser copy operations usually expose the freshest image payload on clipboard items,
        // while DataTransfer.files can lag behind and repeat an older copied image in Electron.
        const filesFromItems = this._collectUniqueClipboardFiles(itemFiles);
        if (filesFromItems.length) return filesFromItems;

        return this._collectUniqueClipboardFiles(clipboardData?.files);
    }

    async _importClipboardFiles(files) {
        const preparedFiles = await this._prepareFilesForPending(files, {
            forceStableNamePrefix: 'clipboard-image',
            source: 'clipboard',
            attachPreview: true
        });
        const result = await this._appendPreparedPendingFiles(preparedFiles);

        if (result.added > 0) {
            ui.notifications.info(tf('origin-vault.upload.pasteAdded', { count: result.added }));
            return;
        }

        ui.notifications.warn(t('origin-vault.upload.pasteNoNew'));
    }

    async _fetchRemoteImageAsFile(rawUrl, { notify = true, manageBusy = true } = {}) {
        let normalizedUrl = rawUrl;

        try {
            normalizedUrl = this._normalizeRemoteUrl(rawUrl);
        } catch (error) {
            if (notify) ui.notifications.warn(t('origin-vault.upload.urlInvalid'));
            return null;
        }

        if (manageBusy) {
            this._setRemoteImportBusy(true);
        }

        try {
            const response = await fetch(normalizedUrl, {
                method: 'GET',
                mode: 'cors',
                credentials: 'omit'
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const blob = await response.blob();
            const fileName = this._buildRemoteFileName(normalizedUrl, blob);
            const extension = fileName.includes('.')
                ? fileName.substring(fileName.lastIndexOf('.')).toLowerCase()
                : '';
            const mimeType = blob.type || this._getMimeTypeFromExtension(extension) || 'application/octet-stream';

            return new File([blob], fileName, { type: mimeType });
        } catch (error) {
            console.warn(`${MODULE_ID} | Failed to fetch remote asset: ${normalizedUrl}`, error);
            const message = this._getRemoteFetchErrorMessage(error);
            if (notify) ui.notifications.warn(message);
            return null;
        } finally {
            if (manageBusy) {
                this._setRemoteImportBusy(false);
            }
        }
    }

    _normalizeRemoteUrl(rawUrl) {
        const url = new URL(String(rawUrl || '').trim());
        if (!['http:', 'https:'].includes(url.protocol)) {
            throw new Error('Unsupported URL protocol');
        }
        return url.toString();
    }

    _buildRemoteFileName(rawUrl, blob) {
        const url = new URL(rawUrl);
        const rawName = decodeURIComponent(url.pathname.split('/').pop() || '').trim();
        let fileName = this._sanitizeRemoteFileName(rawName);
        const mimeType = String(blob?.type || '').toLowerCase();
        const extension = fileName.includes('.')
            ? fileName.substring(fileName.lastIndexOf('.')).toLowerCase()
            : '';
        const isImageMime = mimeType.startsWith('image/');
        const canFallbackToExtension = !mimeType || mimeType === 'application/octet-stream';
        const hasImageExtension = FILE_TYPES.IMAGE.includes(extension);

        if (!fileName) {
            const fallbackExtension = this._getExtensionFromMimeType(mimeType) || '.png';
            fileName = `remote-image-${Date.now()}${fallbackExtension}`;
        }

        if (!isImageMime && !(canFallbackToExtension && hasImageExtension)) {
            throw new Error(t('origin-vault.upload.urlNotImage'));
        }

        if (!this._isSupportedFile(fileName)) {
            const fallbackExtension = this._getExtensionFromMimeType(mimeType);
            if (fallbackExtension) {
                fileName = extension
                    ? fileName.replace(/\.[^.]+$/, fallbackExtension)
                    : `${fileName}${fallbackExtension}`;
            }
        }

        if (!this._isSupportedFile(fileName)) {
            throw new Error(t('origin-vault.upload.urlUnsupportedType'));
        }

        return fileName;
    }

    _sanitizeRemoteFileName(name) {
        return String(name || '')
            .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
            .replace(/\s+/g, ' ')
            .trim();
    }

    _getExtensionFromMimeType(mimeType) {
        return URL_MIME_EXTENSION_MAP[String(mimeType || '').toLowerCase()] || '';
    }

    _getMimeTypeFromExtension(extension) {
        return URL_EXTENSION_MIME_MAP[String(extension || '').toLowerCase()] || '';
    }

    _getRemoteFetchErrorMessage(error) {
        const message = String(error?.message || '');
        if (message === t('origin-vault.upload.urlNotImage')) return message;
        if (message === t('origin-vault.upload.urlUnsupportedType')) return message;
        if (error instanceof TypeError || /Failed to fetch|NetworkError|Load failed/i.test(message)) {
            return t('origin-vault.upload.urlCorsBlocked');
        }
        return tf('origin-vault.upload.urlFetchFailed', { message: message || ovText('Unknown error', 'Неизвестная ошибка') });
    }

    _setRemoteImportBusy(isBusy) {
        this._isFetchingRemote = isBusy;

        const overlay = this._overlay;
        if (!overlay) return;

        const input = overlay.querySelector('#ov-upload-url-input');
        const button = overlay.querySelector('#ov-upload-add-url');

        if (input) {
            input.disabled = isBusy;
        }

        if (button) {
            button.disabled = isBusy;
            button.innerHTML = isBusy
                ? `<i class="fas fa-spinner fa-spin"></i> ${t('origin-vault.upload.urlFetching')}`
                : `<i class="fas fa-link"></i> ${t('origin-vault.upload.addUrl')}`;
        }

        this._updateStartButtonState();
    }

    _updateStartButtonState() {
        const startBtn = this._overlay?.querySelector('#ov-upload-start');
        if (!startBtn) return;
        startBtn.disabled = this._isUploading || this._isFetchingRemote || this.pendingFiles.length === 0;
    }

    // ─── 文件列表渲染 ───

    /**
     * 根据当前质量设置重新计算预估大小
     */
    _recalcEstimates() {
        // 质量越高体积越大: quality=0.5 → 系数0.25, quality=0.85 → 系数0.5, quality=1.0 → 系数0.8
        const qualityFactor = 0.15 + this.webpQuality * 0.65;
        for (const item of this.pendingFiles) {
            if (item.canOptimize) {
                const baseRatio = this._getBaseCompressionRatio(item.file.type);
                item.estimatedSize = Math.round(item.file.size * baseRatio * (qualityFactor / 0.5));
            }
        }
    }

    _getBaseCompressionRatio(mimeType) {
        if (mimeType === 'image/png') return 0.35;
        if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') return 0.70;
        if (mimeType === 'image/bmp') return 0.1;
        return 0.5;
    }

    _renderFileList() {
        if (!this._overlay) return;

        this._updateStartButtonState();

        const container = this._overlay.querySelector('#ov-upload-file-list-container');
        const listEl = this._overlay.querySelector('#ov-upload-file-list');
        const summaryEl = this._overlay.querySelector('#ov-upload-summary');
        const regularFiles = this._getRegularPendingFiles();

        this._renderClipboardSection();

        if (this.pendingFiles.length === 0) {
            container.style.display = 'none';
            listEl.innerHTML = '';
            summaryEl.innerHTML = '';
            return;
        }

        if (regularFiles.length === 0) {
            container.style.display = 'none';
            listEl.innerHTML = '';
            summaryEl.innerHTML = '';
            return;
        }

        container.style.display = '';

        // 统计
        let totalOriginal = 0;
        let totalEstimated = 0;
        let optimizableCount = 0;

        for (const item of regularFiles) {
            totalOriginal += item.file.size;
            if (this.optimizeImages && item.canOptimize) {
                totalEstimated += item.estimatedSize;
                optimizableCount++;
            } else {
                totalEstimated += item.file.size;
            }
        }

        const savings = totalOriginal - totalEstimated;
        const pctSaved = totalOriginal > 0 ? Math.round((savings / totalOriginal) * 100) : 0;

        summaryEl.innerHTML = `
      <span>${tf('origin-vault.upload.selectedCount', { count: regularFiles.length })}
      (${ImageOptimizer.formatSize(totalOriginal)})</span>
      ${this.optimizeImages && optimizableCount > 0 ? `
      <span class="ov-upload-savings">
        → ${ImageOptimizer.formatSize(totalEstimated)} 
        <span class="savings-badge">-${pctSaved}%</span>
      </span>` : ''}
    `;

        // 文件列表 (最多显示100项)
        const displayFiles = regularFiles.slice(0, 100);
        listEl.innerHTML = displayFiles.map(item => {
            const icon = this._getFileIcon(item.file.name);
            const sizeStr = ImageOptimizer.formatSize(item.file.size);
            const willOptimize = this.optimizeImages && item.canOptimize;
            const newName = willOptimize ? item.file.name.replace(/\.[^.]+$/, '.webp') : item.file.name;

            return `
        <div class="ov-upload-file-item ${willOptimize ? 'will-optimize' : ''}">
          <i class="${icon}"></i>
          <span class="file-name" title="${item.relativePath}">${this._truncatePath(item.relativePath, 45)}</span>
          <span class="file-size">${sizeStr}</span>
          ${willOptimize ? `<span class="optimize-badge">→ .webp</span>` : ''}
        </div>`;
        }).join('');

        if (regularFiles.length > 100) {
            listEl.innerHTML += `<div class="ov-upload-more">... ${tf('origin-vault.upload.andMore', { count: regularFiles.length - 100 })}</div>`;
        }
    }

    _renderClipboardSection() {
        const section = this._overlay?.querySelector('#ov-upload-clipboard-section');
        const body = this._overlay?.querySelector('#ov-upload-clipboard-body');
        const grid = this._overlay?.querySelector('#ov-upload-clipboard-grid');
        const summary = this._overlay?.querySelector('#ov-upload-clipboard-summary');
        const clearButton = this._overlay?.querySelector('#ov-upload-clear-clipboard');
        if (!section || !body || !grid || !summary || !clearButton) return;

        const clipboardItems = this._getClipboardPendingFiles();
        section.style.display = '';

        if (clipboardItems.length === 0) {
            body.style.display = 'none';
            grid.innerHTML = '';
            summary.textContent = '';
            clearButton.disabled = true;
            return;
        }

        const totalSize = clipboardItems.reduce((sum, item) => sum + Number(item.file?.size || 0), 0);
        body.style.display = '';
        summary.textContent = `${tf('origin-vault.upload.selectedCount', { count: clipboardItems.length })} (${ImageOptimizer.formatSize(totalSize)})`;
        clearButton.disabled = this._isUploading;

        grid.innerHTML = clipboardItems.map(item => {
            const escapedName = this._escapeHtml(item.file.name);
            const escapedSignature = this._escapeHtml(item.signature || item.file.name);
            const preview = item.previewUrl
                ? `<img src="${this._escapeHtml(item.previewUrl)}" alt="${escapedName}">`
                : `<div class="ov-upload-clipboard-fallback"><i class="fas fa-image"></i></div>`;

            return `
        <div class="ov-upload-clipboard-card">
          <div class="ov-upload-clipboard-preview">${preview}</div>
          <div class="ov-upload-clipboard-meta">
            <div class="ov-upload-clipboard-name" title="${escapedName}">${this._escapeHtml(this._truncatePath(item.file.name, 28))}</div>
            <div class="ov-upload-clipboard-size">${ImageOptimizer.formatSize(item.file.size)}</div>
          </div>
          <button
            class="ov-upload-clipboard-remove"
            type="button"
            data-clipboard-signature="${escapedSignature}"
            title="${this._escapeHtml(t('origin-vault.upload.removeClipboardItem'))}"
          >
            <i class="fas fa-times"></i>
          </button>
        </div>`;
        }).join('');
    }

    _getFileIcon(name) {
        const ext = name.substring(name.lastIndexOf('.')).toLowerCase();
        if (FILE_TYPES.IMAGE.includes(ext)) return 'fas fa-image';
        if (FILE_TYPES.VIDEO.includes(ext)) return 'fas fa-video';
        if (FILE_TYPES.AUDIO.includes(ext)) return 'fas fa-music';
        if (FILE_TYPES.SCENE.includes(ext)) return 'fas fa-map';
        return 'fas fa-file';
    }

    _truncatePath(path, max) {
        if (path.length <= max) return path;
        return '...' + path.slice(-max + 3);
    }

    // ─── 上传流程 ───

    async _startUpload() {
        if (this._isUploading || this.pendingFiles.length === 0) return;
        this._isUploading = true;

        const overlay = this._overlay;
        const progressEl = overlay.querySelector('#ov-upload-progress');
        const progressFill = overlay.querySelector('#ov-upload-progress-fill');
        const progressStatus = overlay.querySelector('#ov-upload-progress-status');
        const progressDetail = overlay.querySelector('#ov-upload-progress-detail');
        const startBtn = overlay.querySelector('#ov-upload-start');
        const cancelBtn = overlay.querySelector('#ov-upload-cancel');

        // 切换到进度模式
        overlay.querySelector('#ov-upload-dropzone').style.display = 'none';
        overlay.querySelector('.ov-upload-options').style.display = 'none';
        overlay.querySelector('#ov-upload-file-list-container').style.display = 'none';
        progressEl.style.display = '';
        startBtn.disabled = true;
        cancelBtn.disabled = true;

        const total = this.pendingFiles.length;
        let completed = 0;
        let successCount = 0;
        let errorCount = 0;
        const uploadedPaths = []; // 收集Foundry路径用于 addItems

        // 上传存储源：自定义路径 > 设置 > 默认 data
        let uploadSource = this._uploadSource || 'data';
        let uploadBucket = this._uploadBucket || '';

        if (uploadSource === 's3' && !uploadBucket) {
            const configuredBucket = game.settings.get(MODULE_ID, SETTINGS.S3_BUCKET) || '';
            if (configuredBucket) {
                uploadBucket = configuredBucket;
            } else {
                console.warn(`${MODULE_ID} | Upload source resolved to s3 without a bucket. Falling back to data.`);
                uploadSource = 'data';
            }
        }

        const uploadOptions = (uploadSource === 's3' && uploadBucket)
            ? { bucket: uploadBucket }
            : {};

        ovLog(`${MODULE_ID} | Upload source: ${uploadSource}, bucket: ${uploadBucket || 'N/A'}`);

        // 确定上传根目录: 优先使用本次自定义路径 > 设置中的路径 > 默认路径
        const settingsUploadPath = game.settings.get(MODULE_ID, SETTINGS.UPLOAD_PATH);
        const rawUploadRoot = (this._useCustomPath && this._customUploadPath)
            ? this._customUploadPath
            : (settingsUploadPath || `${this.library.basePath}/uploads`);
        // 文件系统操作使用 FilePicker 返回的原始路径，避免中文路径被错误解码后无法保存。
        const uploadRoot = rawUploadRoot;
        const ensuredDirs = new Set();

        const ensureDir = async (dirPath) => {
            if (ensuredDirs.has(dirPath)) return;
            try {
                await browseFilePicker(uploadSource, dirPath, uploadOptions);
            } catch {
                try {
                    await createFilePickerDirectory(uploadSource, dirPath, uploadOptions);
                } catch { /* exists */ }
            }
            ensuredDirs.add(dirPath);
        };

        // 确保根目录存在
        await ensureDir(uploadRoot);

        const UPLOAD_CONCURRENCY = 5;

        for (let i = 0; i < total; i += UPLOAD_CONCURRENCY) {
            const batch = this.pendingFiles.slice(i, i + UPLOAD_CONCURRENCY);

            const results = await Promise.allSettled(batch.map(async (item) => {
                try {
                    let fileToUpload = item.file;
                    let targetName = item.file.name;

                    // 优化图片
                    if (this.optimizeImages && item.canOptimize) {
                        const result = await ImageOptimizer.optimize(item.file, {
                            quality: this.webpQuality
                        });
                        if (!result.skipped) {
                            fileToUpload = result.file;
                            targetName = result.file.name;
                        }
                    }

                    // 计算上传路径
                    const pathParts = item.relativePath.split('/');
                    const fileName = pathParts.pop();
                    const subDir = pathParts.length > 0 ? '/' + pathParts.join('/') : '';
                    const uploadDir = uploadRoot + subDir;

                    // 确保子目录存在
                    if (subDir) {
                        let cumulative = uploadRoot;
                        for (const part of pathParts) {
                            cumulative += '/' + part;
                            await ensureDir(cumulative);
                        }
                    }

                    // 如果图片被优化了, 文件名已改
                    const finalName = (this.optimizeImages && item.canOptimize && !fileToUpload.name.endsWith(fileName))
                        ? fileToUpload.name // 使用优化后的 .webp 文件名
                        : fileName;

                    // 创建Foundry能接受的File对象
                    const uploadFile = new File([fileToUpload], finalName, { type: fileToUpload.type });

                    // 上传
                    const uploadResult = await uploadWithFilePicker(uploadSource, uploadDir, uploadFile, uploadOptions, { notify: false });

                    if (uploadResult?.path) {
                        return { success: true, path: uploadResult.path };
                    }
                    // FP.upload 可能不返回 path, 手动构建
                    const constructedPath = `${uploadDir}/${finalName}`;
                    return { success: true, path: constructedPath };
                } catch (error) {
                    console.error(`${MODULE_ID} | Upload failed for ${item.relativePath}:`, error);
                    return { success: false, error: error.message };
                }
            }));

            // 统计
            for (let ri = 0; ri < results.length; ri++) {
                const result = results[ri];
                completed++;
                if (result.status === 'fulfilled' && result.value.success) {
                    successCount++;
                    // 虚拟文件夹（__all__ 等）不能作为素材容器，降级到 root
                    const safeFolderId = this.targetFolderId.startsWith('__') ? 'root' : this.targetFolderId;
                    uploadedPaths.push({
                        path: result.value.path,
                        folderId: safeFolderId,
                        relativePath: batch[ri].relativePath
                    });
                } else {
                    errorCount++;
                }
            }

            // 更新进度
            const pct = Math.round((completed / total) * 100);
            progressFill.style.width = `${pct}%`;
            progressStatus.textContent = tf('origin-vault.upload.progressUploading', {
                current: completed, total
            });
            progressDetail.textContent = `${successCount} ${t('origin-vault.upload.success')}` +
                (errorCount > 0 ? `, ${errorCount} ${t('origin-vault.upload.failed')}` : '');
        }

        // 注册到 Origin Vault 元数据
        if (uploadedPaths.length > 0) {
            progressStatus.textContent = t('origin-vault.upload.registering');
            progressFill.style.width = '100%';

            // ★ 根据上传文件的相对路径，在 OV 中创建对应的文件夹层级
            this._resolveUploadFolders(uploadedPaths);

            try {
                const result = await this.library.addItems(uploadedPaths, (current, total) => {
                    progressDetail.textContent = tf('origin-vault.upload.registeringProgress', {
                        current, total
                    });
                });

                // 生成缩略图
                progressStatus.textContent = t('origin-vault.notifications.generatingThumbnails');
                progressFill.style.width = '0%';

                const itemsForThumbnails = [];
                for (const { path } of uploadedPaths) {
                    const item = this.library.getItemByPath(path);
                    if (item && !item.thumbnailGenerated) {
                        itemsForThumbnails.push(item);
                    }
                }

                if (itemsForThumbnails.length > 0) {
                    const thumbnailManager = ThumbnailManager.getInstance();
                    await thumbnailManager.generateBatch(itemsForThumbnails, (current, total) => {
                        const pct = Math.round((current / total) * 100);
                        progressFill.style.width = `${pct}%`;
                        progressDetail.textContent = `${current} / ${total}`;
                    }, false, this.library);
                }

                // 完成
                this._didUpload = true;
                progressStatus.innerHTML = `<i class="fas fa-check-circle" style="color: #4caf50;"></i> ${tf('origin-vault.upload.complete', { count: successCount })}`;
                progressFill.style.width = '100%';
                progressFill.style.background = '#4caf50';

                ui.notifications.info(tf('origin-vault.upload.complete', { count: successCount }));
            } catch (error) {
                console.error(`${MODULE_ID} | Registration error:`, error);
                progressStatus.textContent = t('origin-vault.upload.registrationError');
            }
        }

        // 上传完成后：为所有新素材打标签
        if (this._uploadTags.length > 0 && uploadedPaths.length > 0) {
            progressStatus.textContent = t('origin-vault.upload.applyingTags') || ovText('Applying tags...', 'Применение меток…');
            for (const { path } of uploadedPaths) {
                const item = this.library.getItemByPath(path);
                if (item) {
                    for (const tagId of this._uploadTags) {
                        await this.library.addTagToItem(item.id, tagId);
                    }
                }
            }
        }

        // 上传完成后自动关闭
        this._isUploading = false;
        this._uploadedPaths = uploadedPaths;
        setTimeout(() => this.close(), 1500);

        return { success: successCount, errors: errorCount, paths: uploadedPaths };
    }

    // ─── 辅助方法 ───

    /**
     * 获取默认上传路径显示文本
     */
    _getConfiguredUploadPath() {
        return game.settings.get(MODULE_ID, SETTINGS.UPLOAD_PATH) || `${this.library.basePath}/uploads`;
    }

    _getDefaultUploadPath() {
        const path = this._getConfiguredUploadPath();
        const source = game.settings.get(MODULE_ID, SETTINGS.UPLOAD_SOURCE) || 'data';
        const bucket = game.settings.get(MODULE_ID, SETTINGS.S3_BUCKET) || '';
        const displayPath = decodeURIComponent(path);
        return (source === 's3' && bucket)
            ? `[S3: ${bucket}] ${displayPath}`
            : displayPath;
    }

    /**
     * 打开原生文件夹选择器选择自定义路径
     */
    _openPathPicker() {
        const fp = createFilePickerApp({
            type: 'folder',
            current: this._getConfiguredUploadPath(),
            callback: (path) => {
                if (path) {
                    this._useCustomPath = true;
                    this._customUploadPath = path;

                    // 检测文件选择器当前使用的源和桶
                    // Foundry FilePicker 实例上有 activeSource 属性
                    const pickerSource = fp.activeSource || 'data';
                    if (pickerSource === 's3') {
                        this._uploadSource = 's3';
                        // Foundry FilePicker 的 result 对象或 _bucket 中包含桶名
                        this._uploadBucket = fp.result?.bucket || fp._bucket || this._uploadBucket || '';
                    } else {
                        this._uploadSource = pickerSource;
                        this._uploadBucket = '';
                    }

                    ovLog(`${MODULE_ID} | Path picker selected: source=${this._uploadSource}, bucket=${this._uploadBucket}, path=${path}`);

                    const overlay = this._overlay;
                    if (!overlay) return;
                    overlay.querySelector('#ov-path-default').classList.remove('active');
                    overlay.querySelector('#ov-path-custom').classList.add('active');
                    const displayPath = this._uploadSource === 's3'
                        ? `[S3: ${this._uploadBucket}] ${decodeURIComponent(path)}`
                        : decodeURIComponent(path);
                    overlay.querySelector('#ov-upload-path-text').textContent = displayPath;
                }
            }
        });
        // 标记跳过 OV 拦截
        fp._ovSkipIntercept = true;

        // 记录打开前已有的窗口，后面只接管这次 FilePicker 和它派生的新窗口。
        const existingWindows = new Set(document.querySelectorAll(NATIVE_PICKER_WINDOW_QUERY));
        fp.render(true);
        this._startNativePickerLayerSession(fp, existingWindows);
    }

    /**
     * 打开简化版标签选择器（仅最近使用 + 当前文件夹）
     */
    _openUploadTagPicker() {
        const tempSelected = new Set(this._uploadTags);
        const allTags = this.library.getAllTags() || {};
        const PRESET_COLORS = [
            '#e74c3c', '#e67e22', '#f1c40f', '#2ecc71', '#1abc9c',
            '#3498db', '#9b59b6', '#34495e', '#ecf0f1', '#95a5a6'
        ];

        const buildList = (searchTerm = '') => {
            const lowerSearch = searchTerm.toLowerCase();
            let html = '';

            if (searchTerm) {
                // 搜索模式：显示所有匹配标签
                const matching = Object.values(allTags).filter(t =>
                    t.name.toLowerCase().includes(lowerSearch)
                );
                const hasExact = matching.some(t => t.name.toLowerCase() === lowerSearch);

                matching.forEach(tag => {
                    const sel = tempSelected.has(tag.id) ? 'selected' : '';
                    html += `<div class="ov-tag-chip ${sel}" data-tag-id="${tag.id}">
                        <span class="tag-color-dot" style="background: ${tag.color || '#808080'}"></span>
                        <span class="tag-name">${tag.name}</span>
                        ${sel ? '<i class="fas fa-check"></i>' : ''}
                    </div>`;
                });

                if (!hasExact && searchTerm.length > 0) {
                    html += `<div class="ov-tag-chip create-new" data-new-name="${searchTerm}">
                        <i class="fas fa-plus"></i>
                        <span class="tag-name">${t('origin-vault.tags.createNew')}: "${searchTerm}"</span>
                    </div>`;
                }
                return html;
            }

            // 非搜索：只显示最近使用和当前文件夹
            const recentTags = this.library.getRecentTags(8);
            if (recentTags.length > 0) {
                html += `<div class="ov-tag-section">
                    <div class="ov-tag-section-title"><i class="fas fa-clock"></i> ${t('origin-vault.tags.recent')}</div>
                    <div class="ov-tag-section-content ov-tag-chips">`;
                recentTags.forEach(tag => {
                    const sel = tempSelected.has(tag.id) ? 'selected' : '';
                    html += `<div class="ov-tag-chip ${sel}" data-tag-id="${tag.id}">
                        <span class="tag-color-dot" style="background: ${tag.color || '#808080'}"></span>
                        <span class="tag-name">${tag.name}</span>
                        ${sel ? '<i class="fas fa-check"></i>' : ''}
                    </div>`;
                });
                html += `</div></div>`;
            }

            const folderTags = this.library.getTagsUsedInFolder(this.targetFolderId);
            if (folderTags.length > 0) {
                html += `<div class="ov-tag-section">
                    <div class="ov-tag-section-title"><i class="fas fa-folder"></i> ${t('origin-vault.tags.folderTags')}</div>
                    <div class="ov-tag-section-content ov-tag-chips">`;
                folderTags.forEach(tag => {
                    const sel = tempSelected.has(tag.id) ? 'selected' : '';
                    html += `<div class="ov-tag-chip ${sel}" data-tag-id="${tag.id}">
                        <span class="tag-color-dot" style="background: ${tag.color || '#808080'}"></span>
                        <span class="tag-name">${tag.name}</span>
                        ${sel ? '<i class="fas fa-check"></i>' : ''}
                    </div>`;
                });
                html += `</div></div>`;
            }

            if (!html) {
                html = `<div style="color: #666; text-align: center; padding: 16px; font-size: 12px;">${t('origin-vault.tags.noTags')}</div>`;
            }
            return html;
        };

        // 创建弹窗
        const popup = document.createElement('div');
        popup.className = 'ov-upload-tag-popup';
        popup.innerHTML = `
            <div class="ov-upload-tag-popup-inner">
                <div class="ov-upload-tag-popup-header">
                    <span><i class="fas fa-tags"></i> ${t('origin-vault.upload.addTags')}</span>
                    <button class="ov-upload-tag-popup-close"><i class="fas fa-times"></i></button>
                </div>
                <input type="text" class="ov-tag-search" placeholder="${t('origin-vault.tags.search')}">
                <div class="ov-upload-tag-popup-list">${buildList()}</div>
                <div class="ov-upload-tag-popup-footer">
                    <span class="ov-tag-summary">${t('origin-vault.ui.selected')}: <span class="count">${tempSelected.size}</span></span>
                    <button class="ov-btn primary">${t('origin-vault.dialog.confirm')}</button>
                </div>
            </div>
        `;

        document.body.appendChild(popup);
        popup.style.zIndex = this._reserveDialogZIndex();
        setTimeout(() => popup.classList.add('active'), 10);

        const search = popup.querySelector('.ov-tag-search');
        const list = popup.querySelector('.ov-upload-tag-popup-list');
        const countSpan = popup.querySelector('.count');

        const updateCount = () => countSpan.textContent = tempSelected.size;

        const findExactTag = (name) => {
            const lowerName = String(name || '').trim().toLowerCase();
            if (!lowerName) return null;
            return Object.values(allTags).find(tag => tag.name.toLowerCase() === lowerName) || null;
        };

        const addTagFromSearch = (name) => {
            const tagName = String(name || '').trim();
            if (!tagName) return null;

            const existingTag = findExactTag(tagName);
            if (existingTag) {
                tempSelected.add(existingTag.id);
                return existingTag.id;
            }

            const color = PRESET_COLORS[Math.floor(Math.random() * PRESET_COLORS.length)];
            const newId = this.library.createTag(tagName, color);
            allTags[newId] = { id: newId, name: tagName, color };
            tempSelected.add(newId);
            ui.notifications.info(tf('origin-vault.tags.createSuccess', { name: tagName }));
            return newId;
        };

        const closePopup = (apply) => {
            if (apply) {
                this._uploadTags = Array.from(tempSelected);
                this._renderUploadTags();
            }
            popup.classList.remove('active');
            setTimeout(() => popup.remove(), 200);
        };

        // 搜索
        search.addEventListener('input', () => {
            list.innerHTML = buildList(search.value.trim());
        });

        search.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' || e.isComposing) return;

            e.preventDefault();
            e.stopPropagation();

            const tagId = addTagFromSearch(search.value);
            if (!tagId) return;

            search.value = '';
            list.innerHTML = buildList('');
            updateCount();
        });

        // 点击标签
        list.addEventListener('click', (e) => {
            const chip = e.target.closest('.ov-tag-chip');
            if (!chip) return;

            // 创建新标签
            if (chip.classList.contains('create-new')) {
                const name = chip.dataset.newName;
                if (!addTagFromSearch(name)) return;
                search.value = '';
                list.innerHTML = buildList('');
                updateCount();
                return;
            }

            const tagId = chip.dataset.tagId;
            if (!tagId) return;
            if (tempSelected.has(tagId)) {
                tempSelected.delete(tagId);
            } else {
                tempSelected.add(tagId);
            }
            list.innerHTML = buildList(search.value.trim());
            updateCount();
        });

        // 关闭/确认
        popup.querySelector('.ov-upload-tag-popup-close').addEventListener('click', () => closePopup(false));
        popup.querySelector('.ov-btn.primary').addEventListener('click', () => closePopup(true));
        popup.addEventListener('mousedown', (e) => {
            if (e.target === popup) closePopup(false);
        });

        search.focus();
    }

    /**
     * 渲染已选上传标签芯片
     */
    _renderUploadTags() {
        const container = this._overlay?.querySelector('#ov-upload-tags-chips');
        if (!container) return;

        if (this._uploadTags.length === 0) {
            container.innerHTML = `<span class="ov-upload-tags-empty">${t('origin-vault.upload.noTags') || ovText('No tags', 'Без меток')}</span>`;
            return;
        }

        const allTags = this.library.getAllTags() || {};
        container.innerHTML = this._uploadTags.map(tagId => {
            const tag = allTags[tagId];
            if (!tag) return '';
            return `<span class="ov-upload-tag-chip">
                <span class="tag-color-dot" style="background: ${tag.color || '#808080'}"></span>
                ${tag.name}
                <i class="fas fa-times ov-upload-tag-remove" data-tag-id="${tagId}"></i>
            </span>`;
        }).join('');

        // 删除标签
        container.querySelectorAll('.ov-upload-tag-remove').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = btn.dataset.tagId;
                this._uploadTags = this._uploadTags.filter(t => t !== id);
                this._renderUploadTags();
            });
        });
    }

    // ─── 关闭 ───

    close() {
        if (this._isUploading) return;
        this._stopNativePickerLayerSession();
        if (this._boundPasteHandler) {
            document.removeEventListener('paste', this._boundPasteHandler, true);
            this._boundPasteHandler = null;
        }
        this._revokeAllPendingPreviewUrls();
        if (this._overlay) {
            this._overlay.classList.remove('active');
            setTimeout(() => {
                this._overlay?.remove();
                this._overlay = null;
            }, 200);
        }
        // 仅在实际上传过文件时才触发刷新回调，传递上传路径
        if (this._onClose && this._didUpload) this._onClose(this._uploadedPaths || []);
    }

    /**
     * 根据上传文件的相对路径，在 OV 中创建对应的文件夹层级
     * 例如 relativePath = "Maps/Dungeons/cave.webp"
     * → 创建 Maps 文件夹（父=targetFolderId）
     * → 创建 Dungeons 文件夹（父=Maps）
     * → 将文件分配到 Dungeons 文件夹
     * @param {Array<{path: string, folderId: string, relativePath: string}>} uploadedPaths
     */
    _resolveUploadFolders(uploadedPaths) {
        // 文件夹路径 → OV 文件夹 ID 的缓存
        const folderCache = new Map();

        // 虚拟文件夹（__all__、__untagged__ 等）不能作为父文件夹，降级到 root
        const baseParentId = this.targetFolderId.startsWith('__') ? 'root' : this.targetFolderId;

        for (const item of uploadedPaths) {
            if (!item.relativePath) continue;

            const parts = item.relativePath.split('/');
            if (parts.length <= 1) continue; // 无子目录，使用默认 targetFolderId

            // 去掉文件名，只保留目录部分
            const dirParts = parts.slice(0, -1);

            // 逐级创建文件夹
            let parentId = baseParentId;
            let cumulativePath = '';

            for (const dirName of dirParts) {
                cumulativePath = cumulativePath ? `${cumulativePath}/${dirName}` : dirName;

                if (folderCache.has(cumulativePath)) {
                    parentId = folderCache.get(cumulativePath);
                } else {
                    const folderId = this.library.createFolder(parentId, dirName);
                    folderCache.set(cumulativePath, folderId);
                    parentId = folderId;
                }
            }

            // 更新该文件的目标文件夹
            item.folderId = parentId;
        }
    }

    /**
     * 设置关闭回调
     */
    onClose(callback) {
        this._onClose = callback;
        return this;
    }
}
