/**
 * Origin Vault - 场景渲染器
 * 使用 Canvas 动态渲染场景预览，支持悬停预览和详情页交互
 */

import { MODULE_ID, ENABLE_SCENE_BROWSER_ENHANCEMENTS } from '../constants.js';
import { ovDebug, ovLog } from '../utils/logger.js';

export class SceneRenderer {
    static OVERVIEW_LEVEL_ID = '__origin-vault-scene-overview__';

    // 全局渲染缓存 (LRU)
    // Key: string (sceneId + options hash)
    // Value: { bitmap: ImageBitmap, timestamp: number, pixels: number }
    static cache = new Map();
    static MAX_CACHE_SIZE = 50;
    static MAX_CACHE_PIXELS = 600_000_000; // 6亿像素 ≈ 2.4GB VRAM (足够容纳约15-20个8K场景)
    static _totalCachedPixels = 0;

    /**
     * @param {HTMLElement} container - 挂载 Canvas 的 DOM 容器
     * @param {object} sceneData - 场景数据 (background, tiles, walls, lights等)
     * @param {object} options - 配置选项
     */
    constructor(container, sceneData, options = {}) {
        this.container = container;
        this.sceneData = sceneData;

        // 配置选项
        this.options = {
            interactive: false,       // 是否支持交互（缩放/平移）
            showWalls: false,         // 是否显示墙壁
            showLights: false,        // 是否显示光源
            levelId: null,            // 当前渲染的 level；为空时按版本规则解析默认视角
            enableSceneLevels: true,
            includeLegacyLevels: false,
            includeElevationFallback: false,
            mergeLegacyEntryRanges: false,
            maxSize: 800,             // 最大渲染尺寸
            minResolution: 0,         // 最小渲染分辨率（0 = 使用容器尺寸，3840 = 4K）
            useSceneResolution: false, // 是否使用场景原始分辨率
            ...options
        };

        // Canvas 元素
        this.canvas = null;
        this.ctx = null;

        // 视图状态（仅交互模式）
        this.viewState = {
            offsetX: 0,
            offsetY: 0,
            scale: 1
        };

        // 缩放限制
        this.minScale = 0.25;
        this.maxScale = 4;

        // 拖拽状态
        this._isDragging = false;
        this._lastMouseX = 0;
        this._lastMouseY = 0;

        // 缓存：渲染后的图像快照
        this._cachedBitmap = null;
        this._cacheValid = false;

        // 图片加载缓存
        this._imageCache = new Map();

        // 事件处理器引用（用于清理）
        this._boundHandlers = {};

        // 动画循环相关
        this._animationFrameId = null;
        this._hasVideoContent = false;
        this._resolvedSceneData = null;
        this._sceneLevels = [];
        this._activeLevel = null;
        this._activeLevelId = null;
        this._renderLevels = [];

        // 初始化
        this._initCanvas();
    }

    /**
     * 初始化 Canvas 元素
     */
    _initCanvas() {
        // 创建 Canvas
        this.canvas = document.createElement('canvas');
        this.canvas.className = 'scene-renderer-canvas';
        this.canvas.style.cssText = 'width: 100%; height: 100%; display: block;';

        this.ctx = this.canvas.getContext('2d');
        // 确保高质量缩放
        this.ctx.imageSmoothingEnabled = true;
        this.ctx.imageSmoothingQuality = 'high';

        // 清空容器并挂载
        this.container.innerHTML = '';
        this.container.innerHTML = '';
        this.container.appendChild(this.canvas);

        // 调试：初始填充红色，确认 Canvas 存在
        this.ctx.fillStyle = '#330000';
        this.ctx.fillRect(0, 0, 300, 150);
        // ovLog(`${MODULE_ID} | SceneRenderer: Canvas initialized and appended`);

        // 如果启用交互，绑定事件
        if (this.options.interactive) {
            this._setupInteraction();
        }
    }

