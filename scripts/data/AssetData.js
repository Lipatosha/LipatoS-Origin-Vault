/**
 * Origin Vault - 单个资源的数据管家（AssetData）
 * ---------------------------------------------------
 * 每个素材在硬盘里都有一个 {id}.info/ 文件夹，
 * 里面放着它的"身份证"（metadata.json）和"证件照"（缩略图）。
 * 
 * 这个类就是专门伺候单个素材的管家 ——
 * 帮它建文件夹、读档、存档、更新信息、甚至帮它料理后事（删除）。
 * 
 * v3.0 重构时从"一个大 JSON 装所有素材"改成了"每个素材一个文件夹"，
 * 工作量暴增但换来了更好的扩展性。值不值得？我说值得（含泪）。
 */

import { MODULE_ID, STORAGE, DATA_VERSION } from '../constants.js';
import { ThumbnailManager } from '../utils/ThumbnailManager.js';
import { browseFilePicker, createFilePickerDirectory, uploadWithFilePicker } from '../utils/filePicker.js';
import { ovLog } from '../utils/logger.js';

/**
 * 单个资源的数据管理类
 * 一个实例对应硬盘上的一个 {id}.info/ 文件夹
 */
export class AssetData {
    /**
     * @param {string} libraryPath - 资源库根路径
     * @param {string} assetId - 资源的唯一 ID
     */
    constructor(libraryPath, assetId) {
        this.libraryPath = libraryPath;
        this.id = assetId;
        this._data = null; // 内存缓存，懒加载
    }

    /**
     * 从路径里提取库 ID（路径最后一段就是库名）
     */
    get libraryId() {
        return this.libraryPath.split('/').pop();
    }

    /**
     * 这个素材在硬盘上的文件夹路径
     * 格式：{库路径}/images/{id}.info/
     * @returns {string}
     */
    get folderPath() {
        return `${this.libraryPath}/${STORAGE.IMAGES_DIR}/${this.id}${STORAGE.ASSET_FOLDER_SUFFIX}`;
    }

    /**
     * 元数据文件的完整路径
     * @returns {string}
     */
    get metadataPath() {
        return `${this.folderPath}/${STORAGE.METADATA_FILE}`;
    }

    /**
     * 获取缩略图路径
     * v3.1 之后缩略图统一由 ThumbnailManager 管理，这里只是问它要个路径
     * @param {string} format - 已弃用参数，现在统一用 webp
     * @returns {string}
     */
    getThumbnailPath(format = 'webp') {
        return ThumbnailManager.getInstance().getAssetThumbnailPath(this.id, this.libraryId);
    }

    /**
     * 读取内存里缓存的数据（不会触发磁盘读取）
     * @returns {object|null}
     */
    get data() {
        return this._data;
    }

    // ==================== 创建 ====================

    /**
     * 生成一份全新的素材元数据
     * 相当于帮新来的素材办一张"身份证"
     * 
     * @param {string} id - 资源 ID
     * @param {string} path - 文件路径
     * @param {object} options - 额外信息（标签、评分、备注等）
     * @returns {object} 一份崭新的元数据对象
     */
    static createDefaultMetadata(id, path, options = {}) {
        return {
            id,
            version: DATA_VERSION.ASSET,
            path,
            folders: options.folders || ['root'],    // 默认丢根目录
            displayName: options.displayName || null,
            tags: options.tags || [],
            rating: options.rating || 0,
            notes: options.notes || '',
            addedDate: new Date().toISOString(),      // 入库时间
            lastUsed: null,                           // 还没被用过呢
            useCount: 0,
            metadata: options.metadata || null
        };
    }

    // ==================== 文件系统操作 ====================

    /**
     * 确保这个素材的文件夹存在
     * 如果不存在就创建，连带 images/ 目录一起
     * 
     * 为什么要这么啰嗦？因为 Foundry 的 FilePicker 不支持递归创建目录，
     * 得一层层手动建，跟盖房子一样从地基开始…
     * 
     * @returns {Promise<boolean>}
     */
    async ensureFolder() {
        try {
            await browseFilePicker('data', this.folderPath);
            return true; // 文件夹已存在，不用操心
        } catch {
            // 文件夹不存在，先确保 images 目录在
            const imagesDir = `${this.libraryPath}/${STORAGE.IMAGES_DIR}`;
            try {
                await browseFilePicker('data', imagesDir);
            } catch {
                await createFilePickerDirectory('data', imagesDir);
                ovLog(`${MODULE_ID} | Created images directory: ${imagesDir}`);
            }

            // 然后创建素材自己的文件夹
            await createFilePickerDirectory('data', this.folderPath);
            ovLog(`${MODULE_ID} | Created asset folder: ${this.folderPath}`);
            return true;
        }
    }

