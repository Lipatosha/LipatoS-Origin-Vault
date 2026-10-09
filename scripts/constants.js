import { ovText } from './utils/locale.js';
/**
 * Origin Vault - 店规大全（aka 常量定义）
 * ---------------------------------------------------
 * 这里是咱们店铺的规章制度。
 * 别看只是一堆 const，但动了这里的任何一个值，
 * 整栋楼都可能跟着抖三抖。问我怎么知道的？别问。
 * 
 * 如果你想改什么配置，先深呼吸三次，然后 Ctrl+S 之前再深呼吸三次。
 */

// 动态检测 module ID（根据文件夹名自动判断版本）
// origin-vault/ → 完整版, origin-vault-mad/ → MAD 特供版
export const MODULE_ID = import.meta.url.match(/modules\/([^/]+)\//)?.[1] || 'origin-vault';
export const IS_MAD_EDITION = MODULE_ID.includes('mad');
export const MODULE_TITLE = IS_MAD_EDITION ? ovText('Origin Vault - MAD Edition', 'LipatoS — Хранилище MAD') : ovText('Origin Vault', 'LipatoS — Хранилище ресурсов');
export const DEBUG = false; // 开关调试日志。生产环境千万别开，不然控制台直接变弹幕区

// 多层场景预览已经放开；右侧边栏还是单独走自己的发布节奏。
export const ENABLE_SCENE_BROWSER_ENHANCEMENTS = true;

// 右侧只读边栏和它的快捷书签一起先藏起来。
export const ENABLE_RIGHT_SIDEBAR_BROWSER = false;

// 数据存储路径：两个版本共享同一目录，资源库注册表通过 settings 隔离
export const DEFAULT_DATA_PATH = 'origin-vault';
export const LIBRARY_FILE = 'library.json';

// 全局资源库：跨世界共享的资源库，不按 worldId 隔离
export const GLOBAL_DATA_PATH = 'origin-vault/_global';
// MAD 版使用独立的全局注册表文件，避免和完整版互相覆盖
export const GLOBAL_REGISTRY_FILE = IS_MAD_EDITION ? 'registry-mad.json' : 'registry.json';
export const MAD_GLOBAL_REGISTRY_FILE = 'registry-mad.json';
export const MAD_WORLD_REGISTRY_FILE = 'registry-mad-world.json';
export const LIBRARY_BACKUP_FILE = 'library-backup.json';
export const THUMBNAILS_DIR = 'thumbnails'; // 旧版遗产，留着是因为还有人要从 v2 迁移上来

// ==================== 分散存储结构 v3.0（我花了一周才搞定的重构）====================
export const STORAGE = {
  IMAGES_DIR: 'images',           // 资源大本营
  ASSET_FOLDER_SUFFIX: '.info',   // 每个资源的"身份证"文件夹后缀
  METADATA_FILE: 'metadata.json', // 资源的"履历表"
  THUMBNAIL_FILE: 'thumbnail',    // 缩略图，不带扩展名是因为格式可能变
  TAGS_FILE: 'tags.json',         // 标签定义文件

  // 缩略图缓存目录，按 ID 前两位分桶，不然一个文件夹里几千张图，文件系统会罢工
  CACHE_DIR: '_cache',
  CACHE: {
    ROOT_DEFAULT: 'origin-vault/_cache',
    BUCKET_DEPTH: 2 // 用 ID 前 2 位当子目录名，散列分桶，典型的空间换性能
  }
};

// 数据版本号（每次大改存储格式就得升一版，跟游戏大版本更新一样让人头痛）
export const DATA_VERSION = {
  LIBRARY: '3.0.0',   // 库配置版本
  ASSET: '1.0.0',     // 资源元数据版本
  LEGACY: '2.0.0'     // 旧版标识，看到这个版本号就知道要触发迁移了
};

// ==================== 设置键名（Foundry Settings API 用的 key）====================
export const SETTINGS = {
  // 客户端级别（每个玩家独立）
  WINDOW_POSITION: 'windowPosition',
  REGENERATE_THUMBNAILS: 'regenerateThumbnails',

  // 世界级别（GM 改了所有人生效，权力越大责任越大）
  ACTIVE_LIBRARY_ID: 'activeLibraryId',
  ACTIVE_LIBRARY_PATH: 'activeLibraryPath',
  REGISTRY: 'registry',
  LIBRARY_DATA: 'libraryData',
  WORLD_PREFERENCES: 'worldPreferences',

  // 缩略图质量（高清党和省流党的战争从未停歇）
  THUMBNAIL_QUALITY: 'thumbnailQuality',

  // 缓存存储位置（支持本地和 S3，S3 适合有钱人）
  CACHE_SOURCE: 'cacheSource',
  S3_BUCKET: 's3Bucket',
  CACHE_VERSION: 'cacheVersion',

  // 上传文件存储位置（支持本地和 S3）
  UPLOAD_SOURCE: 'uploadSource',

  // 上传文件存放路径（用户自定义）
  UPLOAD_PATH: 'uploadPath',

  // 预加载（空间换时间的经典操作）
  PRELOAD_LIBRARY: 'preloadLibrary',

  // 新手引导是否已看过（Client 级别）
  ONBOARDING_SEEN: 'onboardingSeen',

  // 对玩家完全禁用 OV（World 级别）
  GM_ONLY: 'gmOnly'
};

// 资源库注册表
export const LIBRARIES_REGISTRY = 'libraries.json';
export const MAX_RECENT_LIBRARIES = 5;

// 缩略图质量档位（低/中/高，选低档的都是网费比我贵的人）
export const THUMBNAIL_PROFILES = {
  low: { width: 256, height: 192, quality: 0.5 },
  medium: { width: 512, height: 384, quality: 0.85 },
  high: { width: 1024, height: 768, quality: 0.95 }
};

// 缩略图通用配置
export const THUMBNAIL = {
  FORMAT: 'image/webp',        // WebP 天下第一，不接受反驳
  VIDEO_SEEK_PERCENT: 0.15     // 视频截取位置：15% 处。太靠前是黑屏，太靠后谁知道是啥
};

// ==================== 支持的文件类型（不在名单上的一律不认）====================
export const FILE_TYPES = {
  IMAGE: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'],
  VIDEO: ['.webm', '.mp4', '.mov', '.avi', '.mkv'],
  AUDIO: ['.mp3', '.wav', '.ogg', '.flac', '.m4a'],
  SCENE: ['.ov-scene'] // 咱自己发明的格式，骄傲！
};

export const ASSET_TYPES = {
  IMAGE: 'image',
  VIDEO: 'video',
  AUDIO: 'audio',
  SCENE: 'scene',
  ITEM: 'item',  // Compendium 物品（武器、护甲、法术等），通过 ItemAdapter 管理
  ACTOR: 'actor'  // Compendium 角色（NPC、怪物、玩家角色等），通过 ActorAdapter 管理
};

// 稀有度颜色映射（通用，不限于 DnD5e）
export const RARITY_COLORS = {
  common: '#9e9e9e',
  uncommon: '#4caf50',
  rare: '#2196f3',
  veryRare: '#9c27b0',
  legendary: '#ff9800',
  artifact: '#f44336'
};

// ==================== 默认设置（出厂配置，改之前请三思）====================
export const DEFAULT_SETTINGS = {
  thumbnailSize: 'medium',      // small / medium / large
  previewBackground: 'black',   // 预览背景色，强迫症患者请选棋盘格
  autoplayVideos: true,         // 视频自动播放，社死预警：开会时别打开素材库
  hoverPreview: true,           // 鼠标悬停预览
  hoverDelay: 300,              // 悬停延迟（ms），太短了会闪瞎眼，太长了没耐心
  defaultPlacement: 'tile',     // 默认放置方式
  defaultScale: 1.0,            // 默认缩放
  snapToGrid: true,             // 对齐网格，强迫症福音
  showFileExtensions: false,    // 显示文件扩展名（关了比较美观）
  confirmDelete: true,          // 删除确认，防手滑保险
  autoBackup: true,             // 自动备份，救命稻草
  backupCount: 5                // 备份份数，5 份够了吧，再多硬盘该哭了
};

// 缩略图尺寸映射
export const THUMBNAIL_SIZES = {
  small: { width: 100, height: 75 },
  medium: { width: 150, height: 112 },
  large: { width: 200, height: 150 }
};

// ==================== 特殊文件夹（虚拟的，不占物理空间，纯靠逻辑撑着）====================
export const SPECIAL_FOLDERS = {
  ROOT: 'root',
  ALL: '__all__',
  FAVORITES: '__favorites__',
  RECENT: '__recent__',
  UNCATEGORIZED: '__uncategorized__'
};

// 智能文件夹是保存的查询视图，不是实体文件夹，前缀别和普通文件夹混用。
export const SMART_FOLDER_PREFIX = '__smart_';

// ==================== 事件名称（Hook 系统的信号灯）====================
export const EVENTS = {
  LIBRARY_LOADED: `${MODULE_ID}.libraryLoaded`,
  LIBRARY_SAVED: `${MODULE_ID}.librarySaved`,
  FOLDER_CREATED: `${MODULE_ID}.folderCreated`,
  FOLDER_DELETED: `${MODULE_ID}.folderDeleted`,
  FOLDER_UPDATED: `${MODULE_ID}.folderUpdated`,
  ITEM_ADDED: `${MODULE_ID}.itemAdded`,
  ITEM_REMOVED: `${MODULE_ID}.itemRemoved`,
  ITEM_UPDATED: `${MODULE_ID}.itemUpdated`,
  TAG_CREATED: `${MODULE_ID}.tagCreated`,
  TAG_DELETED: `${MODULE_ID}.tagDeleted`,
  TAG_UPDATED: `${MODULE_ID}.tagUpdated`,
  SELECTION_CHANGED: `${MODULE_ID}.selectionChanged`,

  // 资源库管理事件（多库系统加的，一个库不够折腾的）
  LIBRARY_CREATED: `${MODULE_ID}.libraryCreated`,
  LIBRARY_DELETED: `${MODULE_ID}.libraryDeleted`,
  LIBRARY_SWITCHED: `${MODULE_ID}.librarySwitched`,
  LIBRARY_RENAMED: `${MODULE_ID}.libraryRenamed`,

  // 全局注册表事件（全局库增删改时触发）
  GLOBAL_REGISTRY_UPDATED: `${MODULE_ID}.globalRegistryUpdated`
};

// UI 相关魔法数字（硬编码是不对，但真香）
export const UI = {
  MAIN_WINDOW_WIDTH: 1200,
  MAIN_WINDOW_HEIGHT: 800,
  MIN_WINDOW_WIDTH: 800,
  MIN_WINDOW_HEIGHT: 600,
  SIDEBAR_WIDTH: 250,         // 侧边栏宽度，再窄文件夹名就要被截断了
  BROWSER_PANEL_WIDTH: 400,   // 文件浏览器面板宽度
  GRID_GAP: 8,                // 网格间距，美学和实用的平衡点
  ANIMATION_DURATION: 200     // 动画时长（ms），快到看不清但又不至于生硬
};

// OV 自己内部的层级表。
// 这次开始别再满地写 10000 / 10001 了，不然下次改壳还得继续挖自己埋的雷。
export const OV_LAYERS = Object.freeze({
  SHELL: 60,
  WINDOWED: 500,
  FILTER_DROPDOWN: 900,
  CONTEXT_MENU: 1200,
  DIALOG_OVERLAY_BASE: 1210,
  NESTED_DIALOG: 1220,
  HELP_OVERLAY: 1230,
  HOVER_ZOOM: 1240,
  HERO_CLONE: 1250,
  FLOATING_PANEL: 1260,
  QUICK_LOOK: 1300,
  IMPORT_FLOATER: 1350,
  ONBOARDING_OVERLAY: 1400,
  ONBOARDING_CALLOUT: 1410,
  DRAG_GHOST: 1500
});
