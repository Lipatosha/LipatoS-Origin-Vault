/**
 * Origin Vault - 导入导出管理器
 * 负责素材库数据的导入和导出
 */

import { MODULE_ID, EVENTS, STORAGE, OV_LAYERS } from '../constants.js';
import { LibraryData } from './LibraryData.js';
import { LibraryManager } from './LibraryManager.js';
import { AssetData } from './AssetData.js';
import { t, tf } from '../utils/i18n.js';
import { appendToOverlayHost } from '../utils/overlayHost.js';

export class ExportImportManager {




    /**
     * 导出当前素材库数据为 JSON 文件
     * @returns {Promise<void>}
     */
    static async exportLibrary() {
        const library = LibraryData.getInstance();

        if (!library.loaded) {
            ui.notifications.warn(t('origin-vault.notifications.libraryNotLoaded'));
            return;
        }

        const exportData = {
            version: '1.0.0',
            exportDate: new Date().toISOString(),
            moduleId: MODULE_ID,
            data: {
                folders: library.data.folders,
                items: library.data.items,
                tags: library.data.tags,
                smartFolders: library.data.smartFolders,
                settings: library.data.settings
            },
            stats: {
                folderCount: Object.keys(library.data.folders).length,
                itemCount: Object.keys(library.data.items).length,
                tagCount: Object.keys(library.data.tags).length
            }
        };

        // 使用紧凑格式减小文件大小（大型库可减少 40-50%）
        const jsonStr = JSON.stringify(exportData);
        const now = new Date();
        const dateStr = now.toISOString().split('T')[0];
        const timeStr = now.toTimeString().slice(0, 8).replace(/:/g, '-');
        const filename = `origin-vault-export-${dateStr}_${timeStr}.json`;

        // 使用 Foundry 的 saveDataToFile 方法，兼容 Electron 环境
        saveDataToFile(jsonStr, 'application/json', filename);

        ui.notifications.info(tf('origin-vault.notifications.exportSuccess', { count: exportData.stats.itemCount }));
    }

