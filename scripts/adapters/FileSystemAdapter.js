/**
 * Origin Vault - 文件系统适配器（aka 跑腿小弟）
 * ---------------------------------------------------
 * 负责管理硬盘里那些普通的图片、音频、视频文件。
 * 说白了就是 LibraryData 的包装纸，穿了件"适配器"的马甲。
 * 
 * 坦白说这个类现在有点尴尬 —— 
 * 真正干活的是 LibraryData 和 FileBrowser，它只是在中间传话。
 * 以后有空会把文件浏览逻辑从 UI 层下沉到这里…… 大概吧。
 */
import { VaultAdapter } from './VaultAdapter.js';
import { LibraryData } from '../data/LibraryData.js';
import { ASSET_TYPES } from '../constants.js';

export class FileSystemAdapter extends VaultAdapter {
    constructor(libraryPath) {
        super(libraryPath);
        // 找到咱们的仓库管理员，后面全靠它
        this.library = LibraryData.getInstance();
    }

    async init() {
        // LibraryData 一般在 main.js 里就初始化好了，
        // 但保险起见还是检查一下，省得出了事要我背锅
        if (!this.library.data()) {
            await this.library.load();
        }
    }

    /**
     * 获取文件夹下的文件资源
     * 
     * 这里要吐槽一下架构债：
     * - LibraryData 管元数据（虚拟文件夹体系）
     * - FileBrowser 管物理文件扫描（直接翻硬盘）
     * - 两边各管各的，这个适配器夹在中间左右为难
     * 
     * 理想情况下应该把 FileBrowser 的扫盘逻辑搬到这里来，
     * 但工程量太大了，先欠着这笔技术债。
     * 所以目前它只能返回空数组，真正的活还是 FileBrowser 在干。
     */
    async getItems(folderId) {
        const folder = this.library.getFolder(folderId);
        if (!folder) return [];

        // TODO: 等我有勇气重构的那天，这里会变成真正的文件获取逻辑
        // 目前这个方法就是个摆设，别指望它干活
        return [];
    }

    /**
     * 获取所有文件夹 —— 这个倒是能用，直接问仓库管理员要
     */
    async getFolders() {
        return this.library.getAllFolders();
    }
}
