/**
 * Origin Vault - 快速预览 (Quick Look)
 * 按下空格键时弹出的全屏预览窗口
 */

import { FILE_TYPES, MODULE_ID, OV_LAYERS, RARITY_COLORS } from '../constants.js';
import { SceneRenderer } from './SceneRenderer.js';
import { hasTranslation, t } from '../utils/i18n.js';
import { getWorldSceneId } from '../utils/worldSceneBindings.js';
import { escapeActorDisplayText, getActorPreviewMeta } from '../utils/actorDisplay.js';

/**
 * 快速预览管理器
 * 负责在按住空格键时显示素材的大图预览
 */
export class QuickLook {
    static #instance = null;

    static getInstance() {
        if (!QuickLook.#instance) {
            QuickLook.#instance = new QuickLook();
        }
        return QuickLook.#instance;
    }

    constructor() {
        if (QuickLook.#instance) {
            throw new Error("QuickLook is a singleton. Use QuickLook.getInstance().");
        }

        this._element = null;
        this.currentAsset = null;
        this.sceneRenderer = null; // 场景渲染器实例

        // 视图状态
        this.scale = 1;
        this.panX = 0;
        this.panY = 0;
        this.isDragging = false;
        this.lastMouseX = 0;
        this.lastMouseY = 0;

        // 绑定方法
        this._onWheel = this._onWheel.bind(this);
        this._onMouseDown = this._onMouseDown.bind(this);
        this._onMouseMove = this._onMouseMove.bind(this);
        this._onMouseUp = this._onMouseUp.bind(this);
    }

    /**
     * 当前是否打开
     */
    get isOpen() {
        return this._element && document.body.contains(this._element);
    }

    /**
     * 打开预览
     * @param {object} asset - 素材对象 {id, path, displayName, type}
     */
    async open(asset) {
        if (this.isOpen) return;
        this.currentAsset = asset;

        // 重置状态
        this.scale = 1;
        this.panX = 0;
        this.panY = 0;

        await this._render();
    }

    /**
     * 切换预览内容（QuickLook 已打开时，用于箭头键导航）
     * @param {object} asset - 新的素材对象
     */
    async switchAsset(asset) {
        if (!this.isOpen || !asset) return;
        this.currentAsset = asset;

        // 重置视图状态
        this.scale = 1;
        this.panX = 0;
        this.panY = 0;

        // 销毁旧的场景渲染器
        if (this.sceneRenderer) {
            this.sceneRenderer.destroy();
            this.sceneRenderer = null;
        }

        const isImage = this._isImage(asset.path);
        const isVideo = this._isVideo(asset.path);
        const isScene = this._isScene(asset);

        const contentEl = this._element.querySelector('.ov-ql-content');
        if (!contentEl) return;

        let contentHtml = '';
        const isItem = this._isItem(asset);
        const isActor = this._isActor(asset);
        if (isScene) {
            contentHtml = `<div class="ov-ql-scene-container" style="width: 90vw; height: 85vh; position: relative; background: #000;"></div>`;
        } else if (isItem || isActor) {
            contentHtml = `<div class="ov-ql-item-loading" style="color: #999; font-size: 14px;"><i class="fas fa-spinner fa-spin"></i> Loading...</div>`;
        } else if (isImage) {
            contentHtml = `<img src="${asset.path}" class="ov-ql-media" draggable="false" />`;
        } else if (isVideo) {
            contentHtml = `<video src="${asset.path}" class="ov-ql-media" autoplay loop muted playsinline></video>`;
        } else {
            contentHtml = `
                <div class="ov-ql-placeholder">
                    <i class="fas ${this._getIcon(asset.path)} fa-5x"></i>
                    <p>${asset.displayName || asset.name}</p>
                </div>
            `;
        }

        contentEl.innerHTML = contentHtml;
        contentEl.style.transform = `translate(0px, 0px) scale(1)`;

        // 如果是场景，初始化渲染器
        if (isScene) {
            const container = contentEl.querySelector('.ov-ql-scene-container');
            if (container) {
                await this._initSceneRenderer(container, asset);
            }
        }

        // 如果是物品，异步加载卡片
        if (isItem) {
            await this._renderItemCard(contentEl, asset);
        }

        // 如果是角色，异步加载卡片
        if (isActor) {
            await this._renderActorCard(contentEl, asset);
        }
    }

