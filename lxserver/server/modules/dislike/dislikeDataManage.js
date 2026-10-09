"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DislikeDataManage = void 0;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const constants_1 = require("../../constants.js");
const utils_1 = require("./utils");
class DislikeDataManage {
    snapshotDataManage;
    dislikeRules = { dislikeList: [] };
    constructor(snapshotDataManage) {
        this.snapshotDataManage = snapshotDataManage;
        try {
            const latest = this.snapshotDataManage.snapshotInfo?.latest;
            if (latest) {
                const filePath = node_path_1.default.join(this.snapshotDataManage.snapshotDir, `snapshot_${latest}`);
                if (node_fs_1.default.existsSync(filePath)) {
                    const content = node_fs_1.default.readFileSync(filePath, 'utf-8').trim();
                    if (content.startsWith('{')) {
                        const parsed = JSON.parse(content);
                        this.dislikeRules = parsed;
                        // normalize: populate missing dislikeRule fields from name/singer
                        this.normalizeRules();
                    }
                }
            }
        }
        catch { /* ignore */ }
        void this.snapshotDataManage.getSnapshotInfo().then(async (snapshotInfo) => {
            if (!snapshotInfo.latest)
                return;
            const data = await this.snapshotDataManage.getSnapshot(snapshotInfo.latest);
            if (data) {
                this.dislikeRules = data;
                this.normalizeRules();
            }
        });
    }
    /**
     * Build the canonical rule string for a DislikeSongInfo entry.
     * Snapshot entries loaded from disk may not have dislikeRule populated
     * (they only have name/singer from the original music object).
     * Format: "name@singer" | "@singer" | "name"
     */
    buildDislikeRule(item) {
        if (item.dislikeRule)
            return item.dislikeRule;
        const name = (item.name ?? '').trim();
        const singer = (item.singer ?? '').trim();
        if (name && singer)
            return `${name}${constants_1.SPLIT_CHAR.DISLIKE_NAME}${singer}`;
        if (singer)
            return `${constants_1.SPLIT_CHAR.DISLIKE_NAME}${singer}`;
        return name;
    }
    /**
     * Ensure every entry in dislikeList has dislikeRule populated.
     * Called after loading from snapshot so getDislikeRulesString works correctly.
     */
    normalizeRules() {
        for (const item of this.dislikeRules.dislikeList) {
            if (!item.dislikeRule) {
                item.dislikeRule = this.buildDislikeRule(item);
            }
        }
    }
    // Returns the structured object
    getDislikeRules = async () => {
        return this.dislikeRules;
    };
    // Returns all active rule strings separated by newline (used by dislikeCache for parsing)
    getDislikeRulesString = () => {
        return this.dislikeRules.dislikeList
            .map(s => this.buildDislikeRule(s))
            .filter(Boolean)
            .join('\n');
    };
    addDislikeInfo = async (infos) => {
        // Check for duplicates
        const currentRules = new Set(this.dislikeRules.dislikeList.map(s => this.buildDislikeRule(s)));
        for (const info of infos) {
            const rule = this.buildDislikeRule(info);
            if (!rule)
                continue;
            if (!currentRules.has(rule)) {
                info.dislikeRule = rule;
                this.dislikeRules.dislikeList.push(info);
                currentRules.add(rule);
            }
        }
        return this.dislikeRules;
    };
    addDislikeAlbums = async (infos) => {
        if (!infos || infos.length === 0)
            return this.dislikeRules;
        const currentRules = new Set(this.dislikeRules.dislikeList.map(s => this.buildDislikeRule(s)));
        const lines = infos.map(info => (0, utils_1.encodeAlbumRule)(info.albumName, info.singer));
        for (let i = 0; i < lines.length; i++) {
            const rule = lines[i];
            if (!currentRules.has(rule)) {
                this.dislikeRules.dislikeList.push({
                    name: '',
                    singer: '',
                    dislikeRule: rule
                });
                currentRules.add(rule);
            }
        }
        return this.dislikeRules;
    };
    overwirteDislikeInfo = async (rulesString) => {
        // Called when removing items: keep only entries whose rule key is still in the string
        const validRules = new Set((0, utils_1.filterRules)(rulesString));
        this.dislikeRules.dislikeList = this.dislikeRules.dislikeList.filter(item => validRules.has(this.buildDislikeRule(item)));
        return this.dislikeRules;
    };
}
exports.DislikeDataManage = DislikeDataManage;
