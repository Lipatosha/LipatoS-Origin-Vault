/**
 * Origin Vault - 核心集成测试
 * 覆盖最关键的功能路径
 * 
 * 新增测试请参考：G:\FVTT\FVTTdata\Data\GIT\计划\OV集成测试指南.md
 */

import { EVENTS, SPECIAL_FOLDERS } from '../constants.js';
import { WaveformManager } from '../utils/WaveformManager.js';
import { TestRunner, assert } from './TestRunner.js';

/**
 * 运行所有核心测试
 * @param {MainWindow} app - Origin Vault 主窗口实例
 */
export async function runCoreTests(app) {
    const t = new TestRunner();

    // ==================== 数据层测试 ====================
    t.group('数据层 - LibraryData');

    await t.run('library 实例应该存在', () => {
        assert.ok(app.library, 'app.library 应该已初始化');
        assert.typeOf(app.library.getFolder, 'function', 'getFolder 应该是方法');
    });

    await t.run('根文件夹应该存在', () => {
        const root = app.library.getFolder('root');
        assert.ok(root, '根文件夹应该存在');
        assert.ok(Array.isArray(root.children), 'root.children 应该是数组');
    });

    await t.run('创建和删除文件夹', () => {
        const id = app.library.createFolder('root', '__test_folder__');
        assert.ok(id, '应该返回文件夹 ID');
        const folder = app.library.getFolder(id);
        assert.ok(folder, '应该能通过 ID 获取文件夹');
        assert.equal(folder.name, '__test_folder__', '名称应该正确');

        // 清理
        app.library.deleteFolder(id, true);
        assert.ok(!app.library.getFolder(id), '删除后不应该再存在');
    });

    await t.run('重命名文件夹', () => {
        const id = app.library.createFolder('root', '__rename_test__');
        app.library.renameFolder(id, '__renamed__');
        assert.equal(app.library.getFolder(id).name, '__renamed__', '名称应该更新');
        app.library.deleteFolder(id, true);
    });

    await t.run('移动文件夹应该保留同级顺序', () => {
        const folderIds = [];

        try {
            const first = app.library.createFolder('root', '__sort_first__');
            const second = app.library.createFolder('root', '__sort_second__');
            const third = app.library.createFolder('root', '__sort_third__');
            folderIds.push(first, second, third);

            app.library.moveFolder(third, 'root', { beforeId: first });
            let children = app.library.getFolder('root').children;
            assert.ok(children.indexOf(third) < children.indexOf(first), '第三个文件夹应该能插到第一个前面');
            assert.equal(app.library.getFolder(third).sortOrder, children.indexOf(third), 'sortOrder 应该跟 children 顺序一致');

            app.library.moveFolder(first, 'root', { afterId: second });
            children = app.library.getFolder('root').children;
            assert.ok(children.indexOf(first) > children.indexOf(second), '第一个文件夹应该能插到第二个后面');
            assert.equal(app.library.getFolder(first).sortOrder, children.indexOf(first), '重排后 sortOrder 应该同步更新');
        } finally {
            for (const folderId of folderIds) {
                if (app.library.getFolder(folderId)) {
                    app.library.deleteFolder(folderId, true);
                }
            }
        }
    });

    await t.run('获取文件夹内素材列表', () => {
        const items = app.library.getItemsByFolder('root');
        assert.ok(Array.isArray(items), '应该返回数组');
    });

    await t.run('智能文件夹 CRUD 与规则匹配', async () => {
        const cleanup = {
            folders: [],
            smartFolders: [],
            itemId: null,
            tagId: null
        };

        try {
            const suffix = foundry.utils.randomID();
            const parentId = app.library.createFolder('root', `__smart_parent_${suffix}__`);
            const childId = app.library.createFolder(parentId, `__smart_child_${suffix}__`);
            cleanup.folders.push(childId, parentId);

            cleanup.tagId = app.library.createTag(`__smart_tag_${suffix}__`, '#3498db');
            cleanup.itemId = await app.library.addItem(`__test__/smart-folder-${suffix}.ov-scene`, childId, {
                displayName: `__smart_scene_${suffix}__`,
                tags: [cleanup.tagId],
                rating: 5,
                metadata: { type: 'scene' }
            });

            assert.ok(cleanup.itemId, '测试素材应该创建成功');

            const smartId = app.library.createSmartFolder({
                name: `__smart_rule_${suffix}__`,
                match: 'all',
                rules: [
                    { field: 'name', operator: 'contains', value: '__smart_scene_' },
                    { field: 'type', operator: 'equals', value: 'scene' },
                    { field: 'tag', operator: 'has', value: cleanup.tagId },
                    { field: 'folder', operator: 'has', value: parentId, includeSubfolders: true },
                    { field: 'rating', operator: 'gte', value: 4 }
                ]
            });
            cleanup.smartFolders.push(smartId);

            assert.ok(app.library.isSmartFolderId(smartId), '智能文件夹 ID 应该带专用前缀');
            assert.ok(app.library.getSmartFolder(smartId), '应该能取回智能文件夹');

            const matched = app.library.getItemsBySmartFolder(smartId);
            assert.ok(matched.some(item => item.id === cleanup.itemId), '规则应该匹配测试素材');
            assert.equal(app.library.getItemCountByFolder(smartId), matched.length, '智能文件夹计数应该复用同一结果链');

            app.library.updateSmartFolder(smartId, {
                match: 'any',
                rules: [
                    { field: 'name', operator: 'contains', value: '__not_a_real_name__' },
                    { field: 'rating', operator: 'gte', value: 5 }
                ]
            });

            const anyMatched = app.library.getItemsByFolder(smartId);
            assert.ok(anyMatched.some(item => item.id === cleanup.itemId), '任一规则模式应该命中评分条件');

            app.library.deleteSmartFolder(smartId);
            cleanup.smartFolders = cleanup.smartFolders.filter(id => id !== smartId);
            assert.ok(!app.library.getSmartFolder(smartId), '删除后不应该再能取到智能文件夹');
        } finally {
            for (const smartId of cleanup.smartFolders) {
                if (app.library.getSmartFolder(smartId)) app.library.deleteSmartFolder(smartId);
            }
            if (cleanup.itemId && app.library.getItem(cleanup.itemId)) {
                await app.library.removeItem(cleanup.itemId);
            }
            if (cleanup.tagId && app.library.getTag(cleanup.tagId)) {
                await app.library.deleteTag(cleanup.tagId);
            }
            for (const folderId of cleanup.folders) {
                if (app.library.getFolder(folderId)) {
                    app.library.deleteFolder(folderId, true);
                }
            }
        }
    });

    // ==================== UI 渲染测试 ====================
    t.group('UI 渲染');

    await t.run('主窗口 DOM 应该存在', () => {
        assert.ok(app.element, 'app.element 应该存在');
    });

    await t.run('侧边栏应该渲染', () => {
        assert.elementExists('#ov-sidebar', app.element, '侧边栏容器应该存在');
        assert.elementExists('.folder-tree-content', app.element, '文件夹树应该存在');
        assert.elementExists('.smart-folder-tree', app.element, '智能文件夹区块应该存在');
    });

    await t.run('素材网格应该渲染', () => {
        assert.elementExists('.asset-grid', app.element, '素材网格容器应该存在');
    });

    await t.run('状态栏应该渲染', () => {
        assert.elementExists('.status-bar', app.element, '状态栏应该存在');
    });

    // ==================== 交互测试 ====================
    t.group('交互逻辑');

    await t.run('切换文件夹应该更新 currentFolderId', () => {
        const original = app.currentFolderId;
        // 切换到根文件夹
        app._onFolderClick('root');
        assert.equal(app.currentFolderId, 'root', '应该切换到根文件夹');
        // 切回
        if (original !== 'root') {
            app._onFolderClick(original);
        }
    });

    await t.run('创建文件夹后侧边栏应该更新', async () => {
        const id = app.library.createFolder('root', '__ui_test__');
        await app._renderSidebar();
        // 检查 DOM 中有没有这个文件夹
        const el = app.element.querySelector(`.folder-item[data-folder-id="${id}"]`);
        assert.ok(el, '新文件夹应该出现在侧边栏');
        // 清理
        app.library.deleteFolder(id, true);
        await app._renderSidebar();
    });

    await t.run('_buildFolderTree 应该返回数组', () => {
        const folders = app.library.folders || {};
        const tree = app._buildFolderTree('__root__', folders, 0);
        assert.ok(Array.isArray(tree), '应该返回数组');
    });

    // ==================== Mixin 完整性测试 ====================
    t.group('Mixin 完整性');

    const expectedMethods = [
        // SidebarMixin
        '_renderSidebar', '_buildFolderTree', '_updateSidebarSelection', '_setFolderImporting',
        '_onFolderClick', '_onFolderToggle', '_expandParentFolders', '_onFolderDrop',
        '_onRemoveFolder', '_onDeleteFolderWithItems', '_createInlineFolder', '_startInlineRename',
        '_onCreateSmartFolder', '_openSmartFolderDialog', '_onSmartFolderContextMenu',
        // ContextMenuMixin
        '_onFolderContextMenu', '_showEnhancedContextMenu', '_onItemContextMenu',
        // VirtualScrollMixin
        '_initVirtualScroll', '_onVirtualScroll',
        // DragDropMixin
        '_initMarqueeSelect',
        // DialogMixin
        '_showConfirmDialog',
    ];

    await t.run('所有 Mixin 方法应该已挂载', () => {
        const missing = expectedMethods.filter(m => typeof app[m] !== 'function');
        if (missing.length > 0) {
            throw new Error(`缺失方法: ${missing.join(', ')}`);
        }
    });

    // ==================== folderIndex 索引测试 ====================
    t.group('folderIndex 反向索引');

    await t.run('_folderIndex 应该存在且为 Map', () => {
        assert.ok(app.library._folderIndex instanceof Map, '_folderIndex 应该是 Map');
    });

    await t.run('getAllDescendantFolders 应该返回 Set', () => {
        const result = app.library.getAllDescendantFolders('root');
        assert.ok(result instanceof Set, '应该返回 Set 而不是 Array');
    });

    await t.run('getItemCountByFolder 应该与 getItemsByFolder.length 一致', () => {
        const count = app.library.getItemCountByFolder('root');
        const items = app.library.getItemsByFolder('root');
        assert.equal(count, items.length, `计数不一致: getItemCountByFolder=${count}, getItemsByFolder.length=${items.length}`);
    });

    await t.run('folderIndex 与 itemsCache 一致性校验', () => {
        // 正向验证：itemsCache 中每个素材的 folders 都在 _folderIndex 中
        let mismatches = 0;
        for (const [itemId, item] of app.library.itemsCache) {
            for (const fid of item.folders) {
                const indexSet = app.library._folderIndex.get(fid);
                if (!indexSet || !indexSet.has(itemId)) {
                    mismatches++;
                }
            }
        }
        assert.equal(mismatches, 0, `正向校验: ${mismatches} 个素材-文件夹关系在索引中缺失`);

        // 反向验证：_folderIndex 中的每个引用都在 itemsCache 中存在
        let phantoms = 0;
        for (const [fid, itemIds] of app.library._folderIndex) {
            for (const id of itemIds) {
                if (!app.library.itemsCache.has(id)) {
                    phantoms++;
                }
            }
        }
        assert.equal(phantoms, 0, `反向校验: ${phantoms} 个幽灵引用在索引中残留`);
    });

    // ==================== 素材变更后索引同步测试 ====================
    t.group('folderIndex 变更同步');

    // 创建测试文件夹
    let testFolderA, testFolderB;

    await t.run('addItem 后索引应该更新', async () => {
        testFolderA = app.library.createFolder('root', '__idx_test_A__');
        testFolderB = app.library.createFolder('root', '__idx_test_B__');

        // 添加一个测试素材到 testFolderA
        const itemId = await app.library.addItem('__test__/idx_test_asset.png', testFolderA);
        assert.ok(itemId, 'addItem 应该返回 ID');

        // 验证索引
        const indexSet = app.library._folderIndex.get(testFolderA);
        assert.ok(indexSet, `文件夹 ${testFolderA} 应该在索引中`);
        assert.ok(indexSet.has(itemId), '素材应该在文件夹索引中');

        // 通过 getItemsByFolder 验证
        const items = app.library.getItemsByFolder(testFolderA);
        assert.ok(items.some(i => i.id === itemId), 'getItemsByFolder 应该包含新素材');
    });

    await t.run('copyItemToFolder 后索引应该更新', async () => {
        const items = app.library.getItemsByFolder(testFolderA);
        if (items.length === 0) throw new Error('前置条件失败：testFolderA 中没有素材');

        const itemId = items[0].id;
        await app.library.copyItemToFolder(itemId, testFolderB);

        // 验证两个文件夹的索引都包含该素材
        const setA = app.library._folderIndex.get(testFolderA);
        const setB = app.library._folderIndex.get(testFolderB);
        assert.ok(setA && setA.has(itemId), '原文件夹索引应该保留');
        assert.ok(setB && setB.has(itemId), '目标文件夹索引应该包含');
    });

    await t.run('moveItem 后索引应该更新', async () => {
        const items = app.library.getItemsByFolder(testFolderA);
        if (items.length === 0) throw new Error('前置条件失败：testFolderA 中没有素材');

        const itemId = items[0].id;
        await app.library.moveItem(itemId, testFolderA, testFolderB);

        // A 中不应该有，B 中应该有
        const setA = app.library._folderIndex.get(testFolderA);
        const setB = app.library._folderIndex.get(testFolderB);
        assert.ok(!setA || !setA.has(itemId), '原文件夹索引应该已移除');
        assert.ok(setB && setB.has(itemId), '目标文件夹索引应该包含');
    });

    await t.run('removeItemFromFolder 后索引应该更新', async () => {
        const items = app.library.getItemsByFolder(testFolderB);
        if (items.length === 0) throw new Error('前置条件失败：testFolderB 中没有素材');

        const itemId = items[0].id;
        await app.library.removeItemFromFolder(itemId, testFolderB);

        // B 中不应该有
        const setB = app.library._folderIndex.get(testFolderB);
        assert.ok(!setB || !setB.has(itemId), '文件夹索引应该已移除');

        // 素材的 folders 应该为空（不再 fallback 到 root）
        const item = app.library.getItem(itemId);
        assert.equal(item.folders.length, 0, '素材文件夹列表应该为空');
    });

    await t.run('removeItem 后索引应该清理', async () => {
        // 获取 root 中我们的测试素材
        const item = app.library.getItemByPath('__test__/idx_test_asset.png');
        if (!item) throw new Error('前置条件失败：测试素材不存在');

        const itemId = item.id;
        const folders = [...item.folders]; // 备份

        await app.library.removeItem(itemId);

        // 所有相关文件夹索引都不应该有
        for (const fid of folders) {
            const set = app.library._folderIndex.get(fid);
            assert.ok(!set || !set.has(itemId), `文件夹 ${fid} 索引应该已清理`);
        }
    });

    await t.run('deleteFolder 后索引和文件夹应该清理', () => {
        // 清理测试文件夹
        app.library.deleteFolder(testFolderA, true);
        app.library.deleteFolder(testFolderB, true);

        assert.ok(!app.library._folderIndex.has(testFolderA), '删除的文件夹 A 不应该在索引中');
        assert.ok(!app.library._folderIndex.has(testFolderB), '删除的文件夹 B 不应该在索引中');
        assert.ok(!app.library.getFolder(testFolderA), '文件夹 A 应该已删除');
        assert.ok(!app.library.getFolder(testFolderB), '文件夹 B 应该已删除');
    });

    // ==================== 渲染缓存测试 ====================
    t.group('渲染缓存');

    await t.run('_sortedItemsCache 应该存在', () => {
        // 触发一次 _prepareContext 以填充缓存
        assert.ok('_sortedItemsCache' in app, '_sortedItemsCache 字段应该存在');
        assert.ok('_sortedItemsCacheKey' in app, '_sortedItemsCacheKey 字段应该存在');
    });

    await t.run('切换文件夹后缓存 key 应该变化', async () => {
        const original = app.currentFolderId;
        let tempFolderId = null;

        try {
            // 先跑一遍，让 currentFolderId 经过和正式渲染一致的可见性规范化
            await app._prepareContext();
            const normalizedOriginal = app.currentFolderId;
            const key1 = app._sortedItemsCacheKey;

            let targetFolderId;
            if (normalizedOriginal === SPECIAL_FOLDERS.ALL) {
                const folders = app.library.getAllFolders();
                targetFolderId = Object.keys(folders).find(id => id !== SPECIAL_FOLDERS.ROOT);

                if (!targetFolderId) {
                    tempFolderId = app.library.createFolder(SPECIAL_FOLDERS.ROOT, '__cache_key_test__');
                    targetFolderId = tempFolderId;
                }
            } else {
                targetFolderId = SPECIAL_FOLDERS.ALL;
            }

            app.currentFolderId = targetFolderId;
            await app._prepareContext();
            const key2 = app._sortedItemsCacheKey;

            assert.ok(key1 !== key2, `缓存 key 应该变化: '${key1}' vs '${key2}'`);
        } finally {
            app.currentFolderId = original;
            if (tempFolderId) {
                app.library.deleteFolder(tempFolderId, true);
            }
        }
    });


    // ==================== 万级库性能回归测试 ====================
    t.group('万级库性能回归');

    await t.run('usage 模式更新内存但不广播 ITEM_UPDATED', async () => {
        const library = app.library;
        const itemId = await library.addItem('__test__/usage-mode.png', SPECIAL_FOLDERS.ROOT, {
            displayName: '__usage_mode__'
        });
        const item = library.getItem(itemId);
        const oldSaveAssetMetadata = library._saveAssetMetadata;
        let itemUpdatedCount = 0;
        const listener = updated => {
            if (updated?.id === itemId) itemUpdatedCount++;
        };

        try {
            library._saveAssetMetadata = async () => true;
            Hooks.on(EVENTS.ITEM_UPDATED, listener);

            const lastUsed = new Date().toISOString();
            await library.updateItem(itemId, {
                lastUsed,
                useCount: (item.useCount || 0) + 1
            }, { mode: 'usage' });

            assert.equal(item.lastUsed, lastUsed, 'usage 模式应该立即更新内存 lastUsed');
            assert.equal(item.useCount, 1, 'usage 模式应该立即更新内存 useCount');
            assert.equal(itemUpdatedCount, 0, 'usage 模式不应该广播 ITEM_UPDATED');
            assert.ok(library._usageDirtyItemIds?.has(itemId), 'usage 模式应该进入延迟持久化队列');
        } finally {
            Hooks.off(EVENTS.ITEM_UPDATED, listener);
            library._saveAssetMetadata = oldSaveAssetMetadata;
            if (library._usageSaveTimeout) {
                clearTimeout(library._usageSaveTimeout);
                library._usageSaveTimeout = null;
            }
            if (library._usageDirtyItemIds) library._usageDirtyItemIds.delete(itemId);
            await library.removeItem(itemId);
        }
    });

    await t.run('flushPendingPersistence 应该清空 usage 队列', async () => {
        const library = app.library;
        const itemId = await library.addItem('__test__/usage-flush.png', SPECIAL_FOLDERS.ROOT, {
            displayName: '__usage_flush__'
        });
        const oldSaveAssetMetadata = library._saveAssetMetadata;
        const oldQueueCatalogSave = library._queueCatalogSave;

        try {
            library._saveAssetMetadata = async () => true;
            library._queueCatalogSave = async () => true;

            await library.updateItem(itemId, {
                lastUsed: new Date().toISOString(),
                useCount: 1
            }, { mode: 'usage' });

            assert.ok(library._usageDirtyItemIds?.has(itemId), 'flush 前应该有待写 usage');
            await library.flushPendingPersistence();
            assert.equal(library._usageDirtyItemIds.size, 0, 'flush 后 usage 队列应该清空');
        } finally {
            library._saveAssetMetadata = oldSaveAssetMetadata;
            library._queueCatalogSave = oldQueueCatalogSave;
            if (library._usageSaveTimeout) {
                clearTimeout(library._usageSaveTimeout);
                library._usageSaveTimeout = null;
            }
            if (library._usageDirtyItemIds) library._usageDirtyItemIds.delete(itemId);
            await library.removeItem(itemId);
        }
    });

    await t.run('_getVisibleItems 应该与线性扫描结果一致', () => {
        const oldItems = app.allItems;
        const oldPositions = app.itemPositions;
        const oldTotalHeight = app.virtualTotalHeight;
        const oldBuffer = app.virtualBuffer;
        const oldPositionsByTop = app._positionsByTop;

        try {
            app.virtualBuffer = 10;
            app.allItems = Array.from({ length: 80 }, (_, index) => ({
                id: `__visible_${index}__`,
                path: `__test__/visible-${index}.png`,
                displayName: `visible-${index}`,
                aspectRatio: index % 3 === 0 ? 1.6 : 1
            }));

            app._calculateItemPositions(app.allItems, 640, 120, 8);

            const scrollTop = 360;
            const viewportHeight = 420;
            const minTop = scrollTop - app.virtualBuffer;
            const maxTop = scrollTop + viewportHeight + app.virtualBuffer;
            const expectedIds = app.allItems
                .filter(item => {
                    const pos = app.itemPositions.get(item.id);
                    return pos && pos.top + pos.height >= minTop && pos.top <= maxTop;
                })
                .map(item => item.id);
            const actualIds = app._getVisibleItems(scrollTop, viewportHeight).map(item => item.id);

            assert.equal(actualIds.join(','), expectedIds.join(','), '二分可见项结果应该和线性扫描一致');
        } finally {
            app.allItems = oldItems;
            app.itemPositions = oldPositions;
            app.virtualTotalHeight = oldTotalHeight;
            app.virtualBuffer = oldBuffer;
            app._positionsByTop = oldPositionsByTop;
        }
    });

    await t.run('WaveformManager 缓存应该按 LRU 限制在 100 条', () => {
        const manager = WaveformManager.getInstance();
        const oldCache = manager.cache;

        try {
            manager.cache = new Map();
            for (let i = 0; i < 105; i++) {
                manager._rememberWaveform(`__wave_${i}__`, { waveform: [i], duration: i });
            }

            assert.equal(manager.cache.size, 100, '波形缓存不应该超过 100 条');
            assert.ok(!manager.cache.has('__wave_0__'), '最旧的波形缓存应该被淘汰');

            manager._rememberWaveform('__wave_5__', manager.cache.get('__wave_5__'));
            manager._rememberWaveform('__wave_new__', { waveform: [], duration: 0 });

            assert.ok(manager.cache.has('__wave_5__'), '命中的缓存刷新后不应该被下一次写入淘汰');
        } finally {
            manager.cache = oldCache;
        }
    });

    // ==================== 汇总 ====================
    return t.summary();
}
