import { ovText } from '../utils/locale.js';
/**
 * Origin Vault - Marketplace Service
 * Handle remote package fetching and installation via Setup redirect
 * 
 * NOTE: Foundry VTT's /setup API blocks ALL package management when a world is running.
 * The only compliant way to install modules is to redirect the user to the Setup page.
 */

import { MODULE_ID } from '../constants.js';
import { appendToOverlayHost } from '../utils/overlayHost.js';
import { t } from '../utils/i18n.js';
import { ovLog } from '../utils/logger.js';

export class MarketplaceService {
    /**
     * Remote manifest URL (Placeholder for now)
     */
    static REMOTE_MANIFEST_URL = 'https://raw.githubusercontent.com/your-repo/extensions.json';

    /**
     * Fetch available packages from the remote source
     * @returns {Promise<Array>} List of package objects
     */
    static async getPackages() {
        try {
            // Mock Data for Development
            return [
                {
                    id: 'foundry-hourglass',
                    title: 'Foundry Hourglass',
                    version: '1.0.0',
                    manifest: 'https://github.com/Octarines/FoundryHourglass/releases/latest/download/module.json',
                    thumbnail: 'https://raw.githubusercontent.com/Octarines/FoundryHourglass/master/src/assets/hourglass.png',
                    description: ovText('A simple hourglass timer module for Foundry VTT.', 'Простой модуль таймера в виде песочных часов для Foundry VTT.'),
                    author: 'Octarines',
                    size: 'Unknown',
                    type: 'module'
                }
            ];
        } catch (error) {
            console.error(`${MODULE_ID} | Failed to load marketplace packages:`, error);
            ui.notifications.error(t('origin-vault.params.errorLoadingStore'));
            return [];
        }
    }

    /**
     * Check if a package is installed
     * @param {string} packageId 
     * @returns {boolean}
     */
    static isInstalled(packageId) {
        return game.modules.has(packageId);
    }

    /**
     * Check if a package is enabled
     * @param {string} packageId 
     * @returns {boolean}
     */
    static isEnabled(packageId) {
        const module = game.modules.get(packageId);
        return module?.active || false;
    }

    // ─── Setup Redirect Installation ──────────────────────────────────────

    /**
     * Install a package by guiding user to the Setup page
     * NOTE: Foundry VTT blocks ALL /setup API calls when a world is running.
     * So we must guide the user to the Setup page instead.
     * @param {string} manifestUrl 
     * @returns {Promise<boolean>} Success (user confirmed redirect)
     */
    static async installPackage(manifestUrl) {
        if (!game.user.isGM) {
            ui.notifications.error(ovText("Only GMs can install extensions.", "Только мастер может устанавливать расширения."));
            return false;
        }

        try {
            // Copy manifest URL to clipboard
            await navigator.clipboard.writeText(manifestUrl);

            // Show dialog guiding user to Setup page
            const confirmed = await this._showSetupRedirectDialog(manifestUrl);
            if (confirmed) {
                // Navigate to setup page — user will need to auth and paste the manifest URL
                // We open in the same tab to ensure they leave the world properly
                window.location.href = "/setup";
            }
            return confirmed;
        } catch (error) {
            console.error(`${MODULE_ID} | Install guidance failed:`, error);
            ui.notifications.error(`${ovText("Installation failed:", "Ошибка установки:")} ${error.message}`);
            return false;
        }
    }

    /**
     * Show a dialog explaining the installation process and offering to redirect to Setup
     * @param {string} manifestUrl - The manifest URL (already copied to clipboard)
     * @returns {Promise<boolean>} Whether user confirmed to go to Setup
     */
    static async _showSetupRedirectDialog(manifestUrl) {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'ov-dialog-overlay';

            overlay.innerHTML = `
                <div class="ov-dialog" style="width: 450px;">
                    <div class="ov-dialog-header">
                        <h3>${t('origin-vault.dialog.adminAuth.title') || 'Install Extension'}</h3>
                        <button class="ov-dialog-close"><i class="fas fa-times"></i></button>
                    </div>
                    <div class="ov-dialog-content">
                        <div style="margin-bottom: 10px;">
                            <p><i class="fas fa-clipboard-check" style="color: #4CAF50;"></i> <strong>${t('origin-vault.dialog.installRedirect.copied') || 'Manifest URL has been copied to your clipboard!'}</strong></p>
                            <p>${t('origin-vault.dialog.installRedirect.instructions') || 'Foundry VTT requires you to install modules from the Setup page. Click "Go to Setup" below, then paste the URL in the "Install Module" dialog.'}</p>
                            <div style="background: var(--color-bg-option, #1a1a2e); border: 1px solid var(--color-border-highlight, #444); border-radius: 4px; padding: 8px; margin-top: 8px; word-break: break-all; font-family: monospace; font-size: 11px; color: var(--color-text-light-highlight, #aaa);">
                                ${manifestUrl}
                            </div>
                        </div>
                    </div>
                    <div class="ov-dialog-footer">
                        <button class="ov-btn ov-btn-secondary" data-action="cancel">
                            <i class="fas fa-times"></i> ${t('origin-vault.dialog.cancel')}
                        </button>
                        <button class="ov-btn ov-btn-primary" data-action="setup">
                            <i class="fas fa-cog"></i> ${t('origin-vault.dialog.installRedirect.goToSetup') || 'Go to Setup'}
                        </button>
                    </div>
                </div>
            `;

            appendToOverlayHost(overlay);

            const close = (result) => {
                overlay.remove();
                resolve(result);
            };

            overlay.querySelector('.ov-dialog-close').addEventListener('click', () => close(false));
            overlay.querySelector('[data-action="cancel"]').addEventListener('click', () => close(false));
            overlay.querySelector('[data-action="setup"]').addEventListener('click', () => close(true));
            overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
        });
    }

    /**
     * Enable a module in world settings
     * @param {string} moduleId 
     * @returns {Promise<void>}
     */
    static async enablePackage(moduleId) {
        if (!game.user.isGM) return;

        try {
            const currentConfig = game.settings.get("core", "moduleConfiguration");
            if (currentConfig[moduleId]) return; // Already enabled

            const newConfig = foundry.utils.deepClone(currentConfig);
            newConfig[moduleId] = true;

            await game.settings.set("core", "moduleConfiguration", newConfig);
            ovLog(`${MODULE_ID} | Auto-enabled module: ${moduleId}`);

        } catch (error) {
            console.error(`${MODULE_ID} | Failed to enable module ${moduleId}:`, error);
        }
    }
}
