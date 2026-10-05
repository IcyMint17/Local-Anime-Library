/**
 * Turns release-group file names and folder names into structured data.
 *
 * Real-world inputs this has to survive (all taken from the author's library):
 *   [Nekomoe kissaten&LoliHouse] ATRI -My Dear Moments- - 01 [WebRip 1080p HEVC-10bit AAC ASSx2].mkv
 *   [LPSub] BanG Dream! It's MyGO!!!!! [BDRip][01][1080p][AVC AAC][JPSC].mp4
 *   [DBD-Raws][孤独摇滚！][歌曲欣赏][01][1080P][BDRip][HEVC-10bit][FLAC].mkv
 *   [Sakurato] Spy x Family (2025) [01][HEVC-10bit 1080p AAC][CHS&CHT].mkv
 *   [hyakuhuyu&LoliHouse] Re Zero kara Hajimeru Isekai Seikatsu - 67 [WebRip ...].mkv
 *   [Airota][Chuunibyou_demo_Koi_ga_Shitai! -Take On Me-][Movie][BDrip_1080P][x264_AAC][CHT].mp4
 */

const RESOLUTIONS = new Set([144, 240, 360, 432, 480, 540, 576, 720, 1080, 1440, 2160, 4320]);

/** Keywords that mark a bracketed segment as release metadata rather than a title. */
const METADATA_KEYWORDS = [
  /\b(?:1080|720|2160|1440|480|576|360)p\b/i,
  /\b(?:x|h)26[45]\b/i,
  /\bHEVC\b/i,
  /\bAVC\b/i,
  /\b(?:AAC|FLAC|EAC3|AC3|DTS|OPUS|MP3)\b/i,
  /\b\d+bit\b/i,
  /\b(?:BDRip|WebRip|TVRip|UHDRip|DVDRip|BD|WEB)\b/i,
  /\b(?:CHS|CHT|GB|BIG5|JPSC|JPTC|JPN|SC|TC)\b/i,
  /\b(?:MP4|MKV|AVI)\b/i,
  /\b(?:Fin|END|Complete)\b/i,
  /^\d+\s*[-~]\s*\d+/,
  /^\d{1,4}(?:v\d)?$/,
  /简繁|繁简|外挂|内嵌|字体|字幕組|字幕组/,
  /^[A-Z0-9_]{2,12}$/,
];

/** Keywords that mark a file as a special / extra rather than a main episode. */
const SPECIAL_KEYWORDS = [
  /\bNC(?:OP|ED)\b/i,
  /\bNCOP\b/i,
  /\bNCED\b/i,
  /\b(?:OVA|OAD|ONA)\b/i,
  /\b(?:PV|CM|Menu|Preview|Trailer)\b/i,
  /\bMV\b/,
  /\b(?:Making|Digest|Interview)\b/i,
  /\bSPs?\b/,
  /特典/,
  /映像特典/,
  /小剧场/,
  /迷你/,
  /歌曲欣赏/,
  /吉他英雄之路/,
  /谈话/,
  /座談/,
  /采访/,
  /花絮/,
  /预告/,
  /舞台/,
  /声优/,
  /广播剧/,
  /特番/,
  /特别篇/,
  /番外/,
  /未放送/,
  /总集篇/,
  /総集編/,
];

/**
 * Extra-content markers that only count when they appear in a *sub-folder*.
 * "孤独摇滚！" puts 歌曲欣赏 / 吉他英雄之路 / 谈话 in sub-folders of a release
 * folder whose own name contains 特典映像, so folder-level detection has to be
 * limited to the path segments below the main release folder.
 */
export const EXTRA_FOLDER_KEYWORDS = [
  /特典/,
  /映像/,
  /小剧场/,
  /歌曲欣赏/,
  /吉他英雄之路/,
  /谈话/,
  /座談/,
  /采访/,
  /花絮/,
  /预告/,
  /舞台/,
  /声优/,
  /广播剧/,
  /特番/,
  /特别篇/,
  /番外/,
  /总集篇/,
  /総集編/,
  /\bMenu\b/i,
  /\bBonus\b/i,
  /\bExtras?\b/i,
];

