import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { chromium, type BrowserContext, type Page, type CDPSession } from 'playwright';
import { config } from './config.js';
import { logger } from './logger.js';
import type { PublishBatch } from './types.js';
import { normalizeXhsText, requireUniqueXhsCandidate, type XhsLookupKind } from './xhs-metadata.js';
import { draftSaveLabel, draftSaveAccessibilityNodes, findFreshSavedDraft, matchesXhsDraftContent, type XhsSavedDraftEntry, type XhsDraftTarget, type XhsDraftEvidence } from './xhs-drafts.js';

let browserInUse = false;
export function isXhsBrowserBusy(): boolean { return browserInUse; }

function profileHasLiveChrome(profileDir: string): boolean {
  // A previous Chrome process can leave Singleton* files behind after a
  // container restart. Only remove those files when /proc confirms that no
  // Chrome process is still using this exact profile.
  try {
    for (const entry of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const command = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0');
        if (!command[0]?.toLowerCase().includes('chrome')) continue;
        if (command.some(argument => argument === `--user-data-dir=${profileDir}`)) return true;
      } catch (error) {
        // A vanished process is safe; unreadable process information is not
        // proof that the profile is unused.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ESRCH') return true;
      }
    }
  } catch { return true; }
  return false;
}

function clearStaleProfileLocks(profileDir: string): void {
  if (process.platform !== 'linux') return;
  if (profileHasLiveChrome(profileDir)) return;
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try { fs.rmSync(path.join(profileDir, name), { force: true }); } catch { /* best effort */ }
  }
}

export class XhsPublisher {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private ownsBrowser = false;
  private submissionStarted = false;
  private metadataEditorReady = false;
  private metadataSamplePath: string | undefined;
  private savedDraftEntry: XhsSavedDraftEntry | null = null;
  private reviewStream: CDPSession | null = null;
  private reviewImage: Buffer | null = null;

