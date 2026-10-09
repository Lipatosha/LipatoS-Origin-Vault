/**
 * Origin Vault - DnD5e 自动标签生成器
 * ---------------------------------------------------
 * 仅当 game.system.id === 'dnd5e' 时加载。
 * 从 Compendium 物品的 system 数据中自动提取标签：
 * - 物品子类型 (weapon, armor, spell, feat, ...)
 * - 稀有度 (common, uncommon, rare, veryRare, legendary, artifact)
 * - 法术环阶 (cantrip, 1st–9th)
 * - 需要同调 (attunement)
 * - 伤害类型 (fire, cold, lightning, ...)
 * - 治疗 / 临时 HP
 * - AOE (area of effect)
 *
 * 使用 OV 现有标签系统：library.createTag() + library.addTagToItem()
 * 标签名通过 game.i18n 本地化。
 */

import { MODULE_ID } from '../constants.js';
import { hasTranslation, t } from '../utils/i18n.js';
import { ovDebug } from '../utils/logger.js';

// ==================== 颜色常量 ====================

export const RARITY_COLORS = {
    common: '#9e9e9e',
    uncommon: '#4caf50',
    rare: '#2196f3',
    veryRare: '#9c27b0',
    legendary: '#ff9800',
    artifact: '#f44336'
};

const DAMAGE_TYPE_COLORS = {
    acid: '#69f0ae',
    bludgeoning: '#90a4ae',
    cold: '#80d8ff',
    fire: '#ff6e40',
    force: '#e040fb',
    lightning: '#ffff00',
    necrotic: '#757575',
    piercing: '#b0bec5',
    poison: '#76ff03',
    psychic: '#f48fb1',
    radiant: '#fff176',
    slashing: '#cfd8dc',
    thunder: '#8c9eff'
};

const TAG_COLORS = {
    itemType: '#7e57c2',   // 紫色系
    spellLevel: '#42a5f5',   // 蓝色系
    attunement: '#ffc107',   // 金色
    healing: '#66bb6a',   // 绿色
    tempHp: '#26a69a',   // 青色
    aoe: '#ff7043'    // 橙色
};

// ==================== DnD5e AOE 模板类型 ====================

const AOE_TYPES = new Set([
    'cone', 'cube', 'cylinder', 'emanation',
    'line', 'radius', 'sphere', 'square', 'wall'
]);

function sentenceCase(value) {
    const text = String(value || '');
    if (!text) return '';
    return text.charAt(0).toUpperCase() + text.slice(1);
}

function localizeAutoTag(key, fallback) {
    return hasTranslation(key) ? t(key) : fallback;
}

function localizeValueTag(prefix, value) {
    return localizeAutoTag(`${prefix}.${value}`, sentenceCase(value));
}

function localizeSpellLevel(level) {
    if (level === 0) {
        return localizeAutoTag('origin-vault.autoTags.spellLevel.cantrip', 'Cantrip');
    }

    const template = localizeAutoTag('origin-vault.autoTags.spellLevel.level', 'Level {n}');
    return template.replace('{n}', level);
}

// ==================== 核心函数 ====================

/**
 * 从 Compendium index entry 生成标签列表
 *
 * @param {object} entry - Compendium index entry (含 type, system)
 *   entry.type = 'weapon' | 'armor' | 'spell' | 'feat' | ...
 *   entry.system = DnD5e system data
 * @returns {Array<{name: string, color: string}>} 待创建/关联的标签
 */