    // ==================== 读取 / 保存 ====================

    /**
     * 从硬盘读取元数据
     * 加了时间戳参数防止浏览器缓存捣乱（被坑过，别问）
     * @returns {Promise<object|null>}
     */
    async load() {
        try {
            const response = await fetch(`/${this.metadataPath}?t=${Date.now()}`);
            if (response.ok) {
                this._data = await response.json();
                return this._data;
            }
        } catch (e) {
            console.warn(`${MODULE_ID} | Failed to load metadata for ${this.id}:`, e);
        }
        return null;
    }

    /**
     * 把元数据写回硬盘
     * 会先确保文件夹存在，然后把 JSON 塞进去
     * @param {object} data - 完整的元数据对象
     * @returns {Promise<boolean>}
     */
    async save(data) {
        try {
            await this.ensureFolder();
            this._data = data;

            const content = JSON.stringify(data, null, 2);
            const file = new File([content], STORAGE.METADATA_FILE, { type: 'application/json' });
            await uploadWithFilePicker('data', this.folderPath, file, {}, { notify: false });

            return true;
        } catch (error) {
            console.error(`${MODULE_ID} | Failed to save metadata for ${this.id}:`, error);
            return false;
        }
    }

    /**
     * 部分更新元数据
     * 不用传完整对象，只传要改的字段就行，内部会自动合并
     * 如果内存里还没有数据，会先去硬盘读一份
     * @param {object} updates - 要更新的字段
     * @returns {Promise<boolean>}
     */
    async update(updates) {
        if (!this._data) {
            await this.load();
        }

        if (!this._data) {
            console.error(`${MODULE_ID} | Cannot update - no data loaded for ${this.id}`);
            return false;
        }

        Object.assign(this._data, updates);
        return this.save(this._data);
    }

    // saveThumbnail 已经光荣退休，缩略图的活全交给 ThumbnailManager 了

    // ==================== 删除（料理后事）====================

    /**
     * 删除这个素材的所有痕迹
     * 包括：缓存里的缩略图 + 元数据文件夹里的所有文件
     * 
     * 注意：Foundry 不支持直接删除空文件夹，
     * 所以我们只能把里面的文件都清掉，空壳子等服务器重启时自己消失。
     * 有点像拆迁但不推墙，等它自然倒…
     * 
     * @returns {Promise<boolean>}
     */
    async delete() {
        try {
            const tm = ThumbnailManager.getInstance();
            const source = tm.cacheSource;
            const bucket = tm.s3Bucket;

            // 1. 先把缓存里的缩略图干掉
            await tm.deleteThumbnail(this.id);

            // 2. 遍历元数据文件夹，逐个删除里面的文件
            const result = await browseFilePicker(source, this.folderPath, { bucket });

            for (const file of result.files) {
                try {
                    if (source === 's3') {
                        // S3 的删除方式跟本地不太一样，但都是发 DELETE 请求
                        await fetch(`/${file}`, { method: 'DELETE' });
                    } else {
                        const relativePath = file.replace(/^\//, '');
                        await fetch(`/${relativePath}`, { method: 'DELETE' });
                    }
                } catch (e) {
                    console.warn(`${MODULE_ID} | Failed to delete file: ${file} on ${source}`);
                }
            }

            ovLog(`${MODULE_ID} | Deleted asset folder contents: ${this.folderPath}`);

            this._data = null; // 清空内存缓存，这个素材在内存里也走了
            return true;
        } catch (error) {
            console.error(`${MODULE_ID} | Failed to delete asset folder ${this.id}:`, error);
            return false;
        }
    }

    // ==================== 状态检查 ====================

    /**
     * 检查这个素材的文件夹还在不在
     * @returns {Promise<boolean>}
     */
    async exists() {
        try {
            await browseFilePicker('data', this.folderPath);
            return true;
        } catch {
            return false; // 人走茶凉
        }
    }

    /**
     * 看看缩略图还在不在，在的话返回路径
     * @returns {Promise<string|null>} 存在返回路径，不存在返回 null
     */
    async getThumbnailIfExists() {
        const path = this.getThumbnailPath();
        if (await ThumbnailManager.getInstance().thumbnailExists(path)) {
            return path;
        }
        return null;
    }
}
