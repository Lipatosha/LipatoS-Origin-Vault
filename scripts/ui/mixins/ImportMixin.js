import { ovText } from '../../utils/locale.js';
/**
 * ImportMixin - 素材导入与上传
 * 从 MainWindow 提取的文件导入、缩略图生成、拖放上传相关方法
 * 
 * 包含：批量导入、后台缩略图、进度条、拖放处理、文件校验
 * 混入后通过 this 访问 MainWindow 实例状态
 */

import { MODULE_ID, FILE_TYPES, SPECIAL_FOLDERS } from '../../constants.js';
import { AUDIO_WAVEFORM_THUMBNAIL_VERSION, ThumbnailManager } from '../../utils/ThumbnailManager.js';
import { ImportFloater } from '../ImportFloater.js';
import { browseFilePicker } from '../../utils/filePicker.js';
import { t, tf } from '../../utils/i18n.js';
import { ovLog } from '../../utils/logger.js';

/**
 * 将方法混入目标类
 * @param {Function} cls - 目标类 (MainWindow)
 */
export function applyImportMixin(cls) {
  /**
   * 批量添加文件到库 (使用批量导入优化)
   */
  cls.prototype._addFilesToLibrary = async function (paths, targetFolderId) {
    if (!targetFolderId) {
      targetFolderId = this.currentFolderId.startsWith('__')
        ? SPECIAL_FOLDERS.ROOT
        : this.currentFolderId;
    }

    const items = paths.map(path => ({ path, folderId: targetFolderId }));
    const result = await this.library.addItems(items);

    if (result.added > 0 || result.linked > 0) {
      const totalAffected = result.added + (result.linked || 0);
      ui.notifications.info(tf('origin-vault.items.addedToLibrary', { count: totalAffected }));

      // addItems 跳过 per-item hooks，需手动生成缩略图
      const addedItems = [];
      for (const p of paths) {
        const item = this.library.getItemByPath(p);
        if (item && !item.thumbnailGenerated) addedItems.push(item);
      }
      ovLog(`${MODULE_ID} | _addFilesToLibrary: added = ${result.added}, linked = ${result.linked}, needThumbnail = ${addedItems.length} `);

      this._refreshViewAfterUpdate(targetFolderId);

      // 启动后台缩略图生成（不 await）
      if (addedItems.length > 0) {
        this._startBackgroundThumbnails(addedItems, targetFolderId);
      }
    }
  };

  /**
   * 启动后台缩略图生成任务
   * 不阻塞 UI，关闭 OV 窗口后悬浮窗会接管进度显示
   * @param {object[]} items - 需要生成缩略图的素材列表
   * @param {string} targetFolderId - 导入目标文件夹
   */
  cls.prototype._startBackgroundThumbnails = function (items, targetFolderId) {
    const label = game.i18n?.localize('origin-vault.notifications.generatingThumbnails') || ovText('Generating thumbnails...', 'Создание миниатюр…');

    // 注册后台任务
    this._backgroundTask = {
      type: 'thumbnail',
      label,
      total: items.length,
      completed: 0,
      targetFolderId
    };

    // 在侧边栏为目标文件夹添加导入中动画
    this._setFolderImporting(targetFolderId, true);

    // 立即显示底部进度条（0%）
    this._showBottomProgressBar(0, items.length, label);

    const thumbnailManager = ThumbnailManager.getInstance();

    // 启动后台生成（不 await）
    thumbnailManager.generateBatch(items, (current, total) => {
      // 更新任务状态
      if (this._backgroundTask) {
        this._backgroundTask.completed = current;
        this._backgroundTask.total = total;
      }

      // 如果悬浮窗可见，更新它
      const floater = ImportFloater.getInstance();
      if (floater.isVisible()) {
        floater.update(current, total, label);
      }

      // 如果 OV 窗口打开着，更新底部进度条
      if (this.constructor.isVisible && this.rendered) {
        this._showBottomProgressBar(current, total, label);
      }
    }, false, this.library).then((count) => {
      ovLog(`${MODULE_ID} | Background thumbnail generation complete: ${count} thumbnails`);

      // ★ 立即重建 catalog.json（修复根因：缩略图生成后 catalog 从未更新）
      // generateBatch 只保存个别 metadata.json，catalog.json 需要显式触发
      if (count > 0) {
        this.library._saveCatalog();
      }

      // 清除后台任务
      this._backgroundTask = null;

      // 移除侧边栏导入中动画
      this._setFolderImporting(targetFolderId, false);

      // 如果悬浮窗还在显示，触发完成动画
      const floater = ImportFloater.getInstance();
      if (floater.isVisible()) {
        floater.complete();
      }

      // 如果 OV 窗口打开，移除底部进度条并刷新视图
      if (this.constructor.isVisible && this.rendered) {
        this._hideBottomProgressBar();
        this._refreshViewAfterUpdate(targetFolderId);
      }
    }).catch((err) => {
      console.error(`${MODULE_ID} | Background thumbnail generation failed: `, err);
      this._backgroundTask = null;
      this._setFolderImporting(targetFolderId, false);
      this._hideBottomProgressBar();

      const floater = ImportFloater.getInstance();
      if (floater.isVisible()) {
        floater.hide();
      }
    });
  };

  /**
   * 显示/更新 OV 窗口底部的后台导入进度条
   */
  cls.prototype._showBottomProgressBar = function (current, total, label) {
    if (!this.element) return;
    let bar = this.element.querySelector('.ov-bg-import-bar');
    if (!bar) {
      const statusBar = this.element.querySelector('.status-bar');
      if (!statusBar) return;
      bar = document.createElement('div');
      bar.className = 'ov-bg-import-bar';
      bar.innerHTML = `
        <div class="ov-bg-import-info">
          <i class="fas fa-spinner fa-spin"></i>
          <span class="ov-bg-import-label">${label}</span>
          <span class="ov-bg-import-count">0 / 0</span>
        </div>
        <div class="ov-bg-import-hint">
          ${game.i18n?.localize('origin-vault.notifications.bgImportHint') || '您可以关闭窗口或继续整理文件，导入会在后台进行'}
        </div>
        <div class="ov-bg-import-track">
          <div class="ov-bg-import-fill"></div>
        </div>
`;
      statusBar.parentNode.insertBefore(bar, statusBar);
    }
    const pct = total > 0 ? Math.min(100, (current / total) * 100) : 0;
    bar.querySelector('.ov-bg-import-fill').style.width = `${pct}% `;
    bar.querySelector('.ov-bg-import-count').textContent = `${current} / ${total}`;
    bar.querySelector('.ov-bg-import-label').textContent = label;
  };

  /**
   * 移除 OV 窗口底部的后台导入进度条
   */
  cls.prototype._hideBottomProgressBar = function () {
    if (!this.element) return;
    const bar = this.element.querySelector('.ov-bg-import-bar');
    if (bar) {
      bar.classList.add('ov-bg-import-bar-hiding');
      setTimeout(() => bar.remove(), 300);
    }
  };

  /**
   * 重新生成指定素材的缩略图（来自右键菜单）
   * @param {object[]} items - 素材对象数组（需含 id 和 path）
   * @param {string|null} folderId - 关联文件夹 ID（用于脉冲动画）
   */
  cls.prototype._regenerateThumbnailsForItems = function (items, folderId = null) {
    if (this._backgroundTask) {
      ui.notifications.warn('后台已有缩略图任务在运行，请等待完成后再试');
      return;
    }
    if (!items || items.length === 0) return;

    // 强制标记为未生成，这样 generateBatch 不会跳过
    for (const item of items) {
      item.thumbnailGenerated = false;
    }

    this._startBackgroundThumbnails(items, folderId);
  };

  cls.prototype._countFilesRecursively = async function (path, allowedTypes) {
    let count = 0;
    try {
      const result = await browseFilePicker('data', path);
      for (const filePath of result.files) {
        if (this._isValidFileType(filePath, allowedTypes)) {
          count++;
        }
      }
      for (const dirPath of result.dirs) {
        count += await this._countFilesRecursively(dirPath, allowedTypes);
      }
    } catch (err) {
      // ignore
    }
    return count;
  };

  /**
   * 处理浏览器文件拖放 (优化版: 单次扫描 + 批量导入)
   */
  cls.prototype._handleBrowserDrop = async function (data, targetFolderId) {
    if (data.isDirectory) {
      const paths = data.paths.map(p => decodeURIComponent(p));
      const browseSource = data.source || 'data';
      const browseOptions = data.bucket ? { bucket: data.bucket } : {};

      // 1. 弹出配置对话框
      const allowedTypes = await this._showImportDialog();
      if (!allowedTypes) return; // 用户取消

      // 2. 单次扫描: 收集所有文件路径 + 创建文件夹结构
      const loadingId = ui.notifications.info(t('origin-vault.browser.scanning'), { permanent: true });
      const collectedItems = []; // {path, folderId}

      try {
        for (const path of paths) {
          await this._collectFilesRecursively(path, targetFolderId, allowedTypes, collectedItems, browseSource, browseOptions);
        }
      } catch (e) {
        console.error("Scan failed", e);
      } finally {
        ui.notifications.remove(loadingId);
      }

      if (collectedItems.length === 0) {
        ui.notifications.warn(t('origin-vault.browser.noResults'));
        return;
      }

      // 3. 批量导入 (并行写入, 统一进度条)
      const progressDialog = await this._showProgressDialog(collectedItems.length);

      try {
        const result = await this.library.addItems(collectedItems, (current, total) => {
          progressDialog.update(current);
        });

        if (result.added > 0) {
          // 4. 缩略图生成（后台任务，不阻塞 UI）
          const addedItemIds = [];
          for (const { path } of collectedItems) {
            const item = this.library.getItemByPath(path);
            if (item && !item.thumbnailGenerated) addedItemIds.push(item);
          }

          progressDialog.close();
          ui.notifications.info(tf('origin-vault.items.importedCount', { count: result.added }));
          this._refreshViewAfterUpdate(targetFolderId);

          // 启动后台缩略图生成（不 await）
          if (addedItemIds.length > 0) {
            this._startBackgroundThumbnails(addedItemIds, targetFolderId);
          }
        } else {
          progressDialog.close();
          ui.notifications.warn(t('origin-vault.items.importNoNew'));
        }

      } catch (err) {
        progressDialog.close();
        console.error(err);
        ui.notifications.error(t('origin-vault.items.importError'));
      }

    } else {
      const decodedPaths = data.paths.map(p => decodeURIComponent(p));
      this._addFilesToLibrary(decodedPaths, targetFolderId);
    }
  };

  /**
   * 递归收集文件路径并创建文件夹结构（不执行导入）
   * @param {string} path - 文件系统路径
   * @param {string} parentFolderId - 目标父文件夹 ID
   * @param {string[]} allowedTypes - 允许的文件类型
   * @param {Array<{path: string, folderId: string}>} collectedItems - 收集结果输出
   */
  cls.prototype._collectFilesRecursively = async function (path, parentFolderId, allowedTypes, collectedItems, browseSource = 'data', browseOptions = {}) {
    // 获取文件夹名称
    const parts = path.split('/').filter(p => p);
    const folderName = decodeURIComponent(parts[parts.length - 1]);

    // 在素材库创建新文件夹 (默认折叠)
    const newFolderId = this.library.createFolder(parentFolderId, folderName, { collapsed: true });

    try {
      // 浏览文件系统（支持 data/s3 等源）
      const result = await browseFilePicker(browseSource, path, browseOptions);

      // 收集文件路径
      for (const filePath of result.files) {
        if (this._isValidFileType(filePath, allowedTypes)) {
          collectedItems.push({ path: filePath, folderId: newFolderId });
        }
      }

      // 递归子文件夹
      for (const dirPath of result.dirs) {
        await this._collectFilesRecursively(dirPath, newFolderId, allowedTypes, collectedItems, browseSource, browseOptions);
      }

    } catch (err) {
      console.error(`Error browsing ${path}:`, err);
    }
  };

  /**
   * 检查缺失或过期的缩略图并重新生成
   */
  cls.prototype._checkMissingThumbnails = async function () {
    // 防止重复执行 (避免 render -> getData -> setTimeout -> _checkMissingThumbnails 循环)
    if (this._thumbnailCheckInProgress) return;
    this._thumbnailCheckInProgress = true;

    try {
      const items = Object.values(this.library.getAllItems());
      const thumbnailManager = ThumbnailManager.getInstance();
      const itemsToUpdate = [];

      for (const item of items) {
        // 跳过正在被 ITEM_ADDED 钩子处理的素材
        if (thumbnailManager.pendingThumbnails.has(item.id)) {
          continue;
        }

        if (typeof item.path !== 'string' || !item.path) continue;
        const ext = '.' + item.path.split('.').pop().toLowerCase();
        if (!FILE_TYPES.IMAGE.includes(ext) && !FILE_TYPES.VIDEO.includes(ext) && !FILE_TYPES.AUDIO.includes(ext)) {
          continue;
        }

        // 重新获取最新的素材数据（ITEM_ADDED 钩子可能已经更新了）
        const latestItem = this.library.getItem(item.id);
        if (!latestItem) continue;

        // 检查是否需要更新：
        // 1. 从未生成过
        // 2. 缩略图不是 WebP 格式 (我们希望统一使用 WebP)
        const isAudio = FILE_TYPES.AUDIO.includes(ext);
        const needsUpdate = !latestItem.thumbnailGenerated ||
          (latestItem.thumbnail && !latestItem.thumbnail.endsWith('.webp')) ||
          (isAudio && (latestItem.thumbnailVersion || 0) < AUDIO_WAVEFORM_THUMBNAIL_VERSION);

        if (needsUpdate) {
          itemsToUpdate.push(latestItem);
        }
      }

      if (itemsToUpdate.length === 0) return;

      ovLog(`${MODULE_ID} | Found ${itemsToUpdate.length} thumbnails to generate/update.`);

      // 显示生成进度
      const total = itemsToUpdate.length;
      this._showLoadingOverlay(`Generating thumbnails... 0/${total}`);

      let updatedCount = 0;

      // 使用 batch 并在回调中更新 UI
      // 只有当数量较多(>5)时才显示遮罩，避免闪烁
      // 但用户明确要求进度条，所以总是显示

      updatedCount = await thumbnailManager.generateBatch(itemsToUpdate, (current, total) => {
        this._showLoadingOverlay(`Generating thumbnails... ${current}/${total}`);
      }, false, this.library);

      this._hideLoadingOverlay();

      if (updatedCount > 0) {
        ovLog(`${MODULE_ID} | Generated/Updated ${updatedCount} thumbnails.`);

        // 刷新界面以显示新缩略图
        this.render();
      }
    } catch (error) {
      console.error(`${MODULE_ID} | Error checking missing thumbnails:`, error);
      this._hideLoadingOverlay();
    } finally {
      this._thumbnailCheckInProgress = false;
    }
  };

  cls.prototype._showImportDialog = async function () {
    return new Promise((resolve) => {
      // 检查是否已存在 overlay
      let $overlay = $(this.element).find('.ov-overlay-backdrop.import-config');
      if ($overlay.length === 0) {
        const dialogHtml = `
          <div class="ov-overlay-backdrop import-config">
            <div class="ov-dialog-card">
              <div class="ov-dialog-header">
                <div class="ov-dialog-title">
                  <i class="fas fa-cloud-upload-alt"></i> ${t('origin-vault.dialog.import.title')}
                </div>
              </div>
              <div class="ov-dialog-body">
                <p>${t('origin-vault.dialog.import.selectTypes')}</p>
                <div class="ov-checkbox-group">
                  <label class="ov-checkbox-label">
                    <input type="checkbox" name="type" value="image" checked>
                    <i class="fas fa-image"></i> ${t('origin-vault.dialog.import.images')}
                  </label>
                  <label class="ov-checkbox-label">
                    <input type="checkbox" name="type" value="video" checked>
                    <i class="fas fa-film"></i> ${t('origin-vault.dialog.import.videos')}
                  </label>
                  <label class="ov-checkbox-label">
                    <input type="checkbox" name="type" value="audio" checked>
                    <i class="fas fa-music"></i> ${t('origin-vault.dialog.import.audio')}
                  </label>
                </div>
                <p style="margin-top: 15px; font-size: 12px; color: var(--ov-warning);">
                  <i class="fas fa-info-circle"></i> ${t('origin-vault.dialog.import.note')}
                </p>
              </div>
              <div class="ov-dialog-footer">
                <button class="dialog-button cancel">${t('origin-vault.dialog.cancel')}</button>
                <button class="dialog-button default confirm">${t('origin-vault.dialog.import.start')}</button>
              </div>
            </div>
          </div>`;
        $(this.element).find('.origin-vault-container').append(dialogHtml);
        $overlay = $(this.element).find('.ov-overlay-backdrop.import-config');

        // 绑定事件
        $overlay.find('.cancel').on('click', () => {
          $overlay.removeClass('active');
          setTimeout(() => $overlay.remove(), 200);
          resolve(null);
        });

        $overlay.find('.confirm').on('click', () => {
          const types = [];
          $overlay.find('input[name="type"]:checked').each((_, el) => types.push(el.value));
          $overlay.removeClass('active');
          setTimeout(() => $overlay.remove(), 200);
          resolve(types);
        });
      }

      // 激活动画
      setTimeout(() => $overlay.addClass('active'), 10);
    });
  };

  cls.prototype._showProgressDialog = async function (totalCount) {
    let total = totalCount;
    let $overlay = $(this.element).find('.ov-overlay-backdrop.import-progress');
    if ($overlay.length === 0) {
      const dialogHtml = `
      <div class="ov-overlay-backdrop import-progress">
        <div class="ov-dialog-card">
          <div class="ov-dialog-header">
            <div class="ov-dialog-title">
              <i class="fas fa-spinner fa-spin"></i> ${t('origin-vault.notifications.importing')}
            </div>
          </div>
          <div class="ov-dialog-body">
            <div class="ov-progress-track">
              <div class="ov-progress-fill" style="width: 0%"></div>
            </div>
            <div class="ov-progress-text">
              <span class="curr">0</span>
              <span class="total">/ ${total}</span>
            </div>
          </div>
        </div>
      </div>`;
      $(this.element).find('.origin-vault-container').append(dialogHtml);
      $overlay = $(this.element).find('.ov-overlay-backdrop.import-progress');
    }
    setTimeout(() => $overlay.addClass('active'), 10);

    return {
      update: (current) => {
        const pct = Math.min(100, (current / total) * 100);
        $overlay.find('.ov-progress-fill').css('width', `${pct}%`);
        $overlay.find('.curr').text(current);
      },
      updateTotal: (newTotal) => {
        total = newTotal;
        $overlay.find('.total').text(`/ ${newTotal}`);
        $overlay.find('.ov-dialog-title').html(
          `<i class="fas fa-spinner fa-spin"></i> ${t('origin-vault.notifications.generatingThumbnails')}`
        );
      },
      close: () => {
        $overlay.removeClass('active');
        setTimeout(() => $overlay.remove(), 200);
      }
    };
  };

  /**
   * 验证文件类型
   * @param {string} path
   * @returns {boolean}
   */
  cls.prototype._isValidFileType = function (path) {
    const ext = '.' + path.split('.').pop().toLowerCase();
    // 使用 constants.js 定义的严格类型
    return FILE_TYPES.IMAGE.includes(ext) ||
      FILE_TYPES.VIDEO.includes(ext) ||
      FILE_TYPES.AUDIO.includes(ext);
  };

  /**
   * 打开上传对话框
   */
  cls.prototype._openUploadDialog = async function () {
    const { UploadDialog } = await import('../UploadDialog.js');
    const targetFolderId = this.currentFolderId?.startsWith?.('__')
      ? SPECIAL_FOLDERS.ROOT
      : (this.currentFolderId || SPECIAL_FOLDERS.ROOT);
    const container = this.element?.querySelector('.origin-vault-container');

    const dialog = new UploadDialog(this.library, {
      targetFolderId,
      parentElement: container || document.body
    });

    dialog.onClose(async (uploadedPaths) => {
      // 刷新视图以显示新上传的文件
      await this._refreshViewAfterUpdate(targetFolderId);

      // 文件选择器模式下：自动选中最后上传的文件
      if (this.filePickerMode && uploadedPaths?.length > 0) {
        const lastPath = uploadedPaths[uploadedPaths.length - 1]?.path;
        if (lastPath) {
          const item = this.library.getItemByPath(lastPath);
          if (item) {
            this.selectedItems.clear();
            this.selectedItems.add(item.id);
            this._updateSelectionVisuals();
            this._updatePickerConfirmState();
            await this._renderDetailsPanel();
          }
        }
      }
    });

    dialog.show();
  };
}
