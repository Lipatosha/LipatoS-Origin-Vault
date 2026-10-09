import { ovText } from './utils/locale.js';
/**
 * Origin Vault - 入口文件
 * 专业素材管理工具，专为 Foundry VTT 设计
 */

import { MODULE_ID, MODULE_TITLE, IS_MAD_EDITION, FILE_TYPES, SETTINGS, DEFAULT_DATA_PATH, EVENTS, SPECIAL_FOLDERS, ENABLE_RIGHT_SIDEBAR_BROWSER } from './constants.js';
import { LibraryData } from './data/LibraryData.js';
import { LibraryManager } from './data/LibraryManager.js';
import { MainWindow } from './ui/MainWindow.js';
import { OVSidebarBrowser } from './ui/OVSidebarBrowser.js';
import { OVSidebarQuickLauncher } from './ui/OVSidebarQuickLauncher.js';
import { ThumbnailManager } from './utils/ThumbnailManager.js';
import { findActiveFilePickers, getFilePickerClasses } from './utils/filePicker.js';
import { ensureI18nCompat, hasTranslation, t, tf } from './utils/i18n.js';
import { ovLog } from './utils/logger.js';
import { getActorBadgeLabel } from './utils/actorDisplay.js';
import { buildThumbnailSrc, createThumbnailRevision } from './utils/thumbnailUrl.js';

function trackFilePickerSelection(picker, path) {
  globalThis._ovLastFilePickerSelection = {
    path,
    source: picker?.activeSource || 'data',
    bucket: picker?.result?.bucket || picker?._bucket || ''
  };
}

