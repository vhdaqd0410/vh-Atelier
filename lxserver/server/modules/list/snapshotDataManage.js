"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SnapshotDataManage = void 0;
const common_1 = require("../../utils/common.js");
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const log4js_1 = require("../../utils/log4js.js");
const utils_1 = require("../../utils/index.js");
const data_1 = require("../../user/data.js");
const constants_1 = require("../../constants.js");
class SnapshotDataManage {
    userDataManage;
    listDir;
    snapshotDir;
    snapshotInfoFilePath;
    snapshotInfo;
    clientSnapshotKeys;
    saveSnapshotInfoThrottle;
    isIncluedsDevice = (key) => {
        return this.clientSnapshotKeys.includes(key);
    };
    clearOldSnapshot = async () => {
        if (!this.snapshotInfo)
            return;
        const snapshotList = this.snapshotInfo.list.filter(key => !this.isIncluedsDevice(key));
        // console.log(snapshotList.length, lx.config.maxSnapshotNum)
        const userMaxSnapshotNum = (0, data_1.getUserConfig)(this.userDataManage.userName).maxSnapshotNum;
        let requiredSave = snapshotList.length > userMaxSnapshotNum;
        while (snapshotList.length > userMaxSnapshotNum) {
            const name = snapshotList.pop();
            if (name) {
                await this.removeSnapshot(name);
                this.snapshotInfo.list.splice(this.snapshotInfo.list.indexOf(name), 1);
            }
            else
                break;
        }
        if (requiredSave)
            this.saveSnapshotInfo(this.snapshotInfo);
    };
    updateDeviceSnapshotKey = async (clientId, key) => {
        // console.log('updateDeviceSnapshotKey', key)
        let client = this.snapshotInfo.clients[clientId];
        if (!client)
            client = this.snapshotInfo.clients[clientId] = { snapshotKey: '', lastSyncDate: 0 };
        if (client.snapshotKey)
            this.clientSnapshotKeys.splice(this.clientSnapshotKeys.indexOf(client.snapshotKey), 1);
        client.snapshotKey = key;
        client.lastSyncDate = Date.now();
        this.clientSnapshotKeys.push(key);
        this.saveSnapshotInfoThrottle();
    };
    getDeviceCurrentSnapshotKey = async (clientId) => {
        // console.log('updateDeviceSnapshotKey', key)
        const client = this.snapshotInfo.clients[clientId];
        return client?.snapshotKey;
    };
    getSnapshotInfo = async () => {
        return this.snapshotInfo;
    };
    saveSnapshotInfo = (info) => {
        this.snapshotInfo = info;
        this.saveSnapshotInfoThrottle();
    };
    removeSnapshotInfo = (clientId) => {
        let client = this.snapshotInfo.clients[clientId];
        if (!client)
            return;
        if (client.snapshotKey)
            this.clientSnapshotKeys.splice(this.clientSnapshotKeys.indexOf(client.snapshotKey), 1);
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete this.snapshotInfo.clients[clientId];
        this.saveSnapshotInfoThrottle();
    };
    getSnapshot = async (name) => {
        const filePath = node_path_1.default.join(this.snapshotDir, `snapshot_${name}`);
        let listData;
        try {
            listData = JSON.parse((await node_fs_1.default.promises.readFile(filePath)).toString('utf-8'));
        }
        catch (err) {
            log4js_1.syncLog.warn(err);
            return null;
        }
        return listData;
    };
    saveSnapshot = async (name, data) => {
        log4js_1.syncLog.info('saveSnapshot', this.userDataManage.userName, name);
        const filePath = node_path_1.default.join(this.snapshotDir, `snapshot_${name}`);
        try {
            node_fs_1.default.writeFileSync(filePath, data);
        }
        catch (err) {
            log4js_1.syncLog.error(err);
            throw err;
        }
    };
    saveSnapshotWithTime = async (name, data, time) => {
        log4js_1.syncLog.info('saveSnapshotWithTime', this.userDataManage.userName, name, time);
        const filePath = node_path_1.default.join(this.snapshotDir, `snapshot_${name}`);
        try {
            node_fs_1.default.writeFileSync(filePath, data);
            if (time) {
                const date = new Date(time);
                node_fs_1.default.utimesSync(filePath, date, date);
            }
        }
        catch (err) {
            log4js_1.syncLog.error(err);
            throw err;
        }
    };
    removeSnapshot = async (name) => {
        log4js_1.syncLog.info('removeSnapshot', this.userDataManage.userName, name);
        const filePath = node_path_1.default.join(this.snapshotDir, `snapshot_${name}`);
        try {
            node_fs_1.default.unlinkSync(filePath);
        }
        catch (err) {
            log4js_1.syncLog.error(err);
        }
    };
    getSnapshotListWithMeta = async () => {
        const list = [];
        try {
            const files = await node_fs_1.default.promises.readdir(this.snapshotDir);
            for (const file of files) {
                if (!file.startsWith('snapshot_'))
                    continue;
                const name = file.replace('snapshot_', '');
                const filePath = node_path_1.default.join(this.snapshotDir, file);
                try {
                    const stat = await node_fs_1.default.promises.stat(filePath);
                    list.push({
                        id: name,
                        time: stat.mtimeMs,
                        size: stat.size,
                    });
                }
                catch (e) {
                    // ignore missing files
                }
            }
        }
        catch (err) {
            log4js_1.syncLog.error(err);
        }
        // Sort by time desc
        return list.sort((a, b) => b.time - a.time);
    };
    clearClients = () => {
        this.snapshotInfo.clients = {};
        this.clientSnapshotKeys = [];
        this.saveSnapshotInfoThrottle();
    };
    setLatest = (name) => {
        this.snapshotInfo.latest = name;
        this.saveSnapshotInfoThrottle();
    };
    /**
     * 动态更新快照目录并迁移历史数据（无需重启即时生效）
     * @param targetBackupPath 新的 snapshot.backupPath 配置字符串
     */
    updateSnapshotDir = (targetBackupPath) => {
        const backupPathConf = (targetBackupPath !== undefined ? targetBackupPath : (global.lx.config['snapshot.backupPath'] || '')).trim();
        const oldSnapshotDir = this.snapshotDir;
        let newSnapshotDir = '';
        if (backupPathConf) {
            try {
                const base = node_path_1.default.isAbsolute(backupPathConf)
                    ? backupPathConf
                    : node_path_1.default.join(global.lx.dataPath, backupPathConf);
                newSnapshotDir = node_path_1.default.join(base, this.userDataManage.userName, constants_1.File.listSnapshotDir);
                (0, utils_1.checkAndCreateDirSync)(newSnapshotDir);
            }
            catch (err) {
                log4js_1.syncLog.warn(`[Snapshot] 无法创建自定义快照目录 (${backupPathConf})，已安全回退到默认目录:`, err);
                newSnapshotDir = node_path_1.default.join(this.listDir, constants_1.File.listSnapshotDir);
            }
        }
        else {
            newSnapshotDir = node_path_1.default.join(this.listDir, constants_1.File.listSnapshotDir);
        }
        (0, utils_1.checkAndCreateDirSync)(newSnapshotDir);
        // 确定源目录（从旧 snapshotDir 或默认 legacyDir 迁移）
        const sourceDir = oldSnapshotDir || node_path_1.default.join(this.listDir, constants_1.File.listSnapshotDir);
        if (newSnapshotDir !== sourceDir && node_fs_1.default.existsSync(sourceDir)) {
            try {
                let count = 0;
                for (const name of node_fs_1.default.readdirSync(sourceDir)) {
                    const src = node_path_1.default.join(sourceDir, name);
                    const dst = node_path_1.default.join(newSnapshotDir, name);
                    if (!node_fs_1.default.existsSync(dst)) {
                        try {
                            node_fs_1.default.renameSync(src, dst);
                            count++;
                        }
                        catch (e) {
                            log4js_1.syncLog.error(`[Snapshot] 迁移快照文件失败 (${name}):`, e);
                        }
                    }
                }
                if (count > 0) {
                    log4js_1.syncLog.info(`[Snapshot] 用户 ${this.userDataManage.userName} 歌单快照迁移成功 (共 ${count} 个文件 -> ${newSnapshotDir})`);
                }
                if (node_fs_1.default.existsSync(sourceDir) && node_fs_1.default.readdirSync(sourceDir).length === 0) {
                    try {
                        node_fs_1.default.rmdirSync(sourceDir);
                        // 向上递归清理空的父目录（如 data/snapshot/admin）
                        let parent = node_path_1.default.dirname(sourceDir);
                        while (parent && parent !== global.lx.dataPath && parent !== node_path_1.default.dirname(global.lx.dataPath)) {
                            if (node_fs_1.default.existsSync(parent) && node_fs_1.default.readdirSync(parent).length === 0) {
                                node_fs_1.default.rmdirSync(parent);
                                parent = node_path_1.default.dirname(parent);
                            }
                            else {
                                break;
                            }
                        }
                    }
                    catch { }
                }
            }
            catch (err) {
                log4js_1.syncLog.error(`[Snapshot] 用户 ${this.userDataManage.userName} 歌单快照迁移失败:`, err);
            }
        }
        this.snapshotDir = newSnapshotDir;
        this.snapshotInfoFilePath = node_path_1.default.join(this.snapshotDir, constants_1.File.listSnapshotInfoJSON);
        const legacyInfoPath = node_path_1.default.join(this.listDir, constants_1.File.listSnapshotInfoJSON);
        if (!node_fs_1.default.existsSync(this.snapshotInfoFilePath) && node_fs_1.default.existsSync(legacyInfoPath)) {
            try {
                node_fs_1.default.renameSync(legacyInfoPath, this.snapshotInfoFilePath);
            }
            catch (e) {
                log4js_1.syncLog.error('migrate snapshotInfo failed:', e);
            }
        }
        if (node_fs_1.default.existsSync(this.snapshotInfoFilePath)) {
            try {
                this.snapshotInfo = JSON.parse(node_fs_1.default.readFileSync(this.snapshotInfoFilePath).toString());
            }
            catch { }
        }
    };
    constructor(userDataManage) {
        this.userDataManage = userDataManage;
        this.listDir = node_path_1.default.join(userDataManage.userDir, constants_1.File.listDir);
        (0, utils_1.checkAndCreateDirSync)(this.listDir);
        this.snapshotInfo = { latest: null, time: 0, list: [], clients: {} };
        this.updateSnapshotDir();
        this.saveSnapshotInfoThrottle = (0, common_1.throttle)(() => {
            node_fs_1.default.writeFile(this.snapshotInfoFilePath, JSON.stringify(this.snapshotInfo), 'utf8', (err) => {
                if (err)
                    console.error(err);
                void this.clearOldSnapshot();
            });
        });
        this.clientSnapshotKeys = Object.values(this.snapshotInfo.clients).map(device => device.snapshotKey).filter(k => k);
    }
}
exports.SnapshotDataManage = SnapshotDataManage;
// type UserDataManages = Map<string, UserDataManage>
// export const createUserDataManage = (user: LX.UserConfig) => {
//   const manage = Object.create(userDataManage) as typeof userDataManage
//   manage.userDir = user.dataPath
// }
