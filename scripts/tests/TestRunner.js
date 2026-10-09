/**
 * Origin Vault - 轻量集成测试框架
 * 零依赖，在 Foundry 控制台运行
 * 
 * 使用方式：GM 在控制台输入 ovRunTests()
 */

export class TestRunner {
    constructor(moduleName = 'Origin Vault') {
        this.moduleName = moduleName;
        this.results = [];
        this.currentGroup = null;
    }

    /**
     * 定义测试组
     */
    group(name) {
        this.currentGroup = name;
        console.log(`\n📂 ${name}`);
    }

    /**
     * 运行单个测试
     * @param {string} name - 测试名称
     * @param {Function} fn - 测试函数（支持 async）
     */
    async run(name, fn) {
        const label = this.currentGroup ? `  ${name}` : name;
        try {
            await fn();
            this.results.push({ group: this.currentGroup, name, pass: true });
            console.log(`  ✅ ${name}`);
        } catch (e) {
            this.results.push({ group: this.currentGroup, name, pass: false, error: e.message });
            console.error(`  ❌ ${name}: ${e.message}`);
        }
    }

    /**
     * 输出测试汇总
     */
    summary() {
        const pass = this.results.filter(r => r.pass).length;
        const fail = this.results.length - pass;
        const total = this.results.length;

        console.log('\n' + '='.repeat(50));
        if (fail === 0) {
            console.log(`🎉 全部通过！${pass}/${total} 个测试`);
        } else {
            console.log(`⚠️ ${fail} 个失败, ${pass} 个通过 (共 ${total} 个)`);
            console.log('\n失败详情:');
            this.results.filter(r => !r.pass).forEach(r => {
                console.log(`  ❌ [${r.group}] ${r.name}: ${r.error}`);
            });
        }
        console.log('='.repeat(50));

        return { pass, fail, total, results: this.results };
    }
}

export function combineSummaries(summaries = []) {
    const mergedResults = summaries.flatMap(summary => Array.isArray(summary?.results) ? summary.results : []);
    const pass = mergedResults.filter(result => result.pass).length;
    const fail = mergedResults.length - pass;
    const total = mergedResults.length;
    return { pass, fail, total, results: mergedResults };
}

/**
 * 断言工具集
 */
export const assert = {
    /** 条件为真 */
    ok(value, msg = '期望为 truthy') {
        if (!value) throw new Error(msg);
    },

    /** 严格相等 */
    equal(actual, expected, msg) {
        if (actual !== expected) {
            throw new Error(msg || `期望 ${expected}, 实际 ${actual}`);
        }
    },

    /** 不相等 */
    notEqual(actual, expected, msg) {
        if (actual === expected) {
            throw new Error(msg || `不应等于 ${expected}`);
        }
    },

    /** 包含 */
    includes(arr, item, msg) {
        if (!arr || !arr.includes(item)) {
            throw new Error(msg || `期望包含 ${item}`);
        }
    },

    /** 类型检查 */
    typeOf(value, type, msg) {
        if (typeof value !== type) {
            throw new Error(msg || `期望类型 ${type}, 实际 ${typeof value}`);
        }
    },

    /** 正则匹配 */
    match(value, pattern, msg) {
        if (!pattern.test(String(value ?? ''))) {
            throw new Error(msg || `期望 "${value}" 匹配 ${pattern}`);
        }
    },

    /** 期望异步抛错 */
    async rejects(fn, expected, msg) {
        try {
            await fn();
        } catch (error) {
            if (!expected) return error;
            if (expected instanceof RegExp) {
                if (!expected.test(error?.message || '')) {
                    throw new Error(msg || `错误信息 "${error?.message}" 未匹配 ${expected}`);
                }
                return error;
            }
            if (typeof expected === 'function') {
                const ok = await expected(error);
                if (!ok) {
                    throw new Error(msg || `错误未通过自定义校验: ${error?.message || error}`);
                }
                return error;
            }
            if ((error?.message || '') !== expected) {
                throw new Error(msg || `期望错误 "${expected}"，实际 "${error?.message || error}"`);
            }
            return error;
        }

        throw new Error(msg || '期望抛出错误，但实际没有抛出');
    },

    /** DOM 元素存在 */
    elementExists(selector, container, msg) {
        const el = (container || document).querySelector(selector);
        if (!el) throw new Error(msg || `元素 "${selector}" 不存在`);
        return el;
    },

    /** DOM 元素数量 */
    elementCount(selector, min, container, msg) {
        const els = (container || document).querySelectorAll(selector);
        if (els.length < min) {
            throw new Error(msg || `"${selector}" 数量 ${els.length} < ${min}`);
        }
    }
};