export function isExtraFolderName(name) {
  return EXTRA_FOLDER_KEYWORDS.some((pattern) => pattern.test(String(name ?? '')));
}

const MOVIE_KEYWORDS = [/\bMovie\b/i, /\bThe Movie\b/i, /劇場版/, /剧场版/, /劇場総集編/, /剧场总集篇/];

const CN_DIGITS = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

function cnNumber(text) {
  if (/^\d+$/.test(text)) return Number(text);
  if (text === '十') return 10;
  if (text.length === 1) return CN_DIGITS[text] ?? null;
  // 十一 … 十九 / 二十 / 二十一
  const match = /^([一二三四五六七八九])?十([一二三四五六七八九])?$/.exec(text);
  if (match) {
    const tens = match[1] ? CN_DIGITS[match[1]] : 1;
    const ones = match[2] ? CN_DIGITS[match[2]] : 0;
    return tens * 10 + ones;
  }
  return null;
}

/** Lowercases, folds full-width characters and strips punctuation for comparison. */
export function normaliseName(input) {
  return String(input ?? '')
    .toLowerCase()
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\u3000]/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Dice coefficient over character bigrams — works for both CJK and Latin text. */
function diceOver(a, b, sizeA, sizeB) {
  if (!a.size || !b.size || sizeA <= 0 || sizeB <= 0) return 0;
  let overlap = 0;
  for (const [gram, count] of a) {
    const other = b.get(gram);
    if (other) overlap += Math.min(count, other);
  }
  return (2 * overlap) / (sizeA + sizeB);
}

function multiset(text, length) {
  const set = new Map();
  for (let i = 0; i + length <= text.length; i += 1) {
    const gram = text.slice(i, i + length);
    set.set(gram, (set.get(gram) ?? 0) + 1);
  }
  return set;
}

const CJK_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

export function similarity(a, b) {
  const left = normaliseName(a);
  const right = normaliseName(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) {
    const ratio = Math.min(left.length, right.length) / Math.max(left.length, right.length);
    return 0.85 + 0.15 * ratio;
  }
  const bigramScore = diceOver(multiset(left, 2), multiset(right, 2), left.length - 1, right.length - 1);
  if (!CJK_PATTERN.test(left) && !CJK_PATTERN.test(right)) return bigramScore;
  // Chinese titles are short and share whole characters rather than bigrams
  // (超时空辉夜姬 vs 超辉夜姬), so a character-level measure is kinder.
  const unigramScore = diceOver(multiset(left, 1), multiset(right, 1), left.length, right.length);
  return Math.max(bigramScore, unigramScore);
}

export function isMetadataTag(tag) {
  const trimmed = tag.trim();
  if (!trimmed) return true;
  return METADATA_KEYWORDS.some((pattern) => pattern.test(trimmed));
}

/** Splits a name into bracket tags and the text outside of them. */
export function splitTags(name) {
  const tags = [];
  let outside = name.replace(/[[【]([^\][【】]*)[\]】]/g, (_, tag) => {
    tags.push(tag.trim());
    return ' ';
  });
  // Parentheses usually hold release metadata ("(00-12Fin WEBRip 1080p AAC SC)")
  // or a year ("(2025)"), but can also be part of a real title. Only treat them
  // as a tag when the content clearly looks like metadata.
  outside = outside.replace(/\(([^()]*)\)/g, (match, inner) => {
    const trimmed = inner.trim();
    if (trimmed && isMetadataTag(trimmed)) {
      tags.push(trimmed);
      return ' ';
    }
    return match;
  });
  return { tags, outside: outside.replace(/\s+/g, ' ').trim() };
}