export function generateDnd5eTags(entry) {
    if (!entry) return [];

    const tags = [];
    const sys = entry.system || {};

    // 1. 物品子类型
    if (entry.type) {
        const typeName = localizeValueTag('origin-vault.autoTags.itemType', entry.type);
        tags.push({ name: typeName, color: TAG_COLORS.itemType });
    }

    // 2. 稀有度
    if (sys.rarity && sys.rarity !== 'common') {
        const rarityName = localizeValueTag('origin-vault.autoTags.rarity', sys.rarity);
        tags.push({ name: rarityName, color: RARITY_COLORS[sys.rarity] || '#9e9e9e' });
    }

    // 3. 法术环阶
    if (entry.type === 'spell' && sys.level !== undefined && sys.level !== null) {
        const level = Number(sys.level);
        const levelName = localizeSpellLevel(level);
        tags.push({ name: levelName, color: TAG_COLORS.spellLevel });
    }

    // 4. 需要同调
    if (sys.attunement) {
        const attName = localizeAutoTag('origin-vault.autoTags.attunement', 'Requires Attunement');
        tags.push({ name: attName, color: TAG_COLORS.attunement });
    }

    // 5. 伤害类型、治疗、AOE — 从 Activities 提取 (DnD5e v4+)
    const damageTypes = new Set();
    let hasHealing = false;
    let hasTempHp = false;
    let hasAoe = false;

    if (sys.activities) {
        // sys.activities 是一个 object（key = activity ID, value = activity data）
        const activities = typeof sys.activities === 'object' ? Object.values(sys.activities) : [];

        for (const activity of activities) {
            // 5a. 检测治疗活动
            if (activity.type === 'heal') {
                // DnD5e v5: heal activity 有 healing.types Set
                if (activity.healing?.types) {
                    const healTypes = activity.healing.types instanceof Set
                        ? activity.healing.types
                        : new Set(Array.isArray(activity.healing.types) ? activity.healing.types : []);
                    if (healTypes.has('temphp')) {
                        hasTempHp = true;
                    } else {
                        hasHealing = true;
                    }
                } else {
                    hasHealing = true;
                }
            }

            // 5b. 提取伤害类型
            if (activity.damage?.parts) {
                const parts = Array.isArray(activity.damage.parts) ? activity.damage.parts : [];
                for (const part of parts) {
                    // DnD5e v5: damage.parts[].types 是一个 array/Set of damage type strings
                    if (part.types) {
                        const types = part.types instanceof Set ? [...part.types]
                            : Array.isArray(part.types) ? part.types : [];
                        for (const t of types) {
                            if (t && t !== 'none') damageTypes.add(t);
                        }
                    }
                    // 兼容旧格式: damage.parts[].type (单一字符串)
                    if (part.type && part.type !== 'none') {
                        damageTypes.add(part.type);
                    }
                }
            }

            // 5c. 检测 AOE — 从 target.template
            if (activity.target?.template?.type && AOE_TYPES.has(activity.target.template.type)) {
                hasAoe = true;
            }
            // 也检查 target.affects (有些活动只用 affects 而不是 template)
        }
    }

    // 兼容旧版 DnD5e (v3 以下): system.damage.parts 格式
    if (!sys.activities && sys.damage?.parts) {
        const parts = Array.isArray(sys.damage.parts) ? sys.damage.parts : [];
        for (const part of parts) {
            // 旧格式: [formula, damageType]
            if (Array.isArray(part) && part[1]) {
                damageTypes.add(part[1]);
            }
        }
    }

    // 兼容旧版: system.actionType
    if (!sys.activities && sys.actionType === 'heal') {
        hasHealing = true;
    }

    // 兼容旧版: system.target
    if (!sys.activities && sys.target?.type && AOE_TYPES.has(sys.target.type)) {
        hasAoe = true;
    }

    // 添加伤害类型标签
    for (const dt of damageTypes) {
        const dtName = localizeValueTag('origin-vault.autoTags.damageType', dt);
        tags.push({ name: dtName, color: DAMAGE_TYPE_COLORS[dt] || '#888888' });
    }

    // 添加治疗标签
    if (hasHealing) {
        const healName = localizeAutoTag('origin-vault.autoTags.healing', 'Healing');
        tags.push({ name: healName, color: TAG_COLORS.healing });
    }

    if (hasTempHp) {
        const tempName = localizeAutoTag('origin-vault.autoTags.tempHp', 'Temp HP');
        tags.push({ name: tempName, color: TAG_COLORS.tempHp });
    }

    // 添加 AOE 标签
    if (hasAoe) {
        const aoeName = localizeAutoTag('origin-vault.autoTags.aoe', 'AOE');
        tags.push({ name: aoeName, color: TAG_COLORS.aoe });
    }

    return tags;
}

