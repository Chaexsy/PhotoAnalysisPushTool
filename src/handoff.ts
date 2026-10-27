import path from 'node:path';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { ZipFile } from 'yazl';
import { z } from 'zod';
import type { PhotoStore } from './db.js';

export const handoffConfirmationSchema = z.object({
  revision: z.number().int().nonnegative().safe(),
  result: z.enum(['draft_saved', 'published']),
  confirmed: z.literal(true)
}).strict();

const publishUrl = 'https://creator.xiaohongshu.com/publish/publish';
export function handoffDetails(store: PhotoStore, postId: number, revision?: number) {
  const post = store.listPosts().find(item => item.id === postId);
  if (!post || !['draft', 'draft_saved'].includes(post.status)) throw new Error('笔记不存在或当前状态不支持准备发布');
  if (revision !== undefined && post.revision !== revision) throw new Error('笔记内容已变化，请重新打开准备发布窗口');
  const photos = post.photoIds.map((id, index) => {
    const photo = store.getPhoto(id);
    if (!photo) throw new Error(`照片 ${id} 已不存在`);
    const original = path.basename(photo.filePath.replace(/\\/g, '/')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
    return { id, position: index + 1, filename: `${String(index + 1).padStart(2, '0')}-${original}`, thumbnail: `/api/photos/${id}/thumbnail?width=480` };
  });
  if (!photos.length) throw new Error('笔记中没有照片');
  return { postId, revision: post.revision, status: post.status, title: post.title, description: post.description,
    topics: post.topics, location: post.locationTag ?? '', suggestedLocation: post.locationName ?? '',
    photos, publishUrl, manualConfirmedAt: post.manualConfirmedAt ?? null };
}

export async function handoffPackage(store: PhotoStore, postId: number, revision: number) {
  const details = handoffDetails(store, postId, revision);
  const files = details.photos.map(photo => ({ ...photo, filePath: store.getPhoto(photo.id)!.filePath }));
  // Fail before sending ZIP headers, so a missing original produces a clear error.
  await Promise.all(files.map(async file => {
    try { await access(file.filePath, constants.R_OK); if (!(await stat(file.filePath)).isFile()) throw new Error(); }
    catch { throw new Error(`原图不可读取：${file.filename}，请检查 NAS 照片目录`); }
  }));
  // File checks are asynchronous; reject if the note was edited in the meantime.
  handoffDetails(store, postId, revision);
  const zip = new ZipFile();
  for (const file of files) zip.addFile(file.filePath, file.filename, { compress: false });
  const texts = {
    '标题.txt': details.title,
    '文案.txt': details.description,
    '话题.txt': details.topics.map(topic => `#${topic}`).join(' '),
    '地点.txt': details.location || details.suggestedLocation,
    '发布说明.txt': `笔记编号：${postId}\n版本：${revision}\n\n1. 解压照片包，按文件名编号顺序上传原图。\n2. 在自己的浏览器打开 ${publishUrl}，登录后上传照片，填写标题和文案。\n3. 在小红书页面逐个搜索并点选话题和地点；复制关键词不会自动建立平台标签。\n4. 在小红书页面点击暂存或发布，并确认页面操作成功。\n5. 回照片发布台，明确确认已暂存或已发布。\n\n本照片包的下载、复制和打开网页均不会变更系统笔记状态。\n网页草稿仅存于执行暂存操作的浏览器本地，不保证跨浏览器或手机同步。\n`
  };
  for (const [name, value] of Object.entries(texts)) zip.addBuffer(Buffer.from(value, 'utf8'), name);
  return { zip, details };
}