    /**
     * 关闭预览
     */
    close() {
        if (!this.isOpen) return;

        // 移除事件监听
        if (this._element) {
            this._element.removeEventListener('wheel', this._onWheel);
            this._element.removeEventListener('mousedown', this._onMouseDown);
            window.removeEventListener('mousemove', this._onMouseMove);
            window.removeEventListener('mouseup', this._onMouseUp);

            // 销毁场景渲染器
            if (this.sceneRenderer) {
                this.sceneRenderer.destroy();
                this.sceneRenderer = null;
            }

            this._element.classList.remove('active');

            setTimeout(() => {
                if (this._element && this._element.parentNode) {
                    this._element.remove();
                }
                this._element = null;
                this.currentAsset = null;
            }, 300);
        }
    }

    /**
     * 构建并插入 DOM
     */
    async _render() {
        const el = document.createElement('div');
        el.id = 'ov-quick-look';
        el.className = 'ov-quick-look';
        el.style.zIndex = String(this._resolveOverlayZIndex());

        const isImage = this._isImage(this.currentAsset.path);
        const isVideo = this._isVideo(this.currentAsset.path);
        const isScene = this._isScene(this.currentAsset);

        let contentHtml = '';
        const isItem = this._isItem(this.currentAsset);
        const isActor = this._isActor(this.currentAsset);
        if (isScene) {
            contentHtml = `<div class="ov-ql-scene-container" style="width: 90vw; height: 85vh; position: relative; background: #000;"></div>`;
        } else if (isItem || isActor) {
            contentHtml = `<div class="ov-ql-item-loading" style="color: #999; font-size: 14px;"><i class="fas fa-spinner fa-spin"></i> Loading...</div>`;
        } else if (isImage) {
            contentHtml = `<img src="${this.currentAsset.path}" class="ov-ql-media" draggable="false" />`;
        } else if (isVideo) {
            contentHtml = `<video src="${this.currentAsset.path}" class="ov-ql-media" autoplay loop muted playsinline></video>`;
        } else {
            contentHtml = `
                <div class="ov-ql-placeholder">
                    <i class="fas ${this._getIcon(this.currentAsset.path)} fa-5x"></i>
                    <p>${this.currentAsset.displayName || this.currentAsset.name}</p>
                </div>
            `;
        }

        el.innerHTML = `
            <div class="ov-ql-backdrop"></div>
            <div class="ov-ql-container">
                <div class="ov-ql-content">
                    ${contentHtml}
                </div>
            </div>
        `;

        document.body.appendChild(el);
        this._element = el;

        el.classList.add('active');

        // 初始化场景 (如果需要)
        if (isScene) {
            requestAnimationFrame(async () => {
                const container = el.querySelector('.ov-ql-scene-container');
                if (container) {
                    await this._initSceneRenderer(container, this.currentAsset);
                }
            });
        }

        // 初始化物品/角色卡片 (异步加载描述)
        if (isItem) {
            this._renderItemCard(el.querySelector('.ov-ql-content'), this.currentAsset);
        } else if (isActor) {
            this._renderActorCard(el.querySelector('.ov-ql-content'), this.currentAsset);
        }

        // 绑定事件
        this._element.addEventListener('wheel', this._onWheel, { passive: false });
        this._element.addEventListener('mousedown', this._onMouseDown);
        this._element.addEventListener('click', (e) => {
            // 点击背景关闭
            if (e.target === el || e.target.classList.contains('ov-ql-container') || e.target.classList.contains('ov-ql-backdrop')) {
                this.close();
            }
        });
    }