/**
 * 将自动标签应用到 OV 库中的物品
 *
 * @param {LibraryData} library - OV 的 LibraryData 实例
 * @param {string} ovItemId - OV 素材 ID (item_xxxxx)
 * @param {object} entry - Compendium index entry
 */
export async function applyAutoTags(library, ovItemId, entry) {
    if (!library || !ovItemId || !entry) return;
    if (game.system?.id !== 'dnd5e') return;

    try {
        const tags = generateDnd5eTags(entry);
        for (const tag of tags) {
            const tagId = library.createTag(tag.name, tag.color);
            await library.addTagToItem(ovItemId, tagId);
        }

        if (tags.length > 0) {
            ovDebug(`${MODULE_ID} | Auto-tagged "${entry.name}" with ${tags.length} tags: ${tags.map(t => t.name).join(', ')}`);
        }
    } catch (err) {
        console.warn(`${MODULE_ID} | Auto-tag failed for "${entry.name}":`, err);
    }
}

/**
 * 检查当前系统是否支持自动标签
 * @returns {boolean}
 */
export function isDnd5eSystem() {
    return game.system?.id === 'dnd5e';
}

// ==================== 标签分组 ====================

/**
 * 标签分组定义
 * 用于在筛选面板中将自动标签分组显示
 */
export const TAG_GROUP_DEFINITIONS = [
    { id: 'spellLevel', icon: '📊', i18nKey: 'origin-vault.autoTags.groups.spellLevel' },
    { id: 'rarity', icon: '💎', i18nKey: 'origin-vault.autoTags.groups.rarity' },
    { id: 'damageType', icon: '⚔️', i18nKey: 'origin-vault.autoTags.groups.damageType' },
    { id: 'itemType', icon: '📦', i18nKey: 'origin-vault.autoTags.groups.itemType' },
    { id: 'range', icon: '🎯', i18nKey: 'origin-vault.autoTags.groups.range' },
    { id: 'other', icon: '🔗', i18nKey: 'origin-vault.autoTags.groups.other' },
];

// 分组排序映射（法术环阶内部排序）
const SPELL_LEVEL_ORDER = {};
(() => {
    // 这个自执行函数在模块加载时不运行——延迟到运行时
})();

/**
 * 获取所有自动标签并按分组分类
 * 
 * @param {LibraryData} library - OV 库实例
 * @param {string} [folderId] - 当前文件夹 ID（仅显示该文件夹内物品使用的标签）
 * @returns {Array<{group: object, tags: Array<{id, name, color}>}>} 分组后的标签
 */
