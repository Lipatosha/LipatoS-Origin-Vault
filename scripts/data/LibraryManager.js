/**
 * Origin Vault - 资源库管理器
 * 负责管理多个资源库实例和全局资源库注册表
 */

import { MODULE_ID, IS_MAD_EDITION, DEFAULT_DATA_PATH, GLOBAL_DATA_PATH, GLOBAL_REGISTRY_FILE, MAD_GLOBAL_REGISTRY_FILE, MAD_WORLD_REGISTRY_FILE, LIBRARIES_REGISTRY, SETTINGS, EVENTS, MAX_RECENT_LIBRARIES, OV_LAYERS } from '../constants.js';

import { FILE_TYPES } from '../constants.js';
import { ThumbnailManager } from '../utils/ThumbnailManager.js';
import { browseFilePicker, createFilePickerDirectory, uploadWithFilePicker } from '../utils/filePicker.js';
import { t, tf } from '../utils/i18n.js';
import { appendToOverlayHost } from '../utils/overlayHost.js';
import { ovLog } from '../utils/logger.js';

function isProbablyAlreadyExistsError(error) {
    const message = String(error?.message || error || '').toLowerCase();
    return /already exists|alreadyexist|exists|eexist|conflict|409|已存在/.test(message);
}

export class LibraryManager {
    /** @type {LibraryManager} */
    static #instance = null;

    /**
     * 获取单例实例
     * @returns {LibraryManager}
     */
    static getInstance() {
        if (!LibraryManager.#instance) {
            LibraryManager.#instance = new LibraryManager();
        }
        return LibraryManager.#instance;
    }

    constructor() {
        if (LibraryManager.#instance) {
            throw new Error('LibraryManager is a singleton. Use LibraryManager.getInstance()');
        }

        /** @type {object} 世界资源库注册表（存储在 game.settings，按世界隔离） */
        this.registry = null;

        /** @type {object|null} 全局资源库注册表（存储在文件系统，跨世界共享） */
        this.globalRegistry = null;

        /** @type {object|null} MAD 版全局注册表（完整版也能直接管理这批库） */
        this.madGlobalRegistry = null;

        /** @type {object|null} MAD 版当前世界注册表（避免和 MAD 全局库混在一起串味） */
        this.madWorldRegistry = null;

        /** @type {boolean} 是否已加载 */
        this._loaded = false;
    }


    // -------------------------------------------------------------------
    //  Maintenance Tools (Refactored from V1 Apps)
    // -------------------------------------------------------------------

    /**
     * Show Regenerate Thumbnails Dialog
     */
    static showRegenerateDialog() {
        const overlay = document.createElement('div');
        overlay.className = 'ov-dialog-overlay';

        overlay.innerHTML = `
      <div class="ov-dialog ov-confirm-dialog">
        <div class="ov-dialog-header">
          <h3>${t('origin-vault.notifications.confirmRegenerate')}</h3>
          <button class="ov-dialog-close"><i class="fas fa-times"></i></button>
        </div>
        <div class="ov-dialog-content">
          <p style="margin-bottom: 10px;">${t('origin-vault.notifications.regenerateWarning')}</p>
          <p class="notes" style="color: var(--ov-text-secondary); font-size: 13px;">
            <i class="fas fa-exclamation-triangle" style="color: var(--ov-warning);"></i> ${t('origin-vault.notifications.regenerateNote')}<br><br>
            ${t('origin-vault.notifications.regenerateConfirm')}
          </p>
        </div>
        <div class="ov-dialog-footer">
          <button class="ov-btn ov-btn-secondary" data-action="cancel">
            <i class="fas fa-times"></i> ${t('origin-vault.dialog.cancel')}
          </button>
          <button class="ov-btn ov-btn-primary" data-action="confirm">
            <i class="fas fa-check"></i> ${t('origin-vault.settings.startGeneration')}
          </button>
        </div>
      </div>
    `;

        appendToOverlayHost(overlay);

        const close = () => overlay.remove();

        overlay.querySelector('.ov-dialog-close').addEventListener('click', close);
        overlay.querySelector('[data-action="cancel"]').addEventListener('click', close);

        // Confirm Action
        overlay.querySelector('[data-action="confirm"]').addEventListener('click', async () => {
            close();
            this._startRegeneration();
        });

        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    }

