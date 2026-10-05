#!/usr/bin/env node
/**
 * Dev tool: print how the scanner groups a media library.
 * Usage: node tools/inspect-library.mjs [libraryRoot]
 */
import { walkVideos } from '../src/scan/walk.js';
import { groupFiles } from '../src/scan/group.js';

const root = process.argv[2] ?? 'E:\\Videos\\Anime';
const { files, skippedFiles, errors } = walkVideos(root);
const groups = groupFiles(files, { rootName: root.split(/[\\/]/).pop() });

console.log(`根目录: ${root}`);
console.log(`视频文件: ${files.length} 个 | 跳过的非视频文件: ${skippedFiles} 个 | 读取错误: ${errors.length} 个`);
console.log(`分组结果: ${groups.length} 组\n`);

for (const group of groups) {
  const specials = group.files.filter((item) => item.parsed.kind !== 'episode').length;
  const parts = [
    `season=${group.season ?? '-'}`,
    `kind=${group.kind}`,
    `files=${group.files.length}`,
    `episodes=${group.episodeCount}`,
    `specials=${specials}`,
    group.minEpisode != null ? `range=${group.minEpisode}-${group.maxEpisode}` : 'range=-',
  ];
  console.log(`${group.sourceFolder}`);
  console.log(`    ${parts.join('  ')}`);
  console.log(`    查询候选: ${JSON.stringify(group.titleCandidates.slice(0, 4))}`);
}

if (errors.length) {
  console.log('\n读取错误:');
  for (const error of errors.slice(0, 10)) console.log(`  ${error.path}: ${error.message}`);
}
