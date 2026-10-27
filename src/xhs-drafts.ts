export const draftSaveLabel = /^(暂存离开|保存草稿|存为草稿|暂存)$/;

export function draftSaveErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/locator\.waitFor[\s\S]*input\[type=/.test(message)) return '小红书图片上传入口未就绪，请稍后重试';
  if (/net::ERR|page\.goto/.test(message)) return '连接小红书失败，请检查 NAS 网络后重试';
  if (/Timeout|timed out|timeout/i.test(message)) return '小红书页面处理超时，请稍后重试；若已点击暂存，请先核验草稿箱';
  return message.replace(/\u001b\[[0-9;]*m/g, '');
}

export function hasDraftSaveConfirmation(text: string): boolean {
  return /草稿[^\n]{0,20}(已保存|保存成功)|(?:已保存|保存成功)[^\n]{0,20}草稿|暂存成功|笔记已暂存/.test(text)
    && !/草稿保存失败|暂存失败|保存失败/.test(text);
}

export interface XhsSavedDraftEntry { id: string; title: string; savedAt: string; }

export function findFreshSavedDraft(entries: XhsSavedDraftEntry[], title: string, startedAt: number, now = Date.now()): XhsSavedDraftEntry | null {
  const expected = title.trim() || '暂无笔记标题';
  const matching = entries.filter(entry => {
    if (!entry.id || entry.title.trim() !== expected) return false;
    const time = entry.savedAt.match(/(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
    if (!time) return false;
    const timestamp = new Date(`${time[1]}T${time[2]}`).getTime();
    return Number.isFinite(timestamp) && timestamp >= startedAt - 2000 && timestamp <= now + 5000;
  });
  return matching.length === 1 ? matching[0] : null;
}

export function hasFreshSavedDraft(entries: XhsSavedDraftEntry[], title: string, startedAt: number, now = Date.now()): boolean {
  return findFreshSavedDraft(entries, title, startedAt, now) !== null;
}

export interface XhsDraftEvidence { draftId: string; account: string | null; storage: 'browser_local'; }
export interface XhsDraftTarget { title: string; description: string; photoIds: number[]; draftSavedAt: string | null; xhsDraftId?: string | null; locationTag?: string | null; }

export function matchesXhsDraftContent(texts: string[], target: Pick<XhsDraftTarget, 'title' | 'description' | 'locationTag'>): boolean {
  const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
  const values = texts.map(normalize);
  return (!target.title.trim() || values.includes(target.title.trim()))
    && (!target.description.trim() || values.join(' ').includes(normalize(target.description)))
    && (!target.locationTag || values.some(value => value.includes(target.locationTag!)));
}

/** Closed shadow controls still expose their actual button names in Chrome's accessibility tree. */
export function draftSaveAccessibilityNodes(nodes: { ignored?: boolean; role?: { value?: unknown }; name?: { value?: unknown }; backendDOMNodeId?: number }[]): number[] {
  return nodes.filter(node => !node.ignored && node.role?.value === 'button' && draftSaveLabel.test(String(node.name?.value ?? '').trim()) && Number.isInteger(node.backendDOMNodeId))
    .map(node => node.backendDOMNodeId!);
}