    /**
     * 渲染场景
     * @param {boolean} useCache - 是否尝试使用缓存
     */
    async render(useCache = true) {
        if (!this.sceneData) {
            console.warn(`${MODULE_ID} | SceneRenderer: No scene data provided`);
            return;
        }

        const scene = this._resolveSceneForRender();

        // 获取容器与其尺寸
        // 使用 clientWidth/Height 而非 getBoundingClientRect，以避免在 CSS Transform 动画期间获取到错误的缩放尺寸
        const rect = {
            width: this.container.clientWidth,
            height: this.container.clientHeight
        };

        if (rect.width === 0 || rect.height === 0) {
            // 如果容器不可见，无法渲染。可能 DOM 还没更新完
            return;
        }

        // Canvas 分辨率计算
        // 优先级：useSceneResolution > minResolution > 容器尺寸 * dpr
        const bgWidth = scene.width || 1000;
        const bgHeight = scene.height || 1000;

        // Calculate padding and full scene dimensions
        // Foundry stores tile coordinates relative to the TOTAL canvas (including padding)
        // So we must use scene.padding to calculate the full canvas size
        const padding = (typeof scene.padding === 'number') ? scene.padding : 0;

        // Padding offset = where background starts inside the full canvas
        // Foundry VTT 对齐 padding 到网格尺寸（向上取整）
        const gridSize = scene.grid?.size || scene.gridSize || 100;
        let padOffsetX = Math.ceil((bgWidth * padding) / gridSize) * gridSize;
        let padOffsetY = Math.ceil((bgHeight * padding) / gridSize) * gridSize;

        // 如果 padding 为 0，确保 padOffset 也为 0 (防止浮点误差)
        if (padding === 0) {
            padOffsetX = 0;
            padOffsetY = 0;
        }

        // Full canvas size based on aligned padding
        // 注意：Foundry 的实际 padding 计算可能更复杂（考虑宽高比），但通常是对齐网格的
        const fullWidth = bgWidth + 2 * padOffsetX;
        const fullHeight = bgHeight + 2 * padOffsetY;

        // Save dimensions for rendering
        this._bgWidth = bgWidth;
        this._bgHeight = bgHeight;
        this._padOffsetX = padOffsetX;
        this._padOffsetY = padOffsetY;
        this._totalWidth = fullWidth;
        this._totalHeight = fullHeight;

        // ovLog(`${MODULE_ID} | SceneRenderer: scene.padding=${scene.padding}, using padding=${padding}`);
        // ovLog(`${MODULE_ID} | SceneRenderer: bg=${bgWidth}x${bgHeight}, total=${fullWidth}x${fullHeight}, padOffset=(${padOffsetX}, ${padOffsetY})`);

        // 详细场景数据日志 - 用于调试偏移问题
        const bgOffsetX = scene.background?.offsetX || 0;
        const bgOffsetY = scene.background?.offsetY || 0;
        this._bgOffsetX = bgOffsetX;
        this._bgOffsetY = bgOffsetY;

        // 调试日志已移除 (热路径)

        const dpr = window.devicePixelRatio || 1;

        let width, height;

        // ★ 关键修改：交互模式下必须使用容器尺寸，否则用户放大/平移时会被裁切
        // 因为 Canvas 的像素边界就是可见区域的边界
        if (this.options.interactive) {
            // 交互模式：Canvas 分辨率 = 容器像素尺寸（考虑 DPR）
            // 这样整个容器都可以显示内容，不会在缩放时被裁切
            width = Math.floor(rect.width * dpr);
            height = Math.floor(rect.height * dpr);
        } else if (this.options.useSceneResolution) {
            // 非交互模式 + 使用场景分辨率（用于静态预览/缩略图生成）
            width = fullWidth;
            height = fullHeight;
        } else if (this.options.minResolution > 0) {
            // 使用指定的最小分辨率（保持场景比例）
            const aspectRatio = fullWidth / fullHeight;
            if (fullWidth >= fullHeight) {
                width = Math.max(this.options.minResolution, fullWidth);
                height = Math.round(width / aspectRatio);
            } else {
                height = Math.max(this.options.minResolution, fullHeight);
                width = Math.round(height * aspectRatio);
            }
        } else {
            // 默认：使用容器尺寸 * dpr
            width = Math.floor(rect.width * dpr);
            height = Math.floor(rect.height * dpr);
        }

        // 限制最大分辨率以防性能问题（最大 4K）
        const MAX_RESOLUTION = 4096;
        if (width > MAX_RESOLUTION || height > MAX_RESOLUTION) {
            const scale = MAX_RESOLUTION / Math.max(width, height);
            width = Math.round(width * scale);
            height = Math.round(height * scale);
        }

        // 如果尺寸变化，重设 Canvas
        if (this.canvas.width !== width || this.canvas.height !== height) {
            this.canvas.width = width;
            this.canvas.height = height;
            // 通过 CSS 确保显示尺寸正确
            this.canvas.style.width = '100%';
            this.canvas.style.height = '100%';
            this._cacheValid = false; // 尺寸变了缓存失效
            // ovLog(`${MODULE_ID} | SceneRenderer: Resolution set to ${width}x${height}`);
        }

        // 如果是首次渲染(scale为1)或者强制重置，计算 fitScale
        // 或者保留上一次交互的 scale 以支持动态更新而不重置视图？
        // 这里简化逻辑：如果是第一次 render (或者尺寸变了)，重置视图居中
        if (!this._hasRendered || !this.options.interactive) { // 如果非交互模式，每次都重置视图
            // 使用背景图尺寸作为基准（不含 padding），让视口填满背景图
            const scaleX = this.canvas.width / this._bgWidth;
            const scaleY = this.canvas.height / this._bgHeight;
            const fitScale = Math.min(scaleX, scaleY) * 0.95; // 留一点边距

            // 限制最大最小缩放
            this.minScale = Math.min(fitScale * 0.5, 0.1);
            this.maxScale = Math.max(fitScale * 10, 5);

            this.viewState.scale = fitScale;

            // 居中计算 - 聚焦于背景图区域
            // 公式：(Canvas一半) - (背景图一半 * 缩放) - (Padding偏移 * 缩放)
            // 这样 (padOffsetX, padOffsetY) 会被转换到屏幕合适位置，使得背景图居中
            const scaledBgW = this._bgWidth * fitScale;
            const scaledBgH = this._bgHeight * fitScale;

            // 先计算背景图相对于 Canvas 的居中偏移
            const centerOffsetX = (this.canvas.width - scaledBgW) / 2;
            const centerOffsetY = (this.canvas.height - scaledBgH) / 2;

            // 再减去 padding 的偏移影响 (因为渲染时是从 total 0,0 开始画的，所以要往回拉 padOffset)
            this.viewState.offsetX = centerOffsetX - (this._padOffsetX * fitScale);
            this.viewState.offsetY = centerOffsetY - (this._padOffsetY * fitScale);

            this._hasRendered = true;
        }

        // 如果有有效缓存且仅是视图变换，使用缓存快速重绘
        if (useCache && this._cacheValid && this._cachedBitmap) {
            this._drawFromCache();
            return;
        }

        // ★ 在完整渲染之前，先检查全局缓存
        if (useCache && !this._hasVideoContent) {
            const cacheKey = SceneRenderer.getCacheKey(this.sceneData, this.options);
            // ovLog(`${MODULE_ID} | SceneRenderer: Looking up cache key=...`);
            const cached = SceneRenderer.getCachedBitmap(cacheKey);
            if (cached) {
                this._cachedBitmap = cached;
                this._cacheValid = true;
                this._drawFromCache();
                // ovLog(`${MODULE_ID} | SceneRenderer: ★ Global cache HIT ★`);
                return;
            } else {
                // ovLog(`${MODULE_ID} | SceneRenderer: Cache MISS`);
            }
        } else {
            // ovLog(`${MODULE_ID} | SceneRenderer: Cache check SKIPPED`);
        }

        // 完整渲染
        await this._renderFull();

        // 再次检查 Canvas 是否有效 (await 期间可能被销毁)
        if (!this.canvas) return;

        // 如果是交互模式，创建缓存（不含 viewState 变换）
        if (!this._hasVideoContent) {
            await this._createCacheWithoutTransform();
        }

        // 如果场景包含视频内容，启动动画循环
        if (this._hasVideoContent) {
            this._startAnimationLoop();
        }
    }

    /**
     * 启动动画循环（用于视频内容的持续重绘）
     */
    _startAnimationLoop() {
        // 如果已经在运行，不重复启动
        if (this._animationFrameId) return;

        ovLog(`${MODULE_ID} | SceneRenderer: Starting animation loop for video content`);

        const animate = () => {
            if (!this.canvas || !this.ctx) {
                this._stopAnimationLoop();
                return;
            }

            // 重绘场景（不使用缓存，因为视频帧在变化）
            this._renderFull();

            // 继续下一帧
            this._animationFrameId = requestAnimationFrame(animate);
        };

        this._animationFrameId = requestAnimationFrame(animate);
    }

    /**
     * 停止动画循环
     */
    _stopAnimationLoop() {
        if (this._animationFrameId) {
            cancelAnimationFrame(this._animationFrameId);
            this._animationFrameId = null;
            ovLog(`${MODULE_ID} | SceneRenderer: Animation loop stopped`);
        }
    }

    /**
     * 预加载所有图片（并行加载，提升渲染速度）
     */
    async _preloadAllImages() {
        const scene = this._resolvedSceneData || this._resolveSceneForRender();
        const urls = new Set();
        const renderLevels = this._renderLevels?.length ? this._renderLevels : [scene];

        for (const renderScene of renderLevels) {
            if (renderScene.background?.src) urls.add(renderScene.background.src);
            if (renderScene.foreground?.src) urls.add(renderScene.foreground.src);

            const tiles = renderScene.tiles || [];
            const tileList = tiles.contents || tiles;
            for (const tile of tileList) {
                const src = SceneRenderer._getTileTextureSource(tile);
                if (src && !tile.hidden) urls.add(src);
            }
        }

        // 过滤已缓存的
        const toLoad = [...urls].filter(url => !this._imageCache.has(url));
        if (toLoad.length === 0) return;

        // 并行加载所有未缓存的图片
        await Promise.allSettled(toLoad.map(url => this._loadImage(url)));
    }

    /**
     * 完整渲染所有图层
     * 渲染逻辑（完整场景版）：
     * 1. 显示整个场景，包括 padding 区域
     * 2. 背景色填充整个 totalWidth x totalHeight
     * 3. 背景图画在 (padOffsetX, padOffsetY)，使用原生尺寸
     * 4. 图块使用原始坐标（相对于总画布 0,0），无需任何转换
     * 5. 这样可以确保完美对齐，因为不需要任何坐标转换！
     */
    async _renderFull() {
        if (!this.canvas || !this.ctx) return;
        const ctx = this.ctx;
        const scene = this._resolvedSceneData || this._resolveSceneForRender();

        // 清空画布
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        // ★ 先用背景色填充整个 Canvas（在变换前），确保超出场景范围的区域也有颜色
        // 这样当场景比例（如 8:8）与容器比例（如 16:9）不一致时，周围不会是黑色
        const bgColor = scene.backgroundColor || '#1a1a2e';  // 使用深蓝灰色作为默认，比纯黑更友好
        ctx.fillStyle = bgColor;
        ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

        // 保存状态，应用视图变换
        ctx.save();

        // 应用平移和缩放
        ctx.translate(this.viewState.offsetX, this.viewState.offsetY);
        ctx.scale(this.viewState.scale, this.viewState.scale);

        // 注意：不设置裁切区域，允许用户放大后看到完整的图块内容（包括超出背景图范围的部分）

        // 1. 绘制背景色（填充场景区域，包括 padding）
        // 这会覆盖在上面的全画布背景色之上，形成场景的实际背景
        ctx.fillStyle = bgColor;
        ctx.fillRect(0, 0, this._totalWidth, this._totalHeight);

        await this._drawRenderLayers(ctx, scene);

        ctx.restore();
    }

