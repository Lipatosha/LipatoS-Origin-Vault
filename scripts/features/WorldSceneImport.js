/**
 * Origin Vault - 完整版专属：世界场景导入
 * 提供从当前世界收录场景到资源库的功能
 * MAD 版发布时删除此文件，功能自动禁用
 */

import { getWorldSceneId } from '../utils/worldSceneBindings.js';

/**
 * 获取世界场景列表（排除已通过 OV 管理的合集包场景）
 * @param {LibraryData} library - 当前资源库实例
 * @returns {object[]} 世界场景列表
 */
export function getWorldScenes(library) {
    const managedWorldIds = new Set();
    // 收集已被 Library 管理的世界场景 ID
    for (const [, item] of library.itemsCache || []) {
        const wsId = getWorldSceneId(item, { library });
        if (wsId) managedWorldIds.add(wsId);
    }
    const scenes = [];
    for (const scene of game.scenes) {
        // 排除从合集包导入的场景（有 compendiumSource 的）
        if (scene._stats?.compendiumSource) continue;
        scenes.push({
            id: scene.id,
            name: scene.name,
            thumb: scene.thumb || '',
            isActive: scene.active,
            isViewing: canvas?.scene?.id === scene.id,
            isCollected: managedWorldIds.has(scene.id)
        });
    }
    return scenes;
}