    static async _startRegeneration() {
        const library = LibraryData.getInstance();
        const items = Object.values(library.getAllItems()).filter(i => {
            const ext = '.' + i.path.split('.').pop().toLowerCase();
            return FILE_TYPES.IMAGE.includes(ext) || FILE_TYPES.VIDEO.includes(ext) || ext === '.ov-scene' || ext === '.json';
        });

        if (items.length === 0) {
            ui.notifications.warn(t('origin-vault.notifications.noItemsToGen'));
            return;
        }

        // Create Progress Dialog
        const progressOverlay = document.createElement('div');
        progressOverlay.className = 'ov-dialog-overlay';
        progressOverlay.style.zIndex = String(OV_LAYERS.NESTED_DIALOG);

        progressOverlay.innerHTML = `
          <div class="ov-dialog" style="width: 350px;">
            <div class="ov-dialog-header">
              <h3>${t('origin-vault.notifications.regenerating')}</h3>
            </div>
            <div class="ov-dialog-content" style="text-align: center; padding: 20px;">
              <i class="fas fa-circle-notch fa-spin fa-3x" style="margin-bottom: 20px; color: var(--ov-accent);"></i>
              <p id="ov-progress-msg" style="font-size: 14px; margin-bottom: 10px; color: var(--ov-text-primary);">${t('origin-vault.notifications.preparing')}</p>
              <div style="width: 100%; height: 6px; background: rgba(0,0,0,0.3); border-radius: 3px; overflow: hidden;">
                <div id="ov-progress-bar" style="width: 0%; height: 100%; background: var(--ov-accent); transition: width 0.2s;"></div>
              </div>
            </div>
          </div>
        `;

        appendToOverlayHost(progressOverlay);

        const manager = ThumbnailManager.getInstance();

        try {
            await manager.generateBatch(items, (current, total) => {
                const pct = Math.round((current / total) * 100);
                const msgEl = progressOverlay.querySelector('#ov-progress-msg');
                const barEl = progressOverlay.querySelector('#ov-progress-bar');

                if (msgEl) msgEl.textContent = tf('origin-vault.notifications.processing', { current, total, pct });
                if (barEl) barEl.style.width = `${pct}%`;
            }, true, library); // force = true, pass library for persistence

            ui.notifications.info(t('origin-vault.notifications.genSuccess'));
        } catch (err) {
            console.error("Origin Vault | Generation failed:", err);
            ui.notifications.error(t('origin-vault.notifications.genFailed'));
        } finally {
            progressOverlay.remove();
        }

        library._markDirty();
        await library.save();

        // Refresh UI
        // Note: Using dynamic import to avoid circular dependencies if possible, 
        // or just rely on EVENT listeners if MainWindow listens to LIBRARY_UPDATED.
        const { MainWindow } = await import('../ui/MainWindow.js');
        if (MainWindow.isVisible) {
            MainWindow.getInstance().render(false);
        }
    }

    /**
     * Show Cleanup Orphans Dialog
     */
    static showCleanupDialog() {
        const overlay = document.createElement('div');
        overlay.className = 'ov-dialog-overlay';

        overlay.innerHTML = `
      <div class="ov-dialog ov-confirm-dialog">
        <div class="ov-dialog-header">
          <h3>${t('origin-vault.notifications.confirmCleanup')}</h3>
          <button class="ov-dialog-close"><i class="fas fa-times"></i></button>
        </div>
        <div class="ov-dialog-content">
          <p style="margin-bottom: 10px;">${t('origin-vault.notifications.cleanupWarning')}</p>
          <div class="ov-warning-box" style="background: rgba(255,165,0,0.1); padding: 10px; border-left: 4px solid var(--ov-warning); margin-bottom: 15px;">
            <p class="notes" style="font-size: 13px; margin: 0;">
              <i class="fas fa-exclamation-triangle" style="color: var(--ov-warning);"></i> ${t('origin-vault.notifications.cleanupNote')}
            </p>
          </div>
        </div>
        <div class="ov-dialog-footer">
          <button class="ov-btn ov-btn-secondary" data-action="cancel">
            <i class="fas fa-times"></i> ${t('origin-vault.dialog.cancel')}
          </button>
          <button class="ov-btn ov-btn-danger" data-action="confirm">
            <i class="fas fa-broom"></i> ${t('origin-vault.settings.startCleanup')}
          </button>
        </div>
      </div>
    `;

        appendToOverlayHost(overlay);

        const close = () => overlay.remove();

        overlay.querySelector('.ov-dialog-close').addEventListener('click', close);
        overlay.querySelector('[data-action="cancel"]').addEventListener('click', close);

        overlay.querySelector('[data-action="confirm"]').addEventListener('click', async () => {
            close();
            const library = LibraryData.getInstance();

            ui.notifications.info(t('origin-vault.notifications.cleaningUp'));

            try {
                const stats = await library.cleanupOrphans();
                ui.notifications.info(tf('origin-vault.notifications.cleanupStats', {
                    assets: stats.deletedFolders,
                    thumbnails: stats.deletedThumbnails
                }));
            } catch (err) {
                console.error("Origin Vault | Cleanup failed:", err);
                ui.notifications.error(t('origin-vault.notifications.cleanupFailed'));
            }
        });

        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    }