    /**
     * 从文件选择器导入素材库数据
     * @returns {Promise<void>}
     */
    static async importLibrary() {
        return new Promise((resolve) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json';

            input.onchange = async (e) => {
                const file = e.target.files[0];
                if (!file) {
                    resolve();
                    return;
                }

                try {
                    const text = await file.text();
                    const importData = JSON.parse(text);

                    // 验证导入数据
                    if (!this._validateImportData(importData)) {
                        ui.notifications.error(t('origin-vault.notifications.invalidImportFormat'));
                        resolve();
                        return;
                    }

                    // 显示确认对话框
                    const confirmed = await this._showImportConfirmDialog(importData);
                    if (!confirmed) {
                        resolve();
                        return;
                    }

                    // 执行导入
                    await this._performImport(importData, confirmed.mode);

                    ui.notifications.info(t('origin-vault.notifications.importSuccess'));
                    Hooks.callAll(EVENTS.LIBRARY_LOADED);

                } catch (error) {
                    console.error(`${MODULE_ID} | Import failed:`, error);
                    ui.notifications.error(tf('origin-vault.notifications.importFailed', { message: error.message }));
                }

                resolve();
            };

            input.click();
        });
    }

    /**
     * 验证导入数据格式
     * @param {object} data 
     * @returns {boolean}
     */
    static _validateImportData(data) {
        if (!data || typeof data !== 'object') return false;
        if (!data.moduleId || data.moduleId !== MODULE_ID) return false;
        if (!data.data || !data.data.items) return false;
        return true;
    }

    /**
     * 显示导入确认对话框
     * @param {object} importData 
     * @returns {Promise<object|null>}
     */
    static async _showImportConfirmDialog(importData) {
        const stats = importData.stats || {
            folderCount: Object.keys(importData.data.folders || {}).length,
            itemCount: Object.keys(importData.data.items || {}).length,
            tagCount: Object.keys(importData.data.tags || {}).length
        };

        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'ov-dialog-overlay';

            overlay.innerHTML = `
                <div class="ov-dialog" style="width: 400px;">
                    <div class="ov-dialog-header">
                        <h3>${t('origin-vault.toolbar.importLibrary')}</h3>
                        <button class="ov-dialog-close"><i class="fas fa-times"></i></button>
                    </div>
                    <div class="ov-dialog-content">
                        <p style="margin-bottom: 15px;">${t('origin-vault.import.previewTitle')}</p>
                        <div style="background: rgba(0,0,0,0.2); padding: 12px; border-radius: 6px; margin-bottom: 15px;">
                            <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
                                <span>${tf('origin-vault.import.folders', { count: stats.folderCount })}</span>
                            </div>
                            <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
                                <span>${tf('origin-vault.import.items', { count: stats.itemCount })}</span>
                            </div>
                            <div style="display: flex; justify-content: space-between;">
                                <span>${tf('origin-vault.import.tags', { count: stats.tagCount })}</span>
                            </div>
                        </div>
                    </div>
                    <div class="ov-dialog-footer">
                        <button class="ov-btn ov-btn-secondary" data-action="cancel">
                            <i class="fas fa-times"></i> ${t('origin-vault.ui.cancel')}
                        </button>
                        <button class="ov-btn ov-btn-primary" data-action="import">
                            <i class="fas fa-file-import"></i> ${t('origin-vault.ui.import')}
                        </button>
                    </div>
                </div>
            `;

            appendToOverlayHost(overlay);

            const close = (result) => {
                overlay.remove();
                resolve(result);
            };

            overlay.querySelector('.ov-dialog-close').addEventListener('click', () => close(null));
            overlay.querySelector('[data-action="cancel"]').addEventListener('click', () => close(null));
            overlay.querySelector('[data-action="import"]').addEventListener('click', () => {
                close({ mode: 'merge' });
            });
            overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
        });
    }

    /**
     * 执行导入操作（带进度对话框）
     * @param {object} importData 
     * @param {string} mode - 'merge' 或 'replace'
     */
    static async _performImport(importData, mode) {
        const library = LibraryData.getInstance();
        const libraryManager = game.modules.get(MODULE_ID).api.getLibraryManager();
        const activeLib = libraryManager.getActiveLibrary();

        // 核心修复：导入前必须确保 library 实例的 basePath 已经对齐到当前活跃库
        if (activeLib && activeLib.path) {
            library.setLibraryPath(activeLib.path);
        } else {
            throw new Error(t('origin-vault.notifications.libraryNotLoaded'));
        }

        // 再次加载确保基准数据正确
        await library.load();

        // 计算总数用于进度显示
        const sourceData = importData.data || importData;
        const totalItems = Object.keys(sourceData.items || {}).length;

        // 创建进度对话框
        const progressDialog = await this._createImportProgressDialog(totalItems);

        try {
            // 调用 LibraryData 中的并发导入方法，传入进度回调
            const stats = await library.importData(importData, mode === 'merge', (current, total, phase) => {
                this._updateImportProgress(progressDialog, current, total, phase);
            });

            // 缩略图不需要重新生成：导入元数据保留了原始 thumbnail 路径，
            // 缓存文件仍在原始库的 _cache/ 目录下，直接复用即可



            return stats;
        } finally {
            // 确保进度对话框关闭
            if (progressDialog) {
                progressDialog.remove();
            }
        }
    }

    /**
     * 创建导入进度对话框
     * @param {number} totalItems - 预计总数
     * @returns {Promise<Dialog>}
     */
    static async _createImportProgressDialog(totalItems) {
        const overlay = document.createElement('div');
        overlay.className = 'ov-dialog-overlay';
        overlay.style.zIndex = String(OV_LAYERS.NESTED_DIALOG);

        overlay.innerHTML = `
            <div class="ov-dialog" style="width: 380px;">
                <div class="ov-dialog-header">
                    <h3>${t('origin-vault.toolbar.importLibrary') || 'Importing Library'}</h3>
                </div>
                <div class="ov-dialog-content" style="text-align: center; padding: 20px;">
                    <i class="fas fa-circle-notch fa-spin fa-3x" style="margin-bottom: 20px; color: var(--ov-accent, #7c3aed);"></i>
                    <p id="ov-import-progress-msg" style="font-size: 14px; margin-bottom: 10px; color: var(--ov-text-primary, #eee);">
                        ${t('origin-vault.notifications.preparing') || 'Preparing...'}
                    </p>
                    <div style="width: 100%; height: 6px; background: rgba(0,0,0,0.3); border-radius: 3px; overflow: hidden;">
                        <div id="ov-import-progress-bar" style="width: 0%; height: 100%; background: var(--ov-accent, #7c3aed); transition: width 0.15s;"></div>
                    </div>
                    <p id="ov-import-progress-detail" style="font-size: 12px; margin-top: 8px; color: var(--ov-text-secondary, #999);">
                        0 / ${totalItems}
                    </p>
                </div>
            </div>
        `;

        appendToOverlayHost(overlay);
        return overlay;
    }

    /**
     * 更新导入进度对话框
     * @param {Dialog} dialog 
     * @param {number} current 
     * @param {number} total 
     * @param {string} phase - 'folders' | 'items'
     */
    static _updateImportProgress(overlay, current, total, phase) {
        if (!overlay) return;

        const pct = total > 0 ? Math.round((current / total) * 100) : 0;
        const phaseLabel = phase === 'folders'
            ? (t('origin-vault.import.phaseFolders') || 'Processing folders...')
            : (t('origin-vault.import.phaseItems') || 'Importing assets...');

        const msgEl = overlay.querySelector('#ov-import-progress-msg');
        const barEl = overlay.querySelector('#ov-import-progress-bar');
        const detailEl = overlay.querySelector('#ov-import-progress-detail');

        if (msgEl) msgEl.textContent = `${phaseLabel} ${pct}%`;
        if (barEl) barEl.style.width = `${pct}%`;
        if (detailEl) detailEl.textContent = `${current} / ${total}`;
    }
}
