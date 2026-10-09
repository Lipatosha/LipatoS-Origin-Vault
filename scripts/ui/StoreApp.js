/**
 * Origin Vault - Extensions Store UI
 */
import { MarketplaceService } from '../data/MarketplaceService.js';
import { MODULE_ID } from '../constants.js';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class StoreApp extends HandlebarsApplicationMixin(ApplicationV2) {
    constructor(options = {}) {
        super(options);
        this.packages = [];
        this.loading = true;
    }

    static DEFAULT_OPTIONS = {
        id: 'origin-vault-store',
        tag: 'form',
        window: {
            title: 'origin-vault.store.title',
            icon: 'fas fa-shopping-basket',
            resizable: true,
            controls: [
                {
                    icon: 'fas fa-sync',
                    label: 'origin-vault.store.refresh',
                    action: 'refresh',
                }
            ]
        },
        position: {
            width: 900,
            height: 600
        },
        actions: {
            installPackage: StoreApp._onInstallPackage,
            enablePackage: StoreApp._onEnablePackage,
            refresh: StoreApp._onRefresh
        },
        classes: ['origin-vault', 'ov-store-window', 'window-app-v2']
    };

    static PARTS = {
        store: {
            template: `modules/${MODULE_ID}/templates/store-window.hbs`,
            scrollable: ['.ov-store-content']
        }
    };

    async _prepareContext(options) {
        // Initial fetch if empty
        if (this.loading) {
            this.packages = await MarketplaceService.getPackages();
            this.loading = false;
        }

        // Process packages for view state
        const packagesView = this.packages.map(pkg => {
            const isInstalled = MarketplaceService.isInstalled(pkg.id);
            const isEnabled = MarketplaceService.isEnabled(pkg.id);

            return {
                ...pkg,
                installed: isInstalled,
                enabled: isEnabled,
                isNew: !isInstalled // Simplified logic for now
            };
        });

        return {
            packages: packagesView,
            loading: this.loading
        };
    }

    /* -------------------------------------------- */
    /*  Event Actions                               */
    /* -------------------------------------------- */

    static async _onInstallPackage(event, target) {
        const pkgId = target.dataset.packageId;
        const pkg = this.packages.find(p => p.id === pkgId);

        if (!pkg) return;

        // Visual feedback (using button content directly since V2 avoids jQuery)
        const originalIcon = target.innerHTML;
        target.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Downloading...';
        target.disabled = true;

        try {
            const success = await MarketplaceService.installPackage(pkg.manifest);
            if (success) {
                // Auto-enable
                await MarketplaceService.enablePackage(pkg.id);

                // Show Reload Dialog
                await MarketplaceService.promptReload(pkg.title);

                // Re-render to update state
                this.render();
            } else {
                // Reset button on failure
                target.innerHTML = originalIcon;
                target.disabled = false;
            }
        } catch (e) {
            console.error(e);
            target.innerHTML = originalIcon;
            target.disabled = false;
        }
    }

    static async _onEnablePackage(event, target) {
        const pkgId = target.dataset.packageId;
        const pkg = this.packages.find(p => p.id === pkgId);

        if (!pkg) return;

        await MarketplaceService.enablePackage(pkg.id);
        await MarketplaceService.promptReload(pkg.title);
        this.render();
    }

    static async _onRefresh(event, target) {
        this.loading = true;
        this.render();
        // The next render cycle will trigger _prepareContext which fetches data because this.loading is true
        // However, since _prepareContext is async, we can just fetch here too for clarity or let the state handle it.
        // Better pattern: fetch, then set loading false, then render.
        // But to keep consistent with constructor:
        this.packages = await MarketplaceService.getPackages();
        this.loading = false;
        this.render();
    }
}