    /**
     * Run Health Check
     */
    static async runHealthCheck() {
        const library = LibraryData.getInstance();
        ui.notifications.info(t('origin-vault.notifications.checkingHealth'));

        try {
            const results = await library.healthCheck();

            if (results.missingCount === 0) {
                ui.notifications.info(t('origin-vault.notifications.healthCheckClean'));
            } else {
                const overlay = document.createElement('div');
                overlay.className = 'ov-dialog-overlay';

                overlay.innerHTML = `
          <div class="ov-dialog" style="width: 500px;">
            <div class="ov-dialog-header">
              <h3>${t('origin-vault.settings.healthCheck')}</h3>
              <button class="ov-dialog-close"><i class="fas fa-times"></i></button>
            </div>
            <div class="ov-dialog-content">
              <h3 style="color: var(--ov-warning); margin-top: 0;"><i class="fas fa-exclamation-circle"></i> ${t('origin-vault.notifications.healthCheckResult').replace('{total}', results.totalItems).replace('{missing}', results.missingCount)}</h3>
              <p style="font-size: 13px; margin-top: 10px;">${t('origin-vault.notifications.healthCheckMissingList').replace('{ids}', '')}</p>
              <div class="ov-missing-list" style="max-height: 200px; overflow-y: auto; background: rgba(0,0,0,0.2); padding: 8px; border-radius: 4px; font-family: monospace; font-size: 12px; margin: 10px 0;">
                ${results.missingItems.map(item => `<div style="margin-bottom: 4px;">• ${item.id} (${item.path})</div>`).join('')}
              </div>
              <p style="font-size: 12px; color: var(--ov-text-secondary);">建议：请检查磁盘上的文件是否被重命名或删除。如果您最近更新了物理素材路径，请尝试重新导入素材库。</p>
            </div>
            <div class="ov-dialog-footer">
              <button class="ov-btn ov-btn-primary" data-action="ok">
                <i class="fas fa-check"></i> ${t('origin-vault.dialog.confirm')}
              </button>
            </div>
          </div>
        `;

                appendToOverlayHost(overlay);

                const close = () => overlay.remove();

                overlay.querySelector('.ov-dialog-close').addEventListener('click', close);
                overlay.querySelector('[data-action="ok"]').addEventListener('click', close);
                overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
            }
        } catch (err) {
            console.error("Origin Vault | Health check failed:", err);
        }
    }

    /**
     * 获取默认注册表数据结构
     * @returns {object}
     */
    _getDefaultRegistry() {
        // 返回空注册表，让用户自己创建资源库（类似 Eagle）
        return {
            version: '1.0.0',
            libraries: {},
            recentLibraries: []
        };
    }

    /**
     * 加载资源库注册表
     * @returns {Promise<boolean>}
     */
    async loadRegistry() {
        if (this._loaded) return true;

        try {
            // 确保目录存在 (用于存放实际文件)
            await this._ensureDirectory();

            // 从 World Settings 加载注册表
            let registry = game.settings.get(MODULE_ID, SETTINGS.REGISTRY);

            // 检查是否为空对象（首次运行）
            if (!registry || Object.keys(registry).length === 0) {
                // 如果设置为空，尝试迁移旧的基于文件的注册表（为了兼容及从文件版过渡）
                // 但为了确保世界隔离，我们默认创建新的或使用已有的
                // 只有在该 World 还没配置过时才创建新的

                // TODO: 可以在这里添加从文件迁移的逻辑，但为了纯粹的世界隔离，建议重新开始或是手动迁移
                // 简单起见，如果为空则初始化默认值的
                this.registry = this._getDefaultRegistry();
                await this.saveRegistry();
                ovLog(`${MODULE_ID} | Initialized new library registry in World Settings`);
            } else {
                this.registry = registry;
                ovLog(`${MODULE_ID} | Loaded library registry with ${Object.keys(this.registry.libraries).length} libraries`);
            }

            // 加载全局注册表（文件系统存储）
            await this.loadGlobalRegistry();

            // 完整版：额外加载 MAD 版的全局注册表（只读，用于显示 MAD 的资源库）
            if (!IS_MAD_EDITION) {
                await this._loadMadRegistries();
            }

            this._loaded = true;
            return true;
        } catch (error) {
            console.error(`${MODULE_ID} | Failed to load library registry:`, error);
            this.registry = this._getDefaultRegistry();
            this._loaded = true;
            return false;
        }
    }

