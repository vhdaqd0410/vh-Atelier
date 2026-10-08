"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSyncDownloadTask = exports.triggerUserSync = exports.syncDownloadForAllUsers = exports.touchGlobalLock = exports.downloadSongToSubPath = exports.migrateSyncStorage = exports.isUserSyncRunning = exports.getUserSyncStorageLocation = exports.saveSyncDownloadData = exports.getSyncDownloadData = exports.saveUserData = exports.loadUserData = exports.getAllSyncProgress = exports.getUserSyncProgress = exports.cancelUserSync = exports.setSongResolver = void 0;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const fileCache = __importStar(require("../fileCache"));
const log4js_1 = require("../../utils/log4js.js");
const user_1 = require("../../user/index.js");
const constants_1 = require("../../constants.js");
const data_1 = require("../../user/data.js");
// ─────────────────────────────────────────────
// Resolver 注入（由 server.ts 在启动时设置）
// ─────────────────────────────────────────────
let _resolver = null;
const setSongResolver = (fn) => {
    _resolver = fn;
};
exports.setSongResolver = setSongResolver;
const QUALITY_RANK = {
    '128k': 1,
    '192k': 2,
    '320k': 3,
    'flac': 4,
    'flac24bit': 5,
    'hires': 5,
    'dolby': 6,
    'sky': 6,
    'atmos': 7,
    'atmos_plus': 8,
    'master': 9,
};
const getQualityRank = (quality) => {
    if (!quality)
        return 0;
    return QUALITY_RANK[quality] ?? 3;
};
// ─────────────────────────────────────────────
// 运行时进度状态 & 中止控制器（每个用户独立）
// ─────────────────────────────────────────────
const progressMap = new Map();
const activeAbortControllers = new Map();
const getProgress = (username) => {
    if (!progressMap.has(username)) {
        progressMap.set(username, {
            isRunning: false,
            isPaused: false,
            startTime: null,
            currentListId: '',
            currentListName: '',
            currentSongName: '',
            currentSongIndex: 0,
            currentListTotalSongs: 0,
            totalSongs: 0,
            overallCurrent: 0,
            successCount: 0,
            addCount: 0,
            deleteCount: 0,
            failCount: 0,
            log: [],
        });
    }
    return progressMap.get(username);
};
const cancelUserSync = (username) => {
    const controller = activeAbortControllers.get(username);
    if (controller) {
        controller.abort();
        activeAbortControllers.delete(username);
    }
    fileCache.stopUserTasks(username);
    const progress = getProgress(username);
    if (progress.isRunning || controller) {
        progress.isRunning = false;
        progress.isPaused = false;
        progress.currentSongName = '';
        addLog(progress, '用户已暂停/停止同步任务');
        return true;
    }
    return false;
};
exports.cancelUserSync = cancelUserSync;
const addLog = (progress, msg) => {
    progress.log.push({ time: Date.now(), msg });
    if (progress.log.length > 100)
        progress.log.shift();
};
const getUserSyncProgress = (username) => {
    return getProgress(username);
};
exports.getUserSyncProgress = getUserSyncProgress;
const getAllSyncProgress = () => {
    return Object.fromEntries(progressMap);
};
exports.getAllSyncProgress = getAllSyncProgress;
// ─────────────────────────────────────────────
// data.json 读写管理
// ─────────────────────────────────────────────
const DATA_FILE_NAME = 'data.json';
const getUserDataPath = (username) => {
    const userDir = node_path_1.default.join(global.lx.userPath, (0, data_1.getUserDirname)(username));
    return node_path_1.default.join(userDir, DATA_FILE_NAME);
};
const loadUserData = (username) => {
    const filePath = getUserDataPath(username);
    if (!node_fs_1.default.existsSync(filePath))
        return {};
    try {
        return JSON.parse(node_fs_1.default.readFileSync(filePath, 'utf-8'));
    }
    catch {
        return {};
    }
};
exports.loadUserData = loadUserData;
const saveUserData = (username, data) => {
    const filePath = getUserDataPath(username);
    const dir = node_path_1.default.dirname(filePath);
    if (!node_fs_1.default.existsSync(dir))
        node_fs_1.default.mkdirSync(dir, { recursive: true });
    const tmp = filePath + '.tmp';
    try {
        node_fs_1.default.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
        node_fs_1.default.renameSync(tmp, filePath);
    }
    catch (e) {
        try {
            if (node_fs_1.default.existsSync(tmp))
                node_fs_1.default.unlinkSync(tmp);
        }
        catch { }
        throw e;
    }
};
exports.saveUserData = saveUserData;
const getSyncDownloadData = (username) => {
    const data = (0, exports.loadUserData)(username);
    return data.syncDownload ?? {
        enabled: false,
        playlists: {},
        lastSyncTime: null,
        lastSyncResult: null,
    };
};
exports.getSyncDownloadData = getSyncDownloadData;
const saveSyncDownloadData = (username, syncData) => {
    const data = (0, exports.loadUserData)(username);
    data.syncDownload = syncData;
    (0, exports.saveUserData)(username, data);
};
exports.saveSyncDownloadData = saveSyncDownloadData;
/**
 * 清理 data.json 中已被删除的歌单条目
 */
const cleanupStalePlaylists = (syncData, validListIds) => {
    let changed = false;
    for (const id of Object.keys(syncData.playlists)) {
        if (!validListIds.has(id)) {
            delete syncData.playlists[id];
            changed = true;
        }
    }
    return changed;
};
// ─────────────────────────────────────────────
// 读取同步下载指定的音质（未单独配置则回退到用户首选音质或 320k）
// ─────────────────────────────────────────────
const getPreferredQuality = (username) => {
    try {
        const syncData = (0, exports.getSyncDownloadData)(username);
        if (syncData.preferredQuality && typeof syncData.preferredQuality === 'string') {
            return syncData.preferredQuality;
        }
        const userSpace = (0, user_1.getUserSpace)(username);
        const settingsPath = node_path_1.default.join(userSpace.dataManage.userDir, constants_1.File.userSettingsJSON);
        if (node_fs_1.default.existsSync(settingsPath)) {
            const settings = JSON.parse(node_fs_1.default.readFileSync(settingsPath, 'utf-8'));
            if (settings.preferredQuality && typeof settings.preferredQuality === 'string') {
                return settings.preferredQuality;
            }
        }
    }
    catch { }
    return '320k';
};
// ─────────────────────────────────────────────
// 超时控制工具函数
// ─────────────────────────────────────────────
const withTimeout = (promise, timeoutMs, errorMsg) => {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(errorMsg)), timeoutMs);
        })
    ]).finally(() => {
        clearTimeout(timer);
    });
};
// ─────────────────────────────────────────────
// 核心：将单首歌曲下载到指定 subPath
// ─────────────────────────────────────────────
const RESOLVE_TIMEOUT_MS = 25000; // 单曲解析超时 25s
const DOWNLOAD_TIMEOUT_MS = 120000; // 单曲下载超时 120s
/** 用于标识自定义目录模式的哨兵值（非 CACHE_ROOTS 枚举） */
const CACHE_LOCATION_CUSTOM = 'custom';
/**
 * 获取指定用户同步下载的有效存储位置。
 * 返回 CACHE_ROOTS.ROOT / CACHE_ROOTS.DATA 或哨兵 'custom'。
 */
