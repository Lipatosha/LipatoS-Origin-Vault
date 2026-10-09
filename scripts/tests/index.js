/**
 * Origin Vault - 控制台集成测试入口
 * 在 Foundry 控制台里执行：
 *   ovRunTests()
 *   ovRunCoreTests()
 *   ovRunLibraryTests()
 */

import { MODULE_ID } from '../constants.js';
import { LibraryData } from '../data/LibraryData.js';
import { LibraryManager } from '../data/LibraryManager.js';
import { MainWindow } from '../ui/MainWindow.js';
import { runCoreTests } from './core.test.js';
import { runLibraryManagerTests } from './library-manager.test.js';
import { combineSummaries } from './TestRunner.js';

const DEFAULT_SUITES = ['core', 'library'];

function wait(ms = 0) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export async function waitFor(predicate, options = {}) {
    const timeout = options.timeout ?? 10000;
    const interval = options.interval ?? 50;
    const label = options.label || '条件';
    const start = Date.now();

    while ((Date.now() - start) < timeout) {
        if (await predicate()) return true;
        await wait(interval);
    }

    throw new Error(`${label} 超时 (${timeout}ms)`);
}

function normalizeSuites(suites) {
    if (!Array.isArray(suites) || suites.length === 0) return [...DEFAULT_SUITES];

    const normalized = suites
        .map(suite => String(suite || '').trim().toLowerCase())
        .filter(Boolean);

    const aliases = {
        all: DEFAULT_SUITES,
        core: ['core'],
        ui: ['core'],
        library: ['library'],
        libraries: ['library']
    };

    const expanded = normalized.flatMap(suite => aliases[suite] || []);
    return [...new Set(expanded.length ? expanded : DEFAULT_SUITES)];
}

async function ensureLibraryManagerReady() {
    const manager = LibraryManager.getInstance();
    if (!manager._loaded) {
        await manager.load();
    }
    return manager;
}

async function ensureActiveLibrary(manager, options = {}) {
    let activeLibrary = manager.getActiveLibrary();
    if (!activeLibrary) {
        const firstLibrary = manager.getAllLibraries()[0];
        if (firstLibrary) {
            await manager.switchLibrary(firstLibrary.id, { path: firstLibrary.path });
            activeLibrary = manager.getActiveLibrary();
        }
    }

    if (activeLibrary || !options.allowBootstrap) {
        return { activeLibrary, bootstrapped: false };
    }

    const slug = `bootstrap${Date.now().toString(36)}${foundry.utils.randomID().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 4)}`.slice(0, 24);
    const libraryId = await manager.createLibrary('OV Test Bootstrap', slug, {
        description: 'Created automatically for Origin Vault integration tests'
    });
    activeLibrary = manager.getLibrary(libraryId);
    await manager.switchLibrary(activeLibrary.id, { path: activeLibrary.path });
    return { activeLibrary, bootstrapped: true };
}

async function ensureAppReady(options = {}) {
    const manager = await ensureLibraryManagerReady();
    const { activeLibrary, bootstrapped } = await ensureActiveLibrary(manager, options);

    if (!activeLibrary) {
        throw new Error('当前世界还没有资源库。请先手动创建一个，或执行 ovRunTests({ allowBootstrap: true })。');
    }

    const libraryData = LibraryData.getInstance();
    libraryData.setLibraryPath(activeLibrary.path);
    if (!libraryData.loaded || libraryData.basePath !== activeLibrary.path) {
        await libraryData.load();
    }

    let app = MainWindow.getInstance();
    if (options.openWindow !== false) {
        MainWindow.open();
        app = MainWindow.getInstance();
        await waitFor(() => app.rendered && !!app.element, { label: 'Origin Vault 窗口渲染' });
        await app.render(true);
        await wait(0);
    }

    return { app, manager, libraryData, activeLibrary, bootstrapped };
}

export async function runIntegrationTests(options = {}) {
    const suites = normalizeSuites(options.suites);
    const needsWindow = suites.includes('core');
    const context = await ensureAppReady({
        openWindow: needsWindow,
        allowBootstrap: !!options.allowBootstrap
    });

    const summaries = [];

    if (suites.includes('library')) {
        summaries.push(await runLibraryManagerTests(context, { waitFor }));
    }

    if (suites.includes('core')) {
        summaries.push(await runCoreTests(context.app));
    }

    const merged = combineSummaries(summaries);
    console.log(`${MODULE_ID} | Test suites complete: ${suites.join(', ')} (${merged.pass}/${merged.total} passed)`);
    if (context.bootstrapped) {
        console.warn(`${MODULE_ID} | Test bootstrap library was created because this world had no existing library.`);
    }
    return { ...merged, suites, bootstrapped: context.bootstrapped };
}

export async function runCoreIntegrationTests(options = {}) {
    return runIntegrationTests({ ...options, suites: ['core'] });
}

export async function runLibraryIntegrationTests(options = {}) {
    return runIntegrationTests({ ...options, suites: ['library'] });
}