    /**
     * 保存资源库注册表
     * @returns {Promise<boolean>}
     */
    async saveRegistry() {
        if (!this.registry) return false;

        try {
            // 保存到 World Settings
            await game.settings.set(MODULE_ID, SETTINGS.REGISTRY, this.registry);

            // MAD 版额外写一份文件备份，以便完整版在 MAD 模块未激活时也能发现
            if (IS_MAD_EDITION) {
                try {
                    const worldDir = `${DEFAULT_DATA_PATH}/${game.world.id}`;
                    try { await browseFilePicker('data', worldDir); } catch (_) {
                        await createFilePickerDirectory('data', worldDir).catch(() => { });
                    }
                    const content = JSON.stringify(this.registry, null, 2);
                    const file = new File([content], 'registry-mad-world.json', { type: 'application/json' });
                    await uploadWithFilePicker('data', worldDir, file, {}, { notify: false });
                } catch (e) {
                    console.warn(`${MODULE_ID} | Failed to write MAD world registry file backup:`, e);
                }
            }

            return true;
        } catch (error) {
            console.error(`${MODULE_ID} | Failed to save library registry:`, error);
            return false;
        }
    }

    /**
     * 确保数据目录存在
     */
    async _ensureDirectory() {
        try {
            await browseFilePicker('data', DEFAULT_DATA_PATH);
        } catch (e) {
            try {
                await createFilePickerDirectory('data', DEFAULT_DATA_PATH);
            } catch (err) {
                // 目录可能已存在
            }
        }
    }

    // -------------------------------------------------------------------
    //  全局注册表（文件存储，跨世界共享）
    // -------------------------------------------------------------------

    /**
     * 确保全局资源库目录存在（递归创建 origin-vault/_global）
     * @returns {Promise<void>}
     */
    async _ensureGlobalDirectory() {
        const parts = GLOBAL_DATA_PATH.split('/').filter(p => p);
        let currentPath = '';
        for (const part of parts) {
            currentPath = currentPath ? `${currentPath}/${part}` : part;
            try {
                await browseFilePicker('data', currentPath);
            } catch (e) {
                await createFilePickerDirectory('data', currentPath);
            }
        }
    }

    async _ensureWorldDirectory() {
        const worldDir = `${DEFAULT_DATA_PATH}/${game.world.id}`;
        const parts = worldDir.split('/').filter(p => p);
        let currentPath = '';

        for (const part of parts) {
            currentPath = currentPath ? `${currentPath}/${part}` : part;
            try {
                await browseFilePicker('data', currentPath);
            } catch (e) {
                await createFilePickerDirectory('data', currentPath);
            }
        }
    }

    /**
     * 加载全局资源库注册表
     * 从文件系统读取 origin-vault/_global/registry.json
     * @returns {Promise<boolean>}
     */
    async loadGlobalRegistry() {
        try {
            await this._ensureGlobalDirectory();
            const filePath = `${GLOBAL_DATA_PATH}/${GLOBAL_REGISTRY_FILE}`;

            // 先 browse 检查文件是否存在，避免 fetch 404 红字
            const listing = await browseFilePicker('data', GLOBAL_DATA_PATH);
            const exists = listing.files?.some(f => f.endsWith(`/${GLOBAL_REGISTRY_FILE}`));

            if (exists) {
                const response = await fetch(`/${filePath}?t=${Date.now()}`);
                if (response.ok) {
                    this.globalRegistry = await response.json();
                    ovLog(`${MODULE_ID} | Loaded global registry with ${Object.keys(this.globalRegistry.libraries).length} libraries`);
                    return true;
                }
            }

            // 文件不存在：初始化空注册表（不写入文件，等有全局库时再写）
            this.globalRegistry = this._getDefaultRegistry();
            return true;
        } catch (error) {
            console.error(`${MODULE_ID} | Failed to load global registry:`, error);
            this.globalRegistry = this._getDefaultRegistry();
            return false;
        }
    }

