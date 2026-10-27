import { config, getPublicSettings } from './config.js';
import { store } from './repository.js';
import { nextPublishTimes } from './timing.js';

export function scheduleDrafts(force = false) {
  const posts = store.listPosts();
  const count = posts.filter(post => post.status === 'draft' && (force || !post.scheduledAt)).length;
  const reservedTimes = posts.filter(post => post.scheduledAt && (force ? post.status !== 'draft' : true)).map(post => post.scheduledAt!);
  if (count) store.scheduleDrafts(nextPublishTimes(getPublicSettings(), count, config.MAX_POSTS_PER_RUN, new Date(), reservedTimes), force);
}