function decodeReadableName(value) {
  if (typeof value !== 'string' || !value) return '';
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// 注册 Handlebars 助手
Handlebars.registerHelper('eq', (a, b) => a === b);
Handlebars.registerHelper('includes', (array, value) => Array.isArray(array) && array.includes(value));
Handlebars.registerHelper('isScene', (item) => {
  // 安全检测场景类型
  if (!item) return false;
  return item.metadata?.type === 'scene' || item.type === 'scene';
});
Handlebars.registerHelper('isItem', (item) => {
  if (!item) return false;
  return item.metadata?.type === 'item' || item.type === 'item';
});
Handlebars.registerHelper('isActor', (item) => {
  if (!item) return false;
  return item.metadata?.type === 'actor' || item.type === 'actor';
});
Handlebars.registerHelper('isVideo', (path) => {
  if (typeof path !== 'string' || !path) return false;
  const ext = path.substring(path.lastIndexOf('.')).toLowerCase();
  return FILE_TYPES.VIDEO.includes(ext);
});
Handlebars.registerHelper('isAudio', (path) => {
  if (typeof path !== 'string' || !path) return false;
  const ext = path.substring(path.lastIndexOf('.')).toLowerCase();
  return FILE_TYPES.AUDIO.includes(ext);
});
Handlebars.registerHelper('thumbnailSrc', (item) => buildThumbnailSrc(item));
Handlebars.registerHelper('or', (a, b) => a || b);
Handlebars.registerHelper('fileName', (path) => {
  if (typeof path !== 'string' || !path) return '';
  const name = path.split('/').pop().replace(/\.[^/.]+$/, '');
  return decodeReadableName(name);
});
Handlebars.registerHelper('fileExtension', (path) => {
  if (typeof path !== 'string' || !path) return '';
  return path.split('.').pop().toUpperCase();
});
// 文件类型角标显示 - 场景类型显示"场景"，物品类型显示子类型，其他显示扩展名
Handlebars.registerHelper('fileTypeBadge', (item) => {
  // 场景类型 (metadata 或扩展名)
  if (item?.metadata?.type === 'scene' || item?.type === 'scene') {
    return t('origin-vault.fileTypes.scene');
  }
  // 物品类型 — 显示物品子类型（如 weapon、spell、feat）
  if (item?.metadata?.type === 'item') {
    const itemType = item.metadata.itemType || 'item';
    // 尝试本地化 DND5E 物品类型
    const typeLabel = hasTranslation(`TYPES.Item.${itemType}`)
      ? t(`TYPES.Item.${itemType}`)
      : itemType.charAt(0).toUpperCase() + itemType.slice(1);
    return typeLabel;
  }
  if (item?.metadata?.type === 'actor' || item?.type === 'actor') {
    return getActorBadgeLabel(item);
  }
  // 检查文件扩展名 (.ov-scene 也是场景)
  const path = item?.path || '';
  if (typeof path !== 'string' || !path) return '';
  const ext = path.split('.').pop().toLowerCase();
  if (ext === 'ov-scene') {
    return t('origin-vault.fileTypes.scene');
  }
  return ext.toUpperCase();
});
Handlebars.registerHelper('isItem', (item) => {
  return item?.metadata?.type === 'item';
});
Handlebars.registerHelper('times', function (n, block) {
  let result = '';
  for (let i = 0; i < n; i++) {
    result += block.fn(i);
  }
  return result;
});

/**
 * 初始化模块
 */
Hooks.once('init', async () => {
  ovLog(`${MODULE_ID} | Initializing ${MODULE_TITLE}`);

  ensureI18nCompat();

  // 记录用户最近一次通过原生 FilePicker 选中的路径来源。
  // 这样设置面板里的 uploadPath 也能同步保存 source/bucket，而不是只剩下 path 字符串。
  for (const FilePickerClass of getFilePickerClasses()) {
    if (!FilePickerClass?.prototype || FilePickerClass.prototype._ovTracksSelection) continue;

    const originalRender = FilePickerClass.prototype.render;
    FilePickerClass.prototype.render = function (...args) {
      if (!this._ovSelectionWrapped && typeof this.callback === 'function') {
        const originalCallback = this.callback;
        this.callback = (path, ...cbArgs) => {
          trackFilePickerSelection(this, path);
          return originalCallback.call(this, path, ...cbArgs);
        };
        this._ovSelectionWrapped = true;
      }
      return originalRender.apply(this, args);
    };
    FilePickerClass.prototype._ovTracksSelection = true;
  }

  // 注册 Handlebars Partials (模块化面板) - 先于其他初始化
  const partialsPath = `modules/${MODULE_ID}/templates/partials`;
  const partials = [
    'sidebar',
    'asset-grid',
    'details-panel',
    'scene-browser',
    'item-browser',
    'actor-browser',
    'compendium-batch-bar'
  ];

  for (const name of partials) {
    try {
      const response = await fetch(`/${partialsPath}/${name}.hbs`);
      if (response.ok) {
        const template = await response.text();
        Handlebars.registerPartial(name, template);
        ovLog(`${MODULE_ID} | Registered partial: ${name}`);
      }
    } catch (e) {
      console.warn(`${MODULE_ID} | Failed to load partial: ${name}`, e);
    }
  }

  // 注册窗口位置设置 (Client 级别)
  game.settings.register(MODULE_ID, SETTINGS.WINDOW_POSITION, {
    name: ovText('Window Position', 'Положение окна'),
    scope: 'client',
    config: false,
    type: Object,
    default: {}
  });

  // 注册活动资源库 ID (World 级别)
  game.settings.register(MODULE_ID, SETTINGS.ACTIVE_LIBRARY_ID, {
    name: ovText('Active Library ID', 'ID активной библиотеки'),
    scope: 'world',
    config: false,
    type: String,
    default: 'lib_default'
  });

  game.settings.register(MODULE_ID, SETTINGS.ACTIVE_LIBRARY_PATH, {
    name: ovText('Active Library Path', 'Путь к активной библиотеке'),
    scope: 'world',
    config: false,
    type: String,
    default: ''
  });

  // 注册资源库注册表 (World 级别)
  game.settings.register(MODULE_ID, SETTINGS.REGISTRY, {
    name: ovText('Libraries Registry', 'Список библиотек'),
    scope: 'world',
    config: false,
    type: Object,
    default: {}
  });

  // 注册素材库数据 (World 级别)
  game.settings.register(MODULE_ID, SETTINGS.LIBRARY_DATA, {
    name: ovText('Library Data', 'Данные библиотеки'),
    scope: 'world',
    config: false,
    type: Object,
    default: {}
  });

  // 注册 World 偏好设置 (World 级别)
  game.settings.register(MODULE_ID, SETTINGS.WORLD_PREFERENCES, {
    name: ovText('World Preferences', 'Предпочтения мира'),
    scope: 'world',
    config: false,
    type: Object,
    default: {}
  });

  // 注册缓存来源 (World 级别)
  game.settings.register(MODULE_ID, SETTINGS.CACHE_SOURCE, {
    name: 'origin-vault.settings.cacheSource',
    hint: 'origin-vault.settings.cacheSourceHint',
    scope: 'world',
    config: true,
    type: String,
    choices: {
      'data': ovText('User Data', 'Пользовательские данные'),
      's3': ovText('S3 Storage', 'Хранилище S3')
    },
    default: 'data'
  });

  // 上传存储源 (内部使用，不显示在设置 UI — 由路径选择器自动检测)
  game.settings.register(MODULE_ID, SETTINGS.UPLOAD_SOURCE, {
    name: ovText('Upload Source', 'Источник загрузки'),
    scope: 'world',
    config: false,
    type: String,
    default: 'data'
  });

  // 注册上传文件存放路径 (World 级别, 原生文件夹选择器)
  game.settings.register(MODULE_ID, SETTINGS.UPLOAD_PATH, {
    name: 'origin-vault.settings.uploadPath',
    hint: 'origin-vault.settings.uploadPathHint',
    scope: 'world',
    config: true,
    type: String,
    filePicker: 'folder',
    default: '',
    onChange: (newPath) => {
      try {
        const lastSelection = globalThis._ovLastFilePickerSelection;
        if (lastSelection?.path === newPath) {
          const source = lastSelection.source || 'data';
          const bucket = lastSelection.bucket || '';
          void game.settings.set(MODULE_ID, SETTINGS.UPLOAD_SOURCE, source);
          if (source === 's3' && bucket) {
            void game.settings.set(MODULE_ID, SETTINGS.S3_BUCKET, bucket);
          }
          ovLog(`${MODULE_ID} | Upload path changed using tracked FilePicker selection: source=${source}, bucket=${bucket || 'N/A'}, path=${newPath}`);
          return;
        }

        const activePickers = findActiveFilePickers();
        const s3Picker = activePickers.find(fp => fp.activeSource === 's3');
        if (s3Picker) {
          void game.settings.set(MODULE_ID, SETTINGS.UPLOAD_SOURCE, 's3');
          const bucket = s3Picker.result?.bucket || s3Picker._bucket || '';
          if (bucket) {
            void game.settings.set(MODULE_ID, SETTINGS.S3_BUCKET, bucket);
          }
          ovLog(`${MODULE_ID} | Upload path changed to S3: ${newPath}`);
        } else {
          // 没检测到 S3 选择器时，视为普通 data 路径。
          void game.settings.set(MODULE_ID, SETTINGS.UPLOAD_SOURCE, 'data');
          ovLog(`${MODULE_ID} | Upload path changed to data: ${newPath}`);
        }
      } catch (e) { /* ignore */ }
    }
  });

  // 注册 S3 Bucket 名称 (World 级别)
  game.settings.register(MODULE_ID, SETTINGS.S3_BUCKET, {
    name: 'origin-vault.settings.s3Bucket',
    hint: 'origin-vault.settings.s3BucketHint',
    scope: 'world',
    config: true,
    type: String,
    default: ''
  });

  // 注册缩略图质量 (World 级别)
  game.settings.register(MODULE_ID, SETTINGS.THUMBNAIL_QUALITY, {
    name: 'origin-vault.settings.thumbnailQuality',
    hint: 'origin-vault.settings.thumbnailQualityHint',
    scope: 'world',
    config: true,
    type: String,
    choices: {
      low: ovText('Low (256px)', 'Низкое (256 пикс.)'),
      medium: ovText('Medium (512px)', 'Среднее (512 пикс.)'),
      high: ovText('High (1024px)', 'Высокое (1024 пикс.)')
    },
    default: 'medium'
  });

  // 注册缓存版本 (World 级别)
  game.settings.register(MODULE_ID, SETTINGS.CACHE_VERSION, {
    scope: 'world',
    config: false,
    type: Number,
    default: 0
  });

  // 帮助按钮是否已被点击 (Client 级别)
  game.settings.register(MODULE_ID, 'helpSeen', {
    scope: 'client',
    config: false,
    type: Boolean,
    default: false
  });

  // 新手引导是否已看过 (World 级别，每个世界独立)
  game.settings.register(MODULE_ID, SETTINGS.ONBOARDING_SEEN, {
    scope: 'world',
    config: false,
    type: Boolean,
    default: false
  });

  // 对玩家完全禁用 OV (World 级别，默认开启)
  game.settings.register(MODULE_ID, SETTINGS.GM_ONLY, {
    name: t('origin-vault.settings.gmOnly'),
    hint: t('origin-vault.settings.gmOnlyHint'),
    scope: 'world',
    config: true,
    type: Boolean,
    default: true
  });

  // 注册快捷键 (必须在 init hook 中注册)
  game.keybindings.register(MODULE_ID, 'openVault', {
    name: tf('origin-vault.open', { title: MODULE_TITLE }),
    hint: t('origin-vault.openHint'),
    editable: [{ key: IS_MAD_EDITION ? 'KeyM' : 'KeyV', modifiers: ['Alt'] }],
    onDown: () => {
      MainWindow.toggle();
      return true;
    },
    restricted: true,
    precedence: CONST.KEYBINDING_PRECEDENCE.NORMAL
  });
});

// 注册资源库相关设置 (在同一个 init hook 中，避免冲突)
// 注意：REGISTRY, ACTIVE_LIBRARY_ID, LIBRARY_DATA 已在上方注册

/**
 * 模块就绪
 */
Hooks.once('ready', async () => {
  ovLog(`${MODULE_ID} | ${MODULE_TITLE} is ready`);

  // ==================== 完整版检测 MAD 共存 ====================
  if (!IS_MAD_EDITION && game.modules.get('origin-vault-mad')?.active) {
    ui.notifications.warn(
      t('origin-vault.mad.coexistWarning'),
      { permanent: true }
    );
  }

  // ==================== FilePicker Interception ====================
  // 完整版专属功能：用 OV 替代 Foundry 原生文件浏览器
  // MAD 版压根不带 features/，这里别再靠 import 404 去试探版本。
  if (!IS_MAD_EDITION) {
    // GM Only 模式：玩家不拦截 FilePicker
    const gmOnly = game.settings.get(MODULE_ID, SETTINGS.GM_ONLY);
    const shouldIntercept = !gmOnly || game.user.isGM;

    if (shouldIntercept) {
      try {
        const { initFilePickerIntercept } = await import('./features/FileUpload.js');
        initFilePickerIntercept(MainWindow);
      } catch (e) {
        console.warn(`${MODULE_ID} | FilePicker intercept unavailable:`, e);
      }
    } else {
      ovLog(`${MODULE_ID} | GM Only mode: FilePicker intercept skipped for player`);
    }
  }

  // ==================== 世界场景导入（完整版专属）====================
  if (!IS_MAD_EDITION) {
    try {
      const { getWorldScenes } = await import('./features/WorldSceneImport.js');
      // 注入到 MainWindow 原型，让 _getWorldScenes 可以调用
      MainWindow.prototype._worldSceneProvider = getWorldScenes;
    } catch (e) {
      console.warn(`${MODULE_ID} | World scene provider unavailable:`, e);
    }
  }

  // ==================== 新手引导弹窗（必须在 early return 之前）====================
  _showOnboardingIfNeeded();

  // 初始化资源库管理器
  const libraryManager = LibraryManager.getInstance();
  await libraryManager.loadRegistry();

  // 获取当前 World 的活动资源库
  const activeLibrary = libraryManager.getActiveLibrary();

  // 如果没有资源库，不初始化数据（等待用户创建资源库）
  if (!activeLibrary) {
    ovLog(`${MODULE_ID} | No library found. Waiting for user to create one.`);
    return;
  }

  // 使用活动资源库的路径
  const libraryPath = activeLibrary.path;

  // 初始化素材库数据
  const library = LibraryData.getInstance();
  library.setLibraryPath(libraryPath);

  // Library will load when vault is opened (lazy loading)
  ovLog(`${MODULE_ID} | Library path set: ${libraryPath}. Data will load when vault is opened.`);

  try {
    const uploadSource = game.settings.get(MODULE_ID, SETTINGS.UPLOAD_SOURCE) || 'data';
    const uploadBucket = game.settings.get(MODULE_ID, SETTINGS.S3_BUCKET) || '';
    if (uploadSource === 's3' && !uploadBucket) {
      await game.settings.set(MODULE_ID, SETTINGS.UPLOAD_SOURCE, 'data');
      console.warn(`${MODULE_ID} | Repaired stale upload source: s3 without bucket -> data`);
    }
  } catch (e) {
    console.warn(`${MODULE_ID} | Failed to validate upload source settings:`, e);
  }

  // ==================== 扩展 API ====================
  // 外部模块（如 ov5e）通过此 API 注册系统适配功能
  const ovGlobal = window.OriginVault || {};
  ovGlobal.autoTaggers = Array.isArray(ovGlobal.autoTaggers) ? ovGlobal.autoTaggers : [];   // (library, ovItemId, entry) => void
  ovGlobal.itemFilterClass = ovGlobal.itemFilterClass || null; // ItemFilterPanel 子类
  ovGlobal.getAutoTagGroups = typeof ovGlobal.getAutoTagGroups === 'function' ? ovGlobal.getAutoTagGroups : null;
  ovGlobal._internals = { ...(ovGlobal._internals || {}), LibraryData }; // 供扩展模块访问 OV 数据层
  window.OriginVault = ovGlobal;
  Hooks.callAll('origin-vault.ready');
  ovLog(`${MODULE_ID} | Extension API ready. autoTaggers: ${window.OriginVault.autoTaggers.length}`);
});

/**
 * 监听资源库切换事件
 */
Hooks.on(EVENTS.LIBRARY_SWITCHED, async (libraryId, library) => {
  ovLog(`${MODULE_ID} | Switching to library: ${library.name}`);

  // 保存当前资源库的未保存更改
  const libraryData = LibraryData.getInstance();
  await libraryData.flushPendingPersistence();

  // 切换到新资源库
  libraryData.setLibraryPath(library.path);
  await libraryData.load();

  // 同步素材计数到注册表
  const lm = LibraryManager.getInstance();
  await lm.updateLibraryStats(libraryId, { itemCount: libraryData.itemsCache.size }, { path: library.path });

  // 更新缩略图管理器路径 (vt.1:不再需要)
  // const thumbnailManager = ThumbnailManager.getInstance();
  // thumbnailManager.setBasePath(library.path);

  // 重置 UI 状态（防止旧库的 folderId 残留导致 "Parent folder not found"）
  const mw = MainWindow.getInstance();
  mw.currentFolderId = SPECIAL_FOLDERS.ALL;
  mw.selectedItems?.clear();
  mw.searchQuery = '';

  // 如果窗口已打开，立即刷新
  if (MainWindow.isVisible) {
    mw.render(true);
  }

  ui.notifications.info(tf('origin-vault.notifications.switchedLibrary', { path: library.name }));
});

/**
 * 添加控制按钮到左侧工具栏 (Token 控件组)
 * 兼容 V11/V12/V13
 */
Hooks.on('getSceneControlButtons', (controls) => {
  if (!game.user.isGM) return;

  try {
    const buttonConfig = {
      name: MODULE_ID,
      title: MODULE_TITLE,
      icon: IS_MAD_EDITION ? 'fas fa-map-location-dot' : 'fas fa-vault',
      button: true,
      onClick: () => MainWindow.toggle()
    };

    // V13: controls 是对象，tools 可能也是对象而非数组
    if (controls && typeof controls === 'object' && !Array.isArray(controls)) {
      // 尝试 'tokens' (V13 使用复数形式)
      const tokenControl = controls.tokens;
      if (tokenControl) {
        // V13 中 tools 可能是对象
        if (tokenControl.tools && typeof tokenControl.tools === 'object') {
          if (Array.isArray(tokenControl.tools)) {
            tokenControl.tools.push(buttonConfig);
          } else {
            // tools 是对象，使用键名添加
            tokenControl.tools[MODULE_ID] = buttonConfig;
          }
          ovLog(`${MODULE_ID} | Button added to tokens controls (V13)`);
          return;
        }
      }
    }

    // V11/V12: controls 是数组
    if (Array.isArray(controls)) {
      const tokenControl = controls.find(c => c.name === 'token' || c.name === 'tokens');
      if (tokenControl?.tools) {
        if (Array.isArray(tokenControl.tools)) {
          tokenControl.tools.push(buttonConfig);
        }
        ovLog(`${MODULE_ID} | Button added to token controls (V11/V12)`);
        return;
      }
    }

    console.warn(`${MODULE_ID} | Could not find token controls to add button`);
  } catch (error) {
    console.error(`${MODULE_ID} | Error adding scene control button:`, error);
  }
});

// MAD 版：渲染后把图标替换为 logo 图片（只替换 <i> 子元素，保留按钮事件）
if (IS_MAD_EDITION) {
  const _replaceMadIcon = () => {
    // V13 按钮没有 data-tool 属性，改用 aria-label / title 匹配
    const btn = document.querySelector(`[data-tool="${MODULE_ID}"]`)
              || document.querySelector(`button[aria-label="${MODULE_TITLE}"]`)
              || document.querySelector(`button[title="${MODULE_TITLE}"]`)
              || document.querySelector(`button.fa-map-location-dot`);
    if (!btn) return false;
    // 已替换过则跳过
    if (btn.querySelector('img.ov-mad-logo')) return true;
    // V13 的 icon button：图标直接在 button 自身的 class 上 (fas fa-map-location-dot)
    // 不是 <i> 子元素，需要把 button 自身的图标样式清除并插入 <img>
    const icon = btn.querySelector('i');
    if (icon) {
      // V11/V12: 图标是 <i> 子元素
      const img = document.createElement('img');
      img.className = 'ov-mad-logo';
      img.src = `modules/origin-vault-mad/mad/Logo_NEW_Red.jpg`;
      img.style.cssText = 'width:28px;height:28px;border-radius:50%;object-fit:cover';
      icon.replaceWith(img);
      return true;
    } else if (btn.classList.contains('fas')) {
      // V13: 图标在 button 自身的 class 上
      btn.classList.remove('fas', 'fa-map-location-dot', 'icon');
      btn.style.cssText += ';background:none;padding:0;display:flex;align-items:center;justify-content:center;';
      const img = document.createElement('img');
      img.className = 'ov-mad-logo';
      img.src = `modules/origin-vault-mad/mad/Logo_NEW_Red.jpg`;
      img.style.cssText = 'width:28px;height:28px;border-radius:50%;object-fit:cover';
      btn.appendChild(img);
      return true;
    }
    return false;
  };
  Hooks.on('renderSceneControls', () => {
    if (!_replaceMadIcon()) {
      requestAnimationFrame(() => {
        if (!_replaceMadIcon()) {
          setTimeout(() => _replaceMadIcon(), 200);
        }
      });
    }
  });
}

/**
 * 处理画布拖放 - 按素材类型分流
 */
Hooks.on('dropCanvasData', async (canvas, data) => {
  // 检查是否是来自 Origin Vault 的拖放
  if (data.type !== 'origin-vault-item') return;

  const library = LibraryData.getInstance();
  const item = library.getItem(data.itemId);
  if (!item) return;

  const ext = '.' + item.path.split('.').pop().toLowerCase();

  // ==================== 场景：阻止放置 ====================
  const isScene = item.metadata?.type === 'scene' || item.type === 'scene' || ext === '.ov-scene';
  if (isScene) {
    ui.notifications.warn(t('origin-vault.drop.sceneNotAllowed'));
    return false; // 阻止 Foundry 默认处理
  }

  // ==================== 音频：创建环境音 ====================
  const isAudio = FILE_TYPES.AUDIO.includes(ext);
  if (isAudio) {
    _showAmbientSoundPreview(item, data.x, data.y);
    return false;
  }

  // ==================== 图片/视频：创建 Tile ====================
  const { x, y } = data;
  const scale = library.getSetting('defaultScale') || 1.0;
  const snapToGrid = library.getSetting('snapToGrid');

  let finalX = x;
  let finalY = y;

  if (snapToGrid) {
    const M = CONST.GRID_SNAPPING_MODES;
    const snapped = canvas.grid.getSnappedPoint({ x, y }, { mode: M.CENTER | M.VERTEX, resolution: 1 });
    finalX = snapped.x;
    finalY = snapped.y;
  }

  // Load texture to get native dimensions
  let width, height;
  try {
    const texture = await foundry.canvas.loadTexture(item.path);
    width = texture.baseTexture.width;
    height = texture.baseTexture.height;
  } catch (e) {
    console.warn(`${MODULE_ID} | Failed to load texture for dimensions, falling back to grid size`, e);
    width = canvas.grid.size;
    height = canvas.grid.size;
  }

  const finalWidth = width * scale;
  const finalHeight = height * scale;
  const centeredX = finalX - finalWidth / 2;
  const centeredY = finalY - finalHeight / 2;

  await canvas.scene.createEmbeddedDocuments('Tile', [{
    texture: { src: item.path },
    x: centeredX,
    y: centeredY,
    width: finalWidth,
    height: finalHeight
  }]);

  // 使用统计别卡住拖放手感，失败也不能影响已经落到画布上的 Tile。
  library.updateItem(item.id, {
    lastUsed: new Date().toISOString(),
    useCount: (item.useCount || 0) + 1
  }, { mode: 'usage' }).catch(error => {
    console.warn(`${MODULE_ID} | Failed to queue tile usage stats:`, error);
  });

  ui.notifications.info(tf('origin-vault.drop.tilePlaced', { name: item.displayName || item.path.split('/').pop() }));
});

/**
 * 显示环境音放置预览 - PIXI 圆圈 + 调整面板
 * @param {object} item - 素材对象
 * @param {number} dropX - 画布 X 坐标
 * @param {number} dropY - 画布 Y 坐标
 */
function _showAmbientSoundPreview(item, dropX, dropY) {
  // 清理旧预览（如果有）
  _removeAmbientSoundPreview();

  const gridSize = canvas.grid.size;
  let currentRadius = 10;  // 默认 10 格
  let currentVolume = 0.75; // 默认 75%

  // ==================== PIXI 预览圆圈 ====================
  const circle = new PIXI.Graphics();
  circle.eventMode = 'none'; // 不拦截鼠标
  canvas.controls.addChild(circle);

  function drawCircle(radiusGrids) {
    const radiusPx = radiusGrids * gridSize;
    circle.clear();
    // 填充
    circle.beginFill(0x4287f5, 0.12);
    circle.drawCircle(dropX, dropY, radiusPx);
    circle.endFill();
    // 描边
    circle.lineStyle(2, 0x4287f5, 0.7);
    circle.drawCircle(dropX, dropY, radiusPx);
    // 中心点
    circle.lineStyle(0);
    circle.beginFill(0x4287f5, 0.9);
    circle.drawCircle(dropX, dropY, 6);
    circle.endFill();
  }

  drawCircle(currentRadius);

  // ==================== HTML 调整面板 ====================
  const rawName = item.displayName || item.name || item.path.split('/').pop();
  const fileName = decodeReadableName(rawName);
  const truncName = fileName.length > 30 ? fileName.slice(0, 27) + '...' : fileName;

  const panel = document.createElement('div');
  panel.id = 'ov-ambient-sound-panel';
  panel.className = 'ov-ambient-sound-panel';
  panel.innerHTML = `
    <div class="ov-asp-content">
      <div class="ov-asp-icon"><i class="fas fa-volume-up"></i></div>
      <div class="ov-asp-name" title="${fileName}">${truncName}</div>
      <div class="ov-asp-divider"></div>
      <div class="ov-asp-control">
        <label><i class="fas fa-bullseye"></i> ${t('origin-vault.drop.ambientRadius')}</label>
        <input type="range" class="ov-asp-radius" min="1" max="30" value="${currentRadius}" step="1">
        <span class="ov-asp-radius-val">${currentRadius}</span>
      </div>
      <div class="ov-asp-control">
        <label><i class="fas fa-volume-down"></i> ${t('origin-vault.drop.ambientVolume')}</label>
        <input type="range" class="ov-asp-volume" min="0" max="100" value="${Math.round(currentVolume * 100)}" step="5">
        <span class="ov-asp-volume-val">${Math.round(currentVolume * 100)}%</span>
      </div>
      <div class="ov-asp-divider"></div>
      <button class="ov-asp-confirm" title="${t('origin-vault.drop.ambientConfirm')}">
        <i class="fas fa-check"></i>
      </button>
      <button class="ov-asp-cancel" title="${t('origin-vault.drop.ambientCancel')}">
        <i class="fas fa-times"></i>
      </button>
    </div>
  `;
  document.body.appendChild(panel);

  // 将面板定位到拖放位置附近（屏幕坐标）
  const stageTransform = canvas.stage.worldTransform;
  const screenPos = {
    x: (dropX * stageTransform.a) + stageTransform.tx,
    y: (dropY * stageTransform.d) + stageTransform.ty
  };
  // 面板出现在放置点上方，水平居中
  panel.style.position = 'fixed';
  panel.style.bottom = 'unset';
  panel.style.left = 'unset';
  panel.style.top = `${Math.max(10, screenPos.y - 60)}px`;
  panel.style.left = `${screenPos.x}px`;
  panel.style.transform = 'translateX(-50%) translateY(0)';

  // 延迟添加 active 以触发动画
  requestAnimationFrame(() => {
    panel.classList.add('active');
    // 确保面板不超出视口
    const rect = panel.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      panel.style.left = `${window.innerWidth - rect.width - 10}px`;
      panel.style.transform = 'translateY(0)';
    }
    if (rect.left < 0) {
      panel.style.left = '10px';
      panel.style.transform = 'translateY(0)';
    }
    if (rect.top < 0) {
      panel.style.top = '10px';
    }
  });

  // ==================== 事件绑定 ====================
  const radiusSlider = panel.querySelector('.ov-asp-radius');
  const radiusVal = panel.querySelector('.ov-asp-radius-val');
  const volumeSlider = panel.querySelector('.ov-asp-volume');
  const volumeVal = panel.querySelector('.ov-asp-volume-val');

  radiusSlider.addEventListener('input', (e) => {
    currentRadius = parseInt(e.target.value);
    radiusVal.textContent = currentRadius;
    drawCircle(currentRadius);
  });

  volumeSlider.addEventListener('input', (e) => {
    currentVolume = parseInt(e.target.value) / 100;
    volumeVal.textContent = `${e.target.value}%`;
  });

  // 确认放置
  panel.querySelector('.ov-asp-confirm').addEventListener('click', async () => {
    _removeAmbientSoundPreview();

    try {
      await canvas.scene.createEmbeddedDocuments('AmbientSound', [{
        path: item.path,
        x: dropX,
        y: dropY,
        radius: currentRadius * (canvas.scene.grid.distance || 5), // 滑块值(格数) → Foundry距离单位
        volume: currentVolume,
        walls: true,
        repeat: true,
        hidden: false
      }]);

      // 使用统计走延迟写，别让一次 metadata 上传拖慢环境音放置反馈。
      const library = LibraryData.getInstance();
      library.updateItem(item.id, {
        lastUsed: new Date().toISOString(),
        useCount: (item.useCount || 0) + 1
      }, { mode: 'usage' }).catch(error => {
        console.warn(`${MODULE_ID} | Failed to queue ambient sound usage stats:`, error);
      });

      ui.notifications.info(tf('origin-vault.drop.ambientPlaced', {
        name: decodeReadableName(item.displayName || item.path.split('/').pop())
      }));
    } catch (err) {
      console.error(`${MODULE_ID} | Failed to create AmbientSound:`, err);
      ui.notifications.error(`Failed to create ambient sound: ${err.message}`);
    }
  });

  // 取消
  panel.querySelector('.ov-asp-cancel').addEventListener('click', () => {
    _removeAmbientSoundPreview();
  });

  // ESC 键取消
  function onKeyDown(e) {
    if (e.key === 'Escape') {
      _removeAmbientSoundPreview();
    }
  }
  document.addEventListener('keydown', onKeyDown, { once: true });

  // 存储引用以便清理
  window._ovAmbientPreview = { circle, panel, onKeyDown };
}

