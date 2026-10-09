/**
 * Origin Vault - 完整版专属：文件上传功能
 * 包含 FilePicker 拦截（用 OV 替代 Foundry 原生文件浏览器）
 * MAD 版发布时删除此文件，功能自动禁用
 * 
 * V13 兼容策略：
 * 先让原生 FilePicker 正常渲染（满足 FVTTFilePickerControl 的 DOM 检测），
 * 然后隐藏原生 picker 并打开 OV。确认后通过原生 picker 提交路径并关闭。
 */

import { MODULE_ID } from '../constants.js';
import { getFilePickerClasses, resolveFilePickerInterceptMode } from '../utils/filePicker.js';
import { ovLog } from '../utils/logger.js';

/**
 * 标记：文件上传模块已加载
 * 其他模块可通过 window._ovFileUploadEnabled 检查此模块是否存在
 */
window._ovFileUploadEnabled = true;

/**
 * 初始化 FilePicker 拦截
 * @param {typeof MainWindow} MainWindowClass - MainWindow 类引用
 */
export function initFilePickerIntercept(MainWindowClass) {
    /**
     * 创建拦截器函数
     * @param {Function} originalRender - 原始 render 方法
     */
    function createInterceptedRender(originalRender) {
        return function (force, options) {
            try {
                const callback = this.callback;
                const field = this.field;  // V13: {{filePicker}} 通过 fromButton() 绑定目标 input
                const fpType = this.type;
                const current = this.request;
                const opts = (typeof force === 'object') ? force : options;
                const interceptMode = resolveFilePickerInterceptMode(this, opts);

                // 文件夹、侧边栏和手动切回原生的实例继续交给 Foundry。
                if (interceptMode === 'native') {
                    return originalRender.call(this, force, options);
                }

                ovLog(`${MODULE_ID} | Intercepting FilePicker: mode=${interceptMode}, type=${fpType}, current=${current}`);

                // 第一步：让原生 FilePicker 正常渲染
                // 这样 FVTTFilePickerControl 的 DOM 轮询能检测到它
                const renderResult = originalRender.call(this, force, options);

                // 立即将原生 picker 移到屏幕外，避免闪烁
                const fpInstance = this;
                requestAnimationFrame(() => {
                    if (fpInstance.element) {
                        const el = fpInstance.element instanceof jQuery
                            ? fpInstance.element[0]
                            : fpInstance.element;
                        if (el) {
                            el.style.position = 'fixed';
                            el.style.left = '-9999px';
                            el.style.top = '-9999px';
                            el.style.opacity = '0';
                            el.style.pointerEvents = 'none';
                        }
                    }
                });

                // 第二步：短暂延迟后隐藏原生 picker 并打开 OV
                setTimeout(() => {
                    if (fpInstance.element) {
                        const el = fpInstance.element instanceof jQuery
                            ? fpInstance.element[0]
                            : fpInstance.element;
                        if (el) {
                            el.style.display = 'none';
                        }
                    }

                    // 只有真正需要回填路径的 picker 才会走到这里。
                    MainWindowClass.openAsFilePicker({
                        callback,
                        field,
                        type: fpType,
                        current,
                        fpInstance
                    });
                }, 50);

                return renderResult;
            } catch (err) {
                console.error(`${MODULE_ID} | FilePicker intercept failed, falling back to native`, err);
                return originalRender.call(this, force, options);
            }
        };
    }

    // 这里只补原型链拦截，业务调用还是继续走 filePicker helper。
    for (const FilePickerClass of getFilePickerClasses()) {
        if (!FilePickerClass?.prototype || FilePickerClass.prototype._ovIntercepted) continue;

        const originalRender = FilePickerClass.prototype.render;
        FilePickerClass.prototype.render = createInterceptedRender(originalRender);
        FilePickerClass.prototype._ovIntercepted = true;
        ovLog(`${MODULE_ID} | FilePicker intercepted: ${FilePickerClass.name || 'anonymous-class'}`);
    }
}
