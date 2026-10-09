import { ovText } from '../utils/locale.js';
/**
 * Origin Vault - 系统配置（aka 各系统的翻译官）
 * ---------------------------------------------------
 * 不同 TRPG 系统的物品数据结构天差地别，
 * 但我又不想为每个系统写一套专用代码。
 * 
 * 解决方案：用配置表来描述每个系统"什么字段在哪里"。
 * 认识的系统就显示增强信息（稀有度、价格等），
 * 不认识的就降级到通用视图，起码不会炸。
 * 
 * 要支持新系统？往 SYSTEM_CONFIGS 里加一段就行，
 * 不用动任何 UI 代码。这就是配置驱动的好处。
 */

/**
 * 系统特定字段映射
 * 
 * 每个系统配置包含：
 * - Item: 物品字段映射数组
 *   - key: Foundry system data 中的字段路径（用 foundry.utils.getProperty 读取）
 *   - label: 显示标签
 *   - icon: 图标（emoji 或 FontAwesome class）
 *   - format: 格式化方式 ('capitalize', 'number', 'boolean')
 *   - suffix: 后缀文本
 *   - filter: 是否可用作筛选条件
 * - description: 描述字段的路径
 */
const SYSTEM_CONFIGS = {
    dnd5e: {
        Item: [
            { key: 'system.rarity', label: ovText('Rarity', 'Редкость'), icon: '💎', format: 'capitalize', filter: true },
            { key: 'system.price.value', label: ovText('Price', 'Цена'), icon: '💰', format: 'number' },
            { key: 'system.price.denomination', label: '', hidden: true },  // 配合 Price 使用
            { key: 'system.weight.value', label: ovText('Weight', 'Вес'), icon: '⚖️', suffix: 'lbs' },
            { key: 'system.attunement', label: ovText('Attunement', 'Настройка'), icon: '🔗', format: 'boolean' },
        ],
        description: 'system.description.value',
        // 物品子类型的本地化标签
        subTypes: {
            weapon: ovText('🗡️ Weapon', '🗡️ Оружие'),
            armor: ovText('🛡️ Armor', '🛡️ Доспехи'),
            equipment: ovText('⚙️ Equipment', '⚙️ Снаряжение'),
            consumable: ovText('🧪 Consumable', '🧪 Расходуемое'),
            tool: ovText('🔧 Tool', '🔧 Инструмент'),
            loot: ovText('💎 Loot', '💎 Добыча'),
            spell: ovText('✨ Spell', '✨ Заклинание'),
            feat: ovText('📜 Feat', '📜 Черта'),
            class: ovText('🎭 Class', '🎭 Класс'),
            subclass: ovText('🎭 Subclass', '🎭 Подкласс'),
            background: ovText('📖 Background', '📖 Предыстория'),
            race: ovText('🧬 Race', '🧬 Раса'),
            facility: ovText('🏠 Facility', '🏠 Строение'),
        }
    },

    pf2e: {
        Item: [
            { key: 'system.level.value', label: ovText('Level', 'Уровень'), icon: '📊', format: 'number', filter: true },
            { key: 'system.traits.rarity', label: ovText('Rarity', 'Редкость'), icon: '💎', format: 'capitalize', filter: true },
            { key: 'system.price.value.gp', label: ovText('Price', 'Цена'), icon: '💰', suffix: 'gp' },
            { key: 'system.bulk.value', label: ovText('Bulk', 'Груз'), icon: '⚖️' },
        ],
        description: 'system.description.value',
        subTypes: {
            weapon: ovText('🗡️ Weapon', '🗡️ Оружие'),
            armor: ovText('🛡️ Armor', '🛡️ Доспехи'),
            equipment: ovText('⚙️ Equipment', '⚙️ Снаряжение'),
            consumable: ovText('🧪 Consumable', '🧪 Расходуемое'),
            treasure: ovText('💎 Treasure', '💎 Сокровище'),
            spell: ovText('✨ Spell', '✨ Заклинание'),
            feat: ovText('📜 Feat', '📜 Черта'),
            action: ovText('⚡ Action', '⚡ Действие'),
            ancestry: ovText('🧬 Ancestry', '🧬 Родословная'),
            heritage: ovText('🧬 Heritage', '🧬 Наследие'),
            background: ovText('📖 Background', '📖 Предыстория'),
            class: ovText('🎭 Class', '🎭 Класс'),
        }
    }
};

/**
 * 获取当前系统的物品增强字段配置
 * 不认识的系统返回空数组，UI 降级到通用视图
 * 
 * @param {string} [systemId] - 系统 ID，默认使用当前游戏系统
 * @param {string} [docType='Item'] - 文档类型
 * @returns {Array} 字段映射数组
 */
export function getSystemFields(systemId = null, docType = 'Item') {
    const id = systemId || game.system?.id;
    const config = SYSTEM_CONFIGS[id];
    if (!config || !config[docType]) return [];
    return config[docType].filter(f => !f.hidden);
}

/**
 * 获取描述字段路径
 * 
 * @param {string} [systemId] - 系统 ID
 * @returns {string} 描述字段路径，默认 'system.description.value'
 */
export function getDescriptionPath(systemId = null) {
    const id = systemId || game.system?.id;
    const config = SYSTEM_CONFIGS[id];
    return config?.description || 'system.description.value';
}

/**
 * 获取物品子类型的显示标签
 * 
 * @param {string} subType - 物品子类型（weapon, armor 等）
 * @param {string} [systemId] - 系统 ID
 * @returns {string} 带图标的显示标签，不认识就返回首字母大写的原始值
 */
export function getSubTypeLabel(subType, systemId = null) {
    const id = systemId || game.system?.id;
    const config = SYSTEM_CONFIGS[id];
    if (config?.subTypes?.[subType]) {
        return config.subTypes[subType];
    }
    // 不认识的类型：首字母大写
    return subType ? subType.charAt(0).toUpperCase() + subType.slice(1) : ovText('Item', 'Предмет');
}

/**
 * 从物品数据中提取增强字段的值
 * 
 * @param {object} itemData - 物品数据（包含 systemData）
 * @param {string} [systemId] - 系统 ID
 * @returns {Array<{label, icon, value, suffix}>} 有值的字段列表
 */
export function extractSystemFieldValues(itemData, systemId = null) {
    const fields = getSystemFields(systemId);
    if (!fields.length || !itemData?.systemData) return [];

    const results = [];
    for (const field of fields) {
        // 从 systemData 中读取值（去掉 'system.' 前缀，因为 systemData 已经是 system 下的内容）
        const fieldPath = field.key.replace(/^system\./, '');
        const value = foundry.utils.getProperty(itemData.systemData, fieldPath);

        // 跳过空值
        if (value === undefined || value === null || value === '' || value === 0) continue;

        // 格式化
        let displayValue = value;
        switch (field.format) {
            case 'capitalize':
                displayValue = String(value).charAt(0).toUpperCase() + String(value).slice(1);
                break;
            case 'number':
                displayValue = Number(value).toLocaleString();
                break;
            case 'boolean':
                displayValue = value ? '✓' : '✗';
                break;
        }

        // 合并后缀（比如 'lbs', 'gp'）
        if (field.suffix) {
            displayValue = `${displayValue} ${field.suffix}`;
        }

        results.push({
            label: field.label,
            icon: field.icon,
            value: displayValue
        });
    }

    return results;
}

/**
 * 检查当前系统是否有增强配置
 * 
 * @param {string} [systemId] - 系统 ID
 * @returns {boolean}
 */
export function isSystemSupported(systemId = null) {
    const id = systemId || game.system?.id;
    return !!SYSTEM_CONFIGS[id];
}