/**
 * 移除环境音预览
 */
function _removeAmbientSoundPreview() {
  const preview = window._ovAmbientPreview;
  if (!preview) return;

  // 移除 PIXI 圆圈
  if (preview.circle) {
    preview.circle.destroy();
  }

  // 移除面板
  if (preview.panel) {
    preview.panel.classList.remove('active');
    setTimeout(() => preview.panel.remove(), 200);
  }

  // 移除键盘监听
  if (preview.onKeyDown) {
    document.removeEventListener('keydown', preview.onKeyDown);
  }

  window._ovAmbientPreview = null;
}

/**
 * 首次使用引导弹窗
 * 仅在用户从未看过引导时显示（client 级别设置）
 */
function _showOnboardingIfNeeded() {
  let seen = false;
  try {
    seen = game.settings.get(MODULE_ID, SETTINGS.ONBOARDING_SEEN);
    console.warn(`[OV-Onboarding] onboardingSeen = ${seen}`);
    if (seen) return;
  } catch (e) {
    console.warn(`[OV-Onboarding] Failed to read setting:`, e);
    return;
  }

  // 延迟显示，等待 UI 完全加载
  setTimeout(() => {
    // ==================== 高亮左侧 OV 按钮 ====================
    // V13 兼容：尝试多种选择器定位 OV 按钮
    const ovBtn = document.querySelector('[data-tool="origin-vault"]')
      || document.querySelector('li.scene-control[data-tool="origin-vault"]')
      || document.querySelector('[title="Origin Vault"]')
      || document.querySelector('.fa-vault')?.closest('li, button, [data-tool]');
    if (ovBtn) {
      ovBtn.classList.add('ov-onboarding-highlight');
      ovBtn.style.position = 'relative';
      ovBtn.style.overflow = 'visible';
      ovBtn.style.zIndex = '100001'; // 高于遮罩层的 99999

      // 添加箭头 + 标签指示器
      const indicator = document.createElement('div');
      indicator.className = 'ov-onboarding-arrow';
      indicator.innerHTML = `<i class="fas fa-caret-left"></i>`;
      ovBtn.appendChild(indicator);
    }

    // ==================== 创建遮罩和弹窗 ====================
    const overlay = document.createElement('div');
    overlay.className = 'ov-onboarding-overlay';

    const popup = document.createElement('div');
    popup.className = 'ov-onboarding-popup';
    popup.innerHTML = `
      <h2><i class="fas fa-vault"></i> ${t('origin-vault.onboarding.title')}</h2>
      <div class="ov-onboarding-items">
        <div class="ov-onboarding-item">
          <div class="ov-onboarding-icon warn"><i class="fas fa-exclamation-triangle"></i></div>
          <p>${t('origin-vault.onboarding.sceneRequired')}</p>
        </div>
        ${IS_MAD_EDITION ? '' : `
        <div class="ov-onboarding-item">
          <div class="ov-onboarding-icon accent"><i class="fas fa-vault"></i></div>
          <p>${t('origin-vault.onboarding.entryIcon')}</p>
        </div>
        <div class="ov-onboarding-item">
          <div class="ov-onboarding-icon info"><i class="fas fa-map-marker-alt"></i></div>
          <p>${t('origin-vault.onboarding.buttonLocation')}</p>
        </div>
        <div class="ov-onboarding-item">
          <div class="ov-onboarding-icon note"><i class="fas fa-file-alt"></i></div>
          <p>${t('origin-vault.onboarding.filePickerReadonly')}</p>
        </div>
        `}
      </div>
      <div class="ov-onboarding-footer">
        <label class="ov-onboarding-checkbox">
          <input type="checkbox" checked>
          <span>${t('origin-vault.onboarding.dontShowAgain')}</span>
        </label>
        <button class="ov-onboarding-btn">
          <i class="fas fa-check"></i> ${t('origin-vault.onboarding.gotIt')}
        </button>
      </div>
    `;

    overlay.appendChild(popup);
    document.body.appendChild(overlay);

    // 入场动画
    requestAnimationFrame(() => {
      overlay.classList.add('active');
    });

    // ==================== 事件绑定 ====================
    const closeOnboarding = () => {
      const dontShow = popup.querySelector('.ov-onboarding-checkbox input')?.checked;
      if (dontShow) {
        try { game.settings.set(MODULE_ID, SETTINGS.ONBOARDING_SEEN, true); } catch (e) { }
      }

      // 退场动画
      overlay.classList.remove('active');
      overlay.classList.add('closing');
      setTimeout(() => overlay.remove(), 300);

      // 移除按钮高亮
      if (ovBtn) {
        ovBtn.classList.remove('ov-onboarding-highlight');
        const arrowEl = ovBtn.querySelector('.ov-onboarding-arrow');
        if (arrowEl) arrowEl.remove();
      }
    };

    popup.querySelector('.ov-onboarding-btn').addEventListener('click', closeOnboarding);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeOnboarding();
    });
  }, 1500);
}