const getEffectiveCacheLocation = (username) => {
    try {
        const syncData = (0, exports.getSyncDownloadData)(username);
        const loc = syncData.storageLocation || 'data';
        if (loc === 'root')
            return fileCache.CACHE_ROOTS.ROOT;
        if (loc === 'custom')
            return CACHE_LOCATION_CUSTOM;
        return fileCache.CACHE_ROOTS.DATA;
    }
    catch {
        return fileCache.CACHE_ROOTS.DATA;
    }
};
/**
 * 从配置中获取该用户的自定义音乐目录（仅在全局+用户双开时有效）
 * 目录不存在时自动创建。
 */
const getCustomSyncDir = (username) => {
    try {
        const globalEnabled = !!global.lx.config['user.enableCustomMusicDir'];
        if (!globalEnabled)
            return null;
        const userCfg = global.lx.config.users?.find((u) => u.name === username);
        if (!userCfg?.enableCustomMusicDir || !userCfg?.customMusicDir)
            return null;
        const resolved = node_path_1.default.resolve(userCfg.customMusicDir);
        if (!node_fs_1.default.existsSync(resolved))
            node_fs_1.default.mkdirSync(resolved, { recursive: true });
        return resolved;
    }
    catch {
        return null;
    }
};
/** custom 模式的 custom_index.json 存在 customDir 根下 */
const CUSTOM_SYNC_INDEX_FILE = 'custom_index.json';
const loadCustomSyncIndex = (customDir) => {
    const indexPath = node_path_1.default.join(customDir, CUSTOM_SYNC_INDEX_FILE);
    if (!node_fs_1.default.existsSync(indexPath))
        return new Map();
    try {
        const raw = JSON.parse(node_fs_1.default.readFileSync(indexPath, 'utf-8'));
        return new Map(Object.entries(raw));
    }
    catch {
        return new Map();
    }
};
const saveCustomSyncIndex = (customDir, index) => {
    const indexPath = node_path_1.default.join(customDir, CUSTOM_SYNC_INDEX_FILE);
    try {
        node_fs_1.default.writeFileSync(indexPath, JSON.stringify(Object.fromEntries(index), null, 2));
    }
    catch (e) {
        log4js_1.syncLog.error('[同步下载] 保存自定义目录索引失败:', e);
    }
};
/** 跨文件系统安全移动文件（rename 失败时 fallback 为 copy+unlink） */
const safeMove = (src, dst) => {
    try {
        node_fs_1.default.renameSync(src, dst);
    }
    catch {
        node_fs_1.default.copyFileSync(src, dst);
        try {
            node_fs_1.default.unlinkSync(src);
        }
        catch { }
    }
};
/**
 * 导出当前用户同步下载存储位置（供前端 status API 获取）
 */
const getUserSyncStorageLocation = (username) => {
    try {
        const syncData = (0, exports.getSyncDownloadData)(username);
        return syncData.storageLocation || 'data';
    }
    catch {
        return 'data';
    }
};
exports.getUserSyncStorageLocation = getUserSyncStorageLocation;
/**
 * 判断用户同步任务是否正在运行（供 server.ts 调用以阻止迁移）
 */
const isUserSyncRunning = (username) => {
    return getProgress(username).isRunning;
};
exports.isUserSyncRunning = isUserSyncRunning;
/**
 * 迁移同步下载的音乐文件到新的存储位置
 * 支持 root↔data、root/data→custom、custom→root/data、以及 customDir 旧路径→新路径 全部方向
 * 仅迁移"已勾选同步"的歌单所对应的文件，未启用的歌单不做迁移
 * @param username 用户名
 * @param newLocation 新位置 'root' | 'data' | 'custom'
 * @param options 可选指定 overrideOldCustomDir 或 overrideNewCustomDir
 * @returns { moved, skipped, errors, message }
 */