    /**
     * 按 elevation 范围绘制图块
     * @param {CanvasRenderingContext2D} ctx - Canvas 上下文
     * @param {number} minElevation - 最小 elevation（包含）
     * @param {number} maxElevation - 最大 elevation（包含）
     */
    async _drawTilesByElevation(ctx, minElevation, maxElevation, tileSource = null) {
        if (!this.canvas || !ctx) return;
        const tiles = tileSource || this._resolvedSceneData?.tiles || this.sceneData.tiles || [];
        const tileList = tiles.contents || tiles;

        // 过滤指定 elevation 范围的图块并排序
        const filteredTiles = [...tileList]
            .filter(t => {
                const elev = SceneRenderer._getEntrySortElevation(t, this.options);
                return elev >= minElevation && elev <= maxElevation;
            })
            .sort((a, b) => SceneRenderer._getEntrySortElevation(a, this.options) - SceneRenderer._getEntrySortElevation(b, this.options));

        // ★ 并行启动所有图片加载，但按顺序绘制（渐进式渲染 + 并行加速）
        const loadPromises = filteredTiles.map(tile => {
            const src = SceneRenderer._getTileTextureSource(tile);
            if (!src || tile.hidden) return Promise.resolve(null);
            return this._loadImage(src).catch(() => null);
        });

        for (let i = 0; i < filteredTiles.length; i++) {
            if (!this.canvas) return;

            const tile = filteredTiles[i];
            const tileImg = await loadPromises[i];
            if (!tileImg || !this.canvas) continue;

            const rect = SceneRenderer._getTileDrawRect(tile, this.options);
            if (rect.width <= 0 || rect.height <= 0) continue;

            ctx.save();
            ctx.globalAlpha = tile.alpha ?? 1;

            if (tile.rotation) {
                ctx.translate(rect.rotationX, rect.rotationY);
                ctx.rotate(tile.rotation * Math.PI / 180);
                ctx.translate(-rect.rotationX, -rect.rotationY);
            }

            ctx.drawImage(tileImg, rect.x, rect.y, rect.width, rect.height);
            ctx.restore();
        }
    }

    /**
     * 绘制图块（已弃用，保留向后兼容）
     * @deprecated 使用 _drawTilesByElevation 代替
     */
    async _drawTiles(ctx) {
        if (!this.canvas || !ctx) return;
        const tiles = this.sceneData.tiles || [];

        // 如果是 Foundry Document 格式，获取 contents
        const tileList = tiles.contents || tiles;

        // 按 elevation 排序
        const sortedTiles = [...tileList].sort((a, b) => SceneRenderer._getEntrySortElevation(a, this.options) - SceneRenderer._getEntrySortElevation(b, this.options));

        for (const tile of sortedTiles) {
            if (!this.canvas) return; // 循环中检查

            const textureSrc = SceneRenderer._getTileTextureSource(tile);
            if (!textureSrc || tile.hidden) continue;

            try {
                const tileImg = await this._loadImage(textureSrc);
                if (!this.canvas) return;

                const rect = SceneRenderer._getTileDrawRect(tile, this.options);
                if (rect.width <= 0 || rect.height <= 0) continue;

                // 调试日志（仅输出前3个 tile）
                if (sortedTiles.indexOf(tile) < 3) {
                    ovLog(`${MODULE_ID} | Tile[${sortedTiles.indexOf(tile)}]: pos=(${rect.x}, ${rect.y}), size=${rect.width}x${rect.height}`);
                }

                ctx.save();

                // 透明度可见性裁剪：跳过画布外的图块 (在应用了 viewState.scale 之后，这里需要更复杂的判断)
                // 暂时省略，因为 ctx.drawImage 会自动裁剪

                // 透明度
                ctx.globalAlpha = tile.alpha ?? 1;

                // 旋转（围绕中心点）
                if (tile.rotation) {
                    ctx.translate(rect.rotationX, rect.rotationY);
                    ctx.rotate(tile.rotation * Math.PI / 180);
                    ctx.translate(-rect.rotationX, -rect.rotationY);
                }

                // 绘制
                ctx.drawImage(tileImg, rect.x, rect.y, rect.width, rect.height);

                // DEBUG: Draw tile bounding box (disabled)
                // ctx.strokeStyle = 'rgba(0, 0, 255, 0.5)';
                // ctx.lineWidth = 2;
                // ctx.strokeRect(x, y, tWidth, tHeight);

                ctx.restore();
            } catch (e) {
                // Ignore load errors
            }
        }

        // DEBUG: Draw Background Area Box (disabled)
        // if (ctx) {
        //     ctx.save();
        //     ctx.strokeStyle = 'rgba(0, 255, 0, 0.8)';
        //     ctx.lineWidth = 5;
        //     ctx.strokeRect(this._padOffsetX, this._padOffsetY, this._bgWidth, this._bgHeight);
        //     ctx.strokeStyle = 'rgba(255, 0, 0, 0.8)';
        //     ctx.lineWidth = 3;
        //     ctx.strokeRect(0, 0, this._totalWidth, this._totalHeight);
        //     ctx.strokeStyle = 'rgba(255, 255, 0, 0.5)';
        //     ctx.beginPath();
        //     ctx.moveTo(this._totalWidth / 2, 0);
        //     ctx.lineTo(this._totalWidth / 2, this._totalHeight);
        //     ctx.moveTo(0, this._totalHeight / 2);
        //     ctx.lineTo(this._totalWidth, this._totalHeight / 2);
        //     ctx.stroke();
        //     ctx.restore();
        // }
    }

    /**
     * 绘制墙壁
     */
    _drawWalls(ctx = this.ctx, wallSource = null) {
        if (!ctx) return;
        const walls = wallSource || this._resolvedSceneData?.walls || this.sceneData.walls || [];

        const wallList = walls.contents || walls;

        if (wallList.length === 0) return;

        ctx.save();
        ctx.lineWidth = 2;
        ctx.lineCap = 'round';

        for (const wall of wallList) {
            // 墙壁坐标格式: c = [x1, y1, x2, y2]
            const c = wall.c;
            if (!c || c.length < 4) continue;

            const x1 = c[0] - this._padOffsetX;
            const y1 = c[1] - this._padOffsetY;
            const x2 = c[2] - this._padOffsetX;
            const y2 = c[3] - this._padOffsetY;

            // 根据门类型设置颜色
            // door: 0=无门, 1=普通门, 2=秘密门
            if (wall.door === 1) {
                ctx.strokeStyle = '#8B4513'; // 棕色 - 普通门
                ctx.setLineDash([5, 3]);
            } else if (wall.door === 2) {
                ctx.strokeStyle = '#4B0082'; // 紫色 - 秘密门
                ctx.setLineDash([2, 2]);
            } else {
                ctx.strokeStyle = '#666666'; // 灰色 - 普通墙
                ctx.setLineDash([]);
            }

            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.stroke();
        }

        ctx.restore();
    }

    /**
     * 绘制光源指示器
     */
    _drawLights(ctx = this.ctx, lightSource = null) {
        if (!ctx) return;
        const lights = lightSource || this._resolvedSceneData?.lights || this.sceneData.lights || [];

        const lightList = lights.contents || lights;

        if (lightList.length === 0) return;

        for (const light of lightList) {
            const x = light.x - this._padOffsetX;
            const y = light.y - this._padOffsetY;

            // 获取光源颜色
            const color = light.config?.color || '#FFFF00';
            const bright = light.config?.bright || 20;
            const dim = light.config?.dim || 40;

            ctx.save();

            // 绘制光照范围（半透明圆）
            ctx.globalAlpha = 0.15;
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(x, y, dim, 0, Math.PI * 2);
            ctx.fill();

            ctx.globalAlpha = 0.25;
            ctx.beginPath();
            ctx.arc(x, y, bright, 0, Math.PI * 2);
            ctx.fill();

            // 绘制中心点指示器
            ctx.globalAlpha = 1;
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(x, y, 6, 0, Math.PI * 2);
            ctx.fill();

            // 边框
            ctx.strokeStyle = '#000000';
            ctx.lineWidth = 1;
            ctx.stroke();

            ctx.restore();
        }
    }

