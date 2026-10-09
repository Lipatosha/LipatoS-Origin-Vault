/**
 * Origin Vault - 适配器基类（aka 万能接口模板）
 * ---------------------------------------------------
 * 这是所有资源适配器的祖宗。
 * 不管你是管文件的、管场景的、还是管什么奇奇怪怪东西的，
 * 都得先拜这个码头，把这几个方法给我实现了。
 * 
 * 本身啥活都不干，纯粹是个架子。
 * 你要是觉得它没用，那说明你还没体会过"统一接口"四个字有多香。
 */
export class VaultAdapter {
    /**
     * 给适配器安个家，告诉它资源库在哪
     * @param {string} libraryPath - 资源库路径
     */
    constructor(libraryPath) {
        this.libraryPath = libraryPath;
    }

    /**
     * 初始化适配器（子类自己看着办，爱干嘛干嘛）
     * @returns {Promise<void>}
     */
    async init() { }

    /**
     * 获取某个文件夹下的所有东西
     * 子类不实现的话就返回空数组，代表"我这儿啥也没有"
     * @param {string} folderId 
     * @returns {Promise<Array>}
     */
    async getItems(folderId) { return []; }

    /**
     * 获取所有文件夹列表
     * @returns {Promise<Array>}
     */
    async getFolders() { return []; }

    /**
     * 搜索功能，子类不实现就等于"搜不到，别找了"
     * @param {string} query 
     * @param {object} filters 
     * @returns {Promise<Array>}
     */
    async search(query, filters = {}) { return []; }

    /**
     * 获取某个资源的详细信息（右侧详情面板要用）
     * @param {string} itemId 
     * @returns {Promise<object>}
     */
    async getItemDetails(itemId) { return null; }

    /**
     * 导入资源。有些适配器不支持导入，那就直接返回 false 装死
     * @param {string|object} source 
     * @returns {Promise<boolean>}
     */
    async importItem(source) { return false; }

    /**
     * 激活资源（比如场景需要"切换到此场景"的操作）
     * 大多数资源类型用不上，所以默认也是装死
     * @param {string} itemId
     * @returns {Promise<boolean>}
     */
    async activateItem(itemId) { return false; }
}
