"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.listRadioStations = listRadioStations;
exports.getRadioStation = getRadioStation;
exports.addRadioStation = addRadioStation;
exports.updateRadioStation = updateRadioStation;
exports.removeRadioStation = removeRadioStation;
/**
 * 用户自建网络电台（Internet Radio Station）分用户隔离持久化。
 *
 * 与「官方电台」(QQ music radio_tx_*，由 discovery.fetchRadios 实时抓取) 不同，
 * 用户自建电台由用户在客户端（如音流）粘贴 streamUrl 添加，需落盘持久化。
 *
 * 存储路径：data/users/<username>/radioStations.json
 * 各用户自建电台独立隔离存储，互不干扰。
 */
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const crypto_1 = __importDefault(require("crypto"));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getUserDirname } = require('../user/index.js');
const userCaches = new Map();
function getUserStoreFile(username) {
    const userPath = (global.lx && global.lx.userPath) || path_1.default.join(process.cwd(), 'data', 'users');
    const userDir = path_1.default.join(userPath, getUserDirname(username || 'default'));
    return path_1.default.join(userDir, 'radioStations.json');
}
function load(username) {
    if (userCaches.has(username))
        return userCaches.get(username);
    const storeFile = getUserStoreFile(username);
    let stations = [];
    try {
        if (fs_1.default.existsSync(storeFile)) {
            const raw = JSON.parse(fs_1.default.readFileSync(storeFile, 'utf-8'));
            stations = Array.isArray(raw?.stations) ? raw.stations : [];
        }
    }
    catch (err) {
        if (err?.code !== 'ENOENT') {
            console.error(`[电台服务] 解析/加载用户 ${username} 的电台配置异常:`, err);
        }
        stations = [];
    }
    userCaches.set(username, stations);
    return stations;
}
function persist(username) {
    const storeFile = getUserStoreFile(username);
    const dir = path_1.default.dirname(storeFile);
    if (!fs_1.default.existsSync(dir))
        fs_1.default.mkdirSync(dir, { recursive: true });
    fs_1.default.writeFileSync(storeFile, JSON.stringify({ stations: userCaches.get(username) ?? [] }, null, 2), 'utf-8');
}
function listRadioStations(username) {
    return load(username).map(s => ({ ...s }));
}
function getRadioStation(username, id) {
    const s = load(username).find(x => x.id === id);
    return s ? { ...s } : null;
}
function addRadioStation(username, name, streamUrl, homepageUrl) {
    const stations = load(username);
    const station = {
        id: `radio_usr_${crypto_1.default.randomUUID()}`,
        name,
        streamUrl,
        homepageUrl,
    };
    stations.push(station);
    persist(username);
    return { ...station };
}
function updateRadioStation(username, id, name, streamUrl, homepageUrl) {
    const stations = load(username);
    const s = stations.find(x => x.id === id);
    if (!s)
        return null;
    if (name !== undefined)
        s.name = name;
    if (streamUrl !== undefined)
        s.streamUrl = streamUrl;
    if (homepageUrl !== undefined)
        s.homepageUrl = homepageUrl;
    persist(username);
    return { ...s };
}
function removeRadioStation(username, id) {
    const stations = load(username);
    const idx = stations.findIndex(x => x.id === id);
    if (idx < 0)
        return false;
    stations.splice(idx, 1);
    persist(username);
    return true;
}