    /**
     * 保存全局资源库注册表到文件系统
     * @returns {Promise<boolean>}
     */
    async saveGlobalRegistry() {
        if (!this.globalRegistry) return false;
        try {
            await this._ensureGlobalDirectory();
            await this._writeRegistryFile(GLOBAL_DATA_PATH, GLOBAL_REGISTRY_FILE, this.globalRegistry);
            return true;
        } catch (error) {
            console.error(`${MODULE_ID} | Failed to save global registry:`, error);
            return false;
        }
    }

    async saveMadGlobalRegistry() {
        if (!this.madGlobalRegistry) return false;
        try {
            await this._ensureGlobalDirectory();
            await this._writeRegistryFile(GLOBAL_DATA_PATH, MAD_GLOBAL_REGISTRY_FILE, this.madGlobalRegistry);
            return true;
        } catch (error) {
            console.error(`${MODULE_ID} | Failed to save MAD global registry:`, error);
            return false;
        }
    }

    async saveMadWorldRegistry() {
        if (!this.madWorldRegistry) return false;
        try {
            const worldDir = `${DEFAULT_DATA_PATH}/${game.world.id}`;
            await this._ensureWorldDirectory();
            await this._writeRegistryFile(worldDir, MAD_WORLD_REGISTRY_FILE, this.madWorldRegistry);

            // 如果 MAD 模块的 setting 还活着，也顺手同步一份，免得两个版本来回切时打架。
            if (!IS_MAD_EDITION) {
                try {
                    await game.settings.set('origin-vault-mad', SETTINGS.REGISTRY, this._serializeRegistryForSave(this.madWorldRegistry));
                } catch (e) {
                    // 对方模块没启用时这里只会丢文件，不算错。
                }
            }
            return true;
        } catch (error) {
            console.error(`${MODULE_ID} | Failed to save MAD world registry:`, error);
            return false;
        }
    }

    _serializeRegistryForSave(registry) {
        if (!registry) return null;

        const cloned = JSON.parse(JSON.stringify(registry));
        for (const library of Object.values(cloned.libraries || {})) {
            for (const key of Object.keys(library)) {
                if (key.startsWith('_')) {
                    delete library[key];
                }
            }
        }

        return cloned;
    }

    async _writeRegistryFile(basePath, fileName, registry) {
        const content = JSON.stringify(this._serializeRegistryForSave(registry), null, 2);
        const file = new File([content], fileName, { type: 'application/json' });
        await uploadWithFilePicker('data', basePath, file, {}, { notify: false });
    }

    _getRegistryBuckets() {
        return [
            { key: 'world', registry: this.registry, global: false, save: () => this.saveRegistry() },
            { key: 'global', registry: this.globalRegistry, global: true, save: () => this.saveGlobalRegistry() },
            { key: 'mad-world', registry: this.madWorldRegistry, global: false, save: () => this.saveMadWorldRegistry() },
            { key: 'mad-global', registry: this.madGlobalRegistry, global: true, save: () => this.saveMadGlobalRegistry() }
        ].filter(bucket => bucket.registry?.libraries);
    }

    _getLibraryEntries(id) {
        if (!id) return [];

        const entries = [];
        for (const bucket of this._getRegistryBuckets()) {
            const library = bucket.registry?.libraries?.[id];
            if (!library) continue;
            entries.push({ ...bucket, library });
        }
        return entries;
    }

    _getLibraryEntry(id, options = {}) {
        const entries = this._getLibraryEntries(id);
        if (!entries.length) return null;

        const path = options?.path || '';
        if (path) {
            const exactMatch = entries.find(entry => entry.library.path === path);
            if (exactMatch) return exactMatch;
        }

        if (entries.length > 1) {
            console.warn(`${MODULE_ID} | Multiple libraries share id "${id}", falling back to first match`, entries.map(entry => ({
                scope: entry.key,
                path: entry.library.path
            })));
        }

        return entries[0];
    }

    _getStoredActiveLibraryRef() {
        let activeId = null;
        let activePath = '';

        try {
            activeId = game.settings.get(MODULE_ID, SETTINGS.ACTIVE_LIBRARY_ID) || null;
        } catch (e) {
            // settings 还没准备好时直接走兜底
        }

        try {
            activePath = game.settings.get(MODULE_ID, SETTINGS.ACTIVE_LIBRARY_PATH) || '';
        } catch (e) {
            // 老设置没有 path，很正常
        }

        if (activeId) {
            const entry = this._getLibraryEntry(activeId, { path: activePath });
            if (entry) {
                return {
                    id: entry.library.id,
                    path: entry.library.path,
                    entry
                };
            }
        }

        const firstLibrary = this.getAllLibraries()[0];
        if (!firstLibrary) {
            return {
                id: null,
                path: '',
                entry: null
            };
        }

        return {
            id: firstLibrary.id,
            path: firstLibrary.path,
            entry: this._getLibraryEntry(firstLibrary.id, { path: firstLibrary.path })
        };
    }

