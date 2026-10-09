/**
 * Origin Vault - 素材库数据管理核心类 (v3.0 分散存储架构)
 * 
 * 数据存储结构:
 * - library.json: 只存储文件夹结构、标签定义、设置
 * - images/{id}.info/metadata.json: 每个资源的元数据
 * - images/{id}.info/thumbnail.webp: 每个资源的缩略图
 */

import { MODULE_ID, IS_MAD_EDITION, DEFAULT_DATA_PATH, LIBRARY_FILE, LIBRARY_BACKUP_FILE, DEFAULT_SETTINGS, SPECIAL_FOLDERS, SMART_FOLDER_PREFIX, EVENTS, SETTINGS, STORAGE, DATA_VERSION, FILE_TYPES } from '../constants.js';
import { AssetData } from './AssetData.js';
import { ThumbnailManager } from '../utils/ThumbnailManager.js';
import { browseFilePicker, createFilePickerDirectory, uploadWithFilePicker } from '../utils/filePicker.js';
import { t, tf } from '../utils/i18n.js';
import Fuse from '../lib/fuse.mjs';
import { ovDebug, ovLog } from '../utils/logger.js';
import { getWorldSceneId, shouldShowWorldSceneAsset } from '../utils/worldSceneBindings.js';
import { naturalCompare } from '../utils/sort.js';

const USAGE_SAVE_DELAY_MS = 60000;

export class LibraryData {
  /** @type {LibraryData} */
  static #instance = null;

  /**
   * 获取单例实例
   * @returns {LibraryData}
   */
  static getInstance() {
    if (!LibraryData.#instance) {
      LibraryData.#instance = new LibraryData();
    }
    return LibraryData.#instance;
  }

  constructor() {
    if (LibraryData.#instance) {
      throw new Error('LibraryData is a singleton. Use LibraryData.getInstance()');
    }

    /** @type {LibraryConfigData} 库配置数据（不含资源和标签） */
    this.config = this._getDefaultConfig();

    /** @type {Object<string, object>} 标签定义 (独立存储，Eagle 风格) */
    this.tags = this._getDefaultTags();

    /** @type {Map<string, object>} 资源内存缓存 */
    this.itemsCache = new Map();

    /** @type {Map<string, string>} 路径→ID 快速查重索引 */
    this._pathIndex = new Map();

    /** @type {Map<string, number>} 文件名词频索引 (用于标签推荐) */
    this._tokenFreq = new Map();

    /** @type {Map<string, Set<string>>} 文件夹→素材ID反向索引 (性能优化) */
    this._folderIndex = new Map();

    /** @type {Array|null} 全量素材数组缓存 (itemsCache 变更时失效) */
    this._allItemsArray = null;

    /** @type {boolean} */
    this.loaded = false;

    /** @type {boolean} */
    this.dirty = false;

    /** @type {boolean} 标签是否有修改 */
    this._tagsDirty = false;

    /** @type {number} */
    this._saveTimeout = null;

    this._catalogSaveTimeout = null;
    this._catalogSavePromise = null;
    this._catalogDirty = false;

    this._usageDirtyItemIds = new Set();
    this._usageSaveTimeout = null;
    this._usageSavePromise = null;

    /** @type {string} 当前资源库根目录 */
    this.basePath = DEFAULT_DATA_PATH;
  }

  /**
   * 获取默认库配置结构（不含资源和标签）
   * @returns {LibraryConfigData}
   */
  _getDefaultConfig() {
    return {
      version: DATA_VERSION.LIBRARY,
      name: t('origin-vault.folders.root'),
      created: new Date().toISOString(),
      lastModified: new Date().toISOString(),
      folders: {
        [SPECIAL_FOLDERS.ROOT]: {
          id: SPECIAL_FOLDERS.ROOT,
          name: t('origin-vault.folders.root'),
          parent: null,
          children: [],
          color: null,
          icon: null,
          sortOrder: 0,
          collapsed: false
        }
      },
      smartFolders: {},
      settings: {
        ...DEFAULT_SETTINGS,
        gridSize: 160
      }
    };
  }

  /**
   * 获取默认标签结构
   * @returns {object}
   */
  _getDefaultTags() {
    return {};
  }

  /**
   * 兼容性：获取旧版数据结构（用于导出等）
   * @returns {object}
   */
  get data() {
    return {
      ...this.config,
      tags: this.tags,  // 标签现在是独立属性
      items: Object.fromEntries(this.itemsCache)
    };
  }

  /**
   * 获取配置文件完整路径
   * @returns {string}
   */
  get filePath() {
    return `${this.basePath}/${LIBRARY_FILE}`;
  }

  /**
   * 获取备份文件完整路径
   * @returns {string}
   */
  get backupPath() {
    return `${this.basePath}/${LIBRARY_BACKUP_FILE}`;
  }

  /**
   * 获取 images 目录路径
   * @returns {string}
   */
  get imagesPath() {
    return `${this.basePath}/${STORAGE.IMAGES_DIR}`;
  }

  /**
   * 获取 tags.json 路径 (Eagle 风格)
   * @returns {string}
   */
  get tagsPath() {
    return `${this.basePath}/${STORAGE.TAGS_FILE}`;
  }

  /**
   * 获取 catalog.json 路径（加速加载用快照）
   * @returns {string}
   */
  get catalogPath() {
    return `${this.basePath}/catalog.json`;
  }

  /**
   * 设置资源库路径
   * @param {string} path 
   */
  setLibraryPath(path) {
    if (this.basePath === path) return;
    this._handoffPendingUsageSave();
    this._handoffPendingCatalogSave();
    this.basePath = path;
    this.loaded = false;
    this.itemsCache.clear();
    this._pathIndex.clear();
    this._folderIndex.clear();
    this._allItemsArray = null;
    ovLog(`${MODULE_ID} | Library path set to: ${this.basePath}`);
  }

  // ==================== 生命周期 ====================

  /**
   * 加载素材库数据
   * @returns {Promise<boolean>}
   */
  async load() {
    try {
      ovLog(`${MODULE_ID} | Loading library from: ${this.basePath}`);

      // 确保目录结构存在
      await this._ensureDataDirectory({ includeImages: false });

      // 1. 加载库配置 (library.json)，如果主文件损坏则尝试从备份恢复
      let storedConfig = null;
      try {
        const response = await fetch(`/${this.filePath}?t=${Date.now()}`);
        if (response.ok) {
          storedConfig = await response.json();
        }
      } catch (e) {
        console.warn(`${MODULE_ID} | library.json corrupted or missing, trying backup...`);
        try {
          const backup = await fetch(`/${this.backupPath}?t=${Date.now()}`);
          if (backup.ok) {
            storedConfig = await backup.json();
            ovLog(`${MODULE_ID} | Recovered config from backup: ${this.backupPath}`);
            ui.notifications.warn('Origin Vault: library.json was corrupted, recovered from backup.');
          }
        } catch (e2) {
          ovLog(`${MODULE_ID} | No backup available either, starting fresh`);
        }
      }

      // 2. 检测数据版本并处理
      if (storedConfig) {
        const version = storedConfig.version || '1.0.0';

        if (this._isLegacyVersion(version)) {
          // 旧版数据：需要迁移
          ovLog(`${MODULE_ID} | Detected legacy data version: ${version}`);
          await this._migrateFromLegacy(storedConfig);
        } else {
          // 新版数据：直接加载配置
          this.config = this._mergeConfig(storedConfig);
          // 扫描并加载所有资源元数据
          await this._loadAllAssets();
        }
      } else {
        // 首次运行或新库：尝试从 World Settings 迁移
        if (this.basePath === DEFAULT_DATA_PATH || this.basePath.includes('lib_default')) {
          await this._migrateFromWorldSettings();
        } else {
          // 新资源库：使用默认配置
          this.config = this._getDefaultConfig();
          await this._saveConfig();
        }
      }

      // 3. 加载标签 (tags.json - Eagle 风格)
      await this._loadTags();

      this.loaded = true;
      this.dirty = false;
      this._tagsDirty = false;

      ovLog(`${MODULE_ID} | Library loaded. Assets: ${this.itemsCache.size}, Tags: ${Object.keys(this.tags).length}`);
      Hooks.callAll(EVENTS.LIBRARY_LOADED, this.data);

      return true;
    } catch (error) {
      console.error(`${MODULE_ID} | Error loading library:`, error);
      ui.notifications.error(tf('origin-vault.notifications.loadFailed', { message: error.message }));

      this.config = this._getDefaultConfig();
      this.loaded = true;
      return false;
    }
  }

  /**
   * 检查是否为旧版本数据
   * @param {string} version 
   * @returns {boolean}
   */
  _isLegacyVersion(version) {
    const major = parseInt(version.split('.')[0], 10);
    return major < 3;
  }

  /**
   * 合并配置（确保所有必需字段存在）
   * @param {object} config 
   * @returns {object}
   */
  _mergeConfig(config) {
    return {
      ...this._getDefaultConfig(),
      ...config,
      smartFolders: this._normalizeSmartFolders(config.smartFolders || {}),
      settings: {
        ...DEFAULT_SETTINGS,
        ...(config.settings || {})
      }
    };
  }

  /**
   * 从旧版数据迁移到分散存储
   * @param {object} legacyData 
   */
  async _migrateFromLegacy(legacyData) {
    ovLog(`${MODULE_ID} | Migrating from legacy format...`);
    ui.notifications.info(t('origin-vault.notifications.migrating'));

    const items = legacyData.items || {};
    const itemCount = Object.keys(items).length;
    let migrated = 0;

    // 1. 创建新配置（不含 items 和 tags）
    this.config = {
      version: DATA_VERSION.LIBRARY,
      name: legacyData.name || t('origin-vault.folders.root'),
      created: legacyData.created || new Date().toISOString(),
      lastModified: new Date().toISOString(),
      folders: legacyData.folders || this._getDefaultConfig().folders,
      smartFolders: this._normalizeSmartFolders(legacyData.smartFolders || {}),
      settings: {
        ...DEFAULT_SETTINGS,
        ...(legacyData.settings || {})
      }
    };

    // 1.5 迁移标签到独立 tags 属性
    this.tags = legacyData.tags || {};
    this._tagsDirty = true;

    // 2. 为每个资源创建独立文件夹
    for (const [id, item] of Object.entries(items)) {
      try {
        const assetData = new AssetData(this.basePath, id);

        // 创建元数据
        const metadata = {
          id,
          version: DATA_VERSION.ASSET,
          path: item.path,
          folders: item.folders || ['root'],
          displayName: item.displayName || null,
          tags: item.tags || [],
          rating: item.rating || 0,
          notes: item.notes || '',
          addedDate: item.addedDate || new Date().toISOString(),
          lastUsed: item.lastUsed || null,
          useCount: item.useCount || 0,
          metadata: item.metadata || null
        };

        // 保存元数据
        await assetData.save(metadata);

        // 迁移缩略图（如果存在）
        if (item.thumbnail) {
          await this._migrateThumbnail(item.thumbnail, assetData);
        }

        // 添加到缓存
        this.itemsCache.set(id, metadata);
        migrated++;

        // 进度通知
        if (migrated % 50 === 0) {
          ovLog(`${MODULE_ID} | Migration progress: ${migrated}/${itemCount}`);
        }
      } catch (e) {
        console.warn(`${MODULE_ID} | Failed to migrate item ${id}:`, e);
      }
    }

    // 3. 备份旧数据
    try {
      const backupContent = JSON.stringify(legacyData, null, 2);
      const backupFile = new File([backupContent], 'library-v2-backup.json', { type: 'application/json' });
      await uploadWithFilePicker('data', this.basePath, backupFile, {}, { notify: false });
    } catch (e) {
      console.warn(`${MODULE_ID} | Failed to create backup:`, e);
    }

    // 4. 保存新配置和标签
    await this._saveConfig();
    await this._saveTags();

    ovLog(`${MODULE_ID} | Migration complete: ${migrated}/${itemCount} items, ${Object.keys(this.tags).length} tags`);
    ui.notifications.info(tf('origin-vault.notifications.migrationComplete', { count: migrated }));
  }

  /**
   * 迁移缩略图到资源文件夹
   * @param {string} oldPath 
   * @param {AssetData} assetData 
   */
  async _migrateThumbnail(oldPath, assetData) {
    try {
      // 获取旧缩略图
      const response = await fetch(`/${oldPath}`);
      if (!response.ok) return;

      const blob = await response.blob();
      const format = oldPath.split('.').pop() || 'webp';
      const fileName = `${STORAGE.THUMBNAIL_FILE}.${format}`;
      const file = new File([blob], fileName, { type: blob.type });

      await assetData.ensureFolder();
      await uploadWithFilePicker('data', assetData.folderPath, file, {}, { notify: false });
    } catch (e) {
      console.warn(`${MODULE_ID} | Failed to migrate thumbnail:`, e);
    }
  }