    /**
     * 加载图片（带缓存）
     * 使用 fetch + createImageBitmap 实现离线线程解码，大幅提升速度
     */
    _loadImage(src) {
        // 检查缓存
        if (this._imageCache.has(src)) {
            const cached = this._imageCache.get(src);
            // 如果是视频，确保它在播放
            if (cached.tagName === 'VIDEO') {
                if (cached.paused || cached.ended) {
                    cached.currentTime = 0;
                    cached.play().catch(e => ovDebug(`${MODULE_ID} | Auto-play prevented:`, e));
                }
            }
            return Promise.resolve(cached);
        }

        const isVideo = /\.(webm|mp4|m4v)$/i.test(src);

        // 视频：仍使用 HTMLVideoElement
        if (isVideo) {
            return this._loadVideo(src);
        }

        // 图片：使用 fetch + createImageBitmap（离线线程解码，不阻塞主线程）
        return this._loadImageBitmap(src);
    }

    /**
     * 使用 createImageBitmap 加载图片（离线线程解码）
     */
    async _loadImageBitmap(src) {
        try {
            const response = await fetch(src);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const blob = await response.blob();
            const bitmap = await createImageBitmap(blob);
            this._imageCache.set(src, bitmap);
            return bitmap;
        } catch (e) {
            // 降级到传统 Image 方式
            return this._loadImageFallback(src);
        }
    }