const migrateSyncStorage = async (username, newLocation, options) => {
    const progress = getProgress(username);
    if (progress.isRunning) {
        throw new Error('同步任务正在运行中，无法迁移存储位置，请先暂停同步');
    }
    const syncData = (0, exports.getSyncDownloadData)(username);
    const currentLoc = getEffectiveCacheLocation(username);
    const targetLocStr = newLocation === 'root'
        ? fileCache.CACHE_ROOTS.ROOT
        : newLocation === 'data'
            ? fileCache.CACHE_ROOTS.DATA
            : CACHE_LOCATION_CUSTOM;
    const configuredCustomDir = getCustomSyncDir(username);
    const oldCustomDir = options?.overrideOldCustomDir || syncData.lastCustomMusicDir || configuredCustomDir;
    const newCustomDir = options?.overrideNewCustomDir || configuredCustomDir;
    const isCustomPathChange = (currentLoc === CACHE_LOCATION_CUSTOM && targetLocStr === CACHE_LOCATION_CUSTOM)
        && !!oldCustomDir && !!newCustomDir && node_path_1.default.resolve(oldCustomDir) !== node_path_1.default.resolve(newCustomDir);
    if (currentLoc === targetLocStr && !isCustomPathChange) {
        // 路径未变，但若当前是 custom 模式，更新并记录 lastCustomMusicDir
        if (targetLocStr === CACHE_LOCATION_CUSTOM && newCustomDir) {
            syncData.lastCustomMusicDir = newCustomDir;
            (0, exports.saveSyncDownloadData)(username, syncData);
        }
        return { moved: 0, skipped: 0, errors: 0, message: '存储位置未变化，无需迁移' };
    }
    // ── 构建"已启用歌单"的 subPath 集合 ──────────────────────────────────────
    const enabledListIds = new Set(Object.entries(syncData.playlists)
        .filter(([, cfg]) => cfg.enabled)
        .map(([id]) => id));
    const enabledSubPaths = new Set();
    try {
        const userSpace = (0, user_1.getUserSpace)(username);
        const listData = await userSpace.listManage.getListData();
        for (const l of (listData?.userList ?? [])) {
            if (enabledListIds.has(l.id)) {
                enabledSubPaths.add(sanitizeDirName(l.name || l.id));
            }
        }
    }
    catch (e) {
        log4js_1.syncLog.warn('[同步下载] 迁移时无法获取歌单列表，将迁移全部文件:', e);
    }
    const hasFilter = enabledSubPaths.size > 0;
    const shouldMigrate = (filename) => {
        if (!hasFilter)
            return true;
        const sep = filename.indexOf('/');
        const itemSubPath = sep > 0 ? filename.substring(0, sep) : '';
        return enabledSubPaths.has(itemSubPath);
    };
    let moved = 0, skipped = 0, errors = 0;
    // ── 场景 A：root ↔ data（均走 fileCache.indexManager）──────────────────────
    if (currentLoc !== CACHE_LOCATION_CUSTOM && targetLocStr !== CACHE_LOCATION_CUSTOM) {
        const srcDir = fileCache.getCacheDir(username, true, currentLoc);
        const dstDir = fileCache.getCacheDir(username, true, targetLocStr);
        const srcItems = fileCache.indexManager.getAll(username, 'music', currentLoc);
        for (const item of srcItems) {
            if (!shouldMigrate(item.filename)) {
                skipped++;
                continue;
            }
            try {
                const srcFile = node_path_1.default.join(srcDir, item.filename);
                const dstFile = node_path_1.default.join(dstDir, item.filename);
                if (!node_fs_1.default.existsSync(srcFile)) {
                    skipped++;
                    continue;
                }
                const dstSubDir = node_path_1.default.dirname(dstFile);
                if (!node_fs_1.default.existsSync(dstSubDir))
                    node_fs_1.default.mkdirSync(dstSubDir, { recursive: true });
                if (node_fs_1.default.existsSync(dstFile)) {
                    skipped++;
                    continue;
                }
                safeMove(srcFile, dstFile);
                if (item.lyricFilename) {
                    const srcLrc = node_path_1.default.join(srcDir, item.lyricFilename);
                    const dstLrc = node_path_1.default.join(dstDir, item.lyricFilename);
                    if (node_fs_1.default.existsSync(srcLrc) && !node_fs_1.default.existsSync(dstLrc)) {
                        const dstLrcDir = node_path_1.default.dirname(dstLrc);
                        if (!node_fs_1.default.existsSync(dstLrcDir))
                            node_fs_1.default.mkdirSync(dstLrcDir, { recursive: true });
                        try {
                            safeMove(srcLrc, dstLrc);
                        }
                        catch { }
                    }
                }
                fileCache.indexManager.update(username, { ...item }, 'music', targetLocStr);
                fileCache.cleanEmptyParentDirs(srcFile, srcDir);
                moved++;
            }
            catch {
                errors++;
            }
        }
        if (moved > 0) {
            fileCache.indexManager.discard(username, 'music', targetLocStr);
            fileCache.indexManager.load(username, 'music', targetLocStr);
            for (const item of fileCache.indexManager.getAll(username, 'music', currentLoc)) {
                const dstFile = node_path_1.default.join(fileCache.getCacheDir(username, true, targetLocStr), item.filename);
                if (node_fs_1.default.existsSync(dstFile)) {
                    fileCache.indexManager.remove(username, item.id, 'music', item.quality, currentLoc);
                }
            }
        }
        return { moved, skipped, errors, message: `迁移完成：已移动 ${moved} 首，跳过 ${skipped} 首，失败 ${errors} 首` };
    }
    // ── 场景 B：root/data → custom ─────────────────────────────────────────────
    if (currentLoc !== CACHE_LOCATION_CUSTOM && targetLocStr === CACHE_LOCATION_CUSTOM) {
        const customDir = newCustomDir;
        if (!customDir)
            throw new Error('custom 目录不可用，请确认已启用自定义音乐目录并配置了路径');
        const srcDir = fileCache.getCacheDir(username, true, currentLoc);
        const srcItems = fileCache.indexManager.getAll(username, 'music', currentLoc);
        const customIndex = loadCustomSyncIndex(customDir);
        for (const item of srcItems) {
            if (!shouldMigrate(item.filename)) {
                skipped++;
                continue;
            }
            try {
                const srcFile = node_path_1.default.join(srcDir, item.filename);
                if (!node_fs_1.default.existsSync(srcFile)) {
                    skipped++;
                    continue;
                }
                const targetFilename = item.filename;
                const dstFile = node_path_1.default.join(customDir, targetFilename);
                const dstSubDir = node_path_1.default.dirname(dstFile);
                if (!node_fs_1.default.existsSync(dstSubDir))
                    node_fs_1.default.mkdirSync(dstSubDir, { recursive: true });
                if (node_fs_1.default.existsSync(dstFile)) {
                    skipped++;
                    continue;
                }
                safeMove(srcFile, dstFile);
                let finalLyricFilename = item.lyricFilename;
                if (item.lyricFilename) {
                    const srcLrc = node_path_1.default.join(srcDir, item.lyricFilename);
                    const dstLrc = node_path_1.default.join(customDir, item.lyricFilename);
                    if (node_fs_1.default.existsSync(srcLrc) && !node_fs_1.default.existsSync(dstLrc)) {
                        const dstLrcDir = node_path_1.default.dirname(dstLrc);
                        if (!node_fs_1.default.existsSync(dstLrcDir))
                            node_fs_1.default.mkdirSync(dstLrcDir, { recursive: true });
                        try {
                            safeMove(srcLrc, dstLrc);
                        }
                        catch { }
                    }
                }
                const idxKey = `${item.id}_${item.quality || 'unknown'}`;
                customIndex.set(idxKey, { ...item, filename: targetFilename, lyricFilename: finalLyricFilename });
                fileCache.cleanEmptyParentDirs(srcFile, srcDir);
                moved++;
            }
            catch {
                errors++;
            }
        }
        if (moved > 0) {
            saveCustomSyncIndex(customDir, customIndex);
            for (const item of fileCache.indexManager.getAll(username, 'music', currentLoc)) {
                const dstFile = node_path_1.default.join(customDir, item.filename);
                if (node_fs_1.default.existsSync(dstFile)) {
                    fileCache.indexManager.remove(username, item.id, 'music', item.quality, currentLoc);
                }
            }
        }
        syncData.lastCustomMusicDir = customDir;
        (0, exports.saveSyncDownloadData)(username, syncData);
        return { moved, skipped, errors, message: `迁移完成：已移动 ${moved} 首到自定义目录，跳过 ${skipped} 首，失败 ${errors} 首` };
    }
    // ── 场景 C：custom → root/data ─────────────────────────────────────────────
    if (currentLoc === CACHE_LOCATION_CUSTOM && targetLocStr !== CACHE_LOCATION_CUSTOM) {
        const customDir = oldCustomDir || configuredCustomDir;
        if (!customDir)
            throw new Error('custom 目录不可用，请确认已启用自定义音乐目录并配置了路径');
        const dstDir = fileCache.getCacheDir(username, true, targetLocStr);
        const customIndex = loadCustomSyncIndex(customDir);
        const customItems = Array.from(customIndex.values());
        for (const item of customItems) {
            if (!shouldMigrate(item.filename)) {
                skipped++;
                continue;
            }
            try {
                const srcFile = node_path_1.default.join(customDir, item.filename);
                if (!node_fs_1.default.existsSync(srcFile)) {
                    skipped++;
                    continue;
                }
                const dstFile = node_path_1.default.join(dstDir, item.filename);
                const dstSubDir = node_path_1.default.dirname(dstFile);
                if (!node_fs_1.default.existsSync(dstSubDir))
                    node_fs_1.default.mkdirSync(dstSubDir, { recursive: true });
                if (node_fs_1.default.existsSync(dstFile)) {
                    skipped++;
                    continue;
                }
                safeMove(srcFile, dstFile);
                if (item.lyricFilename) {
                    const srcLrc = node_path_1.default.join(customDir, item.lyricFilename);
                    const dstLrc = node_path_1.default.join(dstDir, item.lyricFilename);
                    if (node_fs_1.default.existsSync(srcLrc) && !node_fs_1.default.existsSync(dstLrc)) {
                        const dstLrcDir = node_path_1.default.dirname(dstLrc);
                        if (!node_fs_1.default.existsSync(dstLrcDir))
                            node_fs_1.default.mkdirSync(dstLrcDir, { recursive: true });
                        try {
                            safeMove(srcLrc, dstLrc);
                        }
                        catch { }
                    }
                }
                fileCache.indexManager.update(username, { ...item }, 'music', targetLocStr);
                fileCache.cleanEmptyParentDirs(srcFile, customDir);
                moved++;
            }
            catch {
                errors++;
            }
        }
        if (moved > 0) {
            const dstDir2 = fileCache.getCacheDir(username, true, targetLocStr);
            for (const [key, item] of Array.from(customIndex.entries())) {
                const dstFile = node_path_1.default.join(dstDir2, item.filename);
                if (node_fs_1.default.existsSync(dstFile)) {
                    customIndex.delete(key);
                }
            }
            saveCustomSyncIndex(customDir, customIndex);
            fileCache.indexManager.discard(username, 'music', targetLocStr);
            fileCache.indexManager.load(username, 'music', targetLocStr);
        }
        delete syncData.lastCustomMusicDir;
        (0, exports.saveSyncDownloadData)(username, syncData);
        return { moved, skipped, errors, message: `迁移完成：已从自定义目录移出 ${moved} 首，跳过 ${skipped} 首，失败 ${errors} 首` };
    }
    // ── 场景 D：custom 旧路径 → custom 新路径 ────────────────────────────────────
    if (isCustomPathChange) {
        const srcCustomDir = oldCustomDir;
        const dstCustomDir = newCustomDir;
        const srcIndex = loadCustomSyncIndex(srcCustomDir);
        const dstIndex = loadCustomSyncIndex(dstCustomDir);
        const customItems = Array.from(srcIndex.values());
        for (const item of customItems) {
            if (!shouldMigrate(item.filename)) {
                skipped++;
                continue;
            }
            try {
                const srcFile = node_path_1.default.join(srcCustomDir, item.filename);
                if (!node_fs_1.default.existsSync(srcFile)) {
                    skipped++;
                    continue;
                }
                const dstFile = node_path_1.default.join(dstCustomDir, item.filename);
                const dstSubDir = node_path_1.default.dirname(dstFile);
                if (!node_fs_1.default.existsSync(dstSubDir))
                    node_fs_1.default.mkdirSync(dstSubDir, { recursive: true });
                if (node_fs_1.default.existsSync(dstFile)) {
                    skipped++;
                    continue;
                }
                safeMove(srcFile, dstFile);
                let finalLyricFilename = item.lyricFilename;
                if (item.lyricFilename) {
                    const srcLrc = node_path_1.default.join(srcCustomDir, item.lyricFilename);
                    const dstLrc = node_path_1.default.join(dstCustomDir, item.lyricFilename);
                    if (node_fs_1.default.existsSync(srcLrc) && !node_fs_1.default.existsSync(dstLrc)) {
                        const dstLrcDir = node_path_1.default.dirname(dstLrc);
                        if (!node_fs_1.default.existsSync(dstLrcDir))
                            node_fs_1.default.mkdirSync(dstLrcDir, { recursive: true });
                        try {
                            safeMove(srcLrc, dstLrc);
                        }
                        catch { }
                    }
                }
                const idxKey = `${item.id}_${item.quality || 'unknown'}`;
                dstIndex.set(idxKey, { ...item, lyricFilename: finalLyricFilename });
                fileCache.cleanEmptyParentDirs(srcFile, srcCustomDir);
                moved++;
            }
            catch {
                errors++;
            }
        }
        if (moved > 0) {
            for (const [key, item] of Array.from(srcIndex.entries())) {
                const dstFile = node_path_1.default.join(dstCustomDir, item.filename);
                if (node_fs_1.default.existsSync(dstFile)) {
                    srcIndex.delete(key);
                }
            }
            saveCustomSyncIndex(srcCustomDir, srcIndex);
            saveCustomSyncIndex(dstCustomDir, dstIndex);
        }
        syncData.lastCustomMusicDir = dstCustomDir;
        (0, exports.saveSyncDownloadData)(username, syncData);
        return { moved, skipped, errors, message: `迁移完成：已将 ${moved} 首歌曲从旧自定义目录迁移至新目录，跳过 ${skipped} 首，失败 ${errors} 首` };
    }
    return { moved: 0, skipped: 0, errors: 0, message: '无需迁移' };
};
exports.migrateSyncStorage = migrateSyncStorage;
const downloadSongToSubPath = async (songInfo, quality, username, subPath, signal) => {
    if (!_resolver)
        return new Error('Sync download resolver not initialized');
    try {
        (0, exports.touchGlobalLock)();
        const resolved = await withTimeout(_resolver(songInfo, quality, username), RESOLVE_TIMEOUT_MS, `音源解析超时 (${RESOLVE_TIMEOUT_MS / 1000}s)`);
        if (signal?.aborted)
            return new Error('Aborted');
        if (!resolved?.url)
            return new Error('No download URL returned');
        const finalSongInfo = resolved.songInfo || songInfo;
        const effectiveLoc = getEffectiveCacheLocation(username);
        const songId = fileCache.normalizeSongId(finalSongInfo);
        const finalQuality = resolved.quality || quality || '320k';
        // ── 场景 1：custom 模式 ── 直接下载至 customDir/{subPath}/，不走任何 staging 中转
        if (effectiveLoc === CACHE_LOCATION_CUSTOM) {
            const customDir = getCustomSyncDir(username);
            if (!customDir)
                throw new Error('custom 目录不可用，无法写入歌曲');
            const targetDir = node_path_1.default.join(customDir, subPath);
            if (!node_fs_1.default.existsSync(targetDir))
                node_fs_1.default.mkdirSync(targetDir, { recursive: true });
            (0, exports.touchGlobalLock)();
            const songInfoWithSubPath = { ...finalSongInfo, __syncSubPath__: subPath };
            await withTimeout(fileCache.downloadAndCache(songInfoWithSubPath, resolved.url, finalQuality, username, signal, true, true, true, {
                requestedSource: finalSongInfo.requestedSource || finalSongInfo.source,
                downloadSource: finalSongInfo.downloadSource,
                sourceName: finalSongInfo.sourceName,
                customTargetDir: targetDir,
            }), DOWNLOAD_TIMEOUT_MS, `下载歌曲超时 (${DOWNLOAD_TIMEOUT_MS / 1000}s)`);
            (0, exports.touchGlobalLock)();
            if (signal?.aborted)
                return new Error('Aborted');
            // 直接从目标目录检测生成的文件并登记 custom_index.json
            const generatedBaseName = fileCache.getFileName(finalSongInfo, finalQuality, true, username);
            const targetFiles = node_fs_1.default.existsSync(targetDir) ? node_fs_1.default.readdirSync(targetDir) : [];
            const matchedAudio = targetFiles.find(f => f.startsWith(generatedBaseName) && !f.endsWith('.tmp') && !f.endsWith('.lrc'));
            const matchedLrc = targetFiles.find(f => f.startsWith(generatedBaseName) && f.endsWith('.lrc'));
            if (matchedAudio) {
                const targetFilename = node_path_1.default.join(subPath, matchedAudio).replace(/\\/g, '/');
                const lyricFilename = matchedLrc ? node_path_1.default.join(subPath, matchedLrc).replace(/\\/g, '/') : undefined;
                const audioFullPath = node_path_1.default.join(targetDir, matchedAudio);
                const stat = node_fs_1.default.statSync(audioFullPath);
                const customIndex = loadCustomSyncIndex(customDir);
                const idxKey = `${songId}_${finalQuality}`;
                const metadata = fileCache.extractSongMetadata(finalSongInfo);
                customIndex.set(idxKey, {
                    id: songId,
                    songmid: songId,
                    name: metadata.name,
                    singer: metadata.singer,
                    album: metadata.album,
                    albumId: metadata.albumId,
                    img: metadata.img,
                    interval: metadata.interval,
                    source: metadata.source,
                    requestedSource: finalSongInfo.requestedSource || metadata.source,
                    downloadSource: finalSongInfo.downloadSource,
                    sourceName: finalSongInfo.sourceName,
                    quality: finalQuality,
                    filename: targetFilename,
                    folder: 'music',
                    subPath,
                    mtime: stat.mtimeMs,
                    size: stat.size,
                    lyricFilename,
                    ext: node_path_1.default.extname(matchedAudio).replace('.', ''),
                    hasCover: true,
                    hasLyric: !!lyricFilename,
                });
                saveCustomSyncIndex(customDir, customIndex);
            }
            const songKey = songId + '_' + finalQuality;
            const prog = fileCache.cacheProgress.get(songKey);
            return prog?.status === 'exists' ? 'exists' : 'ok';
        }
        // ── 场景 2：root / data 模式 ── 直接下载至对应存储位置的目标 subPath
        const targetBaseDir = fileCache.getCacheDir(username, true, effectiveLoc);
        const targetSubDir = node_path_1.default.join(targetBaseDir, subPath);
        if (!node_fs_1.default.existsSync(targetSubDir))
            node_fs_1.default.mkdirSync(targetSubDir, { recursive: true });
        (0, exports.touchGlobalLock)();
        const songInfoWithSubPath = { ...finalSongInfo, __syncSubPath__: subPath };
        const syncData = (0, exports.getSyncDownloadData)(username);
        const shouldCacheLyric = syncData.downloadLyric !== false; // 默认 true
        const shouldEmbedLyric = syncData.embedLyric !== false; // 默认 true
        await withTimeout(fileCache.downloadAndCache(songInfoWithSubPath, resolved.url, finalQuality, username, signal, true, // isOnlyDownload
        shouldCacheLyric, // cacheLyric (.lrc 文件)
        shouldEmbedLyric, // embedLyric (USLT 标签)
        {
            requestedSource: finalSongInfo.requestedSource || finalSongInfo.source,
            downloadSource: finalSongInfo.downloadSource,
            sourceName: finalSongInfo.sourceName,
        }), DOWNLOAD_TIMEOUT_MS, `下载歌曲超时 (${DOWNLOAD_TIMEOUT_MS / 1000}s)`);
        (0, exports.touchGlobalLock)();
        if (signal?.aborted)
            return new Error('Aborted');
        const item = fileCache.indexManager.get(username, songId, 'music', finalQuality, false, effectiveLoc);
        if (item && (!item.subPath || item.subPath !== subPath)) {
            const musicRoot = fileCache.getCacheDir(username, true, effectiveLoc);
            const currentFilename = item.filename;
            if (!currentFilename.includes('/')) {
                const destFilename = node_path_1.default.join(subPath, node_path_1.default.basename(currentFilename)).replace(/\\/g, '/');
                const srcPath = node_path_1.default.join(musicRoot, currentFilename);
                const destPath = node_path_1.default.join(musicRoot, destFilename);
                if (node_fs_1.default.existsSync(srcPath) && !node_fs_1.default.existsSync(destPath)) {
                    node_fs_1.default.renameSync(srcPath, destPath);
                    let newLyricFilename = item.lyricFilename;
                    if (item.lyricFilename) {
                        const srcLrc = node_path_1.default.join(musicRoot, item.lyricFilename);
                        const destLrcName = node_path_1.default.join(subPath, node_path_1.default.basename(item.lyricFilename)).replace(/\\/g, '/');
                        const destLrc = node_path_1.default.join(musicRoot, destLrcName);
                        if (node_fs_1.default.existsSync(srcLrc)) {
                            try {
                                node_fs_1.default.renameSync(srcLrc, destLrc);
                                newLyricFilename = destLrcName;
                            }
                            catch { }
                        }
                    }
                    fileCache.indexManager.update(username, {
                        ...item,
                        filename: destFilename,
                        subPath,
                        lyricFilename: newLyricFilename,
                    }, 'music', effectiveLoc);
                }
            }
        }
        const songKey = songId + '_' + finalQuality;
        const prog = fileCache.cacheProgress.get(songKey);
        return prog?.status === 'exists' ? 'exists' : 'ok';
    }
    catch (e) {
        return e instanceof Error ? e : new Error(String(e));
    }
};
exports.downloadSongToSubPath = downloadSongToSubPath;
// ─────────────────────────────────────────────
// 重试下载
// ─────────────────────────────────────────────
const downloadWithRetry = async (song, quality, username, subPath, maxRetries = 3, signal) => {
    let lastErr;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        if (signal?.aborted)
            return { status: 'failed', reason: 'Aborted' };
        const result = await (0, exports.downloadSongToSubPath)(song, quality, username, subPath, signal);
        if (result === 'ok')
            return { status: 'ok' };
        if (result === 'exists')
            return { status: 'exists' };
        lastErr = result instanceof Error ? result : new Error(String(result));
        if (attempt < maxRetries) {
            await new Promise(r => setTimeout(r, 1000 * attempt)); // 递增等待
        }
    }
    return { status: 'failed', reason: lastErr?.message || '未知错误' };
};
// ─────────────────────────────────────────────
// 获取本地已有歌曲（按 subPath 分组）
// ─────────────────────────────────────────────
const getLocalSongsMap = (username, subPath, cacheLocation) => {
    if (cacheLocation === CACHE_LOCATION_CUSTOM) {
        const customDir = getCustomSyncDir(username);
        if (!customDir)
            return new Map();
        const map = new Map();
        for (const item of Array.from(loadCustomSyncIndex(customDir).values())) {
            if (item.subPath === subPath)
                map.set(item.id, item);
        }
        return map;
    }
    const items = fileCache.indexManager.getAll(username, 'music', cacheLocation);
    const map = new Map();
    for (const item of items) {
        if (item.subPath === subPath) {
            map.set(item.id, item);
        }
    }
    return map;
};
const getLocalSongIds = (username, subPath, cacheLocation) => {
    const items = fileCache.indexManager.getAll(username, 'music', cacheLocation);
    const ids = new Set();
    for (const item of items) {
        if (item.subPath === subPath) {
            ids.add(item.id);
        }
    }
    return ids;
};
/**
 * 删除本地歌曲并更新索引
 */