  /**
   * 从 World Settings 迁移数据
   */
  async _migrateFromWorldSettings() {
    try {
      const worldData = game.settings.get(MODULE_ID, SETTINGS.LIBRARY_DATA);
      if (worldData && Object.keys(worldData.items || {}).length > 0) {
        ovLog(`${MODULE_ID} | Migrating from World Settings...`);
        await this._migrateFromLegacy(worldData);
        return;
      }
    } catch (e) {
      ovLog(`${MODULE_ID} | No World Settings data available`);
    }

    // 没有旧数据，使用默认配置
    this.config = this._getDefaultConfig();
    await this._saveConfig();
  }

  /**
   * 扫描并加载所有资源元数据
   */
  async _loadAllAssets() {
    this.itemsCache.clear();
    this._pathIndex.clear();
    this._tokenFreq.clear();
    this._folderIndex.clear();
    this._allItemsArray = null;

    // ★ 优先从 catalog.json 加载（1 次 fetch 替代 N 次）
    const catalog = await this._loadCatalog();
    if (catalog) {
      for (const [id, metadata] of Object.entries(catalog.items)) {
        if (metadata.deleted) continue;
        if (!metadata.thumbnail && ThumbnailManager.getInstance().cacheSource === 'data') {
          metadata.thumbnail = ThumbnailManager.getInstance().getAssetThumbnailPath(id);
        }
        // ★ 修复: catalog.json 可能是旧版（缩略图生成后未重建 catalog）
        // 如果有缩略图路径，确保 thumbnailGenerated 为 true
        if (metadata.thumbnail && !metadata.thumbnailGenerated) {
          metadata.thumbnailGenerated = true;
        }
        this.itemsCache.set(id, metadata);
        this._pathIndex.set(metadata.path, id);
        this._folderIndexAdd(id, metadata.folders);
        this._updateTokenFreqFromItem(metadata, 1);
      }
      ovLog(`${MODULE_ID} | ⚡ Loaded ${this.itemsCache.size} assets from catalog.json (fast path)`);
      return;
    }

    // 降级：逐个加载（旧数据 / catalog 缺失时）
    ovLog(`${MODULE_ID} | catalog.json not available, falling back to per-asset loading...`);
    try {
      const result = await browseFilePicker('data', this.imagesPath);
      const assetFolders = result.dirs.filter(d => d.endsWith(STORAGE.ASSET_FOLDER_SUFFIX));

      ovLog(`${MODULE_ID} | Found ${assetFolders.length} asset folders`);

      // 收集加载失败的文件夹，加载完成后统一清理
      const corruptedFolders = [];

      // 分批加载元数据，避免并发请求过多导致 ERR_INSUFFICIENT_RESOURCES
      const BATCH_SIZE = 50;
      for (let i = 0; i < assetFolders.length; i += BATCH_SIZE) {
        const batch = assetFolders.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(async (folderPath) => {
          const folderName = folderPath.split('/').pop();
          const assetId = folderName.replace(STORAGE.ASSET_FOLDER_SUFFIX, '');

          try {
            const assetData = new AssetData(this.basePath, assetId);
            // 加超时保护，单个资源最多 5 秒，防止 fetch 挂死卡住整个加载
            const metadata = await Promise.race([
              assetData.load(),
              new Promise((_, reject) => setTimeout(() => reject(new Error('Load timeout')), 5000))
            ]);

            // 过滤掉已软删除的素材
            if (metadata && !metadata.deleted) {
              // 仅当元数据中没有缩略图路径时，才动态计算（兼容导入数据保留原始路径）
              if (!metadata.thumbnail && ThumbnailManager.getInstance().cacheSource === 'data') {
                metadata.thumbnail = ThumbnailManager.getInstance().getAssetThumbnailPath(assetId);
              }
              this.itemsCache.set(assetId, metadata);
              this._pathIndex.set(metadata.path, assetId);

              // 更新文件夹反向索引
              this._folderIndexAdd(assetId, metadata.folders);

              // 更新词频索引
              this._updateTokenFreqFromItem(metadata, 1);
            } else if (!metadata) {
              // metadata.json 不存在或无法解析 — 标记为损坏
              corruptedFolders.push({ id: assetId, path: folderPath });
            }
          } catch (e) {
            // 加载超时或异常 — 标记为损坏，不阻塞其他资源
            console.warn(`${MODULE_ID} | Skipped corrupted/timeout asset: ${folderPath}`, e.message);
            corruptedFolders.push({ id: assetId, path: folderPath });
          }
        }));
      }

      ovLog(`${MODULE_ID} | Loaded ${this.itemsCache.size} assets (batch size: ${BATCH_SIZE})`);

      // 自动清理损坏的 .info/ 文件夹（导入中断留下的残骸）
      if (corruptedFolders.length > 0) {
        console.warn(`${MODULE_ID} | Cleaning up ${corruptedFolders.length} corrupted asset folders...`);
        for (const { id } of corruptedFolders) {
          try {
            const assetData = new AssetData(this.basePath, id);
            await assetData.delete();
          } catch (cleanupErr) {
            console.warn(`${MODULE_ID} | Failed to clean up corrupted folder for ${id}:`, cleanupErr.message);
          }
        }
        ovLog(`${MODULE_ID} | Cleanup complete. Removed ${corruptedFolders.length} corrupted asset folders.`);
      }
    } catch (e) {
      // images 目录可能不存在
      ovLog(`${MODULE_ID} | No images directory found, starting fresh`);
    }