/**
 * 导出 API 供其他模块使用
 */
Hooks.once('ready', () => {
  if (ENABLE_RIGHT_SIDEBAR_BROWSER) {
    OVSidebarBrowser.getInstance().init();
    OVSidebarQuickLauncher.getInstance().init();
  }

  game.modules.get(MODULE_ID).api = {
    openWindow: () => MainWindow.open(),
    getLibrary: () => LibraryData.getInstance(),
    getLibraryManager: () => LibraryManager.getInstance(),
    addItem: (path, folderId) => LibraryData.getInstance().addItem(path, folderId),
    searchItems: (query, filters) => LibraryData.getInstance().searchItems(query, filters),
    switchLibrary: (id, options) => LibraryManager.getInstance().switchLibrary(id, options)
  };

  // 集成测试入口：GM 在控制台输入 ovRunTests() 即可运行
  if (game.user.isGM) {
    window.ovRunTests = async (options = {}) => {
      const { runIntegrationTests } = await import('./tests/index.js');
      return runIntegrationTests(options);
    };
    window.ovRunCoreTests = async (options = {}) => {
      const { runCoreIntegrationTests } = await import('./tests/index.js');
      return runCoreIntegrationTests(options);
    };
    window.ovRunLibraryTests = async (options = {}) => {
      const { runLibraryIntegrationTests } = await import('./tests/index.js');
      return runLibraryIntegrationTests(options);
    };

    game.modules.get(MODULE_ID).api.runTests = (options = {}) => window.ovRunTests(options);
    game.modules.get(MODULE_ID).api.runCoreTests = (options = {}) => window.ovRunCoreTests(options);
    game.modules.get(MODULE_ID).api.runLibraryTests = (options = {}) => window.ovRunLibraryTests(options);
  }
});