const deleteLocalSong = (username, songId, subPath, cacheLocation) => {
    if (cacheLocation === CACHE_LOCATION_CUSTOM) {
        const customDir = getCustomSyncDir(username);
        if (!customDir)
            return false;
        const index = loadCustomSyncIndex(customDir);
        let deleted = false;
        for (const [key, item] of Array.from(index.entries())) {
            if (item.id === songId && item.subPath === subPath) {
                const filePath = node_path_1.default.join(customDir, item.filename);
                try {
                    if (node_fs_1.default.existsSync(filePath))
                        node_fs_1.default.unlinkSync(filePath);
                }
                catch { }
                if (item.lyricFilename) {
                    const lrcPath = node_path_1.default.join(customDir, item.lyricFilename);
                    try {
                        if (node_fs_1.default.existsSync(lrcPath))
                            node_fs_1.default.unlinkSync(lrcPath);
                    }
                    catch { }
                }
                index.delete(key);
                deleted = true;
            }
        }
        if (deleted)
            saveCustomSyncIndex(customDir, index);
        return deleted;
    }
    const items = fileCache.indexManager.getAll(username, 'music', cacheLocation);
    const toDelete = items.filter(i => i.id === songId && i.subPath === subPath);
    let deleted = false;
    for (const item of toDelete) {
        try {
            fileCache.removeCacheFile(item.filename, username, 'music');
            deleted = true;
        }
        catch (e) {
            log4js_1.syncLog.warn(`[同步下载] 删除文件失败: ${item.filename}: ${e.message}`);
        }
    }
    return deleted;
};
// ─────────────────────────────────────────────
// 清理安全文件名（用于生成子目录名）
// ─────────────────────────────────────────────
const sanitizeDirName = (name) => {
    return name
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 80);
};
// ─────────────────────────────────────────────
// 全局运行锁（跨用户共用，带租约与自愈机制，防止死锁与并发）
// ─────────────────────────────────────────────
let globalIsRunning = false;
let globalLockTime = 0;
const GLOBAL_LOCK_TIMEOUT_MS = 10 * 60 * 1000; // 10 分钟锁租约超时
/**
 * 刷新全局锁心跳
 */