  async open(): Promise<void> {
    if (browserInUse) throw new Error('小红书浏览器正在使用中，请先关闭登录或小红书草稿操作窗口');
    browserInUse = true; this.ownsBrowser = true;
    this.submissionStarted = false;
    this.metadataEditorReady = false;
    this.metadataSamplePath = undefined;
    try {
    fs.mkdirSync(config.sessionDir, { recursive: true });
    const dataRoot = path.dirname(config.sessionDir);
    const chromeHome = path.join(dataRoot, 'chrome-home');
    const chromeConfig = path.join(dataRoot, 'chrome-config');
    const chromeCache = path.join(dataRoot, 'chrome-cache');
    const chromeCrashReports = path.join(dataRoot, 'chrome-crash-reports');
    clearStaleProfileLocks(config.sessionDir);
    fs.mkdirSync(chromeHome, { recursive: true });
    fs.mkdirSync(chromeConfig, { recursive: true });
    fs.mkdirSync(chromeCache, { recursive: true });
    fs.mkdirSync(chromeCrashReports, { recursive: true });
    this.context = await chromium.launchPersistentContext(config.sessionDir, {
      headless: config.XHS_HEADLESS,
      executablePath: config.XHS_BROWSER_PATH,
      env: { ...process.env, HOME: chromeHome, XDG_CONFIG_HOME: chromeConfig, XDG_CACHE_HOME: chromeCache },
      // Chrome 128 in the kasmweb image requires an explicit Crashpad
      // database directory. Without it the browser exits with SIGTRAP, and
      // Playwright waits for its full default 180s launch timeout.
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-breakpad',
        '--disable-gpu',
        `--crash-dumps-dir=${chromeCrashReports}`
      ],
      timeout: 30000,
      viewport: { width: 1440, height: 1000 }
    });
    this.page = this.context.pages()[0] ?? await this.context.newPage();
    await this.page.bringToFront();
    this.page.setDefaultTimeout(5000);
    this.page.setDefaultNavigationTimeout(20000);
    } catch (error) { await this.close(); throw error; }
  }

  async close(): Promise<void> {
    this.reviewStream = null; this.reviewImage = null;
    try { await this.context?.close(); }
    finally { this.context = null; this.page = null; if (this.ownsBrowser) browserInUse = false; this.ownsBrowser = false; }
  }

  /** True once a draft-save click may have reached XHS. Never refers to final publication. */
  wasSubmissionStarted(): boolean { return this.submissionStarted; }

  private getPage(): Page {
    if (!this.page) throw new Error('publisher is not open');
    return this.page;
  }

  async isLoggedIn(): Promise<boolean> {
    await this.navigateLogin(false);
    return (await this.loginState()).loggedIn;
  }

  async navigateLogin(prepareQr = true): Promise<void> {
    const page = this.getPage();
    this.metadataEditorReady = false;
    await page.goto(config.XHS_CREATOR_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.locator('input[type="file"], .login-box-container').first().waitFor({ state: 'attached', timeout: 15000 });
    if ((await this.loginState()).loggedIn || !prepareQr) return;
    await page.getByTestId('loading').waitFor({ state: 'hidden', timeout: 15000 });
    const scanLogin = page.getByText('扫码登录', { exact: true }).first();
    if (await scanLogin.isVisible()) {
      await scanLogin.click({ timeout: 5000 });
    } else if (await page.getByText('短信登录', { exact: true }).isVisible()) {
      // The current creator login page uses an image in the top right corner
      // to switch login modes; there is no "扫码登录" text to click.
      await page.locator('.sso-login-wrapper img').first().click({ timeout: 10000 });
    }
    await page.getByText(/APP扫一扫登录|扫码登录|扫描二维码/).first().waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('.sso-login-wrapper img').nth(1).waitFor({ state: 'visible', timeout: 10000 });
  }

  async loginState(): Promise<{ loggedIn: boolean; account: string | null }> {
    const page = this.getPage();
    const loggedIn = await page.locator('input[type="file"]').count() > 0;
    const accountNode = page.locator('.user-name, .username, .user-info .name, .user .name').first();
    const account = loggedIn && await accountNode.count() ? (await accountNode.innerText()).trim().slice(0, 100) : null;
    return { loggedIn, account };
  }

  async loginImage(): Promise<Buffer> {
    const page = this.getPage();
    const loginBox = page.locator('.login-box-container');
    if (await loginBox.isVisible()) return loginBox.screenshot({ animations: 'disabled', timeout: 5000 });
    return page.screenshot({ fullPage: false, timeout: 5000 });
  }

  async screenshot(path: string): Promise<void> { fs.writeFileSync(path, await sharp(await this.reviewFrame()).png().toBuffer()); }

  /** Search the currently logged-in creator session for visible XHS candidates. */
  async lookupCandidates(kind: XhsLookupKind, query: string, samplePhotoPath?: string): Promise<string[]> {
    const page = this.getPage();
    const normalizedQuery = normalizeXhsText(query);
    if (!normalizedQuery) throw new Error(kind === 'topic' ? '请输入话题关键词' : '请输入地点关键词');
    if (!this.metadataEditorReady && !(await this.isLoggedIn())) throw new Error('小红书未登录，请先在运行配置中登录');
    if (samplePhotoPath) this.metadataSamplePath = samplePhotoPath;
    await this.ensureMetadataEditor(page, this.metadataSamplePath);
    await this.openMetadataPicker(page, kind);
    const input = await this.metadataInput(page, kind);
    if (!input) throw new Error(`小红书编辑器未找到${kind === 'topic' ? '话题' : '地点'}搜索框`);
    if (kind === 'topic' && await input.evaluate(element => element.getAttribute('contenteditable') === 'true').catch(() => false)) {
      await input.pressSequentially(normalizedQuery);
    } else await input.fill(normalizedQuery, { force: true });
    await page.waitForTimeout(700);
    return this.readMetadataCandidates(page, kind);
  }

  /** Re-query before publishing and require every saved value to resolve uniquely. */
  async verifyMetadata(batch: PublishBatch): Promise<void> {
    let topicIndex = 0;
    for (const topic of batch.topics ?? []) {
      if (topicIndex > 0) {
        const editor = this.getPage().locator('[contenteditable="true"]').first();
        if (await editor.count()) await editor.fill('');
      }
      const candidates = await this.lookupCandidates('topic', topic, batch.photos[0]?.filePath);
      requireUniqueXhsCandidate('topic', topic, candidates);
      topicIndex++;
    }
    if (batch.locationName?.trim()) {
      await this.getPage().keyboard.press('Escape').catch(() => undefined);
      const candidates = await this.lookupCandidates('location', batch.locationName, batch.photos[0]?.filePath);
      requireUniqueXhsCandidate('location', batch.locationName, candidates);
    }
  }

  /**
   * Fill the creator form and save it to the XHS draft box. This deliberately
   * never clicks the final publish action: the account owner must review and
   * publish manually. XHS web drafts are local to this NAS browser profile.
   */
  async saveDraft(batch: PublishBatch): Promise<{ remoteUrl: string | null; confirmed: boolean; submitted: boolean; saved: boolean; evidence: XhsDraftEvidence }> {
    const page = this.getPage();
    this.submissionStarted = false;
    this.savedDraftEntry = null;
    if (!(await this.isLoggedIn())) throw new Error('小红书未登录，请在运行配置中扫码登录');
    // The caller preflights metadata while the local note is still a draft.
    // applyTopics/fillLocation search again on the actual editor before saving.

    // A logged-in creator page opens on “上传视频”. The first file input is
    // therefore a single-video input; switch to “上传图文” before selecting
    // photos and require the image input explicitly.
    const imageTab = page.locator('.creator-tab').filter({ hasText: '上传图文' }).last();
    await imageTab.waitFor({ state: 'attached', timeout: 15000 });
    await imageTab.click({ timeout: 10000, force: true });
    const fileInput = page.locator('input[type="file"][accept*=".jpg" i], input[type="file"][accept*=".jpeg" i], input[type="file"][accept*=".png" i], input[type="file"][accept*=".webp" i]').last();
    await fileInput.waitFor({ state: 'attached', timeout: 10000 });
    await fileInput.setInputFiles(batch.photos.map(photo => photo.filePath));
    await this.waitForUploadedImages(page, batch.photos.length);

    const title = page.locator('input[placeholder*="标题"], input[placeholder*="填写标题"]').first();
    if (await title.count()) await title.fill(batch.title.slice(0, 20));
    // Topics are inserted through the creator editor so they become actual
    // XHS tags. Appending “#topic” to the body only looks like a tag and does
    // not participate in XHS topic search or traffic attribution.
    const description = batch.description.trim();
    const editor = page.locator('[contenteditable="true"]').first();
    if (await editor.count()) await editor.fill(description);
    else {
      const textarea = page.locator('textarea').first();
      if (await textarea.count()) await textarea.fill(description);
    }

    if (batch.topics?.length) await this.applyTopics(page, batch.topics);
    if (batch.locationName) await this.fillLocation(page, batch.locationName);
    await page.waitForTimeout(config.XHS_PUBLISH_DELAY_MS);
    const saveStartedAt = Date.now();
    await this.clickDraftSave(page);
    const saved = await this.waitForDraftSaved(page, batch.title, saveStartedAt);
    const pageText = await page.locator('body').innerText().catch(() => '');
    const rejected = pageText.match(/保存失败|草稿保存失败|暂存失败|正文不能为空|至少上传一张|上传失败|内容审核未通过/);
    if (rejected) {
      this.submissionStarted = false;
      throw new Error(`小红书拒绝保存草稿：${rejected[0]}`);
    }
    if (!saved) {
      await page.screenshot({ path: path.join(config.DATA_ROOT, 'xhs-draft-save-unconfirmed.png'), fullPage: false }).catch(() => undefined);
      throw new Error('已点击暂存，但小红书未确认草稿保存结果；请检查草稿箱后再决定是否重试');
    }
    if (!this.savedDraftEntry) throw new Error('未取得小红书本地草稿编号，保存结果待核验');
    const evidence = await this.openSavedDraft({ title: batch.title, description: batch.description,
      photoIds: batch.photos.map(photo => photo.id), draftSavedAt: null,
      xhsDraftId: (this.savedDraftEntry as XhsSavedDraftEntry).id, locationTag: batch.locationName }, true);
    return { remoteUrl: null, confirmed: true, submitted: true, saved: true, evidence };
  }

  /** Backward-compatible alias for callers that still use the old method name. */
  async publish(batch: PublishBatch): Promise<{ remoteUrl: string | null; confirmed: boolean; submitted: boolean; saved: boolean }> {
    return this.saveDraft(batch);
  }

  private async clickDraftSave(page: Page): Promise<void> {
    const candidates = page.locator('button, [role="button"], a').filter({ hasText: draftSaveLabel });
    for (let i = await candidates.count() - 1; i >= 0; i--) {
      const candidate = candidates.nth(i);
      if (!(await candidate.isVisible().catch(() => false))) continue;
      this.submissionStarted = true;
      await candidate.click({ timeout: 5000 });
      return;
    }
    // Resolve the actual named save button even inside a closed shadow tree.
    // Guessing a fraction of the action bar can hit a different action.
    const session = await page.context().newCDPSession(page);
    try {
      const { nodes } = await session.send('Accessibility.getFullAXTree');
      const controls = draftSaveAccessibilityNodes(nodes);
      for (const backendNodeId of controls) {
        const { model } = await session.send('DOM.getBoxModel', { backendNodeId }).catch(() => ({ model: null }));
        if (!model || model.width <= 0 || model.height <= 0) continue;
        const x = (model.content[0] + model.content[2] + model.content[4] + model.content[6]) / 4;
        const y = (model.content[1] + model.content[3] + model.content[5] + model.content[7]) / 4;
        const viewport = page.viewportSize();
        if (!viewport || x < 0 || y < 0 || x > viewport.width || y > viewport.height) continue;
        this.submissionStarted = true;
        await page.mouse.click(x, y);
        return;
      }
      await page.screenshot({ path: path.join(config.DATA_ROOT, 'xhs-draft-save-unavailable.png'), fullPage: false }).catch(() => undefined);
      throw new Error('未找到可明确识别的“暂存离开/保存草稿”按钮，已停止保存');
    } finally { await session.detach(); }
  }

  private async waitForDraftSaved(page: Page, title: string, startedAt: number): Promise<boolean> {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const entry = findFreshSavedDraft(await this.readDraftEntries(page), title, startedAt);
      if (entry) { this.savedDraftEntry = entry; return true; }
      await page.waitForTimeout(250);
    }
    return false;
  }

  private async readDraftEntries(page: Page): Promise<XhsSavedDraftEntry[]> {
    return page.locator('.draft-item[data-draft-type="image"]').evaluateAll(nodes => nodes
      .filter(node => Boolean((node as HTMLElement).offsetWidth || (node as HTMLElement).offsetHeight))
      .map(node => ({ id: node.getAttribute('data-draft-id') ?? '', title: node.querySelector('.draft-title-text')?.textContent ?? '', savedAt: node.querySelector('.draft-time')?.textContent ?? '' })));
  }

  /** Reopen the real, persisted draft; never upload another copy or click publish. */
  async openSavedDraft(target: XhsDraftTarget, verifyContents = false): Promise<XhsDraftEvidence> {
    const page = this.getPage();
    if (!(await this.isLoggedIn())) throw new Error('小红书登录已失效，请先在运行配置中重新登录');
    await page.getByText(/^草稿箱\(\d+\)$/).first().click();
    await page.getByText(/^图文笔记\(\d+\)$/).click();
    await page.locator('.draft-item[data-draft-type="image"]').first().waitFor({ state: 'visible', timeout: 10000 });
    const entries = await this.readDraftEntries(page);
    const entry = target.xhsDraftId
      ? entries.find(item => item.id === target.xhsDraftId)
      : target.draftSavedAt ? findFreshSavedDraft(entries, target.title, Date.parse(target.draftSavedAt), Date.parse(target.draftSavedAt) + 1000) : null;
    if (!entry) throw new Error('当前 NAS 浏览器未找到对应的小红书本地草稿。可能已删除、清理浏览器数据或切换会话；系统没有重新保存，以免产生重复草稿');
    const cards = page.locator('.draft-item[data-draft-type="image"]');
    const ids = await cards.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-draft-id')));
    const card = cards.nth(ids.indexOf(entry.id));
    await card.getByText('编辑', { exact: true }).click({ noWaitAfter: true, timeout: 15000 });
    const evidence: XhsDraftEvidence = { draftId: entry.id, account: (await this.loginState()).account, storage: 'browser_local' };
    // Manual review must still open a draft edited outside this app; strict
    // content matching is only a completion condition for a new automatic save.
    if (!verifyContents) return evidence;
    await this.waitForUploadedImages(page, target.photoIds.length);
    const actualCount = await page.locator('.img-list').getByText('编辑', { exact: true }).count();
    if (actualCount !== target.photoIds.length) throw new Error('小红书草稿照片数量与系统记录不一致，请人工核验');
    // The creator can replace its editor while restoring a local draft. Read
    // the rendered accessibility values, including closed shadow controls,
    // instead of binding verification to one transient textarea instance.
    const session = await page.context().newCDPSession(page);
    try {
      const deadline = Date.now() + 30000;
      let matched = false;
      while (Date.now() < deadline) {
        const { nodes } = await session.send('Accessibility.getFullAXTree');
        const texts = nodes.filter(node => !node.ignored).flatMap(node => [String(node.name?.value ?? ''), String(node.value?.value ?? '')]).filter(Boolean);
        if (matchesXhsDraftContent(texts, target)) { matched = true; break; }
        await page.waitForTimeout(500);
      }
      if (!matched) throw new Error('重新打开小红书原草稿后，未能核验标题、文案或地点，请人工检查；未重新保存');
    } finally { await session.detach(); }
    return evidence;
  }

  async reviewFrame(): Promise<Buffer> {
    if (!this.reviewStream) {
      const stream = await this.getPage().context().newCDPSession(this.getPage());
      this.reviewStream = stream;
      stream.on('Page.screencastFrame', event => {
        if (this.reviewStream !== stream) return;
        this.reviewImage = Buffer.from(event.data, 'base64');
        void stream.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => undefined);
      });
      try { await stream.send('Page.startScreencast', { format: 'jpeg', quality: 75, maxWidth: 1440, maxHeight: 1000, everyNthFrame: 1 }); }
      catch (error) { this.reviewStream = null; await stream.detach().catch(() => undefined); throw error; }
    }
    const deadline = Date.now() + 10000;
    while (!this.reviewImage && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    if (!this.reviewImage) throw new Error('小红书实时画面读取超时，请刷新画面');
    return this.reviewImage;
  }

  /** Inputs originate from a human viewing the live frame, with no publish automation. */
  async reviewInput(input: { kind: 'click' | 'scroll' | 'key' | 'text'; x?: number; y?: number; deltaY?: number; key?: string; text?: string }): Promise<void> {
    const page = this.getPage();
    if (input.kind === 'click') await page.mouse.click(input.x!, input.y!);
    else if (input.kind === 'scroll') { await page.mouse.move(input.x!, input.y!); await page.mouse.wheel(0, input.deltaY!); }
    else if (input.kind === 'key') await page.keyboard.press(input.key!);
    else await page.keyboard.insertText(input.text!);
  }

  private async waitForUploadedImages(page: Page, expected: number): Promise<void> {
    const deadline = Date.now() + 100_000;
    let completed = 0;
    while (Date.now() < deadline) {
      completed = await page.locator('.img-list').getByText('编辑', { exact: true }).count().catch(() => 0);
      if (completed >= expected) return;
      await page.waitForTimeout(500);
    }
    throw new Error(`图片上传未完成（${completed}/${expected}），请稍后重试`);
  }

  private async fillLocation(page: Page, location: string): Promise<void> {
    const normalized = normalizeXhsText(location);
    if (!normalized) return;
    await this.openMetadataPicker(page, 'location');
    const input = await this.metadataInput(page, 'location');
    if (!input) throw new Error('小红书编辑器未找到地点搜索框');
    await input.fill(normalized, { force: true });
    await page.waitForTimeout(700);
    const candidates = await this.readMetadataCandidates(page, 'location');
    const exact = requireUniqueXhsCandidate('location', normalized, candidates);
    await this.clickExactMetadataCandidate(page, 'location', exact);
  }

  private async applyTopics(page: Page, topics: string[]): Promise<void> {
    for (const topic of topics) {
      const normalized = normalizeXhsText(topic);
      if (!normalized) continue;
      await this.openMetadataPicker(page, 'topic');
      const input = await this.metadataInput(page, 'topic');
      if (!input) throw new Error('小红书编辑器未找到话题搜索框');
      if (await input.evaluate(element => element.getAttribute('contenteditable') === 'true').catch(() => false)) await input.pressSequentially(normalized);
      else await input.fill(normalized);
      await page.waitForTimeout(700);
      const candidates = await this.readMetadataCandidates(page, 'topic');
      const exact = requireUniqueXhsCandidate('topic', normalized, candidates);
      await this.clickExactMetadataCandidate(page, 'topic', exact);
    }
  }

  private async openMetadataPicker(page: Page, kind: XhsLookupKind): Promise<void> {
    const direct = kind === 'topic'
      ? page.locator('#topicBtn').last()
      : page.locator('.address-card-select').last();
    if (await direct.count()) {
      await direct.scrollIntoViewIfNeeded().catch(() => undefined);
      if (kind === 'location') await direct.evaluate(element => (element.querySelector('.d-select-main') as HTMLElement | null)?.click());
      else await direct.click({ timeout: 5000 });
      await page.waitForTimeout(200);
      return;
    }
    const pattern = kind === 'topic' ? /话题|添加话题|标签/ : /添加地点|选择地点|地点/;
    const triggers = page.locator('button, [role="button"], a, label').filter({ hasText: pattern });
    for (let i = 0, count = await triggers.count(); i < Math.min(count, 30); i++) {
      const trigger = triggers.nth(i);
      if (!(await trigger.isVisible().catch(() => false))) continue;
      try { await trigger.click({ timeout: 3000 }); return; } catch { /* try the next visible trigger */ }
    }
    throw new Error(`小红书编辑器未找到${kind === 'topic' ? '话题' : '地点'}入口`);
  }

  private async ensureMetadataEditor(page: Page, samplePhotoPath?: string): Promise<void> {
    if (this.metadataEditorReady) return;
    if (!samplePhotoPath) throw new Error('没有可用于打开小红书编辑器的照片');
    await page.goto(config.XHS_CREATOR_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(800);
    const imageTab = page.locator('.creator-tab').filter({ hasText: '上传图文' }).last();
    await imageTab.waitFor({ state: 'attached', timeout: 10000 });
    await imageTab.click({ timeout: 10000, force: true });
    const fileInput = page.locator('input[type="file"][accept*=".jpg" i], input[type="file"][accept*=".jpeg" i], input[type="file"][accept*=".png" i], input[type="file"][accept*=".webp" i]').last();
    await fileInput.waitFor({ state: 'attached', timeout: 10000 });
    await fileInput.setInputFiles(samplePhotoPath);
    await this.waitForUploadedImages(page, 1);
    this.metadataEditorReady = true;
  }

  private async metadataInput(page: Page, kind: XhsLookupKind) {
    const selectors = kind === 'topic'
      ? 'input[placeholder*="话题"], input[placeholder*="搜索"], [contenteditable="true"]'
      : 'input[placeholder*="地点"], input[placeholder*="搜索"], .address-card-select .d-select-input-filter input';
    const inputs = page.locator(selectors);
    for (let i = await inputs.count() - 1; i >= 0; i--) {
      const input = inputs.nth(i);
      if (await input.isVisible().catch(() => false)) return input;
    }
    return null;
  }

  private async readMetadataCandidates(page: Page, kind: XhsLookupKind): Promise<string[]> {
    const selectors = kind === 'topic'
      ? '[role="option"], .topic-item, .recommend-topic-wrapper .tag, .tag-group .tag, [class*="topic"] .tag, [class*="search"] li'
      : '[role="option"], .location-item, .option-name, [class*="location"] li, [class*="search"] li';
    const values = await page.locator(selectors).evaluateAll(nodes => nodes
      .filter(node => {
        const element = node as HTMLElement;
        return Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
      })
      .flatMap(node => String(node.textContent ?? '').split(/\n+/))
      .map(value => value.replace(/[\u200b\u00a0]/g, ' ').replace(/\s+/g, ' ').trim())
      .filter(Boolean));
    return [...new Set(values.map(value => normalizeXhsText(value)).filter(value => value && value !== '更多'))].slice(0, 100);
  }

  private async clickExactMetadataCandidate(page: Page, kind: XhsLookupKind, candidate: string): Promise<void> {
    const selectors = kind === 'topic'
      ? '[role="option"], .topic-item, .recommend-topic-wrapper .tag, .tag-group .tag, [class*="topic"] .tag, [class*="search"] li'
      : '[role="option"], .location-item, .option-name, [class*="location"] li, [class*="search"] li';
    const nodes = page.locator(selectors);
    const normalized = normalizeXhsText(candidate);
    for (let i = 0, count = await nodes.count(); i < count; i++) {
      const node = nodes.nth(i);
      if (!(await node.isVisible().catch(() => false))) continue;
      const text = normalizeXhsText(await node.innerText().catch(() => ''));
      if (text === normalized || text.split(/\n+/).map(normalizeXhsText).includes(normalized)) {
        await node.click({ timeout: 5000 }); return;
      }
    }
    throw new Error(`${kind === 'topic' ? '话题' : '地点'}候选“${candidate}”已变化，请重新搜索确认`);
  }
}