    /**
     * 判断资源库是否为全局库
     * @param {string} id - 资源库 ID
     * @returns {boolean}
     */
    _isGlobalLibrary(id, options = {}) {
        return !!this._getLibraryEntry(id, options)?.global;
    }

    /**
     * 完整版专用：加载 MAD 版的所有注册表
     * 1. 全局注册表：从 origin-vault/_global/registry-mad.json 读取
     * 2. 世界注册表：从 origin-vault/<worldId>/registry-mad-world.json 读取
     */
    async _loadMadRegistries() {
        // MAD 全局和 MAD 世界分开记，不然同 ID 会互相顶掉
        this.madGlobalRegistry = this._getDefaultRegistry();
        this.madWorldRegistry = this._getDefaultRegistry();

        // 1. 加载 MAD 全局注册表
        try {
            const listing = await browseFilePicker('data', GLOBAL_DATA_PATH);
            const exists = listing.files?.some(f => f.endsWith(`/${MAD_GLOBAL_REGISTRY_FILE}`));
            if (exists) {
                const response = await fetch(`/${GLOBAL_DATA_PATH}/${MAD_GLOBAL_REGISTRY_FILE}?t=${Date.now()}`);
                if (response.ok) {
                    const globalReg = await response.json();
                    for (const [id, lib] of Object.entries(globalReg.libraries || {})) {
                        lib._madSource = true;
                        lib._registryScope = 'mad-global';
                        this.madGlobalRegistry.libraries[id] = lib;
                    }
                    ovLog(`${MODULE_ID} | Loaded MAD global libraries: ${Object.keys(globalReg.libraries || {}).length}`);
                }
            }
        } catch (e) {
            // MAD 全局注册表不存在，静默忽略
        }

        // 2. 加载 MAD 世界注册表（从文件系统读，和 MAD 模块是否启用无关）
        try {
            const worldDir = `${DEFAULT_DATA_PATH}/${game.world.id}`;
            const worldListing = await browseFilePicker('data', worldDir);
            const worldExists = worldListing.files?.some(f => f.endsWith(`/${MAD_WORLD_REGISTRY_FILE}`));
            if (worldExists) {
                const resp = await fetch(`/${worldDir}/${MAD_WORLD_REGISTRY_FILE}?t=${Date.now()}`);
                if (resp.ok) {
                    const madWorldRegistry = await resp.json();
                    if (madWorldRegistry?.libraries) {
                        for (const [id, lib] of Object.entries(madWorldRegistry.libraries)) {
                            lib._madSource = true;
                            lib._registryScope = 'mad-world';
                            this.madWorldRegistry.libraries[id] = lib;
                        }
                        ovLog(`${MODULE_ID} | Loaded MAD world libraries (from file): ${Object.keys(madWorldRegistry.libraries).length}`);
                    }
                }
            }
        } catch (e) {
            // MAD 世界注册表文件不存在，静默忽略
        }

        // 没读到就直接清空，省得外面到处判空出奇怪情况
        if (Object.keys(this.madGlobalRegistry.libraries).length === 0) {
            this.madGlobalRegistry = null;
        }
        if (Object.keys(this.madWorldRegistry.libraries).length === 0) {
            this.madWorldRegistry = null;
        }
    }

    /**
     * 获取所有资源库（合并世界注册表 + 全局注册表 + MAD 注册表）
     * @returns {object[]}
     */
    getAllLibraries() {
        const worldLibs = this.registry ? Object.values(this.registry.libraries) : [];
        const globalLibs = this.globalRegistry ? Object.values(this.globalRegistry.libraries) : [];
        const madWorldLibs = this.madWorldRegistry ? Object.values(this.madWorldRegistry.libraries) : [];
        const madGlobalLibs = this.madGlobalRegistry ? Object.values(this.madGlobalRegistry.libraries) : [];
        return [...worldLibs, ...globalLibs, ...madWorldLibs, ...madGlobalLibs];
    }

    /**
     * 检查是否存在任何资源库（含全局）
     * @returns {boolean}
     */
    hasAnyLibrary() {
        return this.getAllLibraries().length > 0;
    }

    /**
     * 获取资源库（先查世界注册表，再查全局注册表，最后查 MAD 注册表）
     * @param {string} id - 资源库 ID
     * @returns {object|null}
     */
    getLibrary(id, options = {}) {
        return this._getLibraryEntry(id, options)?.library || null;
    }

