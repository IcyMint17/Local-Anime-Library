/**
 * Watch state is keyed per watchable item. Episodes use their number, while
 * extras use the file id — 孤独摇滚！ numbers its 歌曲欣赏 shorts 01..05, which
 * would otherwise collide with the real episodes 1..5.
 */
export const EPISODE_KEY = (number) => `ep:${number}`;
export const SPECIAL_KEY = (fileId) => `file:${fileId}`;
export const MOVIE_KEY = 'movie';

export function itemKeyFor(file) {
  if (file.kind === 'special') return SPECIAL_KEY(file.id);
  if (file.kind === 'movie') return MOVIE_KEY;
  if (file.ep_number != null) return EPISODE_KEY(file.ep_number);
  return SPECIAL_KEY(file.id);
}