    /**
     * 初始化场景渲染器
     */
    async _initSceneRenderer(container, asset) {
        if (!asset || !container?.isConnected) return;
        try {
            const sceneData = await this._getSceneData(asset);
            if (!container.isConnected || this.currentAsset !== asset) return;
            if (!sceneData) {
                container.innerHTML = `<div class="ov-ql-placeholder"><i class="fas fa-exclamation-triangle fa-3x"></i><p>无法加载场景数据</p></div>`;
                return;
            }

            const renderer = new SceneRenderer(container, sceneData, {
                interactive: true,
                showWalls: false,
                showLights: false,
                levelId: SceneRenderer.getDefaultLevelId(sceneData),
                useSceneResolution: true
            });

            // 渲染场景
            this.sceneRenderer = renderer;
            await renderer.render();
            // 加载期间可能已关闭或切换候选，不能留下离屏动画循环。
            if (this.sceneRenderer !== renderer || !container.isConnected) renderer.destroy();

        } catch (e) {
            console.error(`${MODULE_ID} | QuickLook Scene Init Error:`, e);
            container.innerHTML = `<div class="ov-ql-placeholder"><i class="fas fa-exclamation-triangle fa-3x"></i><p>渲染失败: ${e.message}</p></div>`;
        }
    }

    /**
     * 获取场景数据 (逻辑复用自 MainWindow)
     */
    async _getSceneData(asset) {
        try {
            // 0. 世界场景：只打开当前世界自己的绑定
            const worldSceneId = asset.worldSceneId || getWorldSceneId(asset);
            if (worldSceneId) {
                const worldScene = game.scenes.get(worldSceneId);
                if (worldScene) return worldScene.toObject();
            }

            // 1. 如果有 UUID，从 Compendium 获取
            if (asset.metadata?.uuid) {
                const doc = await fromUuid(asset.metadata.uuid);
                if (doc) return doc.toObject();
            }

            // 2. 如果有 Pack ID (folderId) 和 ID
            const folderId = asset.metadata?.compendiumId || asset.folderId; // 有时可能是 folderId
            if (folderId && asset.id) {
                const pack = game.packs.get(folderId);
                if (pack) {
                    const doc = await pack.getDocument(asset.id);
                    if (doc) return doc.toObject();
                }
            }

            // 3. 如果是 .ov-scene 数据
            if (asset.sceneData) return asset.sceneData;

            // 4. 如果是普通 Item 数据但类型是 scene (可能直接来自 LibraryManager)
            if (asset.type === 'scene' && asset.metadata?.sceneData) {
                return asset.metadata.sceneData;
            }

            return null;
        } catch (e) {
            console.error(`${MODULE_ID} | Error getting scene data:`, e);
            return null;
        }
    }

    /**
     * 处理滚轮缩放
     */
    _onWheel(e) {
        // 如果是场景，由 SceneRenderer 处理交互，QuickLook 不做处理
        if (this.sceneRenderer) return;

        // 物品或角色类型不支持缩放
        if (this._isItem(this.currentAsset) || this._isActor(this.currentAsset)) return;

        if (!this.currentAsset || (!this._isImage(this.currentAsset.path) && !this._isVideo(this.currentAsset.path))) return;

        e.preventDefault();

        const delta = -Math.sign(e.deltaY) * 0.1;
        const newScale = Math.max(0.5, Math.min(5, this.scale + delta));

        if (newScale !== this.scale) {
            this.scale = newScale;
            this._updateTransform();
        }
    }

    /**
     * 处理拖拽开始
     */
    _onMouseDown(e) {
        // 如果是场景，由 SceneRenderer 处理交互
        if (this.sceneRenderer) return;

        // 物品或角色类型不支持拖拽
        if (this._isItem(this.currentAsset) || this._isActor(this.currentAsset)) return;

        if (e.target.closest('.ov-ql-content')) {
            this.isDragging = true;
            this.lastMouseX = e.clientX;
            this.lastMouseY = e.clientY;

            window.addEventListener('mousemove', this._onMouseMove);
            window.addEventListener('mouseup', this._onMouseUp);
            e.preventDefault(); // 防止选中文本
        }
    }

    /**
     * 处理拖拽移动
     */
    _onMouseMove(e) {
        if (!this.isDragging) return;

        const dx = e.clientX - this.lastMouseX;
        const dy = e.clientY - this.lastMouseY;

        this.panX += dx;
        this.panY += dy;

        this.lastMouseX = e.clientX;
        this.lastMouseY = e.clientY;

        this._updateTransform();
    }

