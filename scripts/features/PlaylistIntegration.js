import { FILE_TYPES } from '../constants.js';
import { t } from '../utils/i18n.js';

const AUDIO_EXTENSIONS = new Set(FILE_TYPES.AUDIO.map(ext => ext.toLowerCase()));

export function listPlaylists() {
    const playlists = Array.from(globalThis.game?.playlists?.values?.() || []);
    return playlists.map(playlist => ({
        id: playlist.id,
        name: playlist.name,
        soundCount: playlist.sounds?.size ?? playlist.sounds?.contents?.length ?? 0
    }));
}

export function filterAudioItems(items) {
    if (!Array.isArray(items)) return [];
    return items.filter(isAudioItem);
}

export async function addAudioItemsToPlaylist(items, playlistId) {
    requireGM();

    const playlist = globalThis.game?.playlists?.get?.(playlistId);
    if (!playlist) throw new Error('Playlist not found.');

    const inputCount = Array.isArray(items) ? items.length : 0;
    const audioItems = filterAudioItems(items);
    if (!audioItems.length) return { added: 0, skipped: inputCount, playlist };

    const created = await addItemsToPlaylist(playlist, audioItems);
    return {
        added: created.length,
        skipped: inputCount - created.length,
        playlist
    };
}

export async function createPlaylistWithAudioItems(name, items) {
    requireGM();

    const playlistName = String(name || '').trim();
    if (!playlistName) throw new Error('Playlist name is required.');

    const playlist = await getPlaylistDocumentClass().create({ name: playlistName });
    const created = await addItemsToPlaylist(playlist, filterAudioItems(items));
    return { playlist, added: created.length };
}

function isAudioItem(item) {
    return AUDIO_EXTENSIONS.has(getPathExtension(item?.path));
}

async function addItemsToPlaylist(playlist, audioItems) {
    if (!audioItems.length) return [];

    if (typeof playlist.bulkImportSounds === 'function') {
        // V13 的 bulkImportSounds 会顺手跳过已在播放列表里的同路径声音；这里不再自己补一套去重规则。
        const created = await playlist.bulkImportSounds(audioItems.map(item => item.path));
        await applyOriginVaultNames(playlist, created, audioItems);
        return created;
    }

    const soundData = audioItems.map(item => ({
        path: item.path,
        name: getSoundName(item)
    }));
    return playlist.createEmbeddedDocuments('PlaylistSound', soundData);
}

async function applyOriginVaultNames(playlist, sounds, audioItems) {
    const updates = sounds
        .map(sound => {
            const item = audioItems.find(candidate => candidate.path === sound.path);
            if (!item) return null;

            const name = getSoundName(item);
            if (!name || name === sound.name) return null;
            return { _id: sound.id, name };
        })
        .filter(Boolean);

    if (updates.length) {
        // bulkImportSounds 只能按路径导入，名称会被 Foundry 自动生成；这里把 OV 里用户整理过的名字补回来。
        await playlist.updateEmbeddedDocuments('PlaylistSound', updates);
    }
}

function getSoundName(item) {
    const displayName = String(item?.displayName || '').trim();
    return displayName || getFilenameFromPath(item?.path) || 'Audio';
}

function getFilenameFromPath(path) {
    const cleanPath = String(path || '').split('?')[0];
    const filename = cleanPath.split(/[\\/]/).pop() || '';
    const stem = filename.replace(/\.[^/.\\]+$/, '');

    try {
        return decodeURIComponent(stem);
    } catch (err) {
        return stem;
    }
}

function getPathExtension(path) {
    const match = String(path || '').trim().match(/(\.[^./\\?#]+)(\?.*)?$/);
    return match ? match[1].toLowerCase() : '';
}

function requireGM() {
    if (globalThis.game?.user?.isGM) return;
    throw new Error(t('origin-vault.playlist.gmOnly'));
}

function getPlaylistDocumentClass() {
    const PlaylistClass = globalThis.foundry?.documents?.Playlist?.implementation
        || globalThis.CONFIG?.Playlist?.documentClass
        || globalThis.Playlist?.implementation
        || globalThis.Playlist;

    if (!PlaylistClass?.create) throw new Error('Playlist document class is not available.');
    return PlaylistClass;
}
