/**
 * Origin Vault - 资源库管理集成测试
 * 重点覆盖资源库 ID、创建、切换、清理这些高风险链路
 */

import { MODULE_ID, DEFAULT_DATA_PATH } from '../constants.js';
import { LibraryData } from '../data/LibraryData.js';
import { directoryExistsWithFilePicker } from '../utils/filePicker.js';
import { t } from '../utils/i18n.js';
import { TestRunner, assert } from './TestRunner.js';

function makeTestSlug(prefix = 'ovtest') {
    const ts = Date.now().toString(36);
    const rand = foundry.utils.randomID().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6);
    return `${prefix}${ts}${rand}`.slice(0, 24);
}

export async function runLibraryManagerTests(context, options = {}) {
    const runner = new TestRunner();
    const manager = context?.manager;
    const waitFor = options.waitFor;
    const libraryData = context?.libraryData || LibraryData.getInstance();
    const baselineLibrary = context?.activeLibrary || manager?.getActiveLibrary();
    const missingSlug = makeTestSlug('probe');
    const testSlug = makeTestSlug('lib');
    const expectedId = `lib_${testSlug}`;
    let createdLibrary = null;

    if (!manager) {
        throw new Error('缺少 LibraryManager 测试上下文');
    }

    if (!baselineLibrary) {
        throw new Error('当前没有可回退的基础资源库，无法安全运行资源库集成测试');
    }

    runner.group('资源库管理');

    await runner.run('非法 slug 应被拒绝', async () => {
        await assert.rejects(
            () => manager.createLibrary('OV Invalid Slug', 'bad-slug'),
            t('origin-vault.errors.invalidLibraryId')
        );
    });

    await runner.run('随机不存在路径不应被识别为已存在', async () => {
        const missingPath = `${DEFAULT_DATA_PATH}/${game.world.id}/lib_${missingSlug}`;
        const exists = await directoryExistsWithFilePicker('data', missingPath);
        assert.equal(exists, false, `不存在路径被误判为已存在: ${missingPath}`);
    });

    await runner.run('createLibrary 应创建新的世界资源库', async () => {
        const libraryId = await manager.createLibrary('OV Integration Test Library', testSlug, {
            description: 'Console integration test library'
        });

        assert.equal(libraryId, expectedId, '返回的资源库 ID 不正确');

        createdLibrary = manager.getLibrary(libraryId);
        assert.ok(createdLibrary, '创建后应该能从注册表取到资源库');
        assert.equal(createdLibrary.path, `${DEFAULT_DATA_PATH}/${game.world.id}/${libraryId}`, '资源库路径不正确');

        const exists = await directoryExistsWithFilePicker('data', createdLibrary.path);
        assert.equal(exists, true, '刚创建的资源库目录应该能被探测到');
    });

    await runner.run('重复 slug 应报已存在', async () => {
        await assert.rejects(
            () => manager.createLibrary('OV Integration Test Library Duplicate', testSlug),
            t('origin-vault.errors.libraryIdExists')
        );
    });

    await runner.run('switchLibrary 应同步切换活动资源库和 LibraryData', async () => {
        assert.ok(createdLibrary, '前置条件失败：测试资源库尚未创建');

        const switched = await manager.switchLibrary(createdLibrary.id, { path: createdLibrary.path });
        assert.ok(switched, 'switchLibrary 应返回 true');

        await waitFor(() => {
            const active = manager.getActiveLibrary();
            return active?.id === createdLibrary.id
                && active?.path === createdLibrary.path
                && libraryData.basePath === createdLibrary.path
                && libraryData.loaded;
        }, { label: '资源库切换同步' });
    });

    await runner.run('renameLibrary 应更新资源库名称', async () => {
        assert.ok(createdLibrary, '前置条件失败：测试资源库尚未创建');

        const renamed = 'OV Integration Test Library Renamed';
        const ok = await manager.renameLibrary(createdLibrary.id, renamed, { path: createdLibrary.path });
        assert.ok(ok, 'renameLibrary 应返回 true');

        createdLibrary = manager.getLibrary(createdLibrary.id, { path: createdLibrary.path });
        assert.equal(createdLibrary?.name, renamed, '资源库名称没有更新');
    });

    await runner.run('deleteLibrary 应清理临时资源库并回到原库', async () => {
        assert.ok(createdLibrary, '前置条件失败：测试资源库尚未创建');

        const restored = await manager.switchLibrary(baselineLibrary.id, { path: baselineLibrary.path });
        assert.ok(restored, '删除前应该先切回基础资源库');

        const removed = await manager.deleteLibrary(createdLibrary.id, { path: createdLibrary.path });
        assert.ok(removed, 'deleteLibrary 应返回 true');
        assert.ok(!manager.getLibrary(createdLibrary.id, { path: createdLibrary.path }), '删除后不应再能取到测试资源库');

        createdLibrary = null;
    });

    try {
        if (createdLibrary) {
            try {
                const active = manager.getActiveLibrary();
                if (active?.id === createdLibrary.id && active?.path === createdLibrary.path) {
                    await manager.switchLibrary(baselineLibrary.id, { path: baselineLibrary.path });
                }
                await manager.deleteLibrary(createdLibrary.id, { path: createdLibrary.path });
            } catch (cleanupError) {
                console.warn(`${MODULE_ID} | Library test cleanup failed:`, cleanupError);
            }
        }

        const active = manager.getActiveLibrary();
        if (!active || active.id !== baselineLibrary.id || active.path !== baselineLibrary.path) {
            await manager.switchLibrary(baselineLibrary.id, { path: baselineLibrary.path });
        }
        libraryData.setLibraryPath(baselineLibrary.path);
        await libraryData.load();
    } catch (restoreError) {
        console.warn(`${MODULE_ID} | Library test restore failed:`, restoreError);
    }

    return runner.summary();
}
