/**
 * Origin Vault - 场景适配器（aka 舞台监督）
 * ---------------------------------------------------
 * 负责跟 Foundry 的 Compendium Packs 和 World Scenes 打交道。
 * 在 Origin Vault 里，每个 Compendium Pack 相当于一个"文件夹"，
 * 里面的场景就是"文件"。
 * 
 * 这玩意儿写起来比文件系统适配器复杂多了，
 * 因为场景有导入/激活/缩略图等一堆状态要跟踪。
 * 我头发就是在这里开始掉的。
 */
import { VaultAdapter } from './VaultAdapter.js';
import { MODULE_ID } from '../constants.js';

export class SceneAdapter extends VaultAdapter {
    constructor(libraryPath) {
        super(libraryPath);
        this.packs = []; // 可用的场景合集包，初始化时填充
    }

    /**
     * 初始化：扫描所有含场景的 Compendium Packs
     * 以后可能加个配置让用户选择启用哪些 Pack，目前先全加载了
     */
    async init() {
        this.packs = game.packs.filter(p => p.documentName === 'Scene');
    }

    /**
     * 获取场景列表
     * 这里有个设计上的小聪明：把 Compendium Pack 当"文件夹"使
     * 
     * @param {string} folderId - 'root' 时返回空（根目录只显示 Pack 文件夹）；
     *                            传 Pack ID 时返回该 Pack 里的所有场景
     */
    async getItems(folderId) {
        if (folderId === 'root' || !folderId) {
            return []; // 根目录只有 Pack "文件夹"，不直接显示场景
        }

        // 找到对应的 Compendium Pack
        const pack = game.packs.get(folderId);
        if (pack) {
            // 拉取索引，顺便要底图和缩略图字段
            const index = await pack.getIndex({ fields: ['background.src', 'thumb', 'name', 'flags'] });

            // 把 Compendium 的数据结构翻译成咱们 Origin Vault 统一的 Item 格式
            return index.map(entry => {
                // 检查这个场景是否已经被导入到当前世界了
                // 原理：Foundry 导入时会在 _stats.compendiumSource 里记录来源 UUID
                const compendiumUuid = `Compendium.${pack.collection}.${entry._id}`;
                const worldScene = game.scenes.find(s => s._stats?.compendiumSource === compendiumUuid);

                // 预览图优先级：底图（高清）> 缩略图 > 啥也没有
                let thumbnail = entry.thumb;
                let previewImage = entry.background?.src;

                if (previewImage) {
                    thumbnail = previewImage; // 有底图就用底图，毕竟高清才是正义
                }

                return {
                    id: entry._id,
                    uuid: compendiumUuid,
                    name: entry.name,
                    type: 'scene',
                    folderId: folderId,

                    // 显示用
                    thumbnail: thumbnail,       // 网格里的小图
                    previewImage: previewImage,  // 详情面板里的大图

                    // 状态标记
                    isImported: !!worldScene,
                    worldId: worldScene?.id,
                    isActive: worldScene?.active || false,

                    // 元数据（如果已导入就从 World Scene 的 flags 里读，否则就是空的）
                    rating: worldScene?.getFlag(MODULE_ID, 'rating') || 0,
                    tags: worldScene?.getFlag(MODULE_ID, 'tags') || [],
                    notes: worldScene?.getFlag(MODULE_ID, 'notes') || '',
                };
            });
        }

        return [];
    }

    /**
     * 获取"文件夹"列表 —— 对场景来说就是 Compendium Packs
     * 每个 Pack 给它上个橙色标记，跟普通文件夹区分开
     */
    async getFolders() {
        return this.packs.map(pack => ({
            id: pack.collection,
            name: pack.metadata.label,
            type: 'pack',
            parentId: 'root',
            color: '#FF9800' // 橙色 = "我是场景包，别把我跟普通文件夹搞混了"
        }));
    }

    /**
     * 获取场景详情
     * 
     * 这个方法目前是摆设…… 因为只传一个 ID 进来，
     * 没法知道它属于哪个 Pack，总不能遍历所有 Pack 去找吧？
     * 所以 UI 那边直接用 getItems 返回的完整对象了，省事。
     */
    async getItemDetails(itemId) {
        return null;
    }

    /**
     * 导入场景：从 Compendium 搬到当前世界
     * 
     * 听起来简单，但 Foundry 的导入流程暗坑不少。
     * 比如缩略图生成需要场景先激活并渲染，没法后台静默搞定，
     * 只能先导入，缩略图的事以后再说。
     * 
     * @param {object} itemData - getItems 返回的那个 item 对象
     */
    async importItem(itemData) {
        if (itemData.isImported) return true; // 已经导入过了，不重复劳动

        try {
            const pack = game.packs.get(itemData.folderId);
            const doc = await pack.getDocument(itemData.id);
            const imported = await game.Scene.fromCompendium(doc);
            return imported;
        } catch (err) {
            console.error("Scene import failed:", err);
            ui.notifications.error(`Import failed: ${err.message}`);
            return false;
        }
    }

    /**
     * 激活场景（让该场景成为玩家们当前看到的场景）
     * @param {string} worldId - 世界中的场景 ID（注意是 World ID 不是 Compendium ID）
     */
    async activateItem(worldId) {
        const scene = game.scenes.get(worldId);
        if (scene) {
            return scene.activate();
        }
        return false;
    }
}