const touchGlobalLock = () => {
    if (globalIsRunning) {
        globalLockTime = Date.now();
    }
};
exports.touchGlobalLock = touchGlobalLock;
/**
 * 对单个用户执行歌单同步下载
 */
const syncUserPlaylists = async (username, signal, targetPlaylistId) => {
    const progress = getProgress(username);
    if (progress.isRunning) {
        log4js_1.syncLog.info(`[同步下载] 用户 ${username} 当前正在同步中，跳过`);
        return;
    }
    // 为每个用户的同步任务创建并注册独立的 AbortController，确保无论定时还是手动触发都能被立即暂停
    let userController = activeAbortControllers.get(username);
    if (!userController) {
        userController = new AbortController();
        activeAbortControllers.set(username, userController);
    }
    const currentSignal = userController.signal;
    const onParentAbort = () => {
        userController?.abort();
    };
    if (signal && signal !== currentSignal) {
        if (signal.aborted) {
            userController.abort();
        }
        else {
            signal.addEventListener('abort', onParentAbort);
        }
    }
    const syncData = (0, exports.getSyncDownloadData)(username);
    if (!syncData.enabled && !targetPlaylistId)
        return;
    const userSpace = (0, user_1.getUserSpace)(username);
    let listData;
    try {
        listData = await userSpace.listManage.getListData();
    }
    catch (e) {
        log4js_1.syncLog.warn(`[同步下载] 用户 ${username} 获取歌单失败: ${e.message}`);
        return;
    }
    if (!listData?.userList?.length)
        return;
    const quality = getPreferredQuality(username);
    const cacheLocation = getEffectiveCacheLocation(username);
    const validListIds = new Set(listData.userList.map((l) => l.id));
    // 清理已删除的歌单
    const cleaned = cleanupStalePlaylists(syncData, validListIds);
    if (cleaned)
        (0, exports.saveSyncDownloadData)(username, syncData);
    // 只同步开启了同步的歌单（如果指定了 targetPlaylistId，则仅同步该歌单）
    const targetLists = listData.userList.filter((l) => {
        if (targetPlaylistId)
            return l.id === targetPlaylistId;
        const cfg = syncData.playlists[l.id];
        return cfg?.enabled === true;
    });
    if (targetLists.length === 0)
        return;
    // 预扫描所有需下载和需删除的歌曲
    let overallTotal = 0;
    const plans = [];
    for (const list of targetLists) {
        const subPath = sanitizeDirName(list.name || list.id);
        const remoteSongs = Array.isArray(list.list) ? list.list : [];
        const remoteSongIds = new Set(remoteSongs.map((s) => {
            const id = String(s.songmid || s.id || '');
            const src = s.source || 'unknown';
            return id.includes('_') ? id : `${src}_${id}`;
        }));
        const localSongsMap = getLocalSongsMap(username, subPath, cacheLocation);
        const localSongIds = new Set(localSongsMap.keys());
        const toDelete = Array.from(localSongIds).filter(id => !remoteSongIds.has(id));
        // 预计算真正需要下载的歌曲（本地无缓存 或 音质需升级）
        const toDownload = remoteSongs.filter((s) => {
            const songId = fileCache.normalizeSongId(s);
            const existing = localSongsMap.get(songId);
            return !existing || existing.quality !== quality;
        });
        overallTotal += toDownload.length; // 进度总数只统计实际需要下载的
        plans.push({ list, subPath, remoteSongs, toDownload, toDelete, localSongsMap });
    }
    progress.isRunning = true;
    progress.isPaused = false;
    progress.startTime = Date.now();
    progress.successCount = 0;
    progress.addCount = 0;
    progress.deleteCount = 0;
    progress.failCount = 0;
    progress.totalSongs = overallTotal;
    progress.overallCurrent = 0;
    progress.currentListId = '';
    progress.currentListName = '';
    progress.currentSongName = '';
    progress.currentSongIndex = 0;
    progress.currentListTotalSongs = 0;
    progress.log = [];
    const totalCheck = plans.reduce((s, p) => s + p.remoteSongs.length, 0);
    addLog(progress, `开始同步用户 ${username} 的 ${targetLists.length} 个歌单，核对 ${totalCheck} 首，其中需下载 ${overallTotal} 首 (目标音质: ${quality})`);
    let totalAdded = 0;
    let totalDeleted = 0;
    let totalFailed = 0;
    try {
        for (const plan of plans) {
            if (currentSignal.aborted)
                break;
            const { list, subPath, remoteSongs, toDownload, toDelete, localSongsMap } = plan;
            const listCfg = syncData.playlists[list.id] ?? {
                enabled: true, lastSyncTime: null, failedSongs: []
            };
            progress.currentListId = list.id;
            progress.currentListName = list.name || list.id;
            progress.currentListTotalSongs = toDownload.length; // 只统计实际需下载数
            progress.currentSongIndex = 0;
            // 删除已移出歌单的歌曲
            for (const id of toDelete) {
                if (currentSignal.aborted)
                    break;
                const deleted = deleteLocalSong(username, id, subPath, cacheLocation);
                if (deleted) {
                    totalDeleted++;
                    progress.deleteCount++;
                }
                addLog(progress, `  已删除: ${id}`);
            }
            // 同步处理歌单中全部歌曲（对比本地缓存或执行下载）
            listCfg.failedSongs = [];
            let listDownloadIdx = 0; // 当前歌单已下载第几首（仅统计实际下载）
            for (let i = 0; i < remoteSongs.length; i++) {
                if (currentSignal.aborted)
                    break;
                const song = remoteSongs[i];
                const songId = fileCache.normalizeSongId(song);
                const oldExisting = localSongsMap.get(songId);
                const isUpgrade = oldExisting && oldExisting.quality !== quality;
                const needDownload = !oldExisting || isUpgrade;
                if (!needDownload) {
                    // 本地已有且音质相符，直接跳过，不占用进度计数
                    progress.successCount++;
                    continue;
                }
                // 只有真正需要下载的才更新进度计数
                listDownloadIdx++;
                progress.currentSongIndex = listDownloadIdx;
                progress.overallCurrent++;
                progress.currentSongName = `${song.name || song.id}${song.singer ? ' - ' + song.singer : ''}`;
                addLog(progress, `  [${i + 1}/${remoteSongs.length}] ${isUpgrade ? '更新音质' : '下载'}: ${song.name} - ${song.singer} (${quality})`);
                const result = await downloadWithRetry(song, quality, username, subPath, 3, currentSignal);
                if (result.status === 'ok') {
                    // 如果是音质变更重新下载成功，先做体积校验再清理旧文件
                    if (isUpgrade && oldExisting && oldExisting.filename) {
                        // 体积缩水保护：获取新下载文件的大小，防止音源返回假高音质文件覆盖本地高质量文件
                        const songId = fileCache.normalizeSongId(song);
                        const effectiveLoc = getEffectiveCacheLocation(username);
                        const newItem = fileCache.indexManager.get(username, songId, 'music', quality, false, effectiveLoc);
                        const oldSize = oldExisting.size ?? 0;
                        const newSize = newItem?.size ?? 0;
                        const isTargetHigher = getQualityRank(quality) > getQualityRank(oldExisting.quality);
                        if (isTargetHigher && oldSize > 0 && newSize > 0 && newSize < oldSize) {
                            // 新文件体积小于旧文件，疑似假高音质，拒绝替换并清除刚下载的劣质文件
                            addLog(progress, `  ⚠ 体积缩水保护：${song.name} 新文件 (${newSize}B) < 旧文件 (${oldSize}B)，已拒绝替换`);
                            try {
                                if (newItem?.filename)
                                    fileCache.removeCacheFile(newItem.filename, username, 'music');
                            }
                            catch { }
                            progress.failCount++;
                            totalFailed++;
                            const cover = song.img || song.pic || song.picUrl || song.meta?.picUrl || song.meta?.pic || song.meta?.albumPic || song.meta?.cover || song.album?.picUrl || song.album?.pic || song.album?.img || song.otherSource?.meta?.picUrl || '';
                            const interval = song.interval || song.meta?.interval || '';
                            const album = song.albumName || song.meta?.albumName || (typeof song.album === 'string' ? song.album : song.album?.name) || '';
                            listCfg.failedSongs.push({
                                id: songId,
                                name: song.name || '',
                                singer: song.singer || '',
                                reason: `新文件（${newSize} 字节）小于原文件（${oldSize} 字节），音源可能返回了低质量文件，已拒绝替换`,
                                source: song.source || '',
                                cover,
                                interval: typeof interval === 'number' ? `${Math.floor(interval / 60)}:${String(Math.floor(interval % 60)).padStart(2, '0')}` : String(interval || ''),
                                album,
                            });
                            continue;
                        }
                        try {
                            fileCache.removeCacheFile(oldExisting.filename, username, 'music');
                        }
                        catch { }
                    }
                    progress.successCount++;
                    progress.addCount++;
                    totalAdded++;
                }
                else if (result.status === 'exists') {
                    progress.successCount++;
                }
                else {
                    progress.failCount++;
                    totalFailed++;
                    const reason = result.reason || '未知错误';
                    const cover = song.img || song.pic || song.picUrl || song.meta?.picUrl || song.meta?.pic || song.meta?.albumPic || song.meta?.cover || song.album?.picUrl || song.album?.pic || song.album?.img || song.otherSource?.meta?.picUrl || '';
                    const interval = song.interval || song.meta?.interval || '';
                    const album = song.albumName || song.meta?.albumName || (typeof song.album === 'string' ? song.album : song.album?.name) || '';
                    listCfg.failedSongs.push({
                        id: fileCache.normalizeSongId(song),
                        name: song.name || '',
                        singer: song.singer || '',
                        reason,
                        source: song.source || '',
                        cover,
                        interval: typeof interval === 'number' ? `${Math.floor(interval / 60)}:${String(Math.floor(interval % 60)).padStart(2, '0')}` : String(interval || ''),
                        album,
                    });
                }
            }
            listCfg.lastSyncTime = Date.now();
            syncData.playlists[list.id] = listCfg;
            (0, exports.saveSyncDownloadData)(username, syncData);
        }
        if (currentSignal.aborted) {
            const resultMsg = `已暂停/终止同步: 增加 ${totalAdded} 首，减少 ${totalDeleted} 首，失败 ${totalFailed} 首`;
            addLog(progress, resultMsg);
            syncData.lastSyncResult = resultMsg;
            (0, exports.saveSyncDownloadData)(username, syncData);
        }
        else {
            const resultMsg = `同步完成: 增加 ${totalAdded} 首，减少 ${totalDeleted} 首，失败 ${totalFailed} 首`;
            addLog(progress, resultMsg);
            syncData.lastSyncTime = Date.now();
            syncData.lastSyncResult = resultMsg;
            (0, exports.saveSyncDownloadData)(username, syncData);
        }
    }
    catch (err) {
        const errorMsg = `同步过程异常终止: ${err?.message || err}`;
        addLog(progress, errorMsg);
        syncData.lastSyncResult = errorMsg;
        (0, exports.saveSyncDownloadData)(username, syncData);
        log4js_1.syncLog.error(`[同步下载] 用户 ${username} 同步执行出错:`, err);
    }
    finally {
        if (signal && signal !== currentSignal) {
            signal.removeEventListener('abort', onParentAbort);
        }
        if (activeAbortControllers.get(username) === userController) {
            activeAbortControllers.delete(username);
        }
        progress.isRunning = false;
        progress.startTime = null;
        progress.currentSongName = '';
        log4js_1.syncLog.info(`[同步下载] 用户 ${username} ${syncData.lastSyncResult}`);
    }
};
/**
 * 对所有启用了自动下载的用户执行同步
 */