    // 降级加载完成后自动生成 catalog（下次加载就快了）
    if (this.itemsCache.size > 0) {
      ovLog(`${MODULE_ID} | Building catalog.json for next load...`);
      await this._saveCatalog();
    }
  }

  /**
   * 保存库配置（不含资源）
   * @returns {Promise<boolean>}
   */
  async _saveConfig() {
    try {
      this.config.lastModified = new Date().toISOString();

      // 写入前备份当前 library.json（防止写入中断导致配置损坏）
      try {
        const existing = await fetch(`/${this.filePath}?t=${Date.now()}`);
        if (existing.ok) {
          const backupContent = await existing.text();
          const backupFile = new File([backupContent], LIBRARY_BACKUP_FILE, { type: 'application/json' });
          await uploadWithFilePicker('data', this.basePath, backupFile, {}, { notify: false });
        }
      } catch (e) { /* 首次保存无需备份 */ }

      const content = JSON.stringify(this.config, null, 2);
      const file = new File([content], LIBRARY_FILE, { type: 'application/json' });
      await uploadWithFilePicker('data', this.basePath, file, {}, { notify: false });

      return true;
    } catch (error) {
      console.error(`${MODULE_ID} | Error saving config:`, error);
      return false;
    }
  }

  /**
   * 保存素材库数据（兼容旧接口）
   * @param {boolean} immediate 
   * @returns {Promise<boolean>}
   */
  async save(immediate = false) {
    if (!this.loaded || !this.basePath) {
      console.warn(`${MODULE_ID} | Save aborted: Path not ready or not loaded.`);
      return false;
    }

    if (this._saveTimeout) {
      clearTimeout(this._saveTimeout);
      this._saveTimeout = null;
    }

    if (!immediate) {
      return new Promise((resolve) => {
        this._saveTimeout = setTimeout(async () => {
          const result = await this._doSaveAll();
          resolve(result);
        }, 1000);
      });
    }

    return this._doSaveAll();
  }

  /**
   * 执行完整保存（配置 + 标签）
   * @returns {Promise<boolean>}
   */
  async _doSaveAll() {
    const configResult = await this._saveConfig();

    // 只在标签有变化时保存 tags.json
    if (this._tagsDirty) {
      await this._saveTags();
      this._tagsDirty = false;
    }

    // 异步更新 catalog 快照（防抖 3s，不阻塞保存流程）
    this.scheduleCatalogSave();

    return configResult;
  }

  /**
   * 加载标签数据 (tags.json - Eagle 风格)
   * @returns {Promise<void>}
   */
  async _loadTags() {
    try {
      // 先检查文件是否存在，避免 fetch 404 在控制台产生红色报错
      const listing = await browseFilePicker('data', this.basePath);
      const tagsFile = STORAGE.TAGS_FILE; // "tags.json"
      const exists = listing.files?.some(f => f.endsWith(`/${tagsFile}`));

      if (exists) {
        const response = await fetch(`/${this.tagsPath}?t=${Date.now()}`);
        if (response.ok) {
          this.tags = await response.json();
          ovLog(`${MODULE_ID} | Loaded ${Object.keys(this.tags).length} tags from tags.json`);
          return;
        }
      }

      this.tags = this._getDefaultTags();
    } catch (e) {
      ovLog(`${MODULE_ID} | No tags.json found, using defaults`);
      this.tags = this._getDefaultTags();
    }
  }

  /**
   * 保存标签数据 (tags.json - Eagle 风格)
   * @returns {Promise<boolean>}
   */
  async _saveTags() {
    try {
      const content = JSON.stringify(this.tags, null, 2);
      const file = new File([content], STORAGE.TAGS_FILE, { type: 'application/json' });
      await uploadWithFilePicker('data', this.basePath, file, {}, { notify: false });
      ovLog(`${MODULE_ID} | Saved ${Object.keys(this.tags).length} tags to tags.json`);
      return true;
    } catch (error) {
      console.error(`${MODULE_ID} | Error saving tags:`, error);
      return false;
    }
  }

  // ==================== Catalog 快照 ====================

  /** @type {number|null} catalog 保存防抖计时器 */
  _catalogSaveTimeout = null;

  /**
   * 从 catalog.json 一次性加载所有资源元数据
   * @returns {Promise<object|null>} catalog 对象，失败返回 null（触发降级）
   */
  async _loadCatalog() {
    try {
      const listing = await browseFilePicker('data', this.basePath);
      const exists = listing.files?.some(f => f.endsWith('/catalog.json'));
      if (!exists) return null;

      const response = await fetch(`/${this.catalogPath}?t=${Date.now()}`);
      if (!response.ok) return null;

      const catalog = await response.json();
      if (!catalog?.items) {
        console.warn(`${MODULE_ID} | catalog.json is missing items field, falling back`);
        return null;
      }

      ovLog(`${MODULE_ID} | catalog.json found: ${catalog.itemCount ?? Object.keys(catalog.items).length} items, generated at ${catalog.generatedAt || 'unknown'}`);
      return catalog;
    } catch (e) {
      console.warn(`${MODULE_ID} | Failed to load catalog.json:`, e);
      return null;
    }
  }

  /**
   * 防抖触发 catalog 保存（避免频繁写入）
   */
  scheduleCatalogSave() {
    this._catalogDirty = true;
    if (this._catalogSaveTimeout) clearTimeout(this._catalogSaveTimeout);
    this._catalogSaveTimeout = setTimeout(() => {
      this.flushPendingCatalogSave().catch((error) => {
        console.warn(`${MODULE_ID} | Failed to flush pending catalog save:`, error);
      });
    }, 500);
  }

  _handoffPendingCatalogSave() {
    if (this._catalogSaveTimeout) {
      clearTimeout(this._catalogSaveTimeout);
      this._catalogSaveTimeout = null;
    }

    if (!this._catalogDirty) return;

    const basePath = this.basePath;
    const catalog = this._buildCatalogPayload();
    this._catalogDirty = false;

    this._queueCatalogSave(basePath, catalog).catch((error) => {
      console.warn(`${MODULE_ID} | Failed to hand off catalog save for ${basePath}:`, error);
    });
  }

  _isUsageOnlyUpdate(updates = {}) {
    const keys = Object.keys(updates || {});
    return keys.length > 0 && keys.every(key => key === 'lastUsed' || key === 'useCount');
  }

  _markUsageDirty(id) {
    this._usageDirtyItemIds.add(id);
    if (this._usageSaveTimeout) clearTimeout(this._usageSaveTimeout);

    this._usageSaveTimeout = setTimeout(() => {
      this.flushPendingUsageSave().catch((error) => {
        console.warn(`${MODULE_ID} | Failed to flush usage stats:`, error);
      });
    }, USAGE_SAVE_DELAY_MS);
  }

  _handoffPendingUsageSave() {
    const handoff = this._prepareUsageFlush();
    if (!handoff) return;

    this._queueUsageSave(handoff).catch((error) => {
      console.warn(`${MODULE_ID} | Failed to hand off usage save for ${handoff.basePath}:`, error);
    });
  }

  _prepareUsageFlush() {
    if (this._usageSaveTimeout) {
      clearTimeout(this._usageSaveTimeout);
      this._usageSaveTimeout = null;
    }

    if (!this._usageDirtyItemIds.size) return null;

    const basePath = this.basePath;
    const itemIds = Array.from(this._usageDirtyItemIds);
    const items = itemIds
      .map(id => ({ id, item: this.itemsCache.get(id) }))
      .filter(entry => entry.item);
    this._usageDirtyItemIds.clear();

    if (!items.length) return null;

    return {
      basePath,
      items,
      catalog: this._buildCatalogPayload()
    };
  }

  async flushPendingUsageSave() {
    const flush = this._prepareUsageFlush();
    if (!flush) {
      return this._usageSavePromise ?? false;
    }

    return this._queueUsageSave(flush);
  }

  _queueUsageSave(flush) {
    const previous = this._usageSavePromise ?? Promise.resolve(true);
    const next = previous
      .catch(() => false)
      .then(async () => {
        for (const { id, item } of flush.items) {
          await this._saveAssetMetadata(id, item, {
            basePath: flush.basePath,
            scheduleCatalog: false
          });
        }

        return this._queueCatalogSave(flush.basePath, flush.catalog);
      })
      .catch((error) => {
        if (flush.basePath === this.basePath) {
          for (const { id } of flush.items) this._markUsageDirty(id);
        }
        throw error;
      });

    const wrapped = next.finally(() => {
      if (this._usageSavePromise === wrapped) {
        this._usageSavePromise = null;
      }
    });

    this._usageSavePromise = wrapped;
    return wrapped;
  }

  async flushPendingCatalogSave() {
    if (this._catalogSaveTimeout) {
      clearTimeout(this._catalogSaveTimeout);
      this._catalogSaveTimeout = null;
    }

    if (!this._catalogDirty) {
      return this._catalogSavePromise ?? false;
    }

    const basePath = this.basePath;
    const catalog = this._buildCatalogPayload();
    this._catalogDirty = false;
    return this._queueCatalogSave(basePath, catalog);
  }

  async flushPendingPersistence() {
    await this.flushPendingUsageSave();

    if (this.dirty || this._saveTimeout) {
      await this.save(true);
    }

    return this.flushPendingCatalogSave();
  }

  _buildCatalogPayload() {
    const items = {};
    for (const [id, metadata] of this.itemsCache) {
      items[id] = this._buildStoredAssetMetadata(metadata);
    }

    return {
      version: DATA_VERSION.LIBRARY,
      generatedAt: new Date().toISOString(),
      itemCount: this.itemsCache.size,
      items
    };
  }

  _queueCatalogSave(basePath, catalog) {
    const previous = this._catalogSavePromise ?? Promise.resolve(true);
    const next = previous
      .catch(() => false)
      .then(() => this._saveCatalogToPath(basePath, catalog));

    const wrapped = next.finally(() => {
      if (this._catalogSavePromise === wrapped) {
        this._catalogSavePromise = null;
      }
    });

    this._catalogSavePromise = wrapped;
    return wrapped;
  }

  /**
   * 保存 catalog.json 快照（包含所有资源元数据）
   * @returns {Promise<boolean>}
   */
  async _saveCatalog() {
    if (!this.loaded) return false;
    return this._saveCatalogToPath(this.basePath, this._buildCatalogPayload());
  }

  async _saveCatalogToPath(basePath, catalog) {
    if (!basePath) return false;
    try {
      const content = JSON.stringify(catalog);
      const file = new File([content], 'catalog.json', { type: 'application/json' });
      await uploadWithFilePicker('data', basePath, file, {}, { notify: false });
      ovLog(`${MODULE_ID} | Catalog saved: ${catalog.itemCount} items -> ${basePath}`);
      return true;
    } catch (e) {
      console.warn(`${MODULE_ID} | Failed to save catalog for ${basePath}:`, e);
      return false;
    }
  }

  /**
   * 确保数据目录存在 (递归确保)
   */
  async _ensureDataDirectory({ includeImages = true } = {}) {
    // 递归确保库根目录存在
    try {
      const parts = this.basePath.split('/').filter(p => p);
      let currentPath = "";
      for (const part of parts) {
        currentPath = currentPath ? `${currentPath}/${part}` : part;
        try {
          await browseFilePicker("data", currentPath);
        } catch (e) {
          await createFilePickerDirectory("data", currentPath);
          ovLog(`${MODULE_ID} | Created directory: ${currentPath}`);
        }
      }
    } catch (e) {
      console.error(`${MODULE_ID} | Failed to ensure library directory structure:`, e);
    }

    if (!includeImages) return;

    // 读 catalog 快路径不用扫 images/，写路径会在真正落文件时再兜这个目录。
    try {
      await browseFilePicker('data', this.imagesPath);
    } catch {
      try {
        await createFilePickerDirectory('data', this.imagesPath);
      } catch (e) { }
    }
  }

  /**
   * 清理孤儿数据（不再被素材库引用的元数据文件夹和缩略图）
   * @returns {Promise<{deletedAssets: number, deletedThumbnails: number}>}
   */
  /**
   * 清理孤儿数据（不再被素材库引用的元数据文件夹和缩略图）
   * @returns {Promise<{deletedAssets: number, deletedThumbnails: number}>}
   */
  async cleanupOrphans() {
    ovLog(`${MODULE_ID} | Starting orphan cleanup...`);
    const knownIds = new Set(this.itemsCache.keys());
    let deletedAssets = 0;
    let deletedThumbnails = 0;

    const tm = ThumbnailManager.getInstance();
    const source = tm.cacheSource; // 'data' 或 's3'
    const bucket = tm.s3Bucket || "";

    // 1. 清理 images/ 目录下的孤儿文件夹 (支持 S3)
    try {
      // V13 Compatibility: FilePicker is now under foundry.applications.apps
      // Use the global fallback if available, or the new namespace
      const result = await browseFilePicker(source, this.imagesPath, { bucket });
      for (const dirPath of result.dirs) {
        const folderName = dirPath.split('/').pop();
        if (folderName.endsWith(STORAGE.ASSET_FOLDER_SUFFIX)) {
          const assetId = folderName.replace(STORAGE.ASSET_FOLDER_SUFFIX, '');
          if (!knownIds.has(assetId)) {
            ovLog(`${MODULE_ID} | Found orphan asset folder: ${folderName} on ${source}`);
            const assetData = new AssetData(this.basePath, assetId);
            await assetData.delete(); // AssetData.delete 内部应处理 source
            deletedAssets++;
          }
        }
      }
    } catch (e) {
      console.warn(`${MODULE_ID} | Failed to scan images directory for orphans on ${source}:`, e);
    }

    // 2. 清理 _cache/ 目录下的孤儿缩略图 (支持 S3)
    const cacheLibPath = `${tm.cacheRoot}/${tm.activeLibraryId}`;
    try {
      // 浏览库缓存目录，下面是 bucket 目录 (0-9, a-f)
      const bucketResult = await browseFilePicker(source, cacheLibPath, { bucket });
      for (const bucketPath of bucketResult.dirs) {
        const fileResult = await browseFilePicker(source, bucketPath, { bucket });
        for (const filePath of fileResult.files) {
          const fileName = filePath.split('/').pop();
          if (fileName.endsWith('.webp')) {
            const assetId = fileName.replace('.webp', '');
            if (!knownIds.has(assetId)) {
              ovLog(`${MODULE_ID} | Found orphan thumbnail: ${fileName} on ${source}`);
              try {
                // 对于 S3，需要正确的路径
                const relativePath = source === 's3' ? filePath : filePath.replace(/^\//, '');
                await fetch(`/${relativePath}`, { method: 'DELETE' });
                deletedThumbnails++;
              } catch (e) {
                console.warn(`${MODULE_ID} | Failed to delete orphan thumbnail ${filePath}:`, e);
              }
            }
          }
        }
      }
    } catch (e) {
      console.warn(`${MODULE_ID} | Failed to scan cache directory for orphans on ${source}:`, e);
    }

    ovLog(`${MODULE_ID} | Orphan cleanup complete. Deleted ${deletedAssets} asset folders and ${deletedThumbnails} thumbnails.`);
    return { deletedFolders: deletedAssets, deletedThumbnails };
  }

  /**
   * 执行库健康检查，验证物理文件是否存在
   * @param {Function} progressCallback 进度回调 (current, total)
   * @returns {Promise<{totalItems: number, missingCount: number, missingItems: object[]}>}
   */
  async healthCheck(progressCallback = null) {
    ovLog(`${MODULE_ID} | Starting library health check...`);
    const items = Array.from(this.itemsCache.values());
    const totalItems = items.length;
    const missingItems = [];
    let current = 0;

    for (const item of items) {
      current++;
      if (progressCallback) progressCallback(current, totalItems);

      try {
        // 对于 S3 或远程 URL，使用 fetch HEAD
        // 对于本地 Data 路径，确保路径以 / 开头
        const url = (item.path.startsWith('http') || item.path.startsWith('/')) ? item.path : `/${item.path}`;
        const response = await fetch(url, { method: 'HEAD' });

        if (!response.ok) {
          console.warn(`${MODULE_ID} | Asset file missing: ${item.path} (ID: ${item.id})`);
          missingItems.push(item);
        }
      } catch (e) {
        console.warn(`${MODULE_ID} | Error checking file ${item.path}:`, e);
        missingItems.push(item);
      }
    }

    const missingCount = missingItems.length;
    ovLog(`${MODULE_ID} | Health check complete. Found ${missingCount} missing files.`);
    return { totalItems, missingCount, missingItems };
  }

  // ==================== 智能文件夹 ====================

  isSmartFolderId(id) {
    return typeof id === 'string' && id.startsWith(SMART_FOLDER_PREFIX);
  }

  _normalizeSmartFolderId(id) {
    if (!id) return null;
    const text = String(id);
    return text.startsWith(SMART_FOLDER_PREFIX) ? text : `${SMART_FOLDER_PREFIX}${text}`;
  }

  _createSmartFolderId() {
    let id;
    do {
      id = `${SMART_FOLDER_PREFIX}${foundry.utils.randomID()}`;
    } while (this.config.smartFolders?.[id]);
    return id;
  }

  _normalizeSmartFolders(smartFolders = {}) {
    const normalized = {};

    for (const [key, rawFolder] of Object.entries(smartFolders || {})) {
      const id = this._normalizeSmartFolderId(rawFolder?.id || key);
      if (!id) continue;
      normalized[id] = this._normalizeSmartFolder(rawFolder, id);
    }

    return normalized;
  }

  _normalizeSmartFolder(rawFolder = {}, id = null) {
    const now = new Date().toISOString();
    const smartId = this._normalizeSmartFolderId(id || rawFolder.id || this._createSmartFolderId());
    const rules = Array.isArray(rawFolder.rules)
      ? rawFolder.rules.map(rule => this._normalizeSmartRule(rule)).filter(Boolean)
      : [];

    return {
      id: smartId,
      name: String(rawFolder.name || t('origin-vault.smartFolders.defaultName')).trim() || t('origin-vault.smartFolders.defaultName'),
      description: String(rawFolder.description || ''),
      match: rawFolder.match === 'any' ? 'any' : 'all',
      rules,
      sortOrder: Number.isFinite(rawFolder.sortOrder) ? rawFolder.sortOrder : Object.keys(this.config?.smartFolders || {}).length,
      created: rawFolder.created || now,
      updated: rawFolder.updated || now
    };
  }

  _normalizeSmartRule(rule = {}) {
    if (!rule || typeof rule !== 'object') return null;

    return {
      id: rule.id || foundry.utils.randomID(),
      field: String(rule.field || 'name'),
      operator: String(rule.operator || 'contains'),
      value: rule.value ?? '',
      includeSubfolders: rule.includeSubfolders !== false
    };
  }

  getAllSmartFolders() {
    return Object.values(this.config.smartFolders || {})
      .map(folder => this._normalizeSmartFolder(folder, folder.id))
      .sort((a, b) => {
        const order = (a.sortOrder || 0) - (b.sortOrder || 0);
        return order || naturalCompare(a.name, b.name);
      });
  }

  getSmartFolder(id) {
    const smartId = this._normalizeSmartFolderId(id);
    if (!smartId) return null;

    const folder = this.config.smartFolders?.[smartId];
    return folder ? this._normalizeSmartFolder(folder, smartId) : null;
  }

  createSmartFolder(data = {}) {
    const id = this._createSmartFolderId();
    const now = new Date().toISOString();
    const smartFolder = this._normalizeSmartFolder({ ...data, id, created: now, updated: now }, id);

    this.config.smartFolders = this.config.smartFolders || {};
    this.config.smartFolders[id] = smartFolder;
    this._markDirty();
    return id;
  }

  updateSmartFolder(id, updates = {}) {
    const smartId = this._normalizeSmartFolderId(id);
    const current = this.config.smartFolders?.[smartId];
    if (!current) throw new Error(`Smart folder not found: ${id}`);

    const smartFolder = this._normalizeSmartFolder({
      ...current,
      ...updates,
      id: smartId,
      created: current.created,
      updated: new Date().toISOString()
    }, smartId);

    this.config.smartFolders[smartId] = smartFolder;
    this._markDirty();
    return smartFolder;
  }

  renameSmartFolder(id, name) {
    return this.updateSmartFolder(id, { name });
  }

  deleteSmartFolder(id) {
    const smartId = this._normalizeSmartFolderId(id);
    if (!this.config.smartFolders?.[smartId]) return false;

    delete this.config.smartFolders[smartId];
    this._markDirty();
    return true;
  }

  getItemsBySmartFolder(id) {
    const smartFolder = this.getSmartFolder(id);
    if (!smartFolder) return [];

    return this.getItemsBySmartFolderData(smartFolder);
  }

  getItemsBySmartFolderData(data = {}) {
    const smartFolder = this._normalizeSmartFolder(data, data.id || `${SMART_FOLDER_PREFIX}preview`);
    const rules = this._getUsableSmartRules(smartFolder);
    if (rules.length === 0) return [];

    const allItems = this._filterItemsForCurrentWorld(this._getAllItemsArray());
    return allItems.filter(item => this._itemMatchesSmartFolder(item, smartFolder, rules));
  }

  getSmartFolderItemCount(id) {
    return this.getItemsBySmartFolder(id).length;
  }

  _getUsableSmartRules(smartFolder) {
    return (smartFolder?.rules || []).filter(rule => this._isSmartRuleUsable(rule));
  }

  _isSmartRuleUsable(rule) {
    if (!rule?.field) return false;
    if (rule.field === 'untagged') return true;
    return rule.value !== undefined && rule.value !== null && String(rule.value).trim() !== '';
  }

  _itemMatchesSmartFolder(item, smartFolder, rules = this._getUsableSmartRules(smartFolder)) {
    if (rules.length === 0) return false;

    const matcher = rule => this._itemMatchesSmartRule(item, rule);
    return smartFolder.match === 'any' ? rules.some(matcher) : rules.every(matcher);
  }

  _itemMatchesSmartRule(item, rule) {
    const operator = rule.operator || 'contains';

    if (rule.field === 'tag') {
      const hasTag = this._itemHasSmartTag(item, rule.value);
      return operator === 'notHas' || operator === 'notEquals' ? !hasTag : hasTag;
    }

    if (rule.field === 'folder') {
      const inFolder = this._itemMatchesSmartFolderRule(item, rule);
      return operator === 'notHas' || operator === 'notEquals' ? !inFolder : inFolder;
    }

    if (rule.field === 'type') {
      const matchesType = this._itemMatchesSmartType(item, rule.value);
      return operator === 'notEquals' || operator === 'notHas' ? !matchesType : matchesType;
    }

    if (rule.field === 'untagged') {
      const untagged = !item.tags || item.tags.length === 0;
      const wantsUntagged = String(rule.value ?? 'true') !== 'false';
      return operator === 'notEquals' ? untagged !== wantsUntagged : untagged === wantsUntagged;
    }

    if (rule.field === 'rating') {
      return this._compareSmartNumber(Number(item.rating || 0), Number(rule.value), operator);
    }

    if (rule.field === 'addedDate' || rule.field === 'lastUsed') {
      return this._compareSmartDate(item[rule.field], rule.value, operator);
    }

    return this._compareSmartText(this._getSmartTextValue(item, rule.field), rule.value, operator);
  }

  _itemHasSmartTag(item, value) {
    const target = String(value || '');
    if (!target) return false;

    const itemTags = item.tags || [];
    if (itemTags.includes(target)) return true;

    const targetLower = target.toLowerCase();
    return itemTags.some(tagId => {
      const tag = this.tags[tagId];
      return tag?.name?.toLowerCase?.() === targetLower;
    });
  }

  _itemMatchesSmartFolderRule(item, rule) {
    const folderId = String(rule.value || '');
    if (!folderId) return false;

    const targetFolders = new Set([folderId]);
    if (rule.includeSubfolders !== false && this.config.folders[folderId]) {
      for (const childId of this.getAllDescendantFolders(folderId)) {
        targetFolders.add(childId);
      }
    }

    return (item.folders || []).some(fid => targetFolders.has(fid));
  }

  _itemMatchesSmartType(item, type) {
    const target = String(type || '').toLowerCase();
    if (!target || target === 'all') return true;

    const assetType = item.metadata?.type || item.type || null;
    if (target === 'scene') return assetType === 'scene' || this._getFileExtension(item.path || '') === '.ov-scene';
    if (target === 'item') return assetType === 'item';
    if (target === 'actor') return assetType === 'actor';

    const ext = this._getFileExtension(item.path || '');
    if (target === 'image') return FILE_TYPES.IMAGE.includes(ext);
    if (target === 'video') return FILE_TYPES.VIDEO.includes(ext);
    if (target === 'audio') return FILE_TYPES.AUDIO.includes(ext);

    return false;
  }

  _getSmartTextValue(item, field) {
    if (field === 'path') return item.path || '';

    const rawName = item.displayName || item.name || this._getFileName(item.path || '');
    try {
      return decodeURIComponent(rawName || '');
    } catch {
      return rawName || '';
    }
  }

  _compareSmartText(itemValue, ruleValue, operator) {
    const itemText = String(itemValue || '').toLowerCase();
    const ruleText = String(ruleValue || '').toLowerCase();
    if (!ruleText) return false;

    if (operator === 'equals') return itemText === ruleText;
    if (operator === 'notEquals') return itemText !== ruleText;
    if (operator === 'notContains') return !itemText.includes(ruleText);
    return itemText.includes(ruleText);
  }

  _compareSmartNumber(itemValue, ruleValue, operator) {
    if (!Number.isFinite(ruleValue)) return false;

    if (operator === 'lte') return itemValue <= ruleValue;
    if (operator === 'equals') return itemValue === ruleValue;
    if (operator === 'notEquals') return itemValue !== ruleValue;
    return itemValue >= ruleValue;
  }

  _compareSmartDate(itemValue, ruleValue, operator) {
    const itemTime = itemValue ? new Date(itemValue).getTime() : NaN;
    const ruleTime = ruleValue ? new Date(ruleValue).getTime() : NaN;
    if (!Number.isFinite(itemTime) || !Number.isFinite(ruleTime)) return false;

    const itemDay = new Date(itemTime).toDateString();
    const ruleDay = new Date(ruleTime).toDateString();
    if (operator === 'before' || operator === 'lte') return itemTime <= ruleTime;
    if (operator === 'equals') return itemDay === ruleDay;
    if (operator === 'notEquals') return itemDay !== ruleDay;
    return itemTime >= ruleTime;
  }

  // ==================== 文件夹操作 ====================

  /**
   * 创建文件夹
   * @param {string} parentId
   * @param {string} name
   * @param {object} options
   * @returns {string}
   */
  createFolder(parentId, name, options = {}) {
    const id = `folder_${foundry.utils.randomID()}`;
    const parent = this.config.folders[parentId];

    if (!parent) {
      throw new Error(`Parent folder not found: ${parentId}`);
    }

    const folder = {
      id,
      name,
      parent: parentId,
      children: [],
      color: options.color || null,
      icon: options.icon || null,
      sortOrder: parent.children.length,
      collapsed: options.collapsed ?? false
    };

    this.config.folders[id] = folder;
    parent.children.push(id);
    this._syncFolderChildSortOrder(parent);

    this._markDirty();
    Hooks.callAll(EVENTS.FOLDER_CREATED, folder);

    return id;
  }

  /**
   * 重命名文件夹
   */
  renameFolder(id, name) {
    const folder = this.config.folders[id];
    if (!folder) throw new Error(`Folder not found: ${id}`);
    if (id === SPECIAL_FOLDERS.ROOT) throw new Error('Cannot rename root folder');

    folder.name = name;
    this._markDirty();
    Hooks.callAll(EVENTS.FOLDER_UPDATED, folder);
  }

  /**
   * 删除文件夹
   */
  deleteFolder(id, recursive = false) {
    const folder = this.config.folders[id];
    if (!folder) throw new Error(`Folder not found: ${id}`);
    if (id === SPECIAL_FOLDERS.ROOT) throw new Error('Cannot delete root folder');

    if (recursive) {
      for (const childId of [...folder.children]) {
        this.deleteFolder(childId, true);
      }
    } else if (folder.children.length > 0) {
      throw new Error('Folder is not empty');
    }

    const parent = this.config.folders[folder.parent];
    if (parent) {
      parent.children = parent.children.filter(cid => cid !== id);
      this._syncFolderChildSortOrder(parent);
    }

    // 更新所有资源的文件夹引用
    for (const item of this.itemsCache.values()) {
      if (item.folders.includes(id)) {
        item.folders = item.folders.filter(fid => fid !== id);
        this._saveAssetMetadata(item.id, item);
      }
    }

    // 从文件夹索引中移除
    this._folderIndex.delete(id);
    this._allItemsArray = null;

    delete this.config.folders[id];
    this._markDirty();
    Hooks.callAll(EVENTS.FOLDER_DELETED, { id });
  }

  /**
   * 移动文件夹
   */
  moveFolder(id, newParentId, placement = {}) {
    const folder = this.config.folders[id];
    if (!folder) throw new Error(`Folder not found: ${id}`);

    const oldParent = this.config.folders[folder.parent];
    const newParent = this.config.folders[newParentId];

    if (!newParent) throw new Error(`New parent folder not found: ${newParentId}`);
    if (id === SPECIAL_FOLDERS.ROOT) throw new Error('Cannot move root folder');

    // 检查循环引用
    let current = newParent;
    while (current) {
      if (current.id === id) {
        throw new Error('Cannot move folder into its own descendant');
      }
      current = this.config.folders[current.parent];
    }

    if (oldParent) {
      oldParent.children = oldParent.children.filter(cid => cid !== id);
    }

    const siblings = (newParent.children || []).filter(cid => cid !== id);
    const insertIndex = this._resolveFolderInsertIndex(siblings, placement);

    folder.parent = newParentId;
    siblings.splice(insertIndex, 0, id);
    newParent.children = siblings;

    if (oldParent && oldParent !== newParent) {
      this._syncFolderChildSortOrder(oldParent);
    }
    this._syncFolderChildSortOrder(newParent);

    this._markDirty();
    Hooks.callAll(EVENTS.FOLDER_UPDATED, folder);
  }

  _resolveFolderInsertIndex(siblings, placement = {}) {
    if (Number.isFinite(placement.index)) {
      return Math.max(0, Math.min(siblings.length, Math.trunc(placement.index)));
    }

    if (placement.beforeId) {
      const index = siblings.indexOf(placement.beforeId);
      if (index >= 0) return index;
    }

    if (placement.afterId) {
      const index = siblings.indexOf(placement.afterId);
      if (index >= 0) return index + 1;
    }

    return siblings.length;
  }

  _syncFolderChildSortOrder(folder) {
    if (!folder || !Array.isArray(folder.children)) return;

    folder.children = folder.children.filter((childId, index, children) => {
      return childId && children.indexOf(childId) === index && this.config.folders[childId];
    });

    folder.children.forEach((childId, index) => {
      const child = this.config.folders[childId];
      if (child) child.sortOrder = index;
    });
  }

  getFolder(id) {
    return this.config.folders[id] || null;
  }

  getAllFolders() {
    return this.config.folders;
  }

  /**
   * 获取所有后代文件夹 ID
   * @param {string} folderId 
   * @returns {Set<string>} 后代文件夹 ID 集合
   */
  getAllDescendantFolders(folderId) {
    const descendants = new Set();
    const folder = this.config.folders[folderId];

    if (folder && folder.children) {
      for (const childId of folder.children) {
        descendants.add(childId);
        for (const d of this.getAllDescendantFolders(childId)) {
          descendants.add(d);
        }
      }
    }

    return descendants;
  }

  // ==================== 素材操作 ====================

  /**
   * 添加素材（创建资源文件夹）
   * @param {string} path
   * @param {string} folderId
   * @param {object} options
   * @returns {Promise<string>}
   */
  async addItem(path, folderId = SPECIAL_FOLDERS.ROOT, options = {}) {
    // MAD 版：只允许场景文件入库
    if (IS_MAD_EDITION) {
      const ext = path.split('.').pop()?.toLowerCase();
      const isScene = ext === 'ov-scene' || options.metadata?.type === 'scene';
      if (!isScene) {
        ovDebug(`${MODULE_ID} | MAD Edition: skipping non-scene item: ${path}`);
        return null;
      }
    }

    // 文档类素材不能按图片路径去重；不同物品/角色经常共用头像或图标。
    const documentType = options.metadata?.type;
    const documentUuid = options.metadata?.uuid;
    const dedupeByUuid = ['item', 'actor'].includes(documentType) && documentUuid;

    if (dedupeByUuid) {
      // O(n) UUID 查重 — 文档素材量有限，可接受
      for (const [existId, existItem] of this.itemsCache) {
        if (existItem.metadata?.uuid === documentUuid) {
          // 同一个世界/合集文档已存在，只补到新文件夹
          if (!existItem.folders.includes(folderId)) {
            existItem.folders.push(folderId);
            this._folderIndexAdd(existId, [folderId]);
            await this._saveAssetMetadata(existId, existItem);
            Hooks.callAll(EVENTS.ITEM_UPDATED, existItem);
          }
          return existId;
        }
      }
    } else {
      // 普通媒体素材按路径去重
      // O(1) 查重 (使用路径索引)
      const existingId = this._pathIndex.get(path);
      if (existingId) {
        const item = this.itemsCache.get(existingId);
        if (item) {
          // 已存在，添加到新文件夹
          if (!item.folders.includes(folderId)) {
            item.folders.push(folderId);
            this._folderIndexAdd(existingId, [folderId]);
            await this._saveAssetMetadata(existingId, item);
            Hooks.callAll(EVENTS.ITEM_UPDATED, item);
          }
          return existingId;
        }
      }
    }

    // 创建新资源
    const id = `item_${foundry.utils.randomID()}`;
    const assetData = new AssetData(this.basePath, id);

    const metadata = AssetData.createDefaultMetadata(id, path, {
      folders: options.folders || [folderId],
      displayName: options.displayName,
      tags: options.tags,
      rating: options.rating,
      notes: options.notes,
      metadata: options.metadata
    });

    // 保存到文件系统
    await assetData.save(metadata);

    // 添加到缓存 + 路径索引
    this.itemsCache.set(id, metadata);
    this._pathIndex.set(path, id);
    this._folderIndexAdd(id, metadata.folders);

    // 更新词频
    this._updateTokenFreqFromItem(metadata, 1);
    this.scheduleCatalogSave();

    Hooks.callAll(EVENTS.ITEM_ADDED, metadata);
    return id;
  }

  /**
   * 批量添加素材（高性能版本，用于大文件夹导入）
   * 并行写入 + 跳过逐条 Hooks + 预确认目录
   * @param {Array<{path: string, folderId: string}>} items - 待添加的文件列表
   * @param {Function} onProgress - 进度回调 (current, total)
   * @returns {Promise<{added: number, skipped: number}>}
   */
  async addItems(items, onProgress = null) {
    const BATCH_SIZE = 10; // 并行写入并发数
    let added = 0;
    let skipped = 0;
    let linked = 0;
    const total = items.length;

    // 1. 预确认 images 目录存在（只做一次）
    try {
      await browseFilePicker('data', this.imagesPath);
    } catch {
      try {
        await createFilePickerDirectory('data', this.imagesPath);
      } catch (e) { /* already exists */ }
    }

    // 2. 分批并行处理
    for (let i = 0; i < total; i += BATCH_SIZE) {
      const batch = items.slice(i, i + BATCH_SIZE);

      const results = await Promise.allSettled(batch.map(async ({ path, folderId }) => {
        // O(1) 查重
        const existingId = this._pathIndex.get(path);
        if (existingId) {
          const existingItem = this.itemsCache.get(existingId);
          if (existingItem) {
            if (!existingItem.folders.includes(folderId)) {
              existingItem.folders.push(folderId);
              this._folderIndexAdd(existingId, [folderId]);
              await this._saveAssetMetadata(existingId, existingItem);
              Hooks.callAll(EVENTS.ITEM_UPDATED, existingItem);
              return 'linked';
            }
            return 'skipped';
          }
        }

        // 创建新资源
        const id = `item_${foundry.utils.randomID()}`;
        const metadata = AssetData.createDefaultMetadata(id, path, {
          folders: [folderId]
        });

        // 直接创建目录 + 写入元数据（跳过 browse 检查）
        const assetFolderPath = `${this.basePath}/${STORAGE.IMAGES_DIR}/${id}${STORAGE.ASSET_FOLDER_SUFFIX}`;
        try {
          await createFilePickerDirectory('data', assetFolderPath);
        } catch (e) { /* already exists */ }

        const content = JSON.stringify(metadata, null, 2);
        const file = new File([content], STORAGE.METADATA_FILE, { type: 'application/json' });
        await uploadWithFilePicker('data', assetFolderPath, file, {}, { notify: false });

        // 添加到缓存 + 路径索引
        this.itemsCache.set(id, metadata);
        this._pathIndex.set(path, id);
        this._folderIndexAdd(id, metadata.folders);

        // 更新词频
        this._updateTokenFreqFromItem(metadata, 1);

        return 'added';
      }));

      // 统计结果
      for (const result of results) {
        if (result.status === 'fulfilled') {
          if (result.value === 'added') added++;
          else if (result.value === 'linked') linked++;
          else skipped++;
        }
      }

      // 进度回调
      if (onProgress) {
        onProgress(Math.min(i + BATCH_SIZE, total), total);
      }
    }

    // 3. 批量完成后统一触发事件
    if (added > 0 || linked > 0) {
      this.scheduleCatalogSave();
    }
    Hooks.callAll(EVENTS.LIBRARY_LOADED, this.data);

    ovLog(`${MODULE_ID} | Batch import complete: ${added} added, ${linked} linked, ${skipped} skipped`);
    return { added, skipped, linked };
  }

  /**
   * 移除素材（软删除 - 标记为已删除）
   * 由于 Foundry VTT 不支持 HTTP DELETE，我们使用标记删除法
   * @param {string} id
   */
  async removeItem(id) {
    const item = this.itemsCache.get(id);
    if (!item) throw new Error(`Item not found: ${id}`);

    // 更新词频（减 1）
    this._updateTokenFreqFromItem(item, -1);

    // 标记为已删除（软删除）
    item.deleted = true;
    item.deletedAt = new Date().toISOString();

    // 保存元数据
    await this._saveAssetMetadata(id, item);

    // 从缓存和路径索引移除
    this._pathIndex.delete(item.path);
    this._folderIndexRemove(id, item.folders);
    this.itemsCache.delete(id);

    Hooks.callAll(EVENTS.ITEM_REMOVED, { id });
  }

  /**
   * 从文件夹中移除素材
   */
  async removeItemFromFolder(itemId, folderId) {
    const item = this.itemsCache.get(itemId);
    if (!item) throw new Error(`Item not found: ${itemId}`);

    item.folders = item.folders.filter(id => id !== folderId);
    this._folderIndexRemove(itemId, [folderId]);

    await this._saveAssetMetadata(itemId, item);
    Hooks.callAll(EVENTS.ITEM_UPDATED, item);
  }

  /**
   * 移动素材到文件夹
   */
  async moveItem(itemId, fromFolderId, toFolderId) {
    const item = this.itemsCache.get(itemId);
    if (!item) throw new Error(`Item not found: ${itemId}`);

    item.folders = item.folders.filter(id => id !== fromFolderId);
    this._folderIndexRemove(itemId, [fromFolderId]);
    if (!item.folders.includes(toFolderId)) {
      item.folders.push(toFolderId);
      this._folderIndexAdd(itemId, [toFolderId]);
    }

    await this._saveAssetMetadata(itemId, item);
    Hooks.callAll(EVENTS.ITEM_UPDATED, item);
  }

  /**
   * 复制素材到文件夹
   */
  async copyItemToFolder(itemId, toFolderId) {
    const item = this.itemsCache.get(itemId);
    if (!item) throw new Error(`Item not found: ${itemId}`);

    if (!item.folders.includes(toFolderId)) {
      item.folders.push(toFolderId);
      this._folderIndexAdd(itemId, [toFolderId]);
      await this._saveAssetMetadata(itemId, item);
      Hooks.callAll(EVENTS.ITEM_UPDATED, item);
    }
  }

  /**
   * 更新素材信息
   */
  async updateItem(id, updates, options = {}) {
    const item = this.itemsCache.get(id);
    if (!item) throw new Error(`Item not found: ${id}`);

    if (options?.mode === 'usage' && this._isUsageOnlyUpdate(updates)) {
      for (const [key, value] of Object.entries(updates)) {
        item[key] = value;
      }
      this._markUsageDirty(id);
      return item;
    }

    if (options?.mode === 'usage') {
      console.warn(`${MODULE_ID} | Ignoring usage mode for non-usage update on ${id}`);
    }

    // 如果显示名称改变，更新词频索引
    if (updates.displayName !== undefined && updates.displayName !== item.displayName) {
      this._updateTokenFreqFromItem(item, -1);
      const tempItem = { ...item, displayName: updates.displayName };
      this._updateTokenFreqFromItem(tempItem, 1);
    }

    const allowedFields = ['displayName', 'tags', 'rating', 'notes', 'link', 'thumbnail', 'thumbnailGenerated', 'thumbnailVersion', 'thumbnailRevision', 'metadata', 'lastUsed', 'useCount'];

    for (const [key, value] of Object.entries(updates)) {
      if (allowedFields.includes(key)) {
        item[key] = value;
      }
    }

    // displayName 或 name 变更时清除渲染缓存标记
    if (updates.displayName !== undefined || updates.name !== undefined) {
      item._displayNameDecoded = false;
    }

    await this._saveAssetMetadata(id, item);
    Hooks.callAll(EVENTS.ITEM_UPDATED, item);
    return item;
  }

  _buildStoredAssetMetadata(metadata) {
    const stored = foundry.utils.deepClone(metadata);

    // 这些是世界运行态，留在内存里可以，别回写进资源库
    delete stored.isImported;
    delete stored.isItemImported;
    delete stored.isActorImported;
    delete stored.worldId;
    delete stored.worldItemUuid;
    delete stored.worldActorUuid;

    // 渲染期临时挂在 item 上的派生字段，不是素材履历，别跟着落盘污染 metadata/catalog。
    // aspectRatio / name 每次渲染都会从 metadata 重算，_ 前缀是运行态标记的统一约定（如 _displayNameDecoded）。
    delete stored.aspectRatio;
    delete stored.name;
    for (const key of Object.keys(stored)) {
      if (key.startsWith('_')) delete stored[key];
    }

    if (stored.metadata) {
      const sceneMetadata = stored.metadata;
      const bindings = sceneMetadata.worldSceneBindings && typeof sceneMetadata.worldSceneBindings === 'object'
        ? sceneMetadata.worldSceneBindings
        : {};
      const hasBindings = Object.keys(bindings).length > 0;

      if (hasBindings) {
        sceneMetadata.worldSceneOrigin = true;
        delete sceneMetadata.worldSceneId;
      } else if (sceneMetadata.worldSceneOrigin !== true) {
        delete sceneMetadata.worldSceneId;
        delete sceneMetadata.worldSceneOrigin;
      } else {
        const legacySceneId = sceneMetadata.worldSceneId;
        const worldId = game?.world?.id || null;
        const legacyScene = legacySceneId ? game?.scenes?.get?.(legacySceneId) : null;
        if (worldId && legacyScene) {
          // 旧数据只有一个 worldSceneId。当前世界能找到它时，顺手升级成按世界隔离的绑定。
          sceneMetadata.worldSceneBindings = {
            [worldId]: {
              sceneId: legacyScene.id,
              sceneName: legacyScene.name || sceneMetadata.sceneName || stored.displayName || '',
              source: 'legacy-world-scene',
              createdFromAsset: false,
              backgroundSrc: sceneMetadata.backgroundSrc || legacyScene.background?.src || '',
              updatedAt: new Date().toISOString()
            }
          };
          delete sceneMetadata.worldSceneId;
        }
      }
    }

    return stored;
  }

  /**
   * 保存单个资源的元数据
   * @param {string} id 
   * @param {object} metadata 
   */
  async _saveAssetMetadata(id, metadata, options = {}) {
    const assetData = new AssetData(options.basePath || this.basePath, id);
    await assetData.save(this._buildStoredAssetMetadata(metadata));
    if (options.scheduleCatalog !== false) {
      this.scheduleCatalogSave();
    }
  }

  getItem(id) {
    return this.itemsCache.get(id) || null;
  }

  getItemByPath(path) {
    const id = this._pathIndex.get(path);
    if (id) return this.itemsCache.get(id) || null;
    return null;
  }

  _filterItemsForCurrentWorld(items) {
    return items.filter(item => shouldShowWorldSceneAsset(item, { library: this }));
  }

  _isItemVisibleInCurrentWorld(item) {
    return shouldShowWorldSceneAsset(item, { library: this });
  }

  getItemsByFolder(folderId) {
    if (this.isSmartFolderId(folderId)) {
      return this.getItemsBySmartFolder(folderId);
    }

    // ALL/ROOT: 返回全量缓存数组（惰性创建，itemsCache 变更时失效）
    if (folderId === SPECIAL_FOLDERS.ALL || folderId === SPECIAL_FOLDERS.ROOT) {
      return this._filterItemsForCurrentWorld(this._getAllItemsArray());
    }

    if (folderId === SPECIAL_FOLDERS.FAVORITES) {
      return this._filterItemsForCurrentWorld(this._getAllItemsArray()).filter(item => item.rating >= 4);
    }

    if (folderId === SPECIAL_FOLDERS.RECENT) {
      return this._filterItemsForCurrentWorld(this._getAllItemsArray())
        .filter(item => item.lastUsed)
        .sort((a, b) => new Date(b.lastUsed) - new Date(a.lastUsed))
        .slice(0, 50);
    }

    // 普通文件夹：通过 folderIndex 反向索引查询 (含子文件夹)
    const targetFolders = this.getAllDescendantFolders(folderId);
    targetFolders.add(folderId);

    const seen = new Set();
    const result = [];
    for (const fid of targetFolders) {
      const itemIds = this._folderIndex.get(fid);
      if (!itemIds) continue;
      for (const id of itemIds) {
        if (seen.has(id)) continue;
        seen.add(id);
        const item = this.itemsCache.get(id);
        if (item) result.push(item);
      }
    }
    return this._filterItemsForCurrentWorld(result);
  }

  /**
   * 获取文件夹内素材（仅直接子项，不包含子文件夹内容）
   * @param {string} folderId
   * @returns {Array}
   */
  getDirectItemsByFolder(folderId) {
    if (this.isSmartFolderId(folderId)) {
      return this.getItemsBySmartFolder(folderId);
    }

    if (folderId === SPECIAL_FOLDERS.ALL || folderId === SPECIAL_FOLDERS.ROOT) {
      const itemIds = this._folderIndex.get(SPECIAL_FOLDERS.ROOT);
      if (!itemIds) return [];
      const result = [];
      for (const id of itemIds) {
        const item = this.itemsCache.get(id);
        if (item) result.push(item);
      }
      return this._filterItemsForCurrentWorld(result);
    }

    // 这些虚拟视图不是文件夹层级，不能按“直属素材”解释。
    if (folderId === SPECIAL_FOLDERS.FAVORITES || folderId === SPECIAL_FOLDERS.RECENT ||
      folderId === SPECIAL_FOLDERS.UNCATEGORIZED) {
      return this.getItemsByFolder(folderId);
    }

    // 仅查当前文件夹的 folderIndex，不含子文件夹
    const itemIds = this._folderIndex.get(folderId);
    if (!itemIds) return [];
    const result = [];
    for (const id of itemIds) {
      const item = this.itemsCache.get(id);
      if (item) result.push(item);
    }
    return this._filterItemsForCurrentWorld(result);
  }

  /**
   * 获取直接子文件夹（仅一级，不含深层后代）
   * @param {string} folderId
   * @returns {Array} 子文件夹对象数组
   */
  getDirectChildFolders(folderId) {
    const allFolders = this.getAllFolders();
    return Object.entries(allFolders)
      .filter(([id, folder]) => {
        if (Object.values(SPECIAL_FOLDERS).includes(id)) return false;
        return (folder.parent || SPECIAL_FOLDERS.ROOT) === folderId;
      })
      .map(([id, folder]) => ({ id, ...folder }))
      .sort((a, b) => naturalCompare(a.name, b.name));
  }

  /**
   * 获取文件夹内素材数量（无需创建数组，直接查索引）
   * @param {string} folderId
   * @returns {number}
   */
  getItemCountByFolder(folderId) {
    const countVisible = (items, { limit = Infinity } = {}) => {
      let count = 0;
      for (const item of items) {
        if (!this._isItemVisibleInCurrentWorld(item)) continue;
        count += 1;
        if (count >= limit) return count;
      }
      return count;
    };

    if (this.isSmartFolderId(folderId)) {
      return this.getSmartFolderItemCount(folderId);
    }

    if (folderId === SPECIAL_FOLDERS.ALL || folderId === SPECIAL_FOLDERS.ROOT) {
      return countVisible(this._getAllItemsArray());
    }

    if (folderId === SPECIAL_FOLDERS.FAVORITES) {
      return countVisible(this._getAllItemsArray().filter(item => item.rating >= 4));
    }

    if (folderId === SPECIAL_FOLDERS.RECENT) {
      const recentItems = this._getAllItemsArray()
        .filter(item => item.lastUsed)
        .sort((a, b) => new Date(b.lastUsed) - new Date(a.lastUsed));
      return countVisible(recentItems, { limit: 50 });
    }

    const targetFolders = this.getAllDescendantFolders(folderId);
    targetFolders.add(folderId);
    const seen = new Set();
    let count = 0;
    for (const fid of targetFolders) {
      const itemIds = this._folderIndex.get(fid);
      if (!itemIds) continue;
      for (const id of itemIds) {
        if (seen.has(id)) continue;
        seen.add(id);
        const item = this.itemsCache.get(id);
        if (item && this._isItemVisibleInCurrentWorld(item)) count += 1;
      }
    }
    return count;
  }

  getAllItems() {
    return Object.fromEntries(this.itemsCache);
  }

  /**
   * 获取全量素材数组（惰性缓存）
   * @returns {Array}
   */
  _getAllItemsArray() {
    if (!this._allItemsArray) {
      this._allItemsArray = Array.from(this.itemsCache.values());
    }
    return this._allItemsArray;
  }

  // ==================== 文件夹索引维护 ====================

  /**
   * 将素材添加到文件夹反向索引
   * @param {string} itemId
   * @param {string[]} folderIds
   */
  _folderIndexAdd(itemId, folderIds) {
    if (!folderIds) return;
    for (const fid of folderIds) {
      let set = this._folderIndex.get(fid);
      if (!set) {
        set = new Set();
        this._folderIndex.set(fid, set);
      }
      set.add(itemId);
    }
    this._allItemsArray = null; // 失效全量缓存
  }

  /**
   * 从文件夹反向索引中移除素材
   * @param {string} itemId
   * @param {string[]} folderIds
   */
  _folderIndexRemove(itemId, folderIds) {
    if (!folderIds) return;
    for (const fid of folderIds) {
      const set = this._folderIndex.get(fid);
      if (set) {
        set.delete(itemId);
        if (set.size === 0) this._folderIndex.delete(fid);
      }
    }
    this._allItemsArray = null; // 失效全量缓存
  }

  // ==================== 标签操作 ====================

  /**
   * 创建标签 (Eagle 风格：标签无归属，跟随素材)
   * @param {string} name - 标签名称
   * @param {string} color - 标签颜色
   * @returns {string} 标签 ID
   */
  createTag(name, color = '#888888') {
    const id = name.toLowerCase().replace(/\s+/g, '-');

    if (this.tags[id]) {
      return id;
    }

    this.tags[id] = {
      id,
      name,
      color,
      sortOrder: Object.keys(this.tags).length
    };

    ovLog(`LibraryData | Created tag: ${name} (ID: ${id})`);

    this._tagsDirty = true;
    this._markDirty();
    Hooks.callAll(EVENTS.TAG_CREATED, this.tags[id]);

    return id;
  }

  /**
   * Eagle 风格：获取指定文件夹视图下素材使用的所有标签
   * 通过扫描文件夹及其子孙文件夹下的素材来确定可见标签
   * @param {string} folderId 
   * @returns {object[]} 标签对象数组
   */
  getTagsUsedInFolder(folderId) {
    if (this.isSmartFolderId(folderId)) {
      const usedTagIds = new Set();
      for (const item of this.getItemsBySmartFolder(folderId)) {
        for (const tagId of item.tags || []) {
          usedTagIds.add(tagId);
        }
      }
      return Array.from(usedTagIds)
        .map(id => this.tags[id])
        .filter(Boolean);
    }

    // 特殊处理：如果是全部素材或根目录，扫描所有素材返回实际使用的标签
    if (!folderId || folderId === SPECIAL_FOLDERS.ROOT || folderId === SPECIAL_FOLDERS.ALL || folderId.startsWith('__')) {
      const usedTagIds = new Set();
      for (const item of this.itemsCache.values()) {
        if (item.tags) {
          for (const tagId of item.tags) {
            usedTagIds.add(tagId);
          }
        }
      }
      return Array.from(usedTagIds)
        .map(id => this.tags[id])
        .filter(Boolean);
    }

    // 获取文件夹及其所有子孙文件夹 ID
    const folderIds = new Set([folderId, ...this.getAllDescendantFolders(folderId)]);

    // 收集这些文件夹下素材使用的标签 ID
    const usedTagIds = new Set();

    for (const item of this.itemsCache.values()) {
      // 检查素材是否在目标文件夹中
      const itemFolders = item.folders || [];
      const isInFolder = itemFolders.some(f => folderIds.has(f));

      if (isInFolder && item.tags) {
        for (const tagId of item.tags) {
          usedTagIds.add(tagId);
        }
      }
    }

    // 返回对应的标签对象
    return Array.from(usedTagIds)
      .map(id => this.tags[id])
      .filter(Boolean); // 过滤掉可能已删除的标签
  }

  /**
   * 别名：保持向后兼容
   * @deprecated 使用 getTagsUsedInFolder 代替
   */
  getTagsForFolder(folderId) {
    return this.getTagsUsedInFolder(folderId);
  }

  /**
   * 获取仅被物品类型文件引用的标签 ID 集合
   * 这些标签不应出现在普通标签筛选器中，只在物品筛选器中显示
   * @param {string} folderId
   * @returns {Set<string>} 仅被物品引用的标签 ID 集合
   */
  getItemOnlyTagIds(folderId) {
    if (this.isSmartFolderId(folderId)) {
      const itemTagIds = new Set();
      const nonItemTagIds = new Set();

      for (const item of this.getItemsBySmartFolder(folderId)) {
        if (!item.tags || item.tags.length === 0) continue;
        const isItemType = item.metadata?.type === 'item';
        for (const tagId of item.tags) {
          if (isItemType) itemTagIds.add(tagId);
          else nonItemTagIds.add(tagId);
        }
      }

      const itemOnlyIds = new Set();
      for (const tagId of itemTagIds) {
        if (!nonItemTagIds.has(tagId)) itemOnlyIds.add(tagId);
      }
      return itemOnlyIds;
    }

    const isAllFolder = !folderId || folderId === SPECIAL_FOLDERS.ROOT ||
      folderId === SPECIAL_FOLDERS.ALL || folderId.startsWith('__');

    const folderIds = isAllFolder
      ? null
      : new Set([folderId, ...this.getAllDescendantFolders(folderId)]);

    // 收集: 被物品类型使用的标签 vs 被非物品类型使用的标签
    const itemTagIds = new Set();
    const nonItemTagIds = new Set();

    for (const item of this.itemsCache.values()) {
      if (!item.tags || item.tags.length === 0) continue;

      // 文件夹过滤
      if (folderIds) {
        const itemFolders = item.folders || [];
        if (!itemFolders.some(f => folderIds.has(f))) continue;
      }

      const isItemType = item.metadata?.type === 'item';

      for (const tagId of item.tags) {
        if (isItemType) {
          itemTagIds.add(tagId);
        } else {
          nonItemTagIds.add(tagId);
        }
      }
    }

    // 返回：仅在物品中使用、不在非物品中使用的标签
    const itemOnlyIds = new Set();
    for (const tagId of itemTagIds) {
      if (!nonItemTagIds.has(tagId)) {
        itemOnlyIds.add(tagId);
      }
    }
    return itemOnlyIds;
  }

  async deleteTag(id) {
    if (!this.tags[id]) return;

    // 从所有资源中移除
    for (const item of this.itemsCache.values()) {
      if (item.tags.includes(id)) {
        item.tags = item.tags.filter(tagId => tagId !== id);
        await this._saveAssetMetadata(item.id, item);
      }
    }

    delete this.tags[id];
    this._tagsDirty = true;
    this._markDirty();
    Hooks.callAll(EVENTS.TAG_DELETED, { id });
  }

  async updateTag(id, data) {
    if (!this.tags[id]) return;

    const changedKeys = Object.keys(data || {}).filter((key) => this.tags[id]?.[key] !== data[key]);
    this.tags[id] = { ...this.tags[id], ...data };
    this._tagsDirty = true;
    this._markDirty();
    Hooks.callAll(EVENTS.TAG_UPDATED, { ...this.tags[id], __ovChangedKeys: changedKeys });
  }

  async addTagToItem(itemId, tagId) {
    const item = this.itemsCache.get(itemId);
    if (!item) throw new Error(`Item not found: ${itemId}`);

    if (!item.tags.includes(tagId)) {
      item.tags.push(tagId);
      await this._saveAssetMetadata(itemId, item);
      Hooks.callAll(EVENTS.ITEM_UPDATED, item);
    }

    // 追踪最近使用的标签
    this._updateRecentTags(tagId);
  }

  /**
   * 更新最近使用的标签列表
   * @param {string} tagId 
   */
  _updateRecentTags(tagId) {
    if (!this.config.recentTags) {
      this.config.recentTags = [];
    }
    // 移除已存在的（避免重复）
    this.config.recentTags = this.config.recentTags.filter(id => id !== tagId);
    // 添加到开头
    this.config.recentTags.unshift(tagId);
    // 保留最多 20 个
    this.config.recentTags = this.config.recentTags.slice(0, 20);
    this._markDirty();
  }

  /**
   * 获取最近使用的标签
   * @param {number} limit - 最多返回多少个
   * @returns {object[]} 标签对象数组
   */
  getRecentTags(limit = 6) {
    const recentIds = this.config.recentTags || [];
    return recentIds
      .slice(0, limit)
      .map(id => this.tags[id])
      .filter(Boolean); // 过滤掉已删除的标签
  }

  async removeTagFromItem(itemId, tagId) {
    const item = this.itemsCache.get(itemId);
    if (!item) throw new Error(`Item not found: ${itemId}`);

    item.tags = item.tags.filter(id => id !== tagId);
    await this._saveAssetMetadata(itemId, item);
    Hooks.callAll(EVENTS.ITEM_UPDATED, item);
  }

  getTag(id) {
    return this.tags[id] || null;
  }

  getAllTags() {
    return this.tags;
  }

  getItemsByTag(tagId) {
    return Array.from(this.itemsCache.values()).filter(item => item.tags.includes(tagId));
  }

  /**
   * 获取智能标签推荐
   * Eagle 风格：支持推荐“潜在标签”，过滤数字字段，确保每素材必有推荐
   * @param {object} item - 素材对象
   * @param {number} limit - 最多返回多少个
   * @returns {object[]} 包含 isPotential 标识的标签对象数组
   */
  getSmartTagSuggestions(item, limit = 8) {
    if (!item) return [];

    const itemTags = new Set(item.tags || []);
    const tagScores = new Map(); // tagId/token -> { score, isPotential, name }

    // 获取规范化后的文件名 (用于推荐)
    const displayName = item.displayName || this._getFileName(item.path);
    const normalizedName = decodeURIComponent(displayName).toLowerCase();

    // 获取当前文件的有效 token
    const itemTokens = this._tokenize(normalizedName);

    // Helper: 添加分数
    const addScore = (id, score, name, isPotential = false) => {
      if (itemTags.has(id)) return;
      const existing = tagScores.get(id);
      if (existing) {
        existing.score += score;
      } else {
        tagScores.set(id, { id, score, name, isPotential });
      }
    };

    // 1. 文件名 Token 打分 (核心优先级：文件名提炼词)
    // 显著提升文件名词段权重，使其优先级远高于文件夹名称
    for (const token of itemTokens) {
      const existingTag = Object.values(this.tags).find(t => t.name.toLowerCase() === token);
      const freq = this._tokenFreq.get(token) || 0;

      if (existingTag) {
        // 已有标签精确命中文件名词段：极高权重
        addScore(existingTag.id, 50 + freq, existingTag.name, false);
      } else {
        // 文件名提炼出的潜在新标签：高权重
        addScore(`potential_${token}`, 40 + freq, token, true);
      }
    }

    // 2. 已有标签匹配 (文件名包含但不是完整词)
    for (const tag of Object.values(this.tags)) {
      const tagName = tag.name.toLowerCase();
      // 避免与精确命中重复
      if (tagScores.has(tag.id)) continue;

      if (normalizedName.includes(tagName)) {
        const freq = this._tokenFreq.get(tagName) || 0;
        addScore(tag.id, 20 + Math.min(freq, 50), tag.name, false);
      }
    }

    // 3. 文件夹习惯与名称匹配 (次要优先级)
    const itemFolderId = (item.folders || [])[0];
    if (itemFolderId) {
      const siblings = this.getItemsByFolder(itemFolderId);
      for (const sibling of siblings) {
        if (sibling.id === item.id) continue;
        for (const tagId of (sibling.tags || [])) {
          if (this.tags[tagId]) {
            addScore(tagId, 1.5, this.tags[tagId].name, false);
          }
        }
      }

      // 4. 文件夹名整体匹配 (用户要求：永不拆分)
      let currentFolder = this.config.folders[itemFolderId];
      let depth = 0;
      while (currentFolder && depth < 2) { // 仅向上追溯两级
        if (currentFolder.name && currentFolder.name !== SPECIAL_FOLDERS.ROOT &&
          currentFolder.name !== 'Library' && currentFolder.name !== '素材库') {

          const folderName = currentFolder.name;
          // 文件夹名作为一个整体推荐，不再进行拆分
          // 权重设为 10，低于文件名词干（40），确保文件名关键词排在最前面
          addScore(`potential_${folderName.toLowerCase()}`, 10, folderName, true);
        }
        currentFolder = this.config.folders[currentFolder.parent];
        depth++;
      }
    }

    // 5. 排序
    let sorted = Array.from(tagScores.values())
      .sort((a, b) => b.score - a.score);

    // 6. 保底逻辑：确保每个素材必有推荐 (满足用户强约束)
    if (sorted.length === 0) {
      if (itemTokens.length > 0) {
        // 优先级 1: 文件名中第一个非数字词干
        const firstToken = itemTokens[0];
        sorted.push({ id: `potential_${firstToken}`, score: 1, name: firstToken, isPotential: true });
      } else {
        // 优先级 2: 文件夹名称 (如果不是根目录)
        const folder = this.getFolder(itemFolderId);
        if (folder && folder.name && folder.id !== SPECIAL_FOLDERS.ROOT) {
          const folderTokens = this._tokenize(folder.name);
          const fToken = folderTokens.length > 0 ? folderTokens[0] : folder.name;
          // 再次检查文件夹名是否也是全数字，如果不是则使用
          if (!/\d/.test(fToken)) {
            sorted.push({ id: `potential_${fToken}`, score: 0.5, name: fToken, isPotential: true });
          }
        }
      }

      // 优先级 3: 终极保底 - 文件后缀名 (如 PNG, MP4)
      if (sorted.length === 0) {
        const ext = item.path.split('.').pop().toUpperCase();
        sorted.push({ id: `potential_${ext}`, score: 0.1, name: ext, isPotential: true });
      }
    }

    // 7. 映射回标准格式
    return sorted.slice(0, limit).map(s => {
      if (s.isPotential) {
        return { id: s.id, name: s.name, color: '#888888', isPotential: true, score: s.score };
      }
      const tag = this.tags[s.id];
      return tag ? { ...tag, score: s.score } : null;
    }).filter(Boolean);
  }

  /**
   * 增强分词逻辑：支持中英文
   * 1. 分离数字与文字 (洞穴01 -> 洞穴, 01)
   * 2. 过滤纯数字 (如 01, 04)，但保留有意义的关键词
   * @param {string} text 
   * @returns {string[]}
   */
  _tokenize(text) {
    if (!text) return [];

    // 1. 预处理：在数字和非数字之间插入空格 (例如 Room1 -> Room 1)
    const spaced = text.replace(/([a-zA-Z\u4e00-\u9fa5])(\d)/g, '$1 $2')
      .replace(/(\d)([a-zA-Z\u4e00-\u9fa5])/g, '$1 $2');

    // 2. 按分隔符拆分 (不再在这里尝试移除扩展名，因为输入通常已经是处理过的名称)
    return spaced.split(/[\s_\-\.\(\)\[\]\{\}\uff08\uff09\u3010\u3011\uff0c\u3002\uff1a\uff1b\uff1f\uff01\uff5c\|\/\\\+\&\*\,\;\?\!\=\>\<]+/)
      .filter(k => k.length >= 1)
      // 3. 过滤掉纯数字的 Token (如 01, 04)，但保留包含字母或中文的词
      .filter(k => !/^\d+$/.test(k))
      // 4. 长度限制与纯符号过滤
      .filter(k => {
        // 中文单字允许
        if (/[\u4e00-\u9fa5]/.test(k)) return true;
        // 英文/西文字符要求长度 >= 2 且必须包含字母
        return k.length >= 2 && /[a-zA-Z]/.test(k);
      });
  }

  /**
   * 从单个素材更新词频索引
   * @param {object} item 
   * @param {number} delta - 增加或减少的数量 (1 或 -1)
   */
  _updateTokenFreqFromItem(item, delta) {
    const displayName = item.displayName || this._getFileName(item.path);
    const name = decodeURIComponent(displayName).toLowerCase();
    const tokens = this._tokenize(name);

    // 1. 基础 Token 词频
    for (const token of tokens) {
      const current = this._tokenFreq.get(token) || 0;
      this._tokenFreq.set(token, Math.max(0, current + delta));
    }

    // 2. 标签名命中词频 (针对中文无空格情况)
    // 如果库中有标签，我们也统计这些标签名在文件名中出现的频次
    for (const tag of Object.values(this.tags)) {
      const tagName = tag.name.toLowerCase();
      if (name.includes(tagName)) {
        const current = this._tokenFreq.get(tagName) || 0;
        this._tokenFreq.set(tagName, Math.max(0, current + delta));
      }
    }
  }

  // ==================== 搜索 ====================

  searchItems(query, filters = {}) {
    let results;

    // 1. 确定搜索范围
    if (filters.folderId) {
      if (filters.includeSubfolders === false) {
        results = this.getDirectItemsByFolder(filters.folderId);
      } else if (filters.folderId !== SPECIAL_FOLDERS.ALL) {
        // 如果指定了文件夹，仅在该文件夹及其子文件夹中搜索
        results = this.getItemsByFolder(filters.folderId);
      } else {
        // 全局搜索
        results = this._filterItemsForCurrentWorld(Array.from(this.itemsCache.values()));
      }
    } else {
      // 全局搜索
      results = this._filterItemsForCurrentWorld(Array.from(this.itemsCache.values()));
    }

    // 2. 优先应用硬性过滤 (Tag/Rating/Type) - 减少 Fuse 计算量
    if (filters.tags && filters.tags.length > 0) {
      results = results.filter(item =>
        filters.tags.every(tagId => item.tags.includes(tagId))
      );
    }

    // 排除标签筛选
    if (filters.excludeTags && filters.excludeTags.length > 0) {
      results = results.filter(item =>
        !filters.excludeTags.some(tagId => item.tags.includes(tagId))
      );
    }

    // 未标签筛选
    if (filters.untagged) {
      results = results.filter(item => !item.tags || item.tags.length === 0);
    }

    if (filters.minRating) {
      results = results.filter(item => item.rating >= filters.minRating);
    }

    if (filters.fileTypes && filters.fileTypes.length > 0) {
      // 预先获取已导入场景的源 ID 集合，优化性能
      const importedSceneSourceIds = new Set();
      const importedWorldSceneIds = new Set();
      const importedSceneNames = new Set();
      const importedItemSourceIds = new Set();
      const importedActorSourceIds = new Set();
      const importedActorWorldUuids = new Set();
      if (filters.fileTypes.includes('imported_scene')) {
        game.scenes.forEach(s => {
          if (s.id) importedWorldSceneIds.add(s.id);
          if (s._stats?.compendiumSource) importedSceneSourceIds.add(s._stats.compendiumSource);
          if (s.flags?.core?.sourceId) importedSceneSourceIds.add(s.flags.core.sourceId);
          const sceneName = s.name?.trim?.().toLowerCase();
          if (sceneName) importedSceneNames.add(sceneName);
        });
      }
      if (filters.fileTypes.includes('imported_item')) {
        game.items.forEach(i => {
          if (i._stats?.compendiumSource) importedItemSourceIds.add(i._stats.compendiumSource);
          if (i.flags?.core?.sourceId) importedItemSourceIds.add(i.flags.core.sourceId);
        });
      }
      if (filters.fileTypes.includes('imported_actor')) {
        game.actors.forEach(a => {
          if (a.uuid) importedActorWorldUuids.add(a.uuid);
          if (a._stats?.compendiumSource) importedActorSourceIds.add(a._stats.compendiumSource);
          if (a.flags?.core?.sourceId) importedActorSourceIds.add(a.flags.core.sourceId);
        });
      }

      results = results.filter(item => {
        // 场景类型单独判断
        const isScene = item.metadata?.type === 'scene' || item.type === 'scene';
        // 角色类型单独判断
        const isActor = item.metadata?.type === 'actor';

        // 检查是否为已导入场景
        if (filters.fileTypes.includes('imported_scene') && isScene) {
          const persistedWorldSceneId = getWorldSceneId(item, { library: this });
          if (persistedWorldSceneId && importedWorldSceneIds.has(persistedWorldSceneId)) return true;

          const uuid = item.metadata?.uuid || item.uuid;
          if (uuid && importedSceneSourceIds.has(uuid)) return true;

          if (!persistedWorldSceneId) {
            const sceneName = (item.metadata?.sceneName || item.name || item.displayName || '').trim().toLowerCase();
            if (sceneName && importedSceneNames.has(sceneName)) return true;
          }
        }

        if (isScene) {
          return filters.fileTypes.includes('scene');
        }

        if (filters.fileTypes.includes('imported_actor') && isActor) {
          const uuid = item.metadata?.uuid || item.uuid;
          if (uuid && (importedActorWorldUuids.has(uuid) || importedActorSourceIds.has(uuid))) return true;
        }

        if (isActor) {
          return filters.fileTypes.includes('actor');
        }

        // 物品类型单独判断
        const isItem = item.metadata?.type === 'item' || item.type === 'item';
        if (filters.fileTypes.includes('imported_item') && isItem) {
          const uuid = item.metadata?.uuid || item.uuid;
          if (uuid && importedItemSourceIds.has(uuid)) return true;
        }
        if (isItem) {
          return filters.fileTypes.includes('item');
        }

        const ext = this._getFileExtension(item.path);
        return filters.fileTypes.some(type => {
          if (type === 'image') return ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'].includes(ext);
          if (type === 'video') return ['.webm', '.mp4', '.mov', '.avi', '.mkv'].includes(ext);
          if (type === 'audio') return ['.mp3', '.wav', '.ogg', '.flac', '.m4a'].includes(ext);
          if (type === 'scene') return false; // 已处理
          if (type === 'actor') return false; // 已处理
          if (type === 'item') return false; // 已处理
          if (type === 'imported_scene') return false; // 已处理
          if (type === 'imported_actor') return false; // 已处理
          return false;
        });
      });
    }

    // 3. 执行搜索
    if (query) {
      if (filters.mode === 'exact') {
        const lowerQuery = query.toLowerCase();
        return results.filter(item => {
          let displayName = item.displayName || this._getFileName(item.path);
          try { displayName = decodeURIComponent(displayName); } catch (e) { }
          return displayName.toLowerCase().includes(lowerQuery) ||
            (item.notes || '').toLowerCase().includes(lowerQuery) ||
            item.tags.some(tagId => {
              const tag = this.tags[tagId];
              return tag && tag.name.toLowerCase().includes(lowerQuery);
            });
        });
      } else {
        // 模糊搜索 (Fuse.js)
        // 为 Fuse 准备数据 (包含标签名，解码 displayName)
        const searchData = results.map(item => {
          let dn = item.displayName || this._getFileName(item.path);
          try { dn = decodeURIComponent(dn); } catch (e) { }
          return {
            ...item,
            _decodedName: dn,
            // 预处理标签名用于搜索
            _tagNames: (item.tags || []).map(tagId => this.tags[tagId]?.name || '').join(' ')
          };
        });

        const options = {
          includeScore: true,
          threshold: 0.3, // 0.0=精确匹配, 1.0=匹配任何
          minMatchCharLength: 2, // 至少连续匹配 2 个字符，过滤噪音
          ignoreLocation: true, // 忽略位置信息 (匹配内容即可，不一定非要在开头)
          keys: [
            { name: '_decodedName', weight: 2.0 }, // 解码后的显示名称权重最高
            { name: 'name', weight: 1.5 },       // 文件名权重次之
            { name: '_tagNames', weight: 1.0 },  // 标签名
            { name: 'notes', weight: 0.5 }       // 备注
          ]
        };

        const fuse = new Fuse(searchData, options);

        // 执行搜索并映射回原始 item
        return fuse.search(query).map(result => result.item);
      }
    }

    return results;
  }

  // ==================== 设置 ====================

  getSetting(key) {
    return this.config.settings[key];
  }

  setSetting(key, value) {
    this.config.settings[key] = value;
    this._markDirty();
  }

  getAllSettings() {
    return this.config.settings;
  }

  // ==================== 工具方法 ====================

  _markDirty() {
    this.dirty = true;
    this.save();
  }

  _getFileName(path) {
    return String(path || '').split('/').pop().replace(/\.[^/.]+$/, '');
  }

  _getFileExtension(path) {
    const match = String(path || '').match(/\.[^/.]+$/);
    return match ? match[0].toLowerCase() : '';
  }

  exportData() {
    return JSON.stringify(this.data, null, 2);
  }

  /**
   * 导入数据
   * @param {object} data - 导入的数据对象
   * @param {boolean} merge - 是否为合并模式
   * @param {Function} progressCallback - 进度回调 (current, total, phase)
   * @returns {Promise<object>} 统计结果
   */
  async importData(data, merge = false, progressCallback = null) {
    const stats = { added: 0, updated: 0, skipped: 0 };
    const sourceData = data.data || data; // 兼容不同包装格式
    const CONCURRENCY = 10; // 并发数

    if (merge) {
      // 合并文件夹
      if (progressCallback) progressCallback(0, 1, 'folders');
      for (const [id, folder] of Object.entries(sourceData.folders || {})) {
        if (!this.config.folders[id]) {
          this.config.folders[id] = folder;
        }
      }

      // 智能文件夹只是保存的查询条件，合并导入时不覆盖本地同名 ID，避免用户已有视图被顶掉
      this.config.smartFolders = this.config.smartFolders || {};
      const incomingSmartFolders = this._normalizeSmartFolders(sourceData.smartFolders || {});
      for (const [id, smartFolder] of Object.entries(incomingSmartFolders)) {
        if (!this.config.smartFolders[id]) {
          this.config.smartFolders[id] = smartFolder;
        }
      }

      // 重建文件夹树（根据 parent 字段重新生成 children 列表）
      this._rebuildFolderTree();

      // 合并标签 (修复点：确保 sourceData.tags 被正确处理)
      const incomingTags = sourceData.tags || data.tags || {};
      for (const [id, tag] of Object.entries(incomingTags)) {
        if (!this.tags[id]) {
          this.tags[id] = tag;
          this._tagsDirty = true;
        }
      }

      // 合并素材（按路径去重）- 保留原始 ID 和缩略图元数据
      const existingPaths = new Map();
      for (const [id, item] of this.itemsCache) {
        existingPaths.set(item.path, id);
      }

      // 筛选出需要导入的素材（保留原始 ID）
      const itemsToImport = [];
      for (const [id, item] of Object.entries(sourceData.items || {})) {
        if (!existingPaths.has(item.path)) {
          itemsToImport.push([id, item]);
        } else {
          stats.skipped++;
        }
      }

      // 并发批量导入（保留原始 ID 和所有元数据字段）
      const total = itemsToImport.length;
      let completed = 0;

      for (let i = 0; i < total; i += CONCURRENCY) {
        const batch = itemsToImport.slice(i, i + CONCURRENCY);
        await Promise.all(batch.map(async ([id, item]) => {
          try {
            const assetData = new AssetData(this.basePath, id);

            const metadata = {
              id,
              version: DATA_VERSION.ASSET,
              path: item.path,
              folders: item.folders || [SPECIAL_FOLDERS.ROOT],
              displayName: item.displayName || null,
              tags: item.tags || [],
              rating: item.rating || 0,
              notes: item.notes || '',
              addedDate: item.addedDate || new Date().toISOString(),
              lastUsed: item.lastUsed || null,
              useCount: item.useCount || 0,
              metadata: item.metadata || null,
              thumbnail: item.thumbnail || null,
              thumbnailGenerated: item.thumbnailGenerated || false,
              thumbnailVersion: item.thumbnailVersion || undefined,
              thumbnailRevision: item.thumbnailRevision || undefined
            };

            await assetData.save(metadata);
            this.itemsCache.set(id, metadata);
            this._pathIndex.set(item.path, id);

            stats.added++;
          } catch (e) {
            console.warn(`${MODULE_ID} | Failed to import item: ${item.path}`, e);
            stats.skipped++;
          }
          completed++;
          if (progressCallback) progressCallback(completed, total, 'items');
        }));
      }
    } else {
      // 替换模式：使用并发迁移
      this.itemsCache.clear();
      this.tags = {};
      this._tagsDirty = true;

      await this._migrateFromLegacyConcurrent(sourceData, CONCURRENCY, progressCallback);

      // 替换模式也重建文件夹树，确保结构一致
      this._rebuildFolderTree();

      stats.added = this.itemsCache.size;
    }

    // 标记脏数据并保存
    this._markDirty();
    await this.save(true);

    // 强制重新加载以确保所有内部索引同步
    await this.load();

    return stats;
  }

  /**
   * 从旧版数据并发迁移到分散存储（优化版）
   * @param {object} legacyData 
   * @param {number} concurrency - 并发数
   * @param {Function} progressCallback - 进度回调 (current, total, phase)
   */
  async _migrateFromLegacyConcurrent(legacyData, concurrency = 10, progressCallback = null) {
    ovLog(`${MODULE_ID} | Migrating from legacy format (concurrent, batch=${concurrency})...`);

    const items = legacyData.items || {};
    const itemEntries = Object.entries(items);
    const itemCount = itemEntries.length;
    let migrated = 0;

    // 1. 创建新配置（不含 items 和 tags）
    this.config = {
      version: DATA_VERSION.LIBRARY,
      name: legacyData.name || t('origin-vault.folders.root'),
      created: legacyData.created || new Date().toISOString(),
      lastModified: new Date().toISOString(),
      folders: legacyData.folders || this._getDefaultConfig().folders,
      smartFolders: this._normalizeSmartFolders(legacyData.smartFolders || {}),
      settings: {
        ...DEFAULT_SETTINGS,
        ...(legacyData.settings || {})
      }
    };

    // 1.5 迁移标签到独立 tags 属性
    this.tags = legacyData.tags || {};
    this._tagsDirty = true;

    // 2. 并发为每个资源创建独立文件夹
    for (let i = 0; i < itemCount; i += concurrency) {
      const batch = itemEntries.slice(i, i + concurrency);
      await Promise.all(batch.map(async ([id, item]) => {
        try {
          const assetData = new AssetData(this.basePath, id);

          const metadata = {
            id,
            version: DATA_VERSION.ASSET,
            path: item.path,
            folders: item.folders || ['root'],
            displayName: item.displayName || null,
            tags: item.tags || [],
            rating: item.rating || 0,
            notes: item.notes || '',
            addedDate: item.addedDate || new Date().toISOString(),
            lastUsed: item.lastUsed || null,
            useCount: item.useCount || 0,
            metadata: item.metadata || null,
            thumbnail: item.thumbnail || null,
            thumbnailGenerated: item.thumbnailGenerated || false,
            thumbnailVersion: item.thumbnailVersion || undefined,
            thumbnailRevision: item.thumbnailRevision || undefined
          };

          await assetData.save(metadata);

          if (item.thumbnail) {
            await this._migrateThumbnail(item.thumbnail, assetData);
          }

          this.itemsCache.set(id, metadata);
          migrated++;

          if (progressCallback) progressCallback(migrated, itemCount, 'items');
        } catch (e) {
          console.warn(`${MODULE_ID} | Failed to migrate item ${id}:`, e);
        }
      }));
    }

    // 3. 备份旧数据
    try {
      const backupContent = JSON.stringify(legacyData);
      const backupFile = new File([backupContent], 'library-v2-backup.json', { type: 'application/json' });
      await uploadWithFilePicker('data', this.basePath, backupFile, {}, { notify: false });
    } catch (e) {
      console.warn(`${MODULE_ID} | Failed to create backup:`, e);
    }

    // 4. 保存新配置和标签
    await this._saveConfig();
    await this._saveTags();

    ovLog(`${MODULE_ID} | Concurrent migration complete: ${migrated}/${itemCount} items`);
  }

  /**
   * 重建文件夹树结构
   * 根据每个文件夹的 parent 字段重新生成所有 children 列表
   * 用于导入后修复丢失的父子关系
   */
  _rebuildFolderTree() {
    const folders = this.config.folders;

    // 确保 root 存在
    if (!folders[SPECIAL_FOLDERS.ROOT]) {
      folders[SPECIAL_FOLDERS.ROOT] = {
        id: SPECIAL_FOLDERS.ROOT,
        name: t('origin-vault.folders.root'),
        parent: null,
        children: [],
        color: null,
        icon: null,
        sortOrder: 0,
        collapsed: false
      };
    }

    // 清空所有 children 列表
    for (const folder of Object.values(folders)) {
      folder.children = [];
    }

    // 根据 parent 字段重建 children
    for (const [id, folder] of Object.entries(folders)) {
      if (id === SPECIAL_FOLDERS.ROOT) continue;

      const parentId = folder.parent || SPECIAL_FOLDERS.ROOT;
      const parent = folders[parentId];

      if (parent) {
        parent.children.push(id);
      } else {
        // 父文件夹不存在，挂到 root
        folder.parent = SPECIAL_FOLDERS.ROOT;
        folders[SPECIAL_FOLDERS.ROOT].children.push(id);
      }
    }

    // 按 sortOrder 排序
    for (const folder of Object.values(folders)) {
      folder.children.sort((a, b) => {
        const fa = folders[a];
        const fb = folders[b];
        return (fa?.sortOrder || 0) - (fb?.sortOrder || 0);
      });
      this._syncFolderChildSortOrder(folder);
    }

    ovLog(`${MODULE_ID} | Folder tree rebuilt. Root children: ${folders[SPECIAL_FOLDERS.ROOT].children.length}`);
  }

  getStats() {
    const items = this._filterItemsForCurrentWorld(Array.from(this.itemsCache?.values() || []));
    const folders = this.config?.folders || {};
    const tags = this.tags || {};

    return {
      totalItems: items.length,
      totalFolders: Math.max(0, Object.keys(folders).length - 1), // 排除根目录
      totalTags: Object.keys(tags).length,
      itemsWithThumbnails: items.filter(i => i.thumbnailGenerated).length,
      averageRating: items.length > 0
        ? (items.reduce((sum, i) => sum + (i.rating || 0), 0) / items.length).toFixed(1)
        : 0
    };
  }
}

/**
 * @typedef {object} LibraryConfigData
 * @property {string} version
 * @property {string} name
 * @property {string} created
 * @property {string} lastModified
 * @property {Object<string, FolderData>} folders
 * @property {Object<string, TagData>} tags
 * @property {Object<string, SmartFolderData>} smartFolders
 * @property {object} settings
 */
