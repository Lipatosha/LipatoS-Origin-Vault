/**
 * Origin Vault - 角色适配器（aka 角色经纪人）
 * ---------------------------------------------------
 * 跟 ItemAdapter 是一个妈生的，但管的是 Compendium 里的角色。
 * NPC、怪物、玩家角色…… 什么都收。
 * 
 * 同样把每个 Compendium Pack 当"文件夹"使，
 * 里面的角色就是"文件"。
 * 
 * 只使用 Foundry Core API，不依赖任何特定系统。
 */
import { VaultAdapter } from './VaultAdapter.js';
import { MODULE_ID } from '../constants.js';

export class ActorAdapter extends VaultAdapter {
    constructor() {
        super();
        this.packs = []; // 可用的角色合集包
    }

    /**
     * 初始化：扫描所有含角色的 Compendium Packs
     */
    async init() {
        this.packs = game.packs.filter(p => p.documentName === 'Actor');
    }

    /**
     * 获取角色列表
     * 
     * @param {string} folderId - 'root' 返回空；传 Pack ID 返回该 Pack 里的所有角色
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

            // 检查世界中是否已存在来自同一 Compendium 源的角色
            const worldActor = game.actors?.find(a => a._stats?.compendiumSource === compendiumUuid);

            return {
                id: entry._id,
                uuid: compendiumUuid,
                name: entry.name,
                type: 'actor',
                subType: entry.type,       // npc, character 等
                folderId: folderId,

                // 显示用
                thumbnail: entry.img || 'icons/svg/mystery-man.svg',
                previewImage: entry.img,

                // 系统数据（用于增强显示）
                systemData: entry.system || {},

                // 状态标记
                isImported: !!worldActor,
                worldId: worldActor?.id,
            };
        });
    }

    /**
     * 获取"文件夹"列表 —— 即所有 Actor 类型的 Compendium Packs
     * 给每个 Pack 上紫色标记，与场景（橙）和物品（绿）区分
     */
    async getFolders() {
        return this.packs.map(pack => ({
            id: pack.collection,
            name: pack.metadata.label,
            type: 'pack',
            parentId: 'root',
            icon: 'fa-users',
            color: '#9C27B0' // 紫色 = "我是角色包"
        }));
    }

    /**
     * 获取角色详情
     * 同 SceneAdapter 一样暂时返回 null，UI 用 getItems 的数据就够了
     */
    async getItemDetails(itemId) {
        return null;
    }

    /**
     * 从 Compendium 导入单个角色到当前世界
     * 
     * @param {object} itemData - getItems 返回的 item 对象
     * @returns {Actor|boolean} 导入的角色文档，失败返回 false
     */
    async importItem(itemData) {
        if (itemData.isImported) return true; // 已导入，不重复

        try {
            const pack = game.packs.get(itemData.folderId);
            if (!pack) throw new Error(`Pack not found: ${itemData.folderId}`);

            const doc = await pack.getDocument(itemData.id);
            const actorObj = doc.toObject();

            // 记录来源信息，方便后续追踪
            actorObj._stats = actorObj._stats || {};
            actorObj._stats.compendiumSource = itemData.uuid;

            const created = await Actor.implementation.create(actorObj);
            return created;
        } catch (err) {
            console.error(`${MODULE_ID} | Actor import failed:`, err);
            ui.notifications.error(`Import failed: ${err.message}`);
            return false;
        }
    }

    /**
     * 批量导入整个 Pack 的所有角色
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
            const exists = game.actors?.find(actor => actor._stats?.compendiumSource === compendiumUuid);
            if (exists) {
                imported++;
                if (onProgress) onProgress(i + 1, index.size);
                continue;
            }

            try {
                const doc = await pack.getDocument(entry._id);
                const actorObj = doc.toObject();
                actorObj._stats = actorObj._stats || {};
                actorObj._stats.compendiumSource = compendiumUuid;
                await Actor.implementation.create(actorObj);
                imported++;
            } catch (err) {
                console.warn(`${MODULE_ID} | Failed to import actor ${entry.name}:`, err);
            }

            if (onProgress) onProgress(i + 1, index.size);
        }

        return imported;
    }
}