    /**
     * 获取当前 World 的活动资源库 ID
     * @returns {string}
     */
    getActiveLibraryId() {
        return this._getStoredActiveLibraryRef().id;
    }

    /**
     * 获取活动资源库
     * @returns {object|null}
     */
    getActiveLibrary() {
        return this._getStoredActiveLibraryRef().entry?.library || null;
    }

    /**
     * 切换活动资源库
     * @param {string} id - 资源库 ID
     * @returns {Promise<boolean>}
     */
    async switchLibrary(id, options = {}) {
        const entry = this._getLibraryEntry(id, options);
        const library = entry?.library;
        if (!library || !entry) {
            console.warn(`${MODULE_ID} | Library not found: ${id}`);
            return false;
        }

        try {
            await game.settings.set(MODULE_ID, SETTINGS.ACTIVE_LIBRARY_ID, library.id);
            await game.settings.set(MODULE_ID, SETTINGS.ACTIVE_LIBRARY_PATH, library.path);

            library.lastAccessed = new Date().toISOString();
            if (entry.key === 'world') {
                this._updateRecentLibraries(library.id);
                await this.saveRegistry();
            } else {
                await entry.save();
            }

            Hooks.callAll(EVENTS.LIBRARY_SWITCHED, library.id, library);
            ovLog(`${MODULE_ID} | Switched to library: ${library.name} (${entry.key})`);
            return true;
        } catch (error) {
            console.error(`${MODULE_ID} | Failed to switch library:`, error);
            return false;
        }
    }

    /**
     * 创建新资源库
     * @param {string} name - 资源库显示名称 (Title)
     * @param {string} slug - 资源库 ID 标识 (仅小写字母数字)
     * @param {object} options - 可选参数
     * @param {boolean} [options.global=false] - 是否创建为全局资源库
     * @returns {Promise<string|null>} 资源库 ID (lib_slug)
     */
    async createLibrary(name, slug, options = {}) {
        // 验证 slug 格式
        if (!slug || !/^[a-z0-9]+$/.test(slug)) {
            throw new Error(t('origin-vault.errors.invalidLibraryId'));
        }

        const id = `lib_${slug}`;
        const isGlobal = !!options.global;

        // 只要当前看得到同 ID，就别再放一个新的进去，后面必然打架
        if (this._getLibraryEntries(id).length > 0) {
            throw new Error(t('origin-vault.errors.libraryIdExists'));
        }

        // 跨版本注册表检查：通过 game.settings 直接读取对方版本的注册表
        try {
            const otherModuleId = MODULE_ID.includes('mad') ? 'origin-vault' : 'origin-vault-mad';
            const otherRegistry = game.settings.get(otherModuleId, SETTINGS.REGISTRY);
            if (otherRegistry?.libraries?.[id]) {
                throw new Error(t('origin-vault.errors.libraryIdExists'));
            }
        } catch (e) {
            if (e.message === t('origin-vault.errors.libraryIdExists')) throw e;
            // 对方模块未安装或 settings 未注册 → 忽略
        }

        // 路径规则：全局库 → _global/lib_xxx，世界库 → <worldId>/lib_xxx
        const libraryPath = isGlobal
            ? `${GLOBAL_DATA_PATH}/${id}`
            : (options.path || `${DEFAULT_DATA_PATH}/${game.world.id}/${id}`);

        const library = {
            id,
            name,
            path: libraryPath,
            description: options.description || '',
            color: options.color || '#5b9bd5',
            icon: options.icon || 'folder',
            global: isGlobal,
            createdDate: new Date().toISOString(),
            lastAccessed: new Date().toISOString(),
            itemCount: 0
        };

        // 直接创建目录，别再先 browse 猜存在性，Forge 这块很容易误判
        try {
            const parts = libraryPath.split('/').filter(p => p);
            let currentPath = '';
            for (let i = 0; i < parts.length; i++) {
                const part = parts[i];
                const isLeafDir = i === parts.length - 1;
                currentPath = currentPath ? `${currentPath}/${part}` : part;
                try {
                    await createFilePickerDirectory('data', currentPath);
                } catch (e) {
                    if (isLeafDir) {
                        if (isProbablyAlreadyExistsError(e)) {
                            throw new Error(t('origin-vault.errors.libraryIdExists'));
                        }
                        throw e;
                    }
                    // 父目录大概率只是已经在了，继续往下走
                }
            }
            // 创建 thumbnails 占位
            try { await createFilePickerDirectory('data', `${libraryPath}/thumbnails`); } catch (e) { }
        } catch (e) {
            console.error(`${MODULE_ID} | Failed to create library directories:`, e);
            throw new Error(t('origin-vault.notifications.libraryCreateFailed').replace('{message}', e.message));
        }

        // 添加到对应注册表
        if (isGlobal) {
            this.globalRegistry.libraries[id] = library;
            await this.saveGlobalRegistry();
            Hooks.callAll(EVENTS.GLOBAL_REGISTRY_UPDATED, id, library);
        } else {
            this.registry.libraries[id] = library;
            this._updateRecentLibraries(id);
            await this.saveRegistry();
        }

        // 触发事件
        Hooks.callAll(EVENTS.LIBRARY_CREATED, id, library);

        ovLog(`${MODULE_ID} | Created ${isGlobal ? 'global ' : ''}library: ${name} (${id})`);
        return id;
    }