const syncDownloadForAllUsers = async (signal) => {
    const now = Date.now();
    if (globalIsRunning) {
        if (globalLockTime && now - globalLockTime > GLOBAL_LOCK_TIMEOUT_MS) {
            log4js_1.syncLog.warn(`[同步下载] 全局同步任务锁定超过 ${GLOBAL_LOCK_TIMEOUT_MS / 60000} 分钟未完成，疑似异常挂起，自动强制释放锁并重新执行`);
            globalIsRunning = false;
        }
        else {
            log4js_1.syncLog.info('[同步下载] 全局同步任务正在运行中，跳过本次触发');
            return { processedUsers: 0, totalSuccess: 0, totalAdded: 0, totalDeleted: 0, totalFail: 0 };
        }
    }
    globalIsRunning = true;
    globalLockTime = Date.now();
    let processedUsers = 0;
    let totalSuccess = 0;
    let totalAdded = 0;
    let totalDeleted = 0;
    let totalFail = 0;
    try {
        const users = [];
        if (Array.isArray(global.lx?.config?.users)) {
            for (const u of global.lx.config.users) {
                if (u?.name) {
                    // 检查管理员是否为该用户开启了 enableAutoDownload
                    const cfg = global.lx.config.users.find((x) => x.name === u.name);
                    if (cfg?.enableAutoDownload === true) {
                        users.push(u.name);
                    }
                }
            }
        }
        for (const username of users) {
            if (signal?.aborted)
                break;
            try {
                (0, exports.touchGlobalLock)();
                const before = getProgress(username);
                const successBefore = before.successCount;
                const addBefore = before.addCount;
                const deleteBefore = before.deleteCount;
                const failBefore = before.failCount;
                await syncUserPlaylists(username, signal);
                const after = getProgress(username);
                totalSuccess += after.successCount - successBefore;
                totalAdded += after.addCount - addBefore;
                totalDeleted += after.deleteCount - deleteBefore;
                totalFail += after.failCount - failBefore;
                processedUsers++;
            }
            catch (e) {
                log4js_1.syncLog.warn(`[同步下载] 处理用户 ${username} 时出错: ${e.message}`);
            }
        }
    }
    finally {
        globalIsRunning = false;
        globalLockTime = 0;
    }
    return { processedUsers, totalSuccess, totalAdded, totalDeleted, totalFail };
};
exports.syncDownloadForAllUsers = syncDownloadForAllUsers;
/**
 * 手动触发单个用户的同步（前端调用，可传 playlistId 仅同步单歌单）
 */