export function stripExtension(name) {
  return name.replace(/\.[a-z0-9]{2,5}$/i, '');
}

function isUsableEpisodeNumber(value) {
  if (!Number.isFinite(value) || value < 0 || value > 3000) return false;
  if (RESOLUTIONS.has(value)) return false;
  if (value >= 1900 && value <= 2100) return false; // years
  return true;
}

/**
 * Finds an episode number, trying the most reliable patterns first.
 * Returns { number, label, confidence } or null.
 */
export function findEpisode(name) {
  const text = stripExtension(name);
  const patterns = [
    { re: /\bS\d{1,2}E(\d{1,4})\b/i, confidence: 1 },
    { re: /第\s*(\d{1,4})\s*[话話集]/i, confidence: 1 },
    { re: /第\s*([一二三四五六七八九十]{1,3})\s*[话話集]/, confidence: 0.95 },
    { re: /[-–—]\s*(\d{1,4})(?:v\d)?(?:\s|$|[[(（])/, confidence: 0.85 },
    // Handles plain numbers, revisions ("01v2"), batch tails ("12END", "12 Fin")
    // and half episodes ("11.5").
    {
      re: /[[［](\d{1,4}(?:\.\d{1,2})?)\s*(?:v\d)?\s*(?:END|Fin|FIN|完|全集)?\s*[\]］]/,
      confidence: 0.8,
    },
    { re: /(?:^|[\s_\]])(\d{1,4})(?:v\d)?\s*[-–—]\s*(?![0-9])/, confidence: 0.6 },
    { re: /(?:^|[^0-9])(\d{2,4})(?:v\d)?(?=\s*[[(（]|\s*$)/, confidence: 0.5 },
  ];

  for (const { re, confidence } of patterns) {
    const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    let match;
    while ((match = global.exec(text)) !== null) {
      const raw = match[1];
      // Decimal-aware: half episodes like 11.5 exist in real releases.
      const value = /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : cnNumber(raw);
      if (!isUsableEpisodeNumber(value)) continue;
      return { number: value, label: raw, confidence };
    }
  }
  return null;
}

/** Detects "01-13" style ranges, used as a hint rather than a real episode number. */
export function findEpisodeRange(name) {
  const match = /(?:^|[^\d])(\d{1,4})\s*[-~～]\s*(\d{1,4})(?:v\d)?(?:[^\d]|$)/.exec(name);
  if (!match) return null;
  const from = Number(match[1]);
  const to = Number(match[2]);
  if (!isUsableEpisodeNumber(from) || !isUsableEpisodeNumber(to) || to <= from) return null;
  return { from, to };
}

const SEASON_ALIASES = [
  [/\b(?:repeat)\b/i, 2],
  [/\b(?:nonstop|non\s*stop)\b/i, 3],
  [/\bbloom\b/i, 3],
  [/\bnext\b/i, 4],
];

/**
 * Detects a season number. Chinese markers are preferred over Roman numerals
 * because folder names like "无职转生 第二季" carry the season explicitly.
 */
export function findSeason(text) {
  const source = String(text ?? '');

  const cn = /第\s*([一二三四五六七八九十\d]{1,3})\s*[季期]/.exec(source);
  if (cn) {
    const value = cnNumber(cn[1]);
    if (value && value >= 1 && value <= 20) return value;
  }

  const ordinal = /\b(\d{1,2})(?:st|nd|rd|th)\s*season\b/i.exec(source);
  if (ordinal) {
    const value = Number(ordinal[1]);
    if (value >= 1 && value <= 20) return value;
  }

  const english = /\bseason\s*(\d{1,2})\b/i.exec(source);
  if (english) {
    const value = Number(english[1]);
    if (value >= 1 && value <= 20) return value;
  }

  // Also matches the common "Re0S3" / "KonosubaS3" style, where a digit precedes the S.
  const short = /(?:^|[^A-Za-z])S(\d{1,2})(?![0-9A-Za-z])/.exec(source);
  if (short) {
    const value = Number(short[1]);
    if (value >= 1 && value <= 20) return value;
  }

  for (const [pattern, value] of SEASON_ALIASES) {
    if (pattern.test(source)) return value;
  }

  const roman = /(?:^|\s)(II|III|IV|V|VI)(?=\s|$|[-–—～!！:：])/.exec(source);
  if (roman) {
    return { II: 2, III: 3, IV: 4, V: 5, VI: 6 }[roman[1]];
  }

  return null;
}

/** Detects "第2部分" / "第2クール" — a part inside a season, not a season itself. */
export function findPart(text) {
  const cn = /第\s*([一二三四五六七八九十\d]{1,3})\s*[部分](?![\u4e00-\u9fa5])/.exec(text ?? '');
  if (cn) return cnNumber(cn[1]);
  const cour = /第\s*([一二三四五六七八九十\d]{1,3})\s*(?:クール|部)/.exec(text ?? '');
  if (cour) return cnNumber(cour[1]);
  return null;
}

export function detectKind(text) {
  const source = String(text ?? '');
  if (MOVIE_KEYWORDS.some((pattern) => pattern.test(source))) return 'movie';
  if (SPECIAL_KEYWORDS.some((pattern) => pattern.test(source))) return 'special';
  return null;
}

/** Removes release noise, season markers and episode numbers to get a clean title. */
export function cleanupTitle(input) {
  let title = String(input ?? '');
  title = stripExtension(title);
  title = title.replace(/\b\d{1,2}(?:st|nd|rd|th)\s*season\b/gi, ' ');
  title = title.replace(/\bseason\s*\d{1,2}\b/gi, ' ');
  title = title.replace(/第\s*[一二三四五六七八九十\d]{1,3}\s*[季期]/g, ' ');
  // Lookbehind keeps the character before the marker (e.g. the 活 in
  // "从零开始的异世界生活S3", or the 0 in "Re0S3").
  title = title.replace(/(?<![A-Za-z])S\d{1,2}(?![0-9A-Za-z])/g, ' ');
  title = title.replace(/\b(?:Movie|The Movie)\b/gi, ' ');
  title = title.replace(/(?:劇場版|剧场版|劇場総集編|剧场总集篇)/g, ' ');
  title = title.replace(/\b(?:NCED|NCOP|OVA|OAD|ONA|PV|CM|Menu|Preview|Trailer)\b/gi, ' ');
  title = title.replace(/特典|映像特典|小剧场|迷你|歌曲欣赏|番外|未放送/g, ' ');
  title = title.replace(/[-–—_]\s*\d{1,4}(?:v\d)?\s*$/, ' ');
  title = title.replace(/\b\d{1,4}(?:v\d)?\s*$/, ' ');
  title = title.replace(/\bv\d+\s*$/i, ' ');
  title = title.replace(/[_-]+/g, ' ');
  title = title.replace(/\s{2,}/g, ' ');
  return title.replace(/^[\s\-–—·.、!,，]+|[\s\-–—·.、!,，]+$/g, '').trim();
}

/** Release-group markers, used to stop "[DHR&MakariHoshiyume]" from beating a real title. */
const RELEASE_GROUP_HINTS = /&|\+|raws|fansub|kissaten|house|studio|\bsub\b|sub$|字幕组|压制/i;

function scoreTitleCandidate(tag) {
  if (isMetadataTag(tag)) return Number.NEGATIVE_INFINITY;
  if (SPECIAL_KEYWORDS.some((pattern) => pattern.test(tag))) return Number.NEGATIVE_INFINITY;
  const cleaned = cleanupTitle(tag);
  if (cleaned.replace(/[^\p{L}\p{N}]/gu, '').length < 2) return Number.NEGATIVE_INFINITY;
  let score = Math.min(cleaned.length, 40) / 40;
  if (/\p{Script=Han}/u.test(cleaned)) score += 3;
  if (/\s/.test(cleaned)) score += 2;
  if (RELEASE_GROUP_HINTS.test(tag)) score -= 2;
  return score;
}

/** Picks the most title-like bracketed tag when nothing sits outside the brackets. */
function bestTitleTag(tags) {
  let best = '';
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const tag of tags) {
    const score = scoreTitleCandidate(tag);
    if (score > bestScore) {
      bestScore = score;
      best = tag;
    }
  }
  return bestScore === Number.NEGATIVE_INFINITY ? '' : best;
}

const RELIABLE_TAGS = [
  /\b(?:Nekomoe kissaten|LoliHouse|Sakurato|LoliHouse|DMG|KTXP|JYFanSub|Airota|LPSub|DBD-Raws|Comicat|KissSub|DHR|MakariHoshiyume|Fyy Raws|hyakuhuyu)\b/i,
];

/**
 * Parses one video file name.
 * @returns {{title:string, season:number|null, part:number|null, episode:number|null,
 *            episodeLabel:string|null, kind:'episode'|'special'|'movie', tags:string[], confidence:number}}
 */
export function parseFileName(fileName) {
  const base = stripExtension(fileName);
  const { tags, outside } = splitTags(base);
  const tagText = tags.join(' ');

  const episode = findEpisode(base);
  const season = findSeason(`${base}`);
  const part = findPart(base);

  let kind = detectKind(`${tagText} ${outside}`) ?? 'episode';
  if (kind === 'episode') {
    // A file with no episode number sitting alone in a "剧场版" style folder is a movie,
    // but we let the grouping step decide that. Here we only flag explicit markers.
    kind = 'episode';
  }

  let title = cleanupTitle(outside);
  if (!title || RELIABLE_TAGS.some((pattern) => pattern.test(title)) || title.length < 2) {
    const fallback = bestTitleTag(tags);
    if (fallback) title = cleanupTitle(fallback);
  }

  let confidence = 0.5;
  if (episode) confidence += episode.confidence * 0.3;
  if (title) confidence += 0.2;
  if (season) confidence += 0.1;

  return {
    title,
    season,
    part,
    episode: episode?.number ?? null,
    episodeLabel: episode?.label ?? null,
    episodeConfidence: episode?.confidence ?? 0,
    kind,
    tags,
    confidence: Math.min(1, confidence),
  };
}

/**
 * Parses a top-level series folder name (e.g. "Re：从零开始的异世界生活 第四季 丧失篇").
 */
export function parseFolderName(folderName) {
  const cleaned = folderName.replace(/[\\/]+$/, '');
  const season = findSeason(cleaned);
  const part = findPart(cleaned);
  const kind = detectKind(cleaned) ?? 'episode';
  const title = cleanupTitle(cleaned) || cleaned;
  return { title, season, part, kind, raw: cleaned };
}

/** Parses a release-group folder name, which often carries the season. */
export function parseReleaseFolderName(folderName) {
  const { tags, outside } = splitTags(stripExtension(folderName));
  const combined = `${outside} ${tags.join(' ')}`;
  return {
    season: findSeason(combined),
    part: findPart(combined),
    kind: detectKind(combined),
    episodeRange: findEpisodeRange(combined),
    raw: folderName,
  };
}

export const VIDEO_EXTENSION_SET = new Set([
  '.mkv',
  '.mp4',
  '.avi',
  '.mov',
  '.wmv',
  '.flv',
  '.ts',
  '.m2ts',
  '.webm',
  '.rmvb',
  '.rm',
  '.iso',
  '.mpg',
  '.mpeg',
]);

export function isVideoFile(fileName) {
  const dot = fileName.lastIndexOf('.');
  if (dot === -1) return false;
  return VIDEO_EXTENSION_SET.has(fileName.slice(dot).toLowerCase());
}
