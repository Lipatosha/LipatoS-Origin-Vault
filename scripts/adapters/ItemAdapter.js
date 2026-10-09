/**
 * Origin Vault - 物品适配器（aka 杂货铺管理员）
 * ---------------------------------------------------
 * 跟 SceneAdapter 是一个妈生的，但管的是 Compendium 里的物品。
 * 武器、护甲、法术、消耗品…… 什么都收，什么都卖。
 * 
 * 同样把每个 Compendium Pack 当"文件夹"使，
 * 里面的物品就是"文件"。
 * 
 * 拖放使用 Foundry 原生的 type:'Item' 格式，
 * 所以 Item Piles 等 mod 能无缝联动，不用我操心。
 */
import { VaultAdapter } from './VaultAdapter.js';
import { MODULE_ID } from '../constants.js';

export class ItemAdapter extends VaultAdapter {
    constructor() {
        super();
        this.packs = []; // 可用的物品合集包
    }

    /**
     * 初始化：扫描所有含物品的 Compendium Packs
     * 跟 SceneAdapter.init() 一模一样的套路
     */
    async init() {
        this.packs = game.packs.filter(p => p.documentName === 'Item');
    }

    /**
     * 获取物品列表
     * 
     * @param {string} folderId - 'root' 返回空；传 Pack ID 返回该 Pack 里的所有物品
     */
    async getItems(folderId) {
        if (folderId === 'root' || !folderId) {
            return []; // 根目录只有 Pack "文件夹"
        }

        const pack = game.packs.get(folderId);
        if (!pack) return [];

        // 拉取索引，要图标、类型、系统数据
        const index = await pack.getIndex({ fields: ['img', 'type', 'system'] });

        return index.map(entry => {
            const compendiumUuid = `Compendium.${pack.collection}.${entry._id}`;

            // 检查世界中是否已存在来自同一 Compendium 源的物品
            const worldItem = game.items?.find(i => i._stats?.compendiumSource === compendiumUuid);

            return {
                id: entry._id,
                uuid: compendiumUuid,
                name: entry.name,
                type: 'item',
                subType: entry.type,       // weapon, armor, spell, consumable 等
                folderId: folderId,

                // 显示用
                thumbnail: entry.img || 'icons/svg/item-bag.svg',  // 没图就用 Foundry 默认图标
                previewImage: entry.img,

                // 系统数据（用于增强显示）
                systemData: entry.system || {},

                // 状态标记
                isImported: !!worldItem,
                worldId: worldItem?.id,
            };
        });
    }

    /**
     * 获取"文件夹"列表 —— 即所有 Item 类型的 Compendium Packs
     * 给每个 Pack 上绿色标记，跟场景的橙色区分
     */
    async getFolders() {
        return this.packs.map(pack => ({
            id: pack.collection,
            name: pack.metadata.label,
            type: 'pack',
            parentId: 'root',
            icon: 'fa-box-open',
            color: '#4CAF50' // 绿色 = "我是物品包"
        }));
    }

    /**
     * 获取物品详情
     * 同 SceneAdapter 一样暂时返回 null，UI 用 getItems 的数据就够了
     */
    async getItemDetails(itemId) {
        return null;
    }

    /**
     * 从 Compendium 导入单个物品到当前世界
     * 
     * @param {object} itemData - getItems 返回的 item 对象
     * @returns {Item|boolean} 导入的物品文档，失败返回 false
     */
    async importItem(itemData) {
        if (itemData.isImported) return true; // 已导入，不重复

        try {
            const pack = game.packs.get(itemData.folderId);
            if (!pack) throw new Error(`Pack not found: ${itemData.folderId}`);

            const doc = await pack.getDocument(itemData.id);
            const itemObj = doc.toObject();

            // 记录来源信息，方便后续追踪
            itemObj._stats = itemObj._stats || {};
            itemObj._stats.compendiumSource = itemData.uuid;

            const created = await Item.implementation.create(itemObj);
            return created;
        } catch (err) {
            console.error(`${MODULE_ID} | Item import failed:`, err);
            ui.notifications.error(`Import failed: ${err.message}`);
            return false;
        }
    }

    /**
     * 批量导入整个 Pack 的所有物品
     * 
     * @param {string} packId - Compendium Pack 的 collection ID
     * @param {Function} onProgress - 进度回调 (current, total)
     * @returns {number} 成功导入的数量
     */
    async importAll(packId, onProgress = null) {
        const pack = game.packs.get(packId);
        if (!pack) return 0;

        const index = await pack.getIndex();
        let imported = 0;

        for (let i = 0; i < index.size; i++) {
            const entry = index.contents[i];
            const compendiumUuid = `Compendium.${pack.collection}.${entry._id}`;

            // 跳过已导入的
            const exists = game.items?.find(item => item._stats?.compendiumSource === compendiumUuid);
            if (exists) {
                imported++;
                if (onProgress) onProgress(i + 1, index.size);
                continue;
            }

            try {
                const doc = await pack.getDocument(entry._id);
                const itemObj = doc.toObject();
                itemObj._stats = itemObj._stats || {};
                itemObj._stats.compendiumSource = compendiumUuid;
                await Item.implementation.create(itemObj);
                imported++;
            } catch (err) {
                console.warn(`${MODULE_ID} | Failed to import item ${entry.name}:`, err);
            }

            if (onProgress) onProgress(i + 1, index.size);
        }

        return imported;
    }
}