const triggerUserSync = async (username, playlistId) => {
    const progress = getProgress(username);
    if (progress.isRunning) {
        return { queued: false, message: '同步任务正在进行中，请稍候' };
    }
    const controller = new AbortController();
    activeAbortControllers.set(username, controller);
    // 异步执行，不阻塞请求
    void syncUserPlaylists(username, controller.signal, playlistId).finally(() => {
        activeAbortControllers.delete(username);
    });
    return { queued: true, message: playlistId ? '歌单同步任务已启动' : '同步任务已启动' };
};
exports.triggerUserSync = triggerUserSync;
/**
 * 创建后台调度任务对象（供 scheduler 调度中心注册）
 */
const createSyncDownloadTask = () => {
    return {
        id: 'sync_download_task',
        name: '歌单歌曲同步下载',
        intervalMs: 0,
        enabled: true,
        isRunning: false,
        run: async () => {
            const startTime = Date.now();
            try {
                const result = await (0, exports.syncDownloadForAllUsers)();
                return {
                    taskId: 'sync_download_task',
                    timestamp: startTime,
                    success: true,
                    message: `已同步 ${result.processedUsers} 个用户: 增加 ${result.totalAdded} 首，减少 ${result.totalDeleted} 首，失败 ${result.totalFail} 首`,
                    details: result
                };
            }
            catch (err) {
                return {
                    taskId: 'sync_download_task',
                    timestamp: startTime,
                    success: false,
                    message: `同步下载失败: ${err.message}`
                };
            }
        }
    };
};
exports.createSyncDownloadTask = createSyncDownloadTask;