// ★ 场景激活/查看时，OV 自动切换到窗口模式
Hooks.on('canvasReady', () => {
  try {
    const instance = MainWindow.getInstance();
    if (!instance?.rendered) return;    // OV 未打开
    if (instance.isWindowed) return;    // 已经是窗口模式
    if (instance.filePickerMode) return; // 文件选择器模式不受影响

    ovLog(`${MODULE_ID} | Scene activated, auto-switching OV to windowed mode`);

    // 用 jQuery 触发点击（事件绑定用的是 jQuery .on）
    $(instance.element).find('.btn-toggle-window').trigger('click');
  } catch (e) {
    // getInstance() 在 OV 未初始化时可能报错，忽略
  }
});

// 监听素材添加事件，自动生成缩略图
Hooks.on(`${MODULE_ID}.itemAdded`, async (item) => {
  const thumbnailManager = ThumbnailManager.getInstance();
  const library = LibraryData.getInstance();

  // 确保 ThumbnailManager 使用正确的基路径 (v3.1: 不再需要)
  // thumbnailManager.setBasePath(library.basePath);

  try {
    const result = await thumbnailManager.generateThumbnail(item);
    if (result && result.path) {
      // 更新素材数据（不触发 UI 刷新，由下面的 DOM 操作处理）
      await library.updateItem(item.id, {
        thumbnail: result.path,
        thumbnailGenerated: true,
        thumbnailVersion: result.thumbnailVersion || 1,
        thumbnailRevision: result.thumbnailRevision,
        metadata: {
          ...item.metadata,
          width: result.width,
          height: result.height,
          duration: result.duration,
          fileSize: result.fileSize
        }
      });

      // 直接更新 UI 中的缩略图显示（避免整个界面刷新）
      const assetCard = document.querySelector(`.asset-card[data-item-id="${item.id}"]`);
      if (assetCard) {
        const thumbnailContainer = assetCard.querySelector('.asset-thumbnail');
        if (thumbnailContainer) {
          let img = thumbnailContainer.querySelector('img');
          const placeholder = thumbnailContainer.querySelector('.thumbnail-placeholder');
          const thumbnailSrc = buildThumbnailSrc({
            ...item,
            thumbnail: result.path,
            thumbnailVersion: result.thumbnailVersion || 1,
            thumbnailRevision: result.thumbnailRevision
          });

          if (img) {
            img.src = thumbnailSrc;
          } else if (placeholder) {
            img = document.createElement('img');
            img.src = thumbnailSrc;
            img.alt = item.displayName || '';
            img.loading = 'lazy';
            placeholder.replaceWith(img);
          }
        }
      }
      // 注意：不再触发整个界面刷新，避免多次刷新问题
    }
  } catch (error) {
    console.error(`${MODULE_ID} | Failed to generate thumbnail for new item:`, error);
  }
});

