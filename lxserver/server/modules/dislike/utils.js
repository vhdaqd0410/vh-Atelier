"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.filterRules = exports.parseAlbumRule = exports.isAlbumRule = exports.encodeAlbumRule = exports.ALBUM_RULE_PREFIX = void 0;
const constants_1 = require("../../constants.js");
const songVersion_1 = require("../../server/utils/songVersion.js");
// ─────────────────────────────────────────────
// 专辑维度规则（lxserver 扩展）
// 格式：!<专辑名>@<歌手>
//
// 按歌手拆成多条存储（一张合辑若有 A/B/C 三位歌手，则写 3 行）。
// 用 ! 前缀与「歌手(@歌手)」「歌曲(歌名@歌手)」维度区分；
// 歌手恒在 @ 末尾，故解析按最后一个 @ 切，专辑名可含 @。
// ─────────────────────────────────────────────
exports.ALBUM_RULE_PREFIX = '!';
/** 生成一条专辑规则行（!<专辑名>@<歌手>）。按歌手拆多条时多次调用。 */
const encodeAlbumRule = (albumName, singer) => {
    return `${exports.ALBUM_RULE_PREFIX}${albumName}${constants_1.SPLIT_CHAR.DISLIKE_NAME}${singer ?? ''}`;
};
exports.encodeAlbumRule = encodeAlbumRule;
/** 是否专辑规则行 */
const isAlbumRule = (line) => line.startsWith(exports.ALBUM_RULE_PREFIX);
exports.isAlbumRule = isAlbumRule;
/**
 * 解析专辑规则行，非专辑规则返回 null。
 * 新格式：!<专辑名>@<歌手>（按最后一个 @ 切，歌手恒在末尾）。
 */
const parseAlbumRule = (line) => {
    if (!(0, exports.isAlbumRule)(line))
        return null;
    const body = line.slice(1);
    const idx = body.lastIndexOf(constants_1.SPLIT_CHAR.DISLIKE_NAME);
    if (idx < 0)
        return null;
    const albumName = (0, songVersion_1.normalizeText)(body.slice(0, idx).trim());
    const singer = (0, songVersion_1.normalizeText)(body.slice(idx + 1).trim());
    if (!albumName)
        return null;
    return { albumName, singer };
};
exports.parseAlbumRule = parseAlbumRule;
/**
 * 规整并去重不喜欢规则串。
 * 歌曲维度做「歌名@歌手」归一化；专辑维度（! 前缀）先解析再重新编码，
 * 避免把分隔符 @ 误写成 # 导致专辑规则失效且无法删除。
 * @param rules 原始规则串（换行分隔）
 * @returns 归一化后的规则集合（已去重）
 */
const filterRules = (rules) => {
    const list = [];
    for (const item of rules.split('\n')) {
        const line = item.trim();
        if (!line)
            continue;
        // 专辑规则（!<专辑名>@<歌手>）：按歌手拆分存储，专辑名可能含 @，不走歌曲规则的 @ 切分。
        // 必须「先解析再重新编码」：直接对整行 normalizeText 会把分隔符 @ 替换成 #，
        // 导致 parseAlbumRule 无法识别该行、删除侧也无法精确匹配。统一成 !<归一化专辑名>@<归一化歌手>。
        if (line.startsWith(exports.ALBUM_RULE_PREFIX)) {
            const parsed = (0, exports.parseAlbumRule)(line);
            list.push(parsed ? (0, exports.encodeAlbumRule)(parsed.albumName, parsed.singer) : (0, songVersion_1.normalizeText)(line));
            continue;
        }
        let [name, singer] = item.split(constants_1.SPLIT_CHAR.DISLIKE_NAME);
        if (name) {
            name = name.replaceAll(constants_1.SPLIT_CHAR.DISLIKE_NAME, constants_1.SPLIT_CHAR.DISLIKE_NAME_ALIAS).toLocaleLowerCase().trim();
            if (singer) {
                singer = singer.replaceAll(constants_1.SPLIT_CHAR.DISLIKE_NAME, constants_1.SPLIT_CHAR.DISLIKE_NAME_ALIAS).toLocaleLowerCase().trim();
                list.push(`${name}${constants_1.SPLIT_CHAR.DISLIKE_NAME}${singer}`);
            }
            else {
                list.push(name);
            }
        }
        else if (singer) {
            singer = singer.replaceAll(constants_1.SPLIT_CHAR.DISLIKE_NAME, constants_1.SPLIT_CHAR.DISLIKE_NAME_ALIAS).toLocaleLowerCase().trim();
            list.push(`${constants_1.SPLIT_CHAR.DISLIKE_NAME}${singer}`);
        }
    }
    return new Set(list);
};
exports.filterRules = filterRules;
