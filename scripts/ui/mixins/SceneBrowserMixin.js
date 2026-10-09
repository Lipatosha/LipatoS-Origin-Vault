import { ovText } from '../../utils/locale.js';
/**
 * SceneBrowserMixin - 场景浏览器相关方法
 * 从 MainWindow 提取的场景浏览、导入、预览、渲染等方法
 * 
 * 包含：场景数据获取、场景导入、场景预览生成、场景渲染器初始化
 * 混入后通过 this 访问 MainWindow 实例状态
 */

import { MODULE_ID, MODULE_TITLE, SPECIAL_FOLDERS, IS_MAD_EDITION } from '../../constants.js';
import { SceneRenderer } from '../SceneRenderer.js';
import { ImportFloater } from '../ImportFloater.js';
import { ThumbnailManager } from '../../utils/ThumbnailManager.js';
import { t, tf } from '../../utils/i18n.js';
import { ovDebug, ovLog } from '../../utils/logger.js';
import { getWorldSceneBinding, getWorldSceneId, setWorldSceneBinding } from '../../utils/worldSceneBindings.js';

/**
 * 将方法混入目标类
 * @param {Function} cls - 目标类 (MainWindow)
 */
export function applySceneBrowserMixin(cls) {
  cls.prototype._getSceneLevelStorageKey = function(sceneLike, sceneData = null) {
    return sceneLike?.sceneLevelKey
      || sceneLike?.uuid
      || sceneLike?.metadata?.uuid
      || getWorldSceneId(sceneLike, { library: this.library })
      || sceneLike?.worldSceneId
      || sceneData?._id
      || sceneLike?.id
      || sceneLike?.path
      || sceneLike?.displayName
      || sceneLike?.name
      || null;
  };

  cls.prototype._getPendingSceneLevelOverride = function(sceneLike, sceneData = null) {
    const pending = this._pendingPreviewSceneLevelOverride;
    if (!pending) return null;

    const sceneLevelKey = this._getSceneLevelStorageKey(sceneLike, sceneData);
    const candidates = new Set([
      sceneLevelKey,
      sceneLike?.id,
      sceneLike?._id,
      sceneLike?.uuid,
      sceneLike?.metadata?.uuid,
      sceneLike?.path
    ].filter(Boolean));

    if (candidates.has(pending.sceneLevelKey) || candidates.has(pending.itemId)) {
      return pending.levelId;
    }

    return null;
  };

  cls.prototype._resolveAssetCollectionFolderId = function(item) {
    const itemFolders = Array.isArray(item?.folders)
      ? item.folders.filter(folderId => folderId && !String(folderId).startsWith('__'))
      : [];
    const realFolders = itemFolders.filter(folderId => folderId === SPECIAL_FOLDERS.ROOT || this.library.getFolder(folderId));
    const currentFolderId = this.currentFolderId;

    if (currentFolderId && !String(currentFolderId).startsWith('__')) {
      if (realFolders.includes(currentFolderId)) return currentFolderId;

      const descendantIds = new Set(this.library.getAllDescendantFolders?.(currentFolderId) || []);
      const nestedFolderId = realFolders.find(folderId => descendantIds.has(folderId));
      if (nestedFolderId) return nestedFolderId;
    }

    return realFolders[0] || (currentFolderId && !String(currentFolderId).startsWith('__')
      ? currentFolderId
      : SPECIAL_FOLDERS.ROOT);
  };

  /**
   * 初始化场景渲染器
   * @param {jQuery} panelEl - 右侧面板元素
   * @param {object} sceneDetail - 场景详情数据
   */
  cls.prototype._initSceneRenderer = async function(panelEl, sceneDetail) {
    const container = panelEl.find('.scene-canvas-container')[0];
    if (!container) {
      ovDebug(`${MODULE_ID} | Scene canvas container not found (panel may not be ready)`);
      return;
    }

    // 销毁旧的渲染器实例
    if (this.sceneRenderer) {
      this.sceneRenderer.destroy();
      this.sceneRenderer = null;
    }

    try {
      // 获取完整的场景文档数据
      const sceneData = await this._getFullSceneData(sceneDetail);
      if (!sceneData) {
        console.warn(`${MODULE_ID} | Failed to get scene data for:`, sceneDetail.id);
        container.innerHTML = '<div class="scene-load-error"><i class="fas fa-exclamation-triangle"></i> Failed to load scene</div>';
        return;
      }

      const sceneLevelKey = this._getSceneLevelStorageKey(sceneDetail, sceneData);
      const overrideLevelId = this._getPendingSceneLevelOverride(sceneDetail, sceneData);
      const storedLevelId = overrideLevelId || this._sceneLevelSelection?.get(sceneLevelKey) || sceneDetail.activeSceneLevelId || null;
      const sceneLevelOptions = SceneRenderer.getDetailLevelOptions();
      const activeSceneLevelId = SceneRenderer.resolveLevelId(sceneData, storedLevelId, sceneLevelOptions);
      if (sceneLevelKey && activeSceneLevelId) {
        const levelStore = this._sceneLevelSelection || (this._sceneLevelSelection = new Map());
        levelStore.set(sceneLevelKey, activeSceneLevelId);
      }
      sceneDetail.sceneLevelKey = sceneLevelKey;
      sceneDetail.activeSceneLevelId = activeSceneLevelId;

      ovLog(`${MODULE_ID} | Initializing SceneRenderer for:`, sceneData.name);

      // 创建渲染器实例 - 详情页启用交互
      // 使用 minResolution 确保足够的渲染分辨率（即使容器很小）
      this.sceneRenderer = new SceneRenderer(container, sceneData, {
        interactive: true,
        showWalls: false,
        showLights: false,
        levelId: sceneDetail.activeSceneLevelId || null,
        ...sceneLevelOptions,
        minResolution: 1024  // 确保至少 1024px 的渲染分辨率
      });

      // 延迟渲染以确保容器尺寸有效
      const attemptRender = async (attempt = 0) => {
        const rect = container.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          ovLog(`${MODULE_ID} | Details panel container ready: ${rect.width}x${rect.height}`);
          await this.sceneRenderer.render();
        } else if (attempt < 10) {
          ovLog(`${MODULE_ID} | Waiting for details panel container size, attempt ${attempt + 1}`);
          await new Promise(r => requestAnimationFrame(r));
          await attemptRender(attempt + 1);
        } else {
          console.warn(`${MODULE_ID} | Details panel container size still 0 after retries`);
        }
      };
      await attemptRender(0);

      // 绑定图层控制事件
      this._bindSceneLayerControls(panelEl);
      this._bindSceneLevelControls(panelEl, sceneDetail);

    } catch (error) {
      console.error(`${MODULE_ID} | Failed to initialize SceneRenderer:`, error);
      container.innerHTML = '<div class="scene-load-error"><i class="fas fa-exclamation-triangle"></i> Render failed</div>';
    }
  };

  /**
   * 获取完整的场景文档数据
   * @param {object} sceneDetail - 场景详情 (来自 SceneAdapter 或 Library)
   * @returns {Promise<object|null>} 场景数据 (包含 background, tiles, walls, lights)
   */
  cls.prototype._getFullSceneData = async function(sceneDetail) {
    try {
      // 世界场景绑定只认当前世界，避免全局库把别的世界的场景也当成已存在。
      const worldSceneId = sceneDetail.worldSceneId || getWorldSceneId(sceneDetail, { library: this.library });
      if (worldSceneId) {
        const worldScene = game.scenes.get(worldSceneId);
        if (worldScene) {
          return worldScene.toObject();
        }
      }

      // 如果有 UUID，尝试从 Compendium 获取完整文档
      if (sceneDetail.uuid) {
        const doc = await fromUuid(sceneDetail.uuid);
        if (doc) {
          return doc.toObject();
        }
      }

      // 如果有 folderId (Pack ID) 和 id，从 Pack 获取
      if (sceneDetail.folderId && sceneDetail.id) {
        const pack = game.packs.get(sceneDetail.folderId);
        if (pack) {
          const doc = await pack.getDocument(sceneDetail.id);
          if (doc) {
            return doc.toObject();
          }
        }
      }

      // 如果有 sceneData 直接返回 (来自 .ov-scene 文件)
      if (sceneDetail.sceneData) {
        return sceneDetail.sceneData;
      }

      return null;
    } catch (error) {
      console.error(`${MODULE_ID} | Error getting scene data:`, error);
      return null;
    }
  };

  /**
   * 绑定场景图层控制事件
   * @param {jQuery} panelEl - 右侧面板元素
   */
  cls.prototype._bindSceneLayerControls = function(panelEl) {
    // 墙壁显示切换
    panelEl.find('.toggle-walls').off('change').on('change', async (e) => {
      if (this.sceneRenderer) {
        await this.sceneRenderer.setLayerVisibility('walls', e.target.checked);
      }
    });

    // 光源显示切换
    panelEl.find('.toggle-lights').off('change').on('change', async (e) => {
      if (this.sceneRenderer) {
        await this.sceneRenderer.setLayerVisibility('lights', e.target.checked);
      }
    });

    // 重置视图按钮
    panelEl.find('.btn-reset-view').off('click').on('click', () => {
      if (this.sceneRenderer) {
        this.sceneRenderer.resetView();
      }
    });
  };

  /**
   * 绑定场景层切换按钮
   * 这里只切当前详情面板里的渲染层，不去重建整张面板。
   */
  cls.prototype._bindSceneLevelControls = function(panelEl, sceneDetail) {
    panelEl.find('.scene-level-tab').off('click').on('click', async (event) => {
      const button = event.currentTarget;
      const levelId = button?.dataset?.levelId;
      if (!levelId) return;

      this._pendingPreviewSceneLevelOverride = null;
      const levelStore = this._sceneLevelSelection || (this._sceneLevelSelection = new Map());
      if (sceneDetail?.sceneLevelKey) {
        levelStore.set(sceneDetail.sceneLevelKey, levelId);
      }
      if (sceneDetail) {
        sceneDetail.activeSceneLevelId = levelId;
      }
      if (this.previewItem) {
        this.previewItem.activeSceneLevelId = levelId;
      }

      panelEl.find('.scene-level-tab').removeClass('active');
      button.classList.add('active');

      if (this.sceneRenderer) {
        await this.sceneRenderer.setLevel(levelId);
      }
      if (this.previewSceneRenderer) {
        await this.previewSceneRenderer.setLevel(levelId);
      }
    });
  };

  /**
   * 初始化预览模式的场景渲染器 (中间大预览区域)
   * @param {HTMLElement} containerEl - 场景预览容器元素
   * @param {object} item - 预览项数据
   */
  cls.prototype._initPreviewSceneRenderer = async function(containerEl, item) {
    const canvasContainer = containerEl.querySelector('.scene-canvas-container');
    if (!canvasContainer) {
      console.warn(`${MODULE_ID} | Preview scene canvas container not found`);
      return;
    }

    // 销毁旧的预览渲染器
    if (this.previewSceneRenderer) {
      this.previewSceneRenderer.destroy();
      this.previewSceneRenderer = null;
    }

    try {
      // 构建场景详情对象
      const sceneDetail = {
        uuid: item.metadata?.uuid,
        id: item.id,
        folderId: item.metadata?.compendiumId,
        sceneData: item.sceneData,
        metadata: item.metadata,
        worldSceneId: getWorldSceneId(item, { library: this.library })
      };

      // 获取完整场景数据
      const sceneData = await this._getFullSceneData(sceneDetail);
      if (!sceneData) {
        console.warn(`${MODULE_ID} | Failed to get scene data for preview:`, item.id);
        canvasContainer.innerHTML = '<div class="scene-load-error"><i class="fas fa-exclamation-triangle"></i> Failed to load scene</div>';
        return;
      }

      const sceneLevelKey = this._getSceneLevelStorageKey(item, sceneData);
      const overrideLevelId = this._getPendingSceneLevelOverride(item, sceneData);
      const storedLevelId = overrideLevelId || this._sceneLevelSelection?.get(sceneLevelKey) || item.activeSceneLevelId || null;
      const sceneLevelOptions = SceneRenderer.getDetailLevelOptions();
      const activeSceneLevelId = SceneRenderer.resolveLevelId(sceneData, storedLevelId, sceneLevelOptions);
      if (sceneLevelKey && activeSceneLevelId) {
        const levelStore = this._sceneLevelSelection || (this._sceneLevelSelection = new Map());
        levelStore.set(sceneLevelKey, activeSceneLevelId);
      }
      item.activeSceneLevelId = activeSceneLevelId;

      ovLog(`${MODULE_ID} | Initializing Preview SceneRenderer for:`, sceneData.name);

      // 创建渲染器实例
      this.previewSceneRenderer = new SceneRenderer(canvasContainer, sceneData, {
        interactive: true,
        showWalls: false,
        showLights: false,
        levelId: activeSceneLevelId,
        ...sceneLevelOptions,
        useSceneResolution: true // Ensure high quality rendering
      });

      // 渲染场景 - 延迟以确保容器尺寸有效
      const attemptRender = async (attempt = 0) => {
        const rect = canvasContainer.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          ovLog(`${MODULE_ID} | Container ready: ${rect.width}x${rect.height}`);
          await this.previewSceneRenderer.render();
        } else if (attempt < 10) {
          ovLog(`${MODULE_ID} | Waiting for container size, attempt ${attempt + 1}`);
          await new Promise(r => requestAnimationFrame(r));
          await attemptRender(attempt + 1);
        } else {
          console.warn(`${MODULE_ID} | Container size still 0 after retries`);
        }
      };
      await attemptRender(0);

      // 绑定图层控制事件
      const controls = containerEl.querySelector('.scene-layer-controls');
      if (controls) {
        controls.querySelector('.btn-toggle-walls')?.addEventListener('click', () => {
          if (this.previewSceneRenderer) {
            this.previewSceneRenderer.options.showWalls = !this.previewSceneRenderer.options.showWalls;
            controls.querySelector('.btn-toggle-walls')?.classList.toggle('active', this.previewSceneRenderer.options.showWalls);
            this.previewSceneRenderer.render();
          }
        });
        controls.querySelector('.btn-toggle-lights')?.addEventListener('click', () => {
          if (this.previewSceneRenderer) {
            this.previewSceneRenderer.options.showLights = !this.previewSceneRenderer.options.showLights;
            controls.querySelector('.btn-toggle-lights')?.classList.toggle('active', this.previewSceneRenderer.options.showLights);
            this.previewSceneRenderer.render();
          }
        });
        controls.querySelector('.btn-reset-view')?.addEventListener('click', () => {
          if (this.previewSceneRenderer) {
            this.previewSceneRenderer.resetView();
          }
        });
      }

    } catch (error) {
      console.error(`${MODULE_ID} | Failed to initialize Preview SceneRenderer:`, error);
      canvasContainer.innerHTML = '<div class="scene-load-error"><i class="fas fa-exclamation-triangle"></i> Render failed</div>';
    }
  };

  /**
   * 获取场景模式下的渲染数据
   */
  cls.prototype._getDataForScenes = async function(options) {
    const adapter = this.currentAdapter;

    // 1. 获取文件夹 (Packs)
    const folders = await adapter.getFolders();

    // 2. 获取当前文件夹 (Pack)
    let currentFolder = folders[this.currentFolderId];
    // 如果当前是 root 或者无效 ID，则默认为 root
    if (!currentFolder || this.currentFolderId === 'root' || !this.currentFolderId) {
      currentFolder = folders['root'];
    }

    // 3. 获取 Items
    let items = [];
    if (this.currentFolderId !== 'root') {
      items = await adapter.getItems(this.currentFolderId);
    }

    // 搜索过滤
    if (this.searchQuery) {
      const query = this.searchQuery.toLowerCase();
      items = items.filter(i => i.name.toLowerCase().includes(query));
    }

    // 构建文件夹树
    const folderTree = this._buildFolderTree('root', folders);

    // 可以在这里添加获取详情的逻辑
    let selectedDetail = null;
    if (this.selectedItems.size === 1) {
      const itemId = this.selectedItems.values().next().value;
      const item = items.find(i => i.id === itemId);
      if (item) {
        const pack = folders[item.folderId];
        selectedDetail = {
          ...item,
          displayName: item.name,
          folderName: pack?.name || ovText('Unknown', 'Неизвестно'),
          formattedAddedDate: '',
          dimensions: '1920 × 1080',
          fileSize: 'N/A',
          tags: [],
          stars: Array.from({ length: 5 }, (_, i) => ({ value: i + 1, filled: false })),
          isScene: true,
          isImported: item.isImported,
          isActive: item.isActive,
          compendiumUuid: item.uuid
        };
      }
    }

    return {
      moduleId: MODULE_ID,
      moduleTitle: MODULE_TITLE,
      folders,
      folderTree,
      tags: [],
      items: items.map(i => ({
        ...i,
        displayName: i.name,
        aspectRatio: 1.77,
        isScene: true,
        isImported: i.isImported || false,
        worldId: i.worldId || null
      })),
      currentFolder,
      currentFolderId: this.currentFolderId,
      currentFolderName: currentFolder?.name || ovText('Compendium Packs', 'Сборники'),
      currentFolderItemCount: items.length,
      selectedItems: Array.from(this.selectedItems),
      selectedDetail,

      activeType: this.activeType,
      settings: this.library.getAllSettings(),
      specialFolders: [],
      isWindowed: this.isWindowed,
      cacheBust: Date.now()
    };
  };

  /**
   * 获取包含场景的 Compendium Packs 列表
   */
  cls.prototype._getScenePacks = function() {
    // 收集已导入的合集包 ID（通过 library 中的 compendiumId 元数据）
    const importedPackIds = new Set();
    if (this.library?.itemsCache) {
      for (const [, item] of this.library.itemsCache) {
        const cid = item.metadata?.compendiumId;
        if (cid) importedPackIds.add(cid);
      }
    }

    const packs = [];
    for (const pack of game.packs) {
      if (pack.documentName === 'Scene') {
        // MAD 版：只显示模块 ID 包含 'mad' 的合集包
        if (IS_MAD_EDITION && !pack.metadata.packageName?.toLowerCase().includes('mad')) continue;
        packs.push({
          id: pack.collection,
          name: pack.metadata.label,
          count: pack.index.size,
          isImported: importedPackIds.has(pack.collection),
          selected: this._isCompendiumPackSelected?.(pack.collection) || false
        });
      }
    }
    return packs;
  };

  /**
   * 获取世界场景列表（完整版专属功能，通过 features/WorldSceneImport.js 提供）
   */
  cls.prototype._getWorldScenes = function() {
    // 完整版：由 features/WorldSceneImport.js 提供实现
    // MAD 版：features/ 不存在，返回空数组
    if (this._worldSceneProvider) {
      return this._worldSceneProvider(this.library);
    }
    return [];
  };

  /**
   * 快速定位当前查看的场景（Quick Locate）
   */
  cls.prototype._locateCurrentScene = function() {
    const viewedScene = canvas?.scene;
    if (!viewedScene) {
      ui.notifications.warn(t('origin-vault.scenes.noActiveScene'));
      return;
    }

    // 在 Library 中查找匹配的 item
    // 尝试多种匹配策略（按优先级排列）
    let matchedItem = null;
    const viewedBg = viewedScene.background?.src || viewedScene.background?.texture?.src || viewedScene.img || '';
    const specialFolderIds = new Set(Object.values(SPECIAL_FOLDERS));
    // Foundry v13: compendium source stored in _stats.compendiumSource
    const compendiumSource = viewedScene._stats?.compendiumSource
      || viewedScene.flags?.core?.sourceId || '';

    ovLog(`${MODULE_ID} | [LOCATE] Searching for scene: id=${viewedScene.id}, name="${viewedScene.name}", bg="${viewedBg}", compendiumSource="${compendiumSource}"`);

    for (const [, item] of this.library.itemsCache || []) {
      if (item.metadata?.type !== 'scene') continue;

      // 1. 直接匹配当前世界绑定（世界场景收录 / 持久化）
      const boundWorldSceneId = getWorldSceneId(item, { library: this.library });
      if (boundWorldSceneId && boundWorldSceneId === viewedScene.id) {
        matchedItem = item;
        ovLog(`${MODULE_ID} | [LOCATE] Matched by current-world scene binding: ${item.id}`);
        break;
      }
      // 2. 匹配内存中的 worldId（导入场景后临时设置的）
      if (item.worldId && item.worldId === viewedScene.id) {
        matchedItem = item;
        ovLog(`${MODULE_ID} | [LOCATE] Matched by in-memory worldId: ${item.id}`);
        break;
      }
      // 3. 匹配 compendium UUID（从合集包导入的场景）
      if (compendiumSource && item.metadata.uuid && item.metadata.uuid === compendiumSource) {
        matchedItem = item;
        ovLog(`${MODULE_ID} | [LOCATE] Matched by compendium UUID: ${item.id}`);
        break;
      }
      // 4. 匹配背景图路径（通用回退 — 背景存在 metadata 中）
      if (viewedBg && item.metadata.backgroundSrc && item.metadata.backgroundSrc === viewedBg) {
        matchedItem = item;
        ovLog(`${MODULE_ID} | [LOCATE] Matched by backgroundSrc: ${item.id}`);
        break;
      }
      // 5. 匹配资源路径 == 背景图路径
      if (viewedBg && item.path === viewedBg) {
        matchedItem = item;
        ovLog(`${MODULE_ID} | [LOCATE] Matched by path === bg: ${item.id}`);
        break;
      }
      // 6. 匹配场景名称 + 尺寸（最后手段）
      if (item.metadata.sceneName === viewedScene.name
        && item.metadata.width === viewedScene.width
        && item.metadata.height === viewedScene.height) {
        matchedItem = item;
        ovLog(`${MODULE_ID} | [LOCATE] Matched by name+dimensions: ${item.id}`);
        break;
      }
    }

    if (!matchedItem) {
      ovLog(`${MODULE_ID} | [LOCATE] No match found. Library scene items:`,
        [...(this.library.itemsCache?.values() || [])].filter(i => i.metadata?.type === 'scene').map(i => ({
          id: i.id, uuid: i.metadata?.uuid, worldSceneId: getWorldSceneId(i, { library: this.library }),
          worldId: i.worldId, name: i.metadata?.sceneName || i.displayName, bg: i.metadata?.backgroundSrc
        }))
      );
    }

    if (!matchedItem) {
      ui.notifications.warn(t('origin-vault.scenes.sceneNotInLibrary'));
      return;
    }

    // 别回到 root。那边会按“全部素材”渲，但左侧栏没有对应选中态。
    const targetFolderId = matchedItem.folders?.find((folderId) => !specialFolderIds.has(folderId))
      || SPECIAL_FOLDERS.ALL;

    void this._navigateToFolder(targetFolderId, {
      preserveSelection: true,
      selectedItemId: matchedItem.id,
      revealItemId: matchedItem.id
    });
  };

  cls.prototype._captureSceneConfigReturnState = function() {
    return {
      currentFolderId: this.currentFolderId,
      browserVisible: this.browserVisible,
      sceneBrowserVisible: this.sceneBrowserVisible,
      itemBrowserVisible: this.itemBrowserVisible,
      actorBrowserVisible: this.actorBrowserVisible,
      previewItem: this.previewItem || null,
      selectedItems: Array.from(this.selectedItems || [])
    };
  };

  cls.prototype._restoreSceneConfigReturnState = async function(state, { render = true } = {}) {
    if (!state) return;

    this.currentFolderId = state.currentFolderId ?? this.currentFolderId;
    this.browserVisible = !!state.browserVisible;
    this.sceneBrowserVisible = !!state.sceneBrowserVisible;
    this.itemBrowserVisible = !!state.itemBrowserVisible;
    this.actorBrowserVisible = !!state.actorBrowserVisible;
    this.previewItem = state.previewItem || null;
    this.selectedItems = new Set(state.selectedItems || []);

    if (!render) return;

    await this._updateSidebarSelection?.(this.currentFolderId);
    await this._renderAssetGrid();
    this._scheduleDetailsPanelRender?.();
  };

  /**
   * 打开新建场景的 SceneConfig，并先把它收录进当前素材库。
   * 默认会让 OV 暂时淡出；个别入口也可以只打开配置，不让 OV 让位。
   * @param {Scene} scene - 要配置的场景
   */
  cls.prototype._minimizeForSceneConfig = async function(scene, {
    suspendOV = true,
    hideOV = false,
    collectOnClose = false,
    ovAlreadyHidden = false,
    restoreUiState = null,
    targetFolderId = null
  } = {}) {
    // 记住当前文件夹用于自动导入
    const collectTargetFolderId = targetFolderId || this.currentFolderId;
    let collectedItemId = null;

    // 立即收录场景到素材库
    if (!collectOnClose) {
      collectedItemId = await this._collectWorldScene(scene.id, collectTargetFolderId);
    }

    // 只有仍然需要让位时，才暂时淡出 OV。
    if (hideOV && !ovAlreadyHidden) {
      this.constructor.hide();
    } else if (suspendOV) {
      this._setWorkspaceShellSuspended?.(true);
      if (this.element) {
        this.element.style.transition = 'opacity 0.25s ease';
        this.element.style.opacity = '0';
        this.element.style.pointerEvents = 'none';
      }
    }

    // 恢复 OV 的通用逻辑。即便 OV 没让位，也要监听这次 SceneConfig 的保存/关闭，
    // 否则“保存后同步名称”这条链路会漏掉。
    let restored = false;
    let sceneConfigRendered = false;
    let sceneConfigApp = null;
    const hookEntries = [];
    let pollTimer = null;
    let safetyTimer = null;
    let saveSyncPromise = Promise.resolve(false);

    const syncCollectedSceneItem = () => {
      if (!collectedItemId) return Promise.resolve(false);
      const currentScene = game.scenes?.get(scene.id) || scene;
      saveSyncPromise = saveSyncPromise
        .catch(() => false)
        .then(() => this._syncCollectedWorldSceneItem(currentScene, collectedItemId));
      return saveSyncPromise;
    };

    const isSceneConfigStillOpen = () => {
      const renderedState = sceneConfigApp?.rendered ?? scene.sheet?.rendered;
      return renderedState !== false;
    };

    const restoreOV = async () => {
      if (restored) return;
      restored = true;

      // 清理所有监听
      if (pollTimer) clearInterval(pollTimer);
      if (safetyTimer) clearTimeout(safetyTimer);
      for (const [hookName, hid] of hookEntries) {
        Hooks.off(hookName, hid);
      }

      if (collectOnClose) {
        collectedItemId = await this._collectWorldScene(scene.id, collectTargetFolderId);
      } else if (collectedItemId) {
        await syncCollectedSceneItem();
        await saveSyncPromise;
      }

      if (restoreUiState) {
        await this._restoreSceneConfigReturnState(restoreUiState, { render: false });
      }

      // 淡入恢复 OV
      if (hideOV) {
        this.constructor.show();
        return;
      }

      if (suspendOV && this.element) {
        this.element.style.transition = 'opacity 0.3s ease';
        this.element.style.opacity = '1';
        this.element.style.pointerEvents = '';
        setTimeout(() => {
          if (this.element) this.element.style.transition = '';
        }, 350);
      }
      if (suspendOV) this._setWorkspaceShellSuspended?.(false);

      // 刷新网格以显示新收录的场景
      await this._renderAssetGrid();
      this._scheduleDetailsPanelRender?.();
    };

    const renderHookId = Hooks.on('renderSceneConfig', (app) => {
      if (app.document?.id !== scene.id) return;
      sceneConfigRendered = true;
      sceneConfigApp = app;
      Hooks.off('renderSceneConfig', renderHookId);
      try {
        const pos = app.position;
        const newHeight = Math.min(window.innerHeight * 0.85, 900);
        app.setPosition({
          width: pos.width || 560,
          height: newHeight,
          top: Math.max(10, (window.innerHeight - newHeight) / 2),
          left: pos.left
        });
      } catch (e) {
        console.warn('origin-vault | Could not resize SceneConfig:', e);
      }
    });
    hookEntries.push(['renderSceneConfig', renderHookId]);

    const updateHookId = Hooks.on('updateScene', (updatedScene) => {
      if (updatedScene?.id !== scene.id) return;
      void syncCollectedSceneItem();
    });
    hookEntries.push(['updateScene', updateHookId]);

    // 打开 SceneConfig
    scene.sheet.render(true);
    ui.notifications.info(t('origin-vault.scenes.sceneCreated'));

    // 方法 1: 轮询检测 SceneConfig 是否已关闭（最可靠）
    pollTimer = setInterval(() => {
      if (sceneConfigRendered && !isSceneConfigStillOpen()) {
        restoreOV();
      }
    }, 300);

    // 方法 2: 尝试多种 Hook 名称（兼容 V1/V2）
    for (const hookName of ['closeDocumentSheet', 'closeSceneConfig', 'closeApplication']) {
      const hid = Hooks.on(hookName, (sheet) => {
        const docId = sheet?.document?.id || sheet?.object?.id;
        if (docId !== scene.id) return;
        restoreOV();
      });
      hookEntries.push([hookName, hid]);
    }

    // 方法 3: 安全超时只处理“没打开或已经关了”的异常，不打断用户正在编辑的 SceneConfig。
    safetyTimer = setTimeout(() => {
      if (scene.sheet?.rendered) return;
      if (sceneConfigRendered && isSceneConfigStillOpen()) return;
      restoreOV();
    }, 60000);
  };

  cls.prototype._syncCollectedWorldSceneItem = async function(scene, itemId) {
    const item = this.library.getItem(itemId);
    if (!scene || !item) return false;

    const sceneName = scene.name || item.displayName || '';
    if (!sceneName) return false;

    item.metadata = item.metadata || {};
    const binding = getWorldSceneBinding(item, { library: this.library, allowLegacy: false });
    setWorldSceneBinding(item, scene, {
      source: binding?.source || 'world-scene',
      createdFromAsset: !!binding?.createdFromAsset,
      backgroundSrc: scene.background?.src || item.metadata.backgroundSrc || ''
    });

    item.metadata.sceneName = sceneName;
    item.metadata.width = scene.width;
    item.metadata.height = scene.height;
    item.metadata.backgroundSrc = scene.background?.src || item.metadata.backgroundSrc || '';

    await this.library.updateItem(item.id, {
      displayName: sceneName,
      metadata: item.metadata
    });
    this._sortedItemsCache = null;
    this._sortedItemsCacheKey = '';

    return true;
  };

  /**
   * 收录世界场景到素材库（使用 v3 分散存储 API）
   * @param {string} sceneId - 世界场景 ID
   * @param {string} [targetFolderId] - 目标文件夹 ID，默认使用 currentFolderId
   */
  cls.prototype._collectWorldScene = async function(sceneId, targetFolderId = null) {
    const scene = game.scenes.get(sceneId);
    if (!scene) return null;

    try {
      const sceneName = scene.name;
      const bgSrc = scene.background?.src || '';

      // 确定目标文件夹
      const folderId = targetFolderId || this.currentFolderId;
      const validFolderId = (folderId && folderId !== SPECIAL_FOLDERS.ALL &&
        folderId !== SPECIAL_FOLDERS.FAVORITES && folderId !== SPECIAL_FOLDERS.RECENT)
        ? folderId : SPECIAL_FOLDERS.ROOT;

      const itemData = {
        metadata: {
          type: 'scene',
          sceneName: sceneName,
          width: scene.width,
          height: scene.height,
          backgroundSrc: bgSrc
        }
      };
      setWorldSceneBinding(itemData, scene, {
        source: 'world-scene',
        backgroundSrc: bgSrc
      });

      // 路径带上 worldId，全球库里不同世界的同 ID 场景不会互相顶掉。
      const itemId = await this.library.addItem(
        `worlds/${game.world.id}/scenes/${sceneId}.ov-scene`,
        validFolderId,
        {
          displayName: sceneName,
          metadata: itemData.metadata
        }
      );

      ui.notifications.info(tf('origin-vault.scenes.collectSuccess', { name: sceneName }));

      // 刷新界面
      this._renderDetailsPanel();
      this.render(false);
      return itemId;
    } catch (err) {
      console.error('origin-vault | Failed to collect world scene:', err);
      ui.notifications.error(ovText('Failed to collect scene', 'Не удалось добавить сцену'));
      return null;
    }
  };

  /**
   * 切换场景浏览器面板
   */
  cls.prototype._toggleSceneBrowser = function() {
    this.sceneBrowserVisible = !this.sceneBrowserVisible;
    // 如果打开场景浏览器，关闭文件浏览器、物品浏览器、角色浏览器（互斥）
    if (this.sceneBrowserVisible) {
      this.browserVisible = false;
      this.itemBrowserVisible = false;
      this.actorBrowserVisible = false;
    }
    this._renderDetailsPanel();
  };

  /**
   * 批量导入 Compendium Pack 中的所有场景
   * @param {string} packId - Compendium Pack ID
   */
  cls.prototype._importPackScenes = async function(packId, options = {}) {
    ovLog(`${MODULE_ID} | [SCENE IMPORT] Starting import for pack: ${packId}`);

    const pack = game.packs.get(packId);
    if (!pack) {
      console.error(`${MODULE_ID} | [SCENE IMPORT] Pack not found: ${packId}`);
      if (options.notify !== false) ui.notifications.error(t('origin-vault.scenes.importFailed'));
      return { success: false, imported: 0, error: new Error(`Pack not found: ${packId}`) };
    }

    // 防止重复导入
    if (this._hasCompendiumImportInFlight?.() || (this._compendiumBatchState?.running && !options.fromBatch)) {
      ui.notifications.warn(t('origin-vault.notifications.bgImportRunning') || ovText('A background import is already running.', 'Фоновый импорт уже выполняется.'));
      return { success: false, imported: 0, busy: true };
    }

    this._scenePackImportPending = true;
    try {
      const folderName = pack.metadata.label;
      const batchPrefix = options.batchPosition
        ? `${options.batchPosition.current}/${options.batchPosition.total} · `
        : '';
      const label = `${batchPrefix}${t('origin-vault.scenes.importing')} ${folderName}`;
      const index = await pack.getIndex();
      const totalCount = index.size;

      if (!totalCount) {
        this._scenePackImportPending = false;
        if (options.notify !== false) ui.notifications.warn(t('origin-vault.scenes.importFailed'));
        return { success: false, imported: 0, error: new Error(`Pack is empty: ${packId}`) };
      }

      const folderId = this.library.createFolder(SPECIAL_FOLDERS.ROOT, folderName);
      this._backgroundTask = {
        type: 'scene-import',
        label,
        total: totalCount,
        completed: 0,
        targetFolderId: folderId
      };

      this._setFolderImporting(folderId, true);
      this._showBottomProgressBar(0, totalCount, label);
      this._renderSidebar();
      this._scenePackImportPending = false;

      return this._doSceneImportAsync(pack, index, folderId, folderName, label, totalCount, options);
    } catch (error) {
      this._scenePackImportPending = false;
      console.error(`${MODULE_ID} | Failed to prepare scene pack import:`, error);
      if (options.notify !== false) ui.notifications.error(t('origin-vault.scenes.importFailed'));
      return { success: false, imported: 0, error };
    }
  };

  /**
   * 异步执行场景导入（后台任务）
   */
  cls.prototype._doSceneImportAsync = async function(pack, index, folderId, folderName, label, totalCount, options = {}) {
    try {
      let importCount = 0;
      let processedCount = 0;
      const updateProgress = () => {
        if (this._backgroundTask) this._backgroundTask.completed = processedCount;

        const floater = ImportFloater.getInstance();
        if (floater.isVisible()) floater.update(processedCount, totalCount, label);

        if (this.constructor.isVisible && this.rendered) {
          this._showBottomProgressBar(processedCount, totalCount, label);
        }
      };

      for (const entry of index) {
        const scene = await pack.getDocument(entry._id);
        if (!scene) {
          console.warn(`${MODULE_ID} | [SCENE IMPORT] Failed to get document for: ${entry.name}`);
          processedCount++;
          updateProgress();
          continue;
        }

        // MAD 版：验证场景内容合法性
        // 至少一个资源路径（背景/图块/前景）必须包含合集包所属模块的路径
        if (IS_MAD_EDITION) {
          const packageName = pack.metadata.packageName || '';
          const pathPrefix = `modules/${packageName}/`;
          const paths = [
            scene.background?.src,
            scene.foreground,
            ...(scene.tiles?.contents || []).map(t => t.texture?.src)
          ].filter(Boolean);

          const hasValidAsset = paths.some(p => p.includes(pathPrefix));
          if (!hasValidAsset) {
            console.warn(`${MODULE_ID} | [SCENE IMPORT] Skipped scene (no valid assets): ${scene.name}`);
            processedCount++;
            updateProgress();
            continue;
          }
        }

        let previewPath = await this._generateScenePreview(scene);
        if (!previewPath) {
          previewPath = String(scene.background?.src || scene.thumb || '');
        }

        await this.library.addItem(previewPath, folderId, {
          displayName: scene.name,
          metadata: {
            type: 'scene',
            uuid: scene.uuid,
            compendiumId: pack.collection,
            width: scene.width,
            height: scene.height,
            tilesCount: scene.tiles?.size || 0
          }
        });

        importCount++;
        processedCount++;
        updateProgress();
      }

      await this.library.save();

      // 清除后台任务
      this._backgroundTask = null;
      this._setFolderImporting(folderId, false);
      this._syncCompendiumBatchControls?.();

      const floater = ImportFloater.getInstance();
      if (!options.fromBatch && floater.isVisible()) {
        floater.complete();
      }

      if (!options.fromBatch && this.constructor.isVisible && this.rendered) {
        this._hideBottomProgressBar();
        this._refreshViewAfterUpdate(folderId);
      }

      if (options.notify !== false) {
        ui.notifications.info(tf('origin-vault.scenes.importSuccess', {
          count: importCount,
          folder: folderName
        }));
      }

      return { success: true, imported: importCount, total: totalCount, folderId };

    } catch (error) {
      console.error('Origin Vault | Scene import failed:', error);
      this._backgroundTask = null;
      this._setFolderImporting(folderId, false);
      this._syncCompendiumBatchControls?.();
      if (!options.fromBatch) this._hideBottomProgressBar();

      const floater = ImportFloater.getInstance();
      if (!options.fromBatch && floater.isVisible()) {
        floater.hide();
      }

      if (options.notify !== false) ui.notifications.error(t('origin-vault.scenes.importFailed'));
      return { success: false, imported: 0, error, folderId };
    }
  };

  /**
   * 生成场景的高清预览图（包含背景 + 图块）
   * @param {Scene} scene - Foundry Scene 文档
   * @param {number} maxSize - 最大尺寸（用于缩放）
   * @returns {Promise<string|null>} - 预览图路径或 null
   */
  cls.prototype._generateScenePreview = async function(scene, maxSize = 800) {
    try {
      ovLog(`${MODULE_ID} | [SCENE PREVIEW] Generating preview for: ${scene.name}`);

      const sceneData = typeof scene.toObject === 'function' ? scene.toObject() : scene;
      const sceneWidth = sceneData.width || 1000;
      const sceneHeight = sceneData.height || 1000;
      const scale = Math.min(maxSize / sceneWidth, maxSize / sceneHeight, 1);
      const canvasWidth = Math.max(1, Math.round(sceneWidth * scale));
      const canvasHeight = Math.max(1, Math.round(sceneHeight * scale));
      const sceneLevelOptions = SceneRenderer.getDetailLevelOptions();

      const container = document.createElement('div');
      container.style.width = `${canvasWidth}px`;
      container.style.height = `${canvasHeight}px`;
      container.style.position = 'fixed';
      container.style.left = '-9999px';
      container.style.top = '-9999px';
      container.style.visibility = 'hidden';
      document.body.appendChild(container);

      let renderer = null;
      let canvas = null;
      try {
        renderer = new SceneRenderer(container, sceneData, {
          interactive: false,
          showWalls: false,
          showLights: false,
          levelId: SceneRenderer.OVERVIEW_LEVEL_ID,
          ...sceneLevelOptions,
          mergeLegacyEntryRanges: !!sceneLevelOptions.includeLegacyLevels,
          minResolution: 0,
          useSceneResolution: false
        });

        // 导入时生成的预览也必须和详情里的“总览”同源，别再走旧的手写 canvas 逻辑。
        await renderer.render(false);
        canvas = renderer.canvas;
      } finally {
        renderer?.destroy();
        container.remove();
      }

      if (!canvas || canvas.width === 0 || canvas.height === 0) {
        throw new Error('Scene preview render failed');
      }

      // 转换为 WebP 数据 URL
      const dataUrl = canvas.toDataURL('image/webp', 0.85);
      ovLog(`${MODULE_ID} | [SCENE PREVIEW] Preview generated, size: ${dataUrl.length} bytes`);

      // 保存到缓存
      const thumbnailManager = ThumbnailManager.getInstance();
      const itemId = `scene_${foundry.utils.randomID()}`;
      const savedPath = await thumbnailManager._saveThumbnail(itemId, dataUrl);

      ovLog(`${MODULE_ID} | [SCENE PREVIEW] Saved to: ${savedPath}`);
      return savedPath;

    } catch (error) {
      console.error(`${MODULE_ID} | [SCENE PREVIEW] Failed to generate preview:`, error);
      return null;
    }
  };

  /**
   * 加载图片或视频（带跨域支持和超时）
   * 支持视频格式：.webm, .mp4, .m4v
   * @param {string} src - 媒体路径
   * @returns {Promise<HTMLImageElement|HTMLVideoElement>}
   */
  cls.prototype._loadImage = function(src) {
    return new Promise((resolve, reject) => {
      // 检测是否为视频格式
      const isVideo = /\.(webm|mp4|m4v)$/i.test(src);

      const timeout = setTimeout(() => {
        reject(new Error(`Media load timeout: ${src}`));
      }, 15000); // 视频可能需要更长时间

      if (isVideo) {
        // 视频处理
        const video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.preload = 'auto';
        video.crossOrigin = 'anonymous';

        video.onloadeddata = () => {
          clearTimeout(timeout);
          // 暂停视频，只需要第一帧用于绘制
          video.pause();
          resolve(video);
        };

        video.onerror = () => {
          clearTimeout(timeout);
          reject(new Error(`Failed to load video: ${src}`));
        };

        video.src = src;
        video.load();
      } else {
        // 图片处理
        const img = new Image();
        img.crossOrigin = 'anonymous';

        img.onload = () => {
          clearTimeout(timeout);
          resolve(img);
        };

        img.onerror = () => {
          clearTimeout(timeout);
          reject(new Error(`Failed to load image: ${src}`));
        };

        img.src = src;
      }
    });
  };
}
