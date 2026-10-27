import { describe, expect, it, vi } from 'vitest';
import { XhsPublisher } from '../src/xhs.js';
import { draftSaveAccessibilityNodes, draftSaveErrorMessage, hasDraftSaveConfirmation, hasFreshSavedDraft, matchesXhsDraftContent } from '../src/xhs-drafts.js';

describe('XHS draft saving controls and evidence', () => {
  it('checks restored content through rendered values and rejects a mismatched title, body or place', () => {
    const target = { title: '壶口不铺 陕西一侧', description: '黄河 激流', locationTag: '壶口瀑布旅游区' };
    const values = ['图片编辑', target.title, '黄河\n激流', '添加地点 壶口瀑布旅游区'];
    expect(matchesXhsDraftContent(values, target)).toBe(true);
    expect(matchesXhsDraftContent(values, { ...target, title: '其他标题' })).toBe(false);
    expect(matchesXhsDraftContent(values, { ...target, description: '其他正文' })).toBe(false);
    expect(matchesXhsDraftContent(values, { ...target, locationTag: '潼关' })).toBe(false);
    expect(matchesXhsDraftContent(values, { ...target, title: '' })).toBe(true);
  });
  it('keeps a single live image stream and acknowledges changing frames', async () => {
    const publisher = new XhsPublisher(); const internal = publisher as any;
    let onFrame!: (event: { data: string; sessionId: number }) => void;
    const session = { on: vi.fn((_name, callback) => { onFrame = callback; }), send: vi.fn(async (name: string) => { if (name === 'Page.startScreencast') onFrame({ data: Buffer.from('first').toString('base64'), sessionId: 1 }); }) };
    const attach = vi.fn(async () => session);
    internal.page = { context: () => ({ newCDPSession: attach }) };
    expect(await publisher.reviewFrame()).toEqual(Buffer.from('first'));
    onFrame({ data: Buffer.from('changed').toString('base64'), sessionId: 2 });
    expect(await publisher.reviewFrame()).toEqual(Buffer.from('changed'));
    expect(attach).toHaveBeenCalledTimes(1);
    expect(session.send).toHaveBeenCalledWith('Page.screencastFrameAck', { sessionId: 2 });
    await publisher.close();
    onFrame({ data: Buffer.from('stale').toString('base64'), sessionId: 3 });
    expect(internal.reviewImage).toBeNull();
  });
  it('recognizes the newly saved draft drawer entry without confusing older or duplicate titles', () => {
    const start = new Date('2026-10-25T11:16:44').getTime();
    const entry = { id: 'draft-id', title: '壶口不铺 陕西一侧', savedAt: '保存于2026-10-25 11:16:45' };
    expect(hasFreshSavedDraft([entry], entry.title, start, start + 2000)).toBe(true);
    expect(hasFreshSavedDraft([{ ...entry, savedAt: '保存于2026-10-25 11:12:59' }], entry.title, start, start + 2000)).toBe(false);
    expect(hasFreshSavedDraft([entry], '另一个标题', start, start + 2000)).toBe(false);
    expect(hasFreshSavedDraft([entry, { ...entry, id: 'another' }], entry.title, start, start + 2000)).toBe(false);
    expect(hasFreshSavedDraft([{ ...entry, title: '暂无笔记标题' }], '', start, start + 2000)).toBe(true);
  });
  it('explains upload timeouts without showing selectors or call logs to the user', () => {
    expect(draftSaveErrorMessage(new Error('locator.waitFor: Timeout 10000ms exceeded.\nCall log: waiting for input[type="file"]'))).toBe('小红书图片上传入口未就绪，请稍后重试');
  });

  it('waits for the image-upload tab before accessing its file input', async () => {
    const publisher = new XhsPublisher();
    const internal = publisher as any;
    let tabReady = false, imageMode = false;
    const tab = { waitFor: vi.fn(async () => { tabReady = true; }), click: vi.fn(async () => { expect(tabReady).toBe(true); imageMode = true; }) };
    const files = { waitFor: vi.fn(async () => { expect(imageMode).toBe(true); }), setInputFiles: vi.fn() };
    const title = { count: async () => 1, fill: vi.fn() }, editor = { count: async () => 1, fill: vi.fn() };
    internal.page = { waitForTimeout: vi.fn(), locator: (selector: string) => {
      if (selector === '.creator-tab') return { filter: () => ({ last: () => tab }) };
      if (selector.startsWith('input[type="file"]')) return { last: () => files };
      if (selector.startsWith('input[placeholder')) return { first: () => title };
      if (selector === '[contenteditable="true"]') return { first: () => editor };
      if (selector === 'body') return { innerText: async () => '草稿保存成功' };
      throw new Error(`unexpected selector ${selector}`);
    } };
    vi.spyOn(publisher, 'isLoggedIn').mockResolvedValue(true);
    internal.waitForUploadedImages = vi.fn(); internal.clickDraftSave = vi.fn(); internal.waitForDraftSaved = vi.fn(async () => { internal.savedDraftEntry = { id: 'saved-id' }; return true; });
    internal.openSavedDraft = vi.fn(async () => ({ draftId: 'saved-id', account: null, storage: 'browser_local' }));
    const batch = { title: '黄河', description: '壶口瀑布', topics: [], locationName: '', photos: [{ filePath: '/photo.jpg' }] };
    expect(await publisher.saveDraft(batch as any)).toMatchObject({ saved: true, confirmed: true });
    expect(files.setInputFiles).toHaveBeenCalledWith(['/photo.jpg']);
    expect(internal.clickDraftSave).toHaveBeenCalledTimes(1);
    expect(internal.openSavedDraft).toHaveBeenCalledWith(expect.objectContaining({ xhsDraftId: 'saved-id' }), true);
  });

  it('requires a persistent draft entry rather than treating a save toast as an account-wide cloud draft', async () => {
    const publisher = new XhsPublisher(); const internal = publisher as any;
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    internal.readDraftEntries = vi.fn(async () => []);
    const page = { locator: () => ({ innerText: async () => '草稿保存成功' }), waitForTimeout: async () => { now += 16000; } };
    try { expect(await internal.waitForDraftSaved(page, '黄河', 0)).toBe(false); }
    finally { vi.restoreAllMocks(); }
  });

  it('does not fall back to another draft when the recorded ID has disappeared', async () => {
    const publisher = new XhsPublisher(); const internal = publisher as any;
    internal.page = { getByText: () => ({ first: () => ({ click: vi.fn() }), click: vi.fn() }), locator: () => ({ first: () => ({ waitFor: vi.fn() }) }) };
    internal.readDraftEntries = vi.fn(async () => [{ id: 'different', title: '同名笔记', savedAt: '2026-10-25 11:16:45' }]);
    vi.spyOn(publisher, 'isLoggedIn').mockResolvedValue(true);
    await expect(publisher.openSavedDraft({ title: '同名笔记', description: '', photoIds: [1], xhsDraftId: 'missing', draftSavedAt: '2026-10-25T11:16:45+08:00' })).rejects.toThrow('未找到对应');
  });

  it('requires explicit draft-save confirmation, excluding generic navigation and publication', () => {
    for (const text of ['暂存成功', '草稿保存成功', '笔记已暂存', '草稿已保存']) expect(hasDraftSaveConfirmation(text)).toBe(true);
    for (const text of ['发布成功', '笔记管理', '已保存', '保存失败', '草稿保存失败', '登录已过期']) expect(hasDraftSaveConfirmation(text)).toBe(false);
  });

  it('only resolves explicitly named draft-save buttons, including closed-shadow buttons', () => {
    expect(draftSaveAccessibilityNodes([
      { role: { value: 'button' }, name: { value: '发布' }, backendDOMNodeId: 1 },
      { role: { value: 'button' }, name: { value: '暂存离开' }, backendDOMNodeId: 2 },
      { role: { value: 'text' }, name: { value: '保存草稿' }, backendDOMNodeId: 3 },
      { role: { value: 'button' }, name: { value: '发布草稿' }, backendDOMNodeId: 4 },
      { ignored: true, role: { value: 'button' }, name: { value: '保存草稿' }, backendDOMNodeId: 5 }
    ])).toEqual([2]);
  });

  it('reuses the current metadata editor and rebuilds it after navigation', async () => {
    const publisher = new XhsPublisher();
    const internal = publisher as any;
    let editorVisible = false, query = '', uploads = 0;
    const page = {
      goto: vi.fn(async () => { editorVisible = false; }),
      locator: () => ({ first: () => ({ waitFor: vi.fn() }) }),
      waitForTimeout: vi.fn()
    };
    internal.page = page;
    vi.spyOn(publisher, 'loginState').mockResolvedValue({ loggedIn: true, account: null });
    internal.ensureMetadataEditor = vi.fn(async () => {
      if (internal.metadataEditorReady) return;
      uploads++; editorVisible = true; internal.metadataEditorReady = true;
    });
    internal.openMetadataPicker = vi.fn(async () => { if (!editorVisible) throw new Error('地点入口不存在'); });
    internal.metadataInput = vi.fn(async () => ({ fill: async (value: string) => { query = value; }, evaluate: async () => false }));
    internal.readMetadataCandidates = vi.fn(async () => [query]);
    expect(await publisher.lookupCandidates('location', '陕西黄河壶口瀑布旅游区', '/photo.jpg')).toEqual(['陕西黄河壶口瀑布旅游区']);
    expect(await publisher.lookupCandidates('topic', '黄河')).toEqual(['黄河']);
    expect(page.goto).toHaveBeenCalledTimes(1);
    expect(uploads).toBe(1);
    await publisher.isLoggedIn(); // Starting another save navigates away from the metadata editor.
    expect(await publisher.lookupCandidates('location', '壶口瀑布')).toEqual(['壶口瀑布']);
    expect(uploads).toBe(2);
  });
});