    /**
     * 重命名资源库
     * @param {string} id - 资源库 ID
     * @param {string} name - 新名称
     * @returns {Promise<boolean>}
     */
    async renameLibrary(id, name, options = {}) {
        const entry = this._getLibraryEntry(id, options);
        const library = entry?.library;
        if (!library || !entry) return false;

        const oldName = library.name;
        library.name = name;

        await entry.save();

        Hooks.callAll(EVENTS.LIBRARY_RENAMED, library.id, name, oldName);
        return true;
    }

    /**
     * 删除资源库
     * @param {string} id - 资源库 ID
     * @returns {Promise<boolean>}
     */
    async deleteLibrary(id, options = {}) {
        if (this.getAllLibraries().length <= 1) {
            ui.notifications.warn(t('origin-vault.notifications.cannotDeleteLastLibrary'));
            return false;
        }

        const entry = this._getLibraryEntry(id, options);
        const library = entry?.library;
        if (!library || !entry) return false;

        const activeRef = this._getStoredActiveLibraryRef();
        const wasActive = activeRef.id === library.id && activeRef.path === library.path;

        delete entry.registry.libraries[library.id];

        if (entry.key === 'world' && Array.isArray(this.registry?.recentLibraries)) {
            this.registry.recentLibraries = this.registry.recentLibraries.filter(libId => libId !== library.id);
        }
        await entry.save();

        if (entry.global) {
            Hooks.callAll(EVENTS.GLOBAL_REGISTRY_UPDATED, library.id, null);
        }

        if (wasActive) {
            const firstLibrary = this.getAllLibraries()[0];
            if (firstLibrary) {
                await this.switchLibrary(firstLibrary.id, { path: firstLibrary.path });
            } else {
                await game.settings.set(MODULE_ID, SETTINGS.ACTIVE_LIBRARY_ID, '');
                await game.settings.set(MODULE_ID, SETTINGS.ACTIVE_LIBRARY_PATH, '');
            }
        }

        Hooks.callAll(EVENTS.LIBRARY_DELETED, library.id, library);
        ovLog(`${MODULE_ID} | Deleted ${entry.key} library: ${library.name}`);
        return true;
    }

    /**
     * 更新最近使用的资源库列表
     * @param {string} id - 资源库 ID
     */
    _updateRecentLibraries(id) {
        if (!this.registry.recentLibraries) {
            this.registry.recentLibraries = [];
        }

        // 移除已有的
        this.registry.recentLibraries = this.registry.recentLibraries.filter(libId => libId !== id);

        // 添加到开头
        this.registry.recentLibraries.unshift(id);

        // 限制数量
        if (this.registry.recentLibraries.length > MAX_RECENT_LIBRARIES) {
            this.registry.recentLibraries = this.registry.recentLibraries.slice(0, MAX_RECENT_LIBRARIES);
        }
    }

    /**
     * 获取最近使用的资源库
     * @returns {object[]}
     */
    getRecentLibraries() {
        if (!this.registry?.recentLibraries) return [];

        return this.registry.recentLibraries
            .map(id => this.getLibrary(id))
            .filter(lib => lib !== null);
    }

    /**
     * 更新资源库统计信息
     * @param {string} id - 资源库 ID
     * @param {object} stats - 统计信息
     */
    async updateLibraryStats(id, stats, options = {}) {
        const entry = this._getLibraryEntry(id, options);
        const library = entry?.library;
        if (!library || !entry) return;

        if (typeof stats.itemCount === 'number') {
            library.itemCount = stats.itemCount;
        }

        await entry.save();
    }
}