export function getTagGroups(library, folderId = null) {
    if (!isDnd5eSystem() || !library) return [];

    // 获取当前文件夹可见的标签
    let visibleTagIds;
    if (folderId) {
        const visibleTags = library.getTagsForFolder(folderId);
        visibleTagIds = new Set(visibleTags.map(t => t.id));
    } else {
        visibleTagIds = new Set(Object.keys(library.getAllTags()));
    }

    if (visibleTagIds.size === 0) return [];

    const allTags = library.getAllTags();

    // 构建已知标签名→分组的映射
    const nameToGroup = _buildNameToGroupMap();

    // 分类标签
    const grouped = {};
    for (const def of TAG_GROUP_DEFINITIONS) {
        grouped[def.id] = { group: def, tags: [] };
    }

    for (const tagId of visibleTagIds) {
        const tag = allTags[tagId];
        if (!tag) continue;
        const groupId = nameToGroup[tag.name];
        if (groupId && grouped[groupId]) {
            grouped[groupId].tags.push({ id: tagId, name: tag.name, color: tag.color });
        }
    }

    // 法术环阶排序：戏法→1环→2环→...→9环
    if (grouped.spellLevel.tags.length > 0) {
        const spellOrder = _buildSpellLevelOrder();
        grouped.spellLevel.tags.sort((a, b) => {
            return (spellOrder[a.name] ?? 99) - (spellOrder[b.name] ?? 99);
        });
    }

    // 稀有度排序
    if (grouped.rarity.tags.length > 0) {
        const rarityOrder = _buildRarityOrder();
        grouped.rarity.tags.sort((a, b) => {
            return (rarityOrder[a.name] ?? 99) - (rarityOrder[b.name] ?? 99);
        });
    }

    // 只返回有标签的分组
    return TAG_GROUP_DEFINITIONS
        .map(def => grouped[def.id])
        .filter(g => g.tags.length > 0);
}

/**
 * 构建标签名→分组 ID 的映射
 * @private
 */
function _buildNameToGroupMap() {
    const map = {};

    // 物品类型
    const itemTypes = ['weapon', 'armor', 'equipment', 'consumable', 'tool', 'loot',
        'spell', 'feat', 'class', 'subclass', 'background', 'race', 'facility', 'container'];
    for (const itemType of itemTypes) {
        const name = localizeValueTag('origin-vault.autoTags.itemType', itemType);
        map[name] = 'itemType';
    }

    // 稀有度
    const rarities = ['common', 'uncommon', 'rare', 'veryRare', 'legendary', 'artifact'];
    for (const rarity of rarities) {
        const name = localizeValueTag('origin-vault.autoTags.rarity', rarity);
        map[name] = 'rarity';
    }

    // 法术环阶
    map[localizeSpellLevel(0)] = 'spellLevel';
    const levelTemplate = localizeAutoTag('origin-vault.autoTags.spellLevel.level', 'Level {n}');
    for (let i = 1; i <= 9; i++) {
        map[levelTemplate.replace('{n}', i)] = 'spellLevel';
    }

    // 伤害类型
    const damageTypes = ['acid', 'bludgeoning', 'cold', 'fire', 'force', 'lightning',
        'necrotic', 'piercing', 'poison', 'psychic', 'radiant', 'slashing', 'thunder'];
    for (const damageType of damageTypes) {
        const name = localizeValueTag('origin-vault.autoTags.damageType', damageType);
        map[name] = 'damageType';
    }
    // 治疗和临时HP也归入伤害类型组
    map[localizeAutoTag('origin-vault.autoTags.healing', 'Healing')] = 'damageType';
    map[localizeAutoTag('origin-vault.autoTags.tempHp', 'Temp HP')] = 'damageType';

    // AOE → 范围组
    map[localizeAutoTag('origin-vault.autoTags.aoe', 'AOE')] = 'range';

    // 同调 → 其他组
    map[localizeAutoTag('origin-vault.autoTags.attunement', 'Requires Attunement')] = 'other';

    return map;
}

/**
 * 构建法术环阶排序映射
 * @private
 */
function _buildSpellLevelOrder() {
    const order = {};
    order[localizeSpellLevel(0)] = 0;
    const levelTemplate = localizeAutoTag('origin-vault.autoTags.spellLevel.level', 'Level {n}');
    for (let i = 1; i <= 9; i++) {
        order[levelTemplate.replace('{n}', i)] = i;
    }
    return order;
}

/**
 * 构建稀有度排序映射
 * @private
 */
function _buildRarityOrder() {
    const order = {};
    const rarities = ['common', 'uncommon', 'rare', 'veryRare', 'legendary', 'artifact'];
    rarities.forEach((rarity, i) => {
        const name = localizeValueTag('origin-vault.autoTags.rarity', rarity);
        order[name] = i;
    });
    return order;
}