// 调试工具（始终可用，方便开发和调试）
const ovDebugApi = window.OriginVault || {};
Object.assign(ovDebugApi, {
  MainWindow,
  LibraryData,
  LibraryManager,
  ThumbnailManager,
  open: () => MainWindow.open(),
  library: () => LibraryData.getInstance(),
  libraryManager: () => LibraryManager.getInstance(),
  thumbnails: () => ThumbnailManager.getInstance(),
  tests: {
    run: (options = {}) => window.ovRunTests?.(options),
    core: (options = {}) => window.ovRunCoreTests?.(options),
    library: (options = {}) => window.ovRunLibraryTests?.(options)
  },
  // 批量生成缩略图的便捷方法
  generateAllThumbnails: async () => {
    const library = LibraryData.getInstance();
    const thumbnailManager = ThumbnailManager.getInstance();
    const items = Object.values(library.getAllItems());

    ui.notifications.info(tf('origin-vault.notifications.regenerating', { count: items.length }));

    const count = await thumbnailManager.generateBatch(items, (current, total) => {
      if (current % 10 === 0 || current === total) {
        ovLog(`${MODULE_ID} | Thumbnail progress: ${current}/${total}`);
      }
    }, false, library);

    // 更新素材数据
    for (const item of items) {
      if (item.thumbnailGenerated) continue;
      // v3.0: 缩略图现在存储在资源文件夹中
      const thumbnailPath = thumbnailManager.getAssetThumbnailPath(item.id);
      const exists = await thumbnailManager.thumbnailExists(thumbnailPath);
      if (exists) {
        await library.updateItem(item.id, {
          thumbnail: thumbnailPath,
          thumbnailGenerated: true,
          thumbnailVersion: 1,
          thumbnailRevision: item.thumbnailRevision || createThumbnailRevision()
        });
      }
    }

    ui.notifications.info(tf('origin-vault.notifications.genSuccess', { count: count }));
    return count;
  }
});
window.OriginVault = ovDebugApi;