    /**
     * 处理拖拽结束
     */
    _onMouseUp(e) {
        this.isDragging = false;
        window.removeEventListener('mousemove', this._onMouseMove);
        window.removeEventListener('mouseup', this._onMouseUp);
    }

    /**
     * 更新变换样式
     */
    _updateTransform() {
        const content = this._element?.querySelector('.ov-ql-content');
        if (content) {
            content.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.scale})`;
        }
    }

    // --- Helpers ---

    _resolveOverlayZIndex() {
        const mainWindow = document.getElementById('origin-vault-main');
        const mainWindowZ = mainWindow
            ? Number.parseInt(window.getComputedStyle(mainWindow).zIndex, 10)
            : Number.NaN;

        if (Number.isFinite(mainWindowZ)) {
            return mainWindowZ + 1;
        }

        return OV_LAYERS.SHELL + 1;
    }

    _isImage(path) {
        const ext = '.' + path.split('.').pop().toLowerCase();
        return FILE_TYPES.IMAGE.includes(ext);
    }

    _isVideo(path) {
        const ext = '.' + path.split('.').pop().toLowerCase();
        return FILE_TYPES.VIDEO.includes(ext);
    }

    _isScene(asset) {
        const isSceneType = asset.metadata?.type === 'scene' || asset.type === 'scene';
        const ext = '.' + asset.path.split('.').pop().toLowerCase();
        return isSceneType || ext === '.json' || ext === '.ov-scene';
    }

    _getIcon(path) {
        const ext = '.' + path.split('.').pop().toLowerCase();
        if (FILE_TYPES.AUDIO.includes(ext)) return 'fa-music';
        if (ext === '.json' || ext === '.ov-scene') return 'fa-map';
        return 'fa-file';
    }

    _getFileInfo(asset) {
        return asset.path.split('.').pop().toUpperCase();
    }

    _isItem(asset) {
        return asset?.metadata?.type === 'item';
    }

    _isActor(asset) {
        return asset?.metadata?.type === 'actor';
    }

    /**
     * 异步渲染物品卡片到 QuickLook 内容区
     */
    async _renderItemCard(contentEl, asset) {
        if (!contentEl) return;
        try {
            const uuid = asset.metadata?.uuid || asset.uuid;
            let description = '';
            let itemName = asset.displayName || asset.name;
            let itemType = asset.metadata?.itemType || 'item';
            let imgSrc = asset.path || asset.thumbnail;

            // 尝试从世界物品获取数据
            if (uuid) {
                const worldItem = game.items?.find(i =>
                    i.flags?.core?.sourceId === uuid ||
                    i._stats?.compendiumSource === uuid
                );
                if (worldItem) {
                    description = worldItem.system?.description?.value || '';
                    itemName = worldItem.name || itemName;
                    if (worldItem.img) imgSrc = worldItem.img;
                } else {
                    // 从合集包获取
                    const doc = await fromUuid(uuid);
                    if (doc) {
                        description = doc.system?.description?.value || '';
                        itemName = doc.name || itemName;
                        if (doc.img) imgSrc = doc.img;
                    }
                }
            }

            // 富文本处理
            let enrichedDesc = description;
            if (typeof TextEditor !== 'undefined' && TextEditor.enrichHTML) {
                enrichedDesc = await TextEditor.enrichHTML(description, { async: true });
            }

            // 物品子类型标签
            const typeLabel = hasTranslation(`TYPES.Item.${itemType}`)
                ? t(`TYPES.Item.${itemType}`)
                : itemType.charAt(0).toUpperCase() + itemType.slice(1);

            // 稀有度角标颜色（从 metadata 读取，不依赖系统类型）
            let badgeBg = 'rgba(138, 92, 246, 0.3)';
            let badgeColor = '#b88cff';
            const rarity = asset.metadata?.rarity || '';
            const rarityColor = rarity ? (RARITY_COLORS[rarity] || '') : '';
            if (rarityColor) {
                badgeBg = `${rarityColor}40`;
                badgeColor = rarityColor;
            }

            contentEl.innerHTML = `
                <div class="item-card-preview" style="max-width: 680px; width: 90vw; max-height: 85vh; overflow-y: auto;
                    display: flex; flex-direction: column; justify-content: center;
                    padding: 24px; box-sizing: border-box; margin: 0 auto;">
                    <div class="item-card-header" style="display: flex; align-items: center; gap: 16px; margin-bottom: 16px;">
                        <img src="${imgSrc}" alt="${itemName}"
                            style="width: 64px; height: 64px; border-radius: 8px; object-fit: cover; border: 2px solid rgba(255,255,255,0.1);" />
                        <div>
                            <div style="font-size: 20px; font-weight: 700; color: #eee;">${itemName}</div>
                            <span class="item-card-type-badge" style="display: inline-block; padding: 2px 10px;
                                border-radius: 12px; font-size: 12px; font-weight: 600;
                                background: ${badgeBg}; color: ${badgeColor}; margin-top: 4px;">${typeLabel}</span>
                        </div>
                    </div>
                    ${enrichedDesc ? `
                    <div class="item-card-description" style="padding: 16px; background: rgba(0,0,0,0.3);
                        border: 1px solid rgba(255,255,255,0.08); border-radius: 8px;
                        font-size: 14px; line-height: 1.7; color: #ddd; max-height: 60vh; overflow-y: auto;">
                        ${enrichedDesc}
                    </div>` : ''}
                </div>
            `;
        } catch (err) {
            console.warn(`${MODULE_ID} | QuickLook item card render failed:`, err);
            contentEl.innerHTML = `
                <div class="ov-ql-placeholder">
                    <i class="fas fa-scroll fa-5x"></i>
                    <p>${asset.displayName || asset.name}</p>
                </div>
            `;
        }
    }

    /**
     * 异步渲染角色卡片到 QuickLook 内容区
     */
    async _renderActorCard(contentEl, asset) {
        if (!contentEl) return;
        try {
            const uuid = asset.metadata?.uuid || asset.uuid;
            let actorDoc = null;

            if (uuid) {
                const worldActor = game.actors?.find(a =>
                    a.flags?.core?.sourceId === uuid ||
                    a._stats?.compendiumSource === uuid
                );
                if (worldActor) {
                    actorDoc = worldActor;
                } else {
                    actorDoc = await fromUuid(uuid);
                }
            }

            const actorMeta = getActorPreviewMeta(asset, actorDoc);
            const actorName = escapeActorDisplayText(actorMeta.name);
            const actorImage = escapeActorDisplayText(actorMeta.imgSrc);
            const actorRace = escapeActorDisplayText(actorMeta.race);
            const actorCr = escapeActorDisplayText(actorMeta.cr);
            const dndMetaHtml = actorMeta.isDnd5e && (actorMeta.race || actorMeta.cr)
                ? `<div style="position: absolute; left: 14px; top: 14px; display: flex; gap: 6px; flex-wrap: wrap;">
                    ${actorMeta.race ? `<span class="item-card-type-badge" style="display: inline-block; padding: 2px 10px; border-radius: 12px; font-size: 12px; font-weight: 700; background: rgba(0,0,0,0.62); color: #f2e7d2;">${actorRace}</span>` : ''}
                    ${actorMeta.cr ? `<span class="item-card-type-badge" style="display: inline-block; padding: 2px 10px; border-radius: 12px; font-size: 12px; font-weight: 700; background: rgba(0,0,0,0.62); color: #f2e7d2;">CR ${actorCr}</span>` : ''}
                </div>`
                : '';

            contentEl.innerHTML = `
                <div class="ov-ql-actor-portrait" style="position: relative; max-width: 82vw; max-height: 84vh; margin: 0 auto;">
                    <img src="${actorImage}" alt="${actorName}"
                        class="ov-ql-media" draggable="false"
                        style="max-width: 82vw; max-height: 84vh; object-fit: contain; border-radius: 8px;" />
                    ${dndMetaHtml}
                </div>
            `;
        } catch (err) {
            console.warn(`${MODULE_ID} | QuickLook actor card render failed:`, err);
            contentEl.innerHTML = `
                <div class="ov-ql-placeholder">
                    <i class="fas fa-users fa-5x"></i>
                    <p>${asset.displayName || asset.name}</p>
                </div>
            `;
        }
    }
}