    /**
     * 传统 Image 加载方式（降级用）
     */
    _loadImageFallback(src) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            const timeout = setTimeout(() => reject(new Error(`Image load timeout: ${src}`)), 15000);
            img.onload = () => {
                clearTimeout(timeout);
                this._imageCache.set(src, img);
                resolve(img);
            };
            img.onerror = () => {
                clearTimeout(timeout);
                reject(new Error(`Failed to load image: ${src}`));
            };
            img.src = src;
        });
    }

    /**
     * 加载视频
     */
    _loadVideo(src) {
        return new Promise((resolve, reject) => {
            const media = document.createElement('video');
            media.muted = true;
            media.loop = true;
            media.autoplay = true;
            media.playsInline = true;
            media.crossOrigin = 'anonymous';

            media.addEventListener('pause', () => {
                if (!media._manualPause) {
                    media.play().catch(e => ovDebug(`${MODULE_ID} | Resume play prevented:`, e));
                }
            });

            media.addEventListener('ended', () => {
                media.currentTime = 0;
                media.play().catch(e => ovDebug(`${MODULE_ID} | Loop play prevented:`, e));
            });

            const timeout = setTimeout(() => reject(new Error(`Video load timeout: ${src}`)), 15000);

            media.onloadeddata = () => {
                clearTimeout(timeout);
                this._imageCache.set(src, media);
                this._hasVideoContent = true;
                media.play().catch(e => ovDebug(`${MODULE_ID} | Initial play prevented:`, e));
                resolve(media);
            };

            media.onerror = () => {
                clearTimeout(timeout);
                reject(new Error(`Failed to load video: ${src}`));
            };

            media.src = src;
            media.load();
        });
    }

    /**
   * 创建渲染缓存（不含 viewState 变换）
   * 缓存场景内容到离屏 Canvas，以便在平移/缩放时快速重绘
   */
    async _createCacheWithoutTransform() {
        if (!this.canvas) return;

        const cacheKey = SceneRenderer.getCacheKey(this.sceneData, this.options);

        // 1. 尝试从全局缓存获取
        const cached = SceneRenderer.getCachedBitmap(cacheKey);
        if (cached) {
            this._cachedBitmap = cached;
            this._cacheValid = true;
            // ovLog(`${MODULE_ID} | SceneRenderer: Cache Hit ${cacheKey}`);
            return;
        }

        // ovLog(`${MODULE_ID} | SceneRenderer: Cache Miss ${cacheKey}, rendering...`);

        try {
            // 创建离屏 Canvas，尺寸为场景总尺寸
            const offscreen = document.createElement('canvas');
            offscreen.width = this._totalWidth;
            offscreen.height = this._totalHeight;
            const offCtx = offscreen.getContext('2d');

            // 渲染场景内容（不含 viewState 变换）
            await this._renderToContext(offCtx);

            // 创建缓存位图
            if (offscreen.width > 0 && offscreen.height > 0) {
                this._cachedBitmap = await createImageBitmap(offscreen);
                this._cacheValid = true;

                // 存入全局缓存
                SceneRenderer.setCachedBitmap(cacheKey, this._cachedBitmap);
            }
        } catch (e) {
            console.warn(`${MODULE_ID} | SceneRenderer: Failed to create cache`, e);
            this._cacheValid = false;
        }
    }

    /**
     * 渲染场景内容到指定 context（不含 viewState 变换）
     * @param {CanvasRenderingContext2D} ctx - 目标 context
     */
    async _renderToContext(ctx) {
        const scene = this._resolvedSceneData || this._resolveSceneForRender();

        // 清空
        ctx.clearRect(0, 0, this._totalWidth, this._totalHeight);

        ctx.save();

        // 注意：不设置裁切区域，允许用户放大后看到完整的图块内容

        // 1. 绘制背景色（填充整个总画布，包括 padding）
        const bgColor = scene.backgroundColor || '#1a1a2e';
        ctx.fillStyle = bgColor;
        ctx.fillRect(0, 0, this._totalWidth, this._totalHeight);

        await this._drawRenderLayers(ctx, scene);

        ctx.restore();
    }

    async _drawBackground(ctx, scene) {
        if (!scene?.background?.src || !this.canvas) return;

        try {
            const bgImg = await this._loadImage(scene.background.src);
            if (!this.canvas || !bgImg) return;

            const offsetX = scene.background?.offsetX ?? 0;
            const offsetY = scene.background?.offsetY ?? 0;
            ctx.drawImage(
                bgImg,
                this._padOffsetX + offsetX,
                this._padOffsetY + offsetY,
                this._bgWidth,
                this._bgHeight
            );
        } catch (e) {
            console.warn(`${MODULE_ID} | SceneRenderer: Failed to load background`, e);
        }
    }

    async _drawRenderLayers(ctx, scene) {
        const renderLevels = this._renderLevels?.length ? this._renderLevels : [scene];

        for (const renderScene of renderLevels) {
            await this._drawTilesByElevation(ctx, -Infinity, -0.001, renderScene.tiles);
            await this._drawBackground(ctx, renderScene);
            if (!this.canvas) return;
            await this._drawTilesByElevation(ctx, 0, Infinity, renderScene.tiles);
            await this._drawForeground(ctx, renderScene);
        }

        if (this.options.showWalls) {
            this._drawWalls(ctx, scene.walls);
        }

        if (this.options.showLights) {
            this._drawLights(ctx, scene.lights);
        }
    }

    /**
     * 绘制当前层前景
     */
    async _drawForeground(ctx, scene) {
        if (!scene?.foreground?.src || !this.canvas) return;

        try {
            const fgImg = await this._loadImage(scene.foreground.src);
            if (!this.canvas || !fgImg) return;

            const offsetX = scene.foreground?.offsetX ?? scene.background?.offsetX ?? 0;
            const offsetY = scene.foreground?.offsetY ?? scene.background?.offsetY ?? 0;
            ctx.drawImage(
                fgImg,
                this._padOffsetX + offsetX,
                this._padOffsetY + offsetY,
                this._bgWidth,
                this._bgHeight
            );
        } catch (e) {
            // 前景失败就安静跳过，别把整张图弄挂
        }
    }

    /**
     * 从缓存绘制（用于平移/缩放时的快速重绘）
     * 缓存存储的是不含 viewState 变换的场景内容，
     * 绘制时应用当前的 viewState 以实现平移/缩放交互。
     */
    _drawFromCache() {
        if (!this.canvas || !this.ctx) return;

        // 如果缓存无效，尝试降级到完整渲染（可能会卡顿，但比不显示强）
        if (!this._cachedBitmap) {
            // 注意：_renderFull 是 async 的，这里无法 await
            this._renderFull();
            return;
        }

        const ctx = this.ctx;
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        // ★ 先用背景色填充整个 Canvas，确保超出场景范围的区域也有颜色
        const bgColor = this._resolvedSceneData?.backgroundColor || this.sceneData?.backgroundColor || '#1a1a2e';
        ctx.fillStyle = bgColor;
        ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

        ctx.save();
        // 应用当前视图变换（平移 + 缩放）
        ctx.translate(this.viewState.offsetX, this.viewState.offsetY);
        ctx.scale(this.viewState.scale, this.viewState.scale);
        ctx.drawImage(this._cachedBitmap, 0, 0);
        ctx.restore();
    }

    /**
     * 设置交互事件监听
     */
    _setupInteraction() {
        // 将事件绑定到 container 而不是 canvas，以提供更好的交互区域
        this._boundHandlers.wheel = (e) => this._onWheel(e);
        this.container.addEventListener('wheel', this._boundHandlers.wheel, { passive: false });

        this._boundHandlers.mousedown = (e) => this._onMouseDown(e);
        this._boundHandlers.mousemove = (e) => this._onMouseMove(e);
        this._boundHandlers.mouseup = (e) => this._onMouseUp(e);
        this._boundHandlers.mouseleave = (e) => this._onMouseUp(e);

        this.container.addEventListener('mousedown', this._boundHandlers.mousedown);
        this.container.addEventListener('mousemove', this._boundHandlers.mousemove);
        this.container.addEventListener('mouseup', this._boundHandlers.mouseup);
        this.container.addEventListener('mouseleave', this._boundHandlers.mouseleave);

        // 阻止右键菜单弹出（因为右键用于拖拽）
        this._boundHandlers.contextmenu = (e) => e.preventDefault();
        this.container.addEventListener('contextmenu', this._boundHandlers.contextmenu);

        this._boundHandlers.dblclick = (e) => this._onDoubleClick(e);
        this.container.addEventListener('dblclick', this._boundHandlers.dblclick);

        // 默认光标：不显示 grab，因为需要右键才能拖拽
        this.container.style.cursor = 'default';
    }

    /**
     * 滚轮缩放
     */
    _onWheel(e) {
        e.preventDefault();
        if (!this.canvas) return;

        const rect = this.container.getBoundingClientRect(); // 使用容器的 rect
        // 将鼠标坐标从屏幕/容器坐标转换为 Canvas 内部像素坐标
        const mouseX = (e.clientX - rect.left) * (this.canvas.width / rect.width);
        const mouseY = (e.clientY - rect.top) * (this.canvas.height / rect.height);

        // 计算缩放因子 - 优化灵敏度，模拟原生 Foundry 场景
        const delta = e.deltaY > 0 ? 0.92 : 1.08;
        const newScale = Math.max(this.minScale, Math.min(this.maxScale, this.viewState.scale * delta));

        // 以鼠标位置为中心缩放
        const scaleRatio = newScale / this.viewState.scale;
        this.viewState.offsetX = mouseX - (mouseX - this.viewState.offsetX) * scaleRatio;
        this.viewState.offsetY = mouseY - (mouseY - this.viewState.offsetY) * scaleRatio;
        this.viewState.scale = newScale;

        // 使用缓存快速重绘
        this._drawFromCache();
    }

    /**
     * 鼠标按下 - 开始拖拽（仅右键）
     */
    _onMouseDown(e) {
        // 仅右键触发拖拽，模拟 Foundry 原生场景操作
        if (e.button !== 2) return;

        this._isDragging = true;
        this._lastMouseX = e.clientX;
        this._lastMouseY = e.clientY;
        this.container.style.cursor = 'grabbing';
    }

    /**
     * 鼠标移动 - 平移
     */
    _onMouseMove(e) {
        if (!this._isDragging) return;

        // 计算位移，并应用 DPR 系数优化灵敏度
        const dpr = window.devicePixelRatio || 1;
        const deltaX = (e.clientX - this._lastMouseX) * dpr;
        const deltaY = (e.clientY - this._lastMouseY) * dpr;

        this.viewState.offsetX += deltaX;
        this.viewState.offsetY += deltaY;

        this._lastMouseX = e.clientX;
        this._lastMouseY = e.clientY;

        // 使用缓存快速重绘
        this._drawFromCache();
    }

    /**
     * 鼠标松开 - 结束拖拽
     */
    _onMouseUp(e) {
        this._isDragging = false;
        this.container.style.cursor = 'default';
    }

    /**
     * 双击 - 重置视图
     */
    _onDoubleClick(e) {
        this.resetView();
    }

    /**
     * 重置视图到初始状态
     */
    resetView() {
        this.viewState.offsetX = 0;
        this.viewState.offsetY = 0;
        this.viewState.scale = 1;

        this._drawFromCache();
    }

    /**
     * 设置图层可见性
     * @param {string} layer - 'walls' 或 'lights'
     * @param {boolean} visible - 是否可见
     */
    async setLayerVisibility(layer, visible) {
        if (layer === 'walls') {
            this.options.showWalls = visible;
        } else if (layer === 'lights') {
            this.options.showLights = visible;
        }

        // 图层变化需要完整重绘并更新缓存
        this._cacheValid = false;
        await this.render(false);
    }

    /**
     * 切换当前渲染层
     */
    async setLevel(levelId) {
        const resolvedLevelId = SceneRenderer.resolveLevelId(this.sceneData, levelId, this.options);
        if (resolvedLevelId === this._activeLevelId && this._cacheValid) return;

        this.options.levelId = resolvedLevelId;
        this._cacheValid = false;
        this._cachedBitmap = null;
        await this.render(false);
    }

    /**
     * 更新场景数据
     */
    async setSceneData(sceneData) {
        this.sceneData = sceneData;
        this._resolvedSceneData = null;
        this._sceneLevels = [];
        this._activeLevel = null;
        this._activeLevelId = null;
        this._renderLevels = [];
        this._cacheValid = false;
        await this.render(false);
    }

    /**
     * 销毁渲染器，清理资源
     */
    destroy() {
        // 停止动画循环
        this._stopAnimationLoop();

        // 移除事件监听 — 事件绑定在 container 上 (见 _setupInteraction)
        if (this.options.interactive && this.container) {
            this.container.removeEventListener('wheel', this._boundHandlers.wheel);
            this.container.removeEventListener('mousedown', this._boundHandlers.mousedown);
            this.container.removeEventListener('mousemove', this._boundHandlers.mousemove);
            this.container.removeEventListener('mouseup', this._boundHandlers.mouseup);
            this.container.removeEventListener('mouseleave', this._boundHandlers.mouseleave);
            this.container.removeEventListener('contextmenu', this._boundHandlers.contextmenu);
            this.container.removeEventListener('dblclick', this._boundHandlers.dblclick);
        }

        // 停止所有缓存的视频
        if (this._imageCache) {
            for (const media of this._imageCache.values()) {
                if (media.tagName === 'VIDEO') {
                    media._manualPause = true;
                    media.pause();
                    media.src = '';
                    media.load();
                }
            }
            this._imageCache.clear();
        }

        // 清理缓存引用 (不关闭位图，因为可能在全局缓存中)
        this._cachedBitmap = null;
        this._hasVideoContent = false;

        // 移除 Canvas
        if (this.canvas && this.canvas.parentNode) {
            this.canvas.parentNode.removeChild(this.canvas);
        }

        this.canvas = null;
        this.ctx = null;
    }

    // ==================== 静态缓存管理 ====================

    /**
     * 生成缓存键
     */
    static getCacheKey(sceneData, options) {
        options = options || {};
        const id = sceneData.uuid || sceneData._id || sceneData.id;
        const modifiedTime = sceneData._stats?.modifiedTime || 0;
        const levelId = SceneRenderer.resolveLevelId(sceneData, options.levelId, options) || 'base';
        const sceneLevelState = options.enableSceneLevels === false ? 'off' : 'on';
        const levelMode = options.includeLegacyLevels ? 'legacy' : 'native';
        const fallbackMode = options.includeElevationFallback ? '1' : '0';
        const legacyMergeMode = SceneRenderer._shouldMergeLegacyEntryRanges(options, levelId) ? '1' : '0';
        const opts = `${options.showWalls ? '1' : '0'}${options.showLights ? '1' : '0'}_${levelId}_${sceneLevelState}_${levelMode}${fallbackMode}${legacyMergeMode}`;
        const key = `${id}_${modifiedTime}_${opts}`;
        // ovLog(`${MODULE_ID} | getCacheKey: ...`);
        return key;
    }

    static getFoundryGeneration() {
        const directGeneration = Number(globalThis.game?.release?.generation);
        if (Number.isFinite(directGeneration)) return directGeneration;

        const version = globalThis.game?.version
            || globalThis.game?.release?.version
            || globalThis.game?.data?.version
            || '';
        const major = Number.parseInt(String(version).split('.')[0], 10);
        return Number.isFinite(major) ? major : null;
    }

    static isOverviewLevelId(levelId) {
        return levelId === SceneRenderer.OVERVIEW_LEVEL_ID;
    }

    static _shouldMergeLegacyEntryRanges(options = {}, levelId = null) {
        return !!options.mergeLegacyEntryRanges
            || (!!options.includeLegacyLevels && SceneRenderer.isOverviewLevelId(levelId));
    }

    static getDetailLevelOptions() {
        if (!ENABLE_SCENE_BROWSER_ENHANCEMENTS) {
            return {
                enableSceneLevels: false,
                includeLegacyLevels: false,
                includeElevationFallback: false
            };
        }

        const generation = SceneRenderer.getFoundryGeneration();
        if (generation && generation <= 13) {
            return {
                enableSceneLevels: true,
                includeLegacyLevels: true,
                includeElevationFallback: true
            };
        }

        return {
            enableSceneLevels: true,
            includeLegacyLevels: false,
            includeElevationFallback: false
        };
    }

    static _coerceLevelNumber(value) {
        if (value === null || value === undefined || value === '') return null;
        if (value === Infinity || value === -Infinity) return value;

        const parsed = Number(value);
        return Number.isNaN(parsed) ? null : parsed;
    }

    static _normalizeLevelRange(bottom, top) {
        bottom = SceneRenderer._coerceLevelNumber(bottom);
        top = SceneRenderer._coerceLevelNumber(top);

        if (bottom === null && top === null) return null;
        if (bottom === null) bottom = top;
        if (top === null) top = bottom;

        return {
            bottom: Math.min(bottom, top),
            top: Math.max(bottom, top)
        };
    }

    static _getLegacyLevelId(index, range) {
        return `legacy-${index}-${range.bottom}-${range.top}`;
    }

    static _formatLegacyLevelName(range) {
        if (!range) return '';
        if (range.bottom === range.top) return String(range.bottom);
        return `${range.bottom} ~ ${range.top}`;
    }

    static _createLegacyLevel(rawLevel, index) {
        let bottom = null;
        let top = null;
        let name = '';

        if (Array.isArray(rawLevel)) {
            [bottom, top, name = ''] = rawLevel;
        } else if (rawLevel && typeof rawLevel === 'object') {
            bottom = rawLevel.rangeBottom ?? rawLevel.bottom ?? rawLevel.elevationBottom ?? rawLevel.elevation?.bottom;
            top = rawLevel.rangeTop ?? rawLevel.top ?? rawLevel.elevationTop ?? rawLevel.elevation?.top;
            name = rawLevel.name ?? rawLevel.label ?? rawLevel.title ?? '';
        }

        const range = SceneRenderer._normalizeLevelRange(bottom, top);
        if (!range) return null;

        return {
            id: SceneRenderer._getLegacyLevelId(index, range),
            name: String(name || '').trim() || SceneRenderer._formatLegacyLevelName(range),
            index,
            elevation: range,
            visibility: { levels: [] },
            legacy: true
        };
    }

    static _getCollectionEntries(collection) {
        const list = collection?.contents || collection || [];
        return Array.isArray(list) ? list : [];
    }

    static _getEntryLevelRange(entry, options = {}) {
        if (!entry) return null;

        if (entry.elevation && typeof entry.elevation === 'object') {
            return SceneRenderer._normalizeLevelRange(entry.elevation.bottom, entry.elevation.top);
        }

        if (options.includeLegacyLevels) {
            const wallRange = SceneRenderer._normalizeLevelRange(
                entry.flags?.['wall-height']?.bottom,
                entry.flags?.['wall-height']?.top
            );
            if (wallRange) return wallRange;

            const levelsFlags = entry.flags?.levels || {};
            const legacyRange = SceneRenderer._normalizeLevelRange(
                levelsFlags.rangeBottom ?? entry.elevation,
                levelsFlags.rangeTop
            );
            if (legacyRange) return legacyRange;
        }

        return SceneRenderer._normalizeLevelRange(entry.elevation, entry.elevation);
    }

    static _getEntrySortElevation(entry, options = {}) {
        const range = SceneRenderer._getEntryLevelRange(entry, options);
        return range?.bottom ?? 0;
    }

    static _getTileTextureSource(tile) {
        return tile?.texture?.src || tile?.src || tile?.img || '';
    }

    static _getTileDrawRect(tile, options = {}) {
        const shape = tile?.shape || {};
        const texture = tile?.texture || {};
        const textureOffset = texture.offset || {};

        const x = SceneRenderer._coerceTextureOffset(tile?.x, SceneRenderer._coerceTextureOffset(shape.x, 0));
        const y = SceneRenderer._coerceTextureOffset(tile?.y, SceneRenderer._coerceTextureOffset(shape.y, 0));
        const width = SceneRenderer._coerceTextureOffset(tile?.width, SceneRenderer._coerceTextureOffset(shape.width, 0));
        const height = SceneRenderer._coerceTextureOffset(tile?.height, SceneRenderer._coerceTextureOffset(shape.height, 0));
        const offsetX = SceneRenderer._coerceTextureOffset(texture.offsetX ?? textureOffset.x, 0);
        const offsetY = SceneRenderer._coerceTextureOffset(texture.offsetY ?? textureOffset.y, 0);
        const hasAnchorX = texture.anchorX !== undefined && texture.anchorX !== null;
        const hasAnchorY = texture.anchorY !== undefined && texture.anchorY !== null;
        const anchorX = hasAnchorX ? SceneRenderer._coerceTextureOffset(texture.anchorX, 0) : 0;
        const anchorY = hasAnchorY ? SceneRenderer._coerceTextureOffset(texture.anchorY, 0) : 0;
        const generation = SceneRenderer.getFoundryGeneration();
        const canUseTextureAnchor = !generation || generation >= 14;
        const useTextureAnchor = canUseTextureAnchor && !options.includeLegacyLevels && (hasAnchorX || hasAnchorY);
        const drawX = x - (useTextureAnchor ? width * anchorX : 0) + offsetX;
        const drawY = y - (useTextureAnchor ? height * anchorY : 0) + offsetY;

        return {
            // V14 tile 的 x/y 是 anchor 点；V13 Levels 仍按旧左上角语义走，别把老包一起拉偏。
            x: drawX,
            y: drawY,
            width: Math.max(0, width),
            height: Math.max(0, height),
            rotationX: useTextureAnchor && hasAnchorX ? x + offsetX : drawX + (width / 2),
            rotationY: useTextureAnchor && hasAnchorY ? y + offsetY : drawY + (height / 2)
        };
    }

    static _collectLegacyLevelsFromEntries(sceneData) {
        const entries = [
            ...SceneRenderer._getCollectionEntries(sceneData?.tiles),
            ...SceneRenderer._getCollectionEntries(sceneData?.lights),
            ...SceneRenderer._getCollectionEntries(sceneData?.walls)
        ];
        const uniqueLevels = new Map();

        for (const entry of entries) {
            const range = SceneRenderer._getEntryLevelRange(entry, { includeLegacyLevels: true });
            if (!range) continue;

            const key = `${range.bottom}:${range.top}`;
            if (!uniqueLevels.has(key)) {
                uniqueLevels.set(key, {
                    range,
                    index: uniqueLevels.size
                });
            }
        }

        return [...uniqueLevels.values()]
            .sort((a, b) => {
                if (a.range.bottom !== b.range.bottom) return a.range.bottom - b.range.bottom;
                if (a.range.top !== b.range.top) return a.range.top - b.range.top;
                return a.index - b.index;
            })
            .map(({ range }, index) => SceneRenderer._createLegacyLevel([range.bottom, range.top, ''], index))
            .filter(Boolean);
    }

    static _mergeLegacySceneLevels(sceneLevels = [], entryLevels = []) {
        const byRange = new Map();
        const mergedLevels = [];

        for (const level of [...sceneLevels, ...entryLevels]) {
            const range = level?.elevation;
            if (!range) continue;

            const key = `${range.bottom}:${range.top}`;
            if (byRange.has(key)) continue;

            byRange.set(key, true);
            mergedLevels.push(level);
        }

        return mergedLevels;
    }

    static _getLegacySceneLevels(sceneData, options = {}) {
        const rawLevels = sceneData?.flags?.levels?.sceneLevels;
        if (Array.isArray(rawLevels) && rawLevels.length) {
            const parsedLevels = rawLevels
                .map((level, index) => SceneRenderer._createLegacyLevel(level, index))
                .filter(Boolean);

            if (parsedLevels.length) {
                if (options.mergeLegacyEntryRanges) {
                    return SceneRenderer._mergeLegacySceneLevels(
                        parsedLevels,
                        SceneRenderer._collectLegacyLevelsFromEntries(sceneData)
                    );
                }
                return parsedLevels;
            }

            if (!options.includeElevationFallback && !options.mergeLegacyEntryRanges) return [];
        }

        if (options.includeElevationFallback || options.mergeLegacyEntryRanges) {
            return SceneRenderer._collectLegacyLevelsFromEntries(sceneData);
        }

        return [];
    }

    static _getNativeSceneLevels(sceneData) {
        const rawLevels = sceneData?.levels;
        const levelList = rawLevels?.contents || rawLevels || [];
        if (!Array.isArray(levelList)) return [];

        return levelList
            .filter(level => level && (level._id || level.id))
            .map((level, index) => ({
                ...level,
                id: level._id || level.id,
                index
            }));
    }

    /**
     * 提取场景 level 列表
     */
    static getSceneLevels(sceneData, options = {}) {
        if (!sceneData) return [];
        if (options.enableSceneLevels === false) return [];

        // V13 只认老的 Levels 数据，别和 V14 原生 levels 混着猜。
        if (options.includeLegacyLevels) {
            return SceneRenderer._getLegacySceneLevels(sceneData, options);
        }

        return SceneRenderer._getNativeSceneLevels(sceneData);
    }

    /**
     * 解析默认 level
     */
    static getDefaultLevelId(sceneData, options = {}) {
        const levels = SceneRenderer.getSceneLevels(sceneData, options);
        if (!levels.length) return null;

        return SceneRenderer._getTopLevel(levels)?.id || levels[0].id;
    }

    /**
     * 解析最终要渲染的 level
     */
    static resolveLevelId(sceneData, preferredLevelId = null, options = {}) {
        const levels = SceneRenderer.getSceneLevels(sceneData, options);
        if (!levels.length) return null;

        if (SceneRenderer.isOverviewLevelId(preferredLevelId)) {
            return SceneRenderer.OVERVIEW_LEVEL_ID;
        }

        if (preferredLevelId && levels.some(level => level.id === preferredLevelId)) {
            return preferredLevelId;
        }

        return SceneRenderer.getDefaultLevelId(sceneData, options);
    }

    /**
     * 根据可见 level 集合过滤集合
     */
    static _filterCollectionByLevel(collection, visibleLevels = [], visibleLevelIds = null, options = {}) {
        const list = collection?.contents || collection || [];
        if (!Array.isArray(list) || !visibleLevels.length) return list;

        const visibleIdSet = visibleLevelIds instanceof Set
            ? visibleLevelIds
            : new Set(visibleLevels.map(level => level?.id).filter(Boolean));

        return list.filter(entry => SceneRenderer._matchesLevel(entry, visibleLevels, visibleIdSet, options));
    }

    static _rangeContainsElevation(range, elevation, options = {}) {
        if (!range || typeof elevation !== 'number') return false;

        if (options.includeLegacyLevels || range.bottom === range.top) {
            return elevation >= range.bottom && elevation <= range.top;
        }

        return elevation >= range.bottom && elevation < range.top;
    }

    static _rangesOverlap(entryRange, levelRange, options = {}) {
        if (!entryRange || !levelRange) return false;

        const entryIsPoint = entryRange.bottom === entryRange.top;
        const levelIsPoint = levelRange.bottom === levelRange.top;

        if (entryIsPoint && levelIsPoint) {
            return entryRange.bottom === levelRange.bottom;
        }

        if (entryIsPoint) {
            return SceneRenderer._rangeContainsElevation(levelRange, entryRange.bottom, options);
        }

        if (levelIsPoint) {
            return SceneRenderer._rangeContainsElevation(entryRange, levelRange.bottom, options);
        }

        if (options.includeLegacyLevels) {
            return entryRange.bottom <= levelRange.top && entryRange.top >= levelRange.bottom;
        }

        return entryRange.bottom < levelRange.top && entryRange.top > levelRange.bottom;
    }

    static _legacyLevelContainsAnchor(levelRange, elevation) {
        if (!levelRange || typeof elevation !== 'number') return false;
        if (levelRange.bottom === levelRange.top) return elevation === levelRange.bottom;
        return elevation >= levelRange.bottom && elevation < levelRange.top;
    }

    static _matchesLevel(entry, visibleLevels = [], visibleLevelIds = new Set(), options = {}) {
        if (!entry || !visibleLevels.length) return true;

        const entryLevels = Array.isArray(entry.levels)
            ? entry.levels.filter(Boolean)
            : [];
        if (!options.includeLegacyLevels && entryLevels.length > 0) {
            return entryLevels.some(levelId => visibleLevelIds.has(levelId));
        }

        const entryRange = SceneRenderer._getEntryLevelRange(entry, options);
        if (!entryRange) return true;

        if (options.includeLegacyLevels) {
            return visibleLevels.some(level => {
                const levelRange = level?.elevation || null;
                return SceneRenderer._legacyLevelContainsAnchor(levelRange, entryRange.bottom);
            });
        }

        return visibleLevels.some(level => {
            const levelRange = level?.elevation || null;
            return SceneRenderer._rangesOverlap(entryRange, levelRange, options);
        });
    }

    static _coerceTextureOffset(value, fallback = 0) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    static _buildLevelTexture(sceneTexture = null, levelTexture = null) {
        if (!levelTexture?.src) return null;

        return {
            ...(sceneTexture || {}),
            ...levelTexture,
            // V14 原生 level 的贴图和 placeable 共用场景坐标，不能把主场景 offset 再套一遍。
            offsetX: SceneRenderer._coerceTextureOffset(levelTexture.offsetX, 0),
            offsetY: SceneRenderer._coerceTextureOffset(levelTexture.offsetY, 0)
        };
    }

    static _buildLevelScene(sceneData, level, { fallbackToSceneBackground = false, filterOptions = {} } = {}) {
        const levelIdSet = new Set([level.id]);

        return {
            id: level.id,
            index: level.index,
            background: level.background?.src
                ? SceneRenderer._buildLevelTexture(sceneData.background, level.background)
                : (fallbackToSceneBackground ? sceneData.background : null),
            foreground: level.foreground?.src
                ? SceneRenderer._buildLevelTexture(sceneData.foreground, level.foreground)
                : (fallbackToSceneBackground ? sceneData.foreground : null),
            tiles: SceneRenderer._filterCollectionByLevel(sceneData.tiles, [level], levelIdSet, filterOptions),
            walls: SceneRenderer._filterCollectionByLevel(sceneData.walls, [level], levelIdSet, filterOptions),
            lights: SceneRenderer._filterCollectionByLevel(sceneData.lights, [level], levelIdSet, filterOptions)
        };
    }

    static _isLevelAboveActive(level, activeLevel) {
        if (!level || !activeLevel || level.id === activeLevel.id) return false;

        const levelBottom = Number.isFinite(level?.elevation?.bottom) ? level.elevation.bottom : null;
        const activeBottom = Number.isFinite(activeLevel?.elevation?.bottom) ? activeLevel.elevation.bottom : null;

        if (typeof levelBottom === 'number' && typeof activeBottom === 'number') {
            return levelBottom > activeBottom;
        }

        return (level.index ?? 0) > (activeLevel.index ?? 0);
    }

    static _getLevelSortValue(level) {
        return Number.isFinite(level?.elevation?.bottom) ? level.elevation.bottom : (level?.index ?? 0);
    }

    static _sortLevelsForRender(levels) {
        return [...levels].sort((a, b) => {
            const aBottom = SceneRenderer._getLevelSortValue(a);
            const bBottom = SceneRenderer._getLevelSortValue(b);
            if (aBottom !== bBottom) return aBottom - bBottom;
            return (a.index ?? 0) - (b.index ?? 0);
        });
    }

    static _getTopLevel(levels) {
        const sortedLevels = SceneRenderer._sortLevelsForRender(levels);
        return sortedLevels[sortedLevels.length - 1] || null;
    }

    /**
     * 构造当前 level 的渲染数据
     */
    static buildRenderScene(sceneData, preferredLevelId = null, options = {}) {
        let activeLevelId = SceneRenderer.resolveLevelId(sceneData, preferredLevelId, options);
        let renderOptions = options;

        if (SceneRenderer._shouldMergeLegacyEntryRanges(options, activeLevelId)) {
            renderOptions = {
                ...options,
                mergeLegacyEntryRanges: true
            };
        }

        const levels = SceneRenderer.getSceneLevels(sceneData, renderOptions);
        if (SceneRenderer.isOverviewLevelId(preferredLevelId) && levels.length) {
            activeLevelId = SceneRenderer.OVERVIEW_LEVEL_ID;
        } else if (!levels.some(level => level.id === activeLevelId)) {
            activeLevelId = SceneRenderer.resolveLevelId(sceneData, activeLevelId, renderOptions);
        }
        const isOverview = SceneRenderer.isOverviewLevelId(activeLevelId);
        const activeLevel = isOverview
            ? SceneRenderer._getTopLevel(levels)
            : (levels.find(level => level.id === activeLevelId) || null);

        if (!activeLevel) {
            return {
                sceneData,
                levels,
                activeLevelId: null,
                activeLevel: null,
                renderLevels: []
            };
        }

        const visibleLevelIds = new Set([activeLevelId]);
        const extraVisibleLevels = Array.isArray(activeLevel.visibility?.levels)
            ? activeLevel.visibility.levels
            : [];

        // OV 的预览视角按“站在当前层往下看”处理：当前层以下都应该能看到，当前层以上不画。
        for (const level of levels) {
            if (!SceneRenderer._isLevelAboveActive(level, activeLevel)) {
                visibleLevelIds.add(level.id);
            }
        }

        if (!renderOptions.includeLegacyLevels) {
            for (const levelId of extraVisibleLevels) {
                if (levels.some(level => level.id === levelId)) {
                    visibleLevelIds.add(levelId);
                }
            }
        }

        const visibleLevels = SceneRenderer._sortLevelsForRender(levels
            // 预览里先别把上层整面屋顶也画进来，不然低层基本没法看
            .filter(level => visibleLevelIds.has(level.id) && !SceneRenderer._isLevelAboveActive(level, activeLevel)));

        const background = activeLevel.background?.src
            ? SceneRenderer._buildLevelTexture(sceneData.background, activeLevel.background)
            : sceneData.background;

        const foreground = activeLevel.foreground?.src
            ? SceneRenderer._buildLevelTexture(sceneData.foreground, activeLevel.foreground)
            : sceneData.foreground;

        // 场景底图永远垫在最下面；总览从最高层往下看，但不能让底图最后盖掉低层内容。
        const sceneBaseLevelId = visibleLevels[0]?.id;
        const renderLevels = visibleLevels.map(level => SceneRenderer._buildLevelScene(sceneData, level, {
            fallbackToSceneBackground: level.id === sceneBaseLevelId,
            filterOptions: renderOptions
        }));

        return {
            sceneData: {
                ...sceneData,
                background,
                foreground,
                backgroundColor: activeLevel.background?.color || sceneData.backgroundColor,
                tiles: SceneRenderer._filterCollectionByLevel(sceneData.tiles, visibleLevels, visibleLevelIds, renderOptions),
                walls: SceneRenderer._filterCollectionByLevel(sceneData.walls, visibleLevels, visibleLevelIds, renderOptions),
                lights: SceneRenderer._filterCollectionByLevel(sceneData.lights, visibleLevels, visibleLevelIds, renderOptions)
            },
            levels,
            activeLevelId,
            activeLevel,
            renderLevels,
            visibleLevelIds: [...visibleLevelIds]
        };
    }

    _resolveSceneForRender() {
        const resolved = SceneRenderer.buildRenderScene(this.sceneData, this.options.levelId, this.options);
        this._resolvedSceneData = resolved.sceneData;
        this._sceneLevels = resolved.levels;
        this._activeLevel = resolved.activeLevel;
        this._activeLevelId = resolved.activeLevelId;
        this._renderLevels = resolved.renderLevels || [];

        if (resolved.activeLevelId && this.options.levelId !== resolved.activeLevelId) {
            this.options.levelId = resolved.activeLevelId;
        }

        return this._resolvedSceneData;
    }

    /**
     * 获取缓存的位图
     */
    static getCachedBitmap(key) {
        const entry = SceneRenderer.cache.get(key);
        if (entry) {
            // LRU: 刷新访问时间 (重新插入到 Map 末尾)
            SceneRenderer.cache.delete(key);
            SceneRenderer.cache.set(key, entry);
            return entry.bitmap;
        }
        return null;
    }

    /**
     * 设置缓存
     */
    static setCachedBitmap(key, bitmap) {
        // ovLog(`${MODULE_ID} | setCachedBitmap: ...`);
        const newPixels = bitmap.width * bitmap.height;

        // 如果已存在，先移除旧的像素计数
        if (SceneRenderer.cache.has(key)) {
            const old = SceneRenderer.cache.get(key);
            SceneRenderer._totalCachedPixels -= (old.pixels || 0);
            SceneRenderer.cache.delete(key);
        }

        // 淘汰策略：数量超限 或 像素总量超限
        while (
            SceneRenderer.cache.size >= SceneRenderer.MAX_CACHE_SIZE ||
            (SceneRenderer._totalCachedPixels + newPixels > SceneRenderer.MAX_CACHE_PIXELS && SceneRenderer.cache.size > 0)
        ) {
            const firstKey = SceneRenderer.cache.keys().next().value;
            const oldEntry = SceneRenderer.cache.get(firstKey);
            if (oldEntry) {
                SceneRenderer._totalCachedPixels -= (oldEntry.pixels || 0);
                if (oldEntry.bitmap) oldEntry.bitmap.close();
            }
            SceneRenderer.cache.delete(firstKey);
        }

        SceneRenderer._totalCachedPixels += newPixels;
        SceneRenderer.cache.set(key, { bitmap, timestamp: Date.now(), pixels: newPixels });
    }
}
