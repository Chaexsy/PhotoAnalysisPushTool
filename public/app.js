const state = { page: null, navigation: 0, refreshRequest: 0, loadedPages: new Set(), publications: [], drafts: [], photos: new Map(), photoLibrary: { items: [], total: 0, page: 1, pageSize: 48, filters: {}, request: 0 }, status: null, scanStatus: null, scanStarting: false, selectionStatus: null, selectionStarting: false, settings: null, settingsDirty: false, editingDraft: null, editingPhotoIds: new Set(), editingCandidates: [], pickerVisibleCount: 36, pickerSelectedIds: new Set(), draftMetadata: { topics: [], verifiedTopics: [], locationTag: '', locationVerified: false, topicCandidates: [], locationCandidates: [], searchingTopic: false, searchingLocation: false } };
Object.assign(state, { scanCursorDragging: false, scanCursorSaving: false, scanCursorPreview: null });
Object.assign(state, { detailPhoto: null, detailRequest: 0, scoreSaving: false });
state.deletingDrafts = new Set();
state.draftToDelete = null;
Object.assign(state, { selectedMergeDrafts: new Set(), mergeContext: null, mergePhotoIds: new Set(), mergeVisibleCount: 36, mergingDrafts: false });
Object.assign(state, { savingDrafts: new Set(), draftSaveErrors: new Map() });
const editableScores = [['quality', '质量', 20], ['composition', '构图', 20], ['aesthetics', '审美', 30], ['story', '故事性', 20], ['technicalScore', '技术', 10]];
const pages = {
  photos: { path: '/photos', title: '照片库', description: '浏览全部图片，筛选扫描状态并查看详细评价。' },
  queue: { path: '/queue', title: '待发布队列', description: '准备照片和文案，在自己的小红书网页完成暂存或发布，再回来确认结果。' },
  publications: { path: '/publications', title: '发布记录', description: '查看每次发布的时间、照片、渠道和结果。' }
};
const $ = (selector) => document.querySelector(selector);
import { openHandoff } from './handoff.js';
const statusText = { published: '已发布', draft_saved: '已暂存（未发布）', uncertain: '待人工核验', failed: '发布失败', publishing: '处理中', submitted: '已提交' };
const channelText = { xiaohongshu: '小红书', legacy: '小红书（旧记录）' };
const photoStatusText = { not_imported: '等待扫描导入', pending: '待发布', needs_analysis: '等待分析', needs_metadata: '缺少拍摄时间', rejected: '未入选', published: '已发布', draft_saved: '已暂存（未发布）', publishing: '处理中', uncertain: '待核验', failed: '发布失败', skipped: '已跳过' };
const evaluationText = { assessed: '已评估', unassessed: '尚未评估', failed: '评估失败', skipped: '技术筛选未通过' };
const photoFilterFields = { directory: 'photoDirectoryFilter', timeField: 'photoTimeField', from: 'photoFromFilter', to: 'photoToFilter', location: 'photoLocationFilter', hasLocation: 'photoHasLocation', scan: 'photoScanFilter', evaluated: 'photoEvaluatedFilter', rated: 'photoRatedFilter', sort: 'photoSort' };
const photoTimeLabels = { captured: '拍摄时间', modified: '文件修改时间', analyzed: '分析时间' };
const photoFilterLabels = {
  hasLocation: { name: '位置信息', options: { yes: '有地点或 GPS', no: '无地点和 GPS' } },
  scan: { name: '扫描状态', options: { scanned: '已尝试分析', unscanned: '尚未分析', failed: '分析失败' } },
  evaluated: { name: '模型评价', options: evaluationText },
  rated: { name: '评分状态', options: { unrated: '未评分', lt65: '<65', '65to75': '65~~~75', '75to85': '75~~~85', gt85: '>85' } }
};
const scheduleCycleLabels = { daily: '每天', every2days: '每 2 天', every3days: '每 3 天' };
const weekDayLabels = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function escapeHtml(value = '') { return String(value).replace(/[&<>'\"]/g, c => ({ '&': '&#38;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c])); }
function formatTime(value) { if (!value) return '—'; const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false }); }
function scoreBand(score) {
  if (score === null || score === undefined || score === '') return 'score-none';
  const value = Number(score);
  if (!Number.isFinite(value)) return 'score-none';
  if (value < 65) return 'score-low';
  if (value < 75) return 'score-mid';
  if (value <= 85) return 'score-good';
  return 'score-high';
}
function scoreLabel(score, prefix = '综合') {
  return score !== null && score !== undefined && score !== '' && Number.isFinite(Number(score)) ? `${prefix} ${Number(score)}` : `${prefix} —`;
}
function hydrateLazyImages(root) {
  if (!root) return;
  const images = [...root.querySelectorAll('img[data-src]')];
  const load = image => {
    if (!image.dataset.src) return;
    image.src = image.dataset.src;
    image.removeAttribute('data-src');
  };
  if (!('IntersectionObserver' in window)) { images.forEach(load); return; }
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => { if (entry.isIntersecting) { load(entry.target); observer.unobserve(entry.target); } });
  }, { root, rootMargin: '180px 0px' });
  images.forEach(image => observer.observe(image));
}
function dateTimeLocal(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
let toastTimer = null;
function showToast(message) {
  const openDialog = [...document.querySelectorAll('dialog[open]')].at(-1);
  const modalToast = openDialog?.querySelector('.modal-toast');
  if (modalToast) {
    modalToast.textContent = message;
    modalToast.classList.add('show');
    setTimeout(() => modalToast.classList.remove('show'), 3200);
    return;
  }
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
}
function openDialog(id) { const dialog = document.getElementById(id); if (!dialog.open) dialog.showModal(); }
function closeDialog(id) { const dialog = document.getElementById(id); if (dialog.open) dialog.close(); }

function showPageMessage(message = '', error = false) {
  const element = $('#pageMessage');
  element.textContent = message;
  element.hidden = !message;
  element.classList.toggle('error', error);
}
function pageFromPath() {
  const pathname = window.location.pathname.replace(/\/$/, '');
  return Object.keys(pages).find(page => pages[page].path === pathname) || 'photos';
}
function navigateToPage(page, { history = 'push', initial = false } = {}) {
  const next = pages[page];
  if (!next) return;
  if (history === 'push' && window.location.pathname !== next.path) window.history.pushState({}, '', next.path);
  if (history === 'replace') window.history.replaceState({}, '', next.path);
  if (state.page === page && !initial) return;
  state.page = page;
  state.navigation++;
  if (page !== 'photos') { if (scanPollTimer) { clearTimeout(scanPollTimer); scanPollTimer = null; } if (selectionPollTimer) { clearTimeout(selectionPollTimer); selectionPollTimer = null; } }
  state.refreshRequest++;
  state.photoLibrary.request++;
  document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
  document.querySelectorAll('[data-page]').forEach(section => { section.hidden = section.dataset.page !== page; });
  document.querySelectorAll('[data-page-link]').forEach(link => {
    if (link.dataset.pageLink === page) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  $('#summaryPanel').hidden = page === 'photos';
  $('#pageTitle').textContent = next.title;
  $('#pageDescription').textContent = next.description;
  document.title = `${next.title} · 照片发布台`;
  showPageMessage();
  // Retain filters and pagination in state, while avoiding image loads in hidden pages.
  $('#photoLibrary').replaceChildren();
  $('#drafts').replaceChildren();
  $('#records').replaceChildren();
  if (state.loadedPages.has(page)) {
    if (page === 'photos') renderPhotoLibrary();
    else if (page === 'queue') renderDrafts();
    else renderRecords();
  }
  if (!initial) {
    window.scrollTo({ top: 0 });
    $('#pageTitle').focus({ preventScroll: true });
  }
  void refresh();
}

function renderSummary() {
  const counts = state.status?.counts ?? {};
  $('#publishedCount').textContent = counts.published ?? 0;
  $('#analysisCount').textContent = (counts.needs_analysis ?? 0) + (counts.needs_metadata ?? 0);
  $('#uncertainCount').textContent = counts.uncertain ?? 0;
  $('#modeCount').textContent = '人工交接';
}

function renderScanStatus() {
  const scan = state.scanStatus ?? { phase: 'idle', running: false };
  const label = $('#scanStatus');
  const button = $('#scanButton');
  const stopButton = $('#scanStopButton');
  const phases = { idle: '待命', discovering: '索引文件', analyzing: scan.currentTask === 'retry' ? '重试失败照片' : '顺序评分', paused: '已停止', completed: '已完成', failed: '扫描失败' };
  button.disabled = Boolean(scan.running || state.scanStarting || state.scanCursorSaving || state.scanCursorDragging);
  button.hidden = Boolean(scan.running);
  button.textContent = state.scanStarting ? '正在启动…' : scan.phase === 'paused' ? '继续扫描' : '立即扫描评分';
  stopButton.hidden = !scan.running;
  stopButton.disabled = Boolean(scan.stopRequested || state.scanStopping || state.scanCursorSaving);
  stopButton.textContent = scan.stopRequested || state.scanStopping ? '正在停止…' : '停止扫描';
  $('#scanPhase').textContent = scan.stopRequested || state.scanStopping ? '正在停止' : state.scanStarting ? '正在启动' : phases[scan.phase] || scan.phase;
  $('#scanPhase').classList.toggle('running', Boolean(scan.running || state.scanStarting));
  $('#scanPhase').classList.toggle('failed', scan.phase === 'failed');
  $('#scanPhase').classList.toggle('paused', scan.phase === 'paused');
  $('#scanLimit').textContent = scan.analysisLimit ?? state.settings?.maxPhotosPerRun ?? 500;
  const counts = `发现 ${scan.discovered ?? 0} 张 · 缓存 ${scan.cached ?? 0} 张 · 已分析 ${scan.analyzed ?? 0} 张 · 错误 ${scan.errors ?? 0} · 草稿 ${scan.draftsCreated ?? 0} 篇`;
  if (scan.running) {
    const progress = scan.phase === 'analyzing' && scan.totalToAnalyze ? `，正在处理第 ${scan.currentIndex} / ${scan.totalToAnalyze} 张` : '';
    label.textContent = scan.stopRequested || state.scanStopping ? `正在停止并保存进度，中断不计失败。${counts}` : `${phases[scan.phase] || scan.phase}${progress}${scan.currentTask === 'retry' ? '（续扫指针不移动）' : ''}：${counts}`;
  } else if (state.scanStarting) label.textContent = '正在启动扫描…';
  else if (scan.phase === 'failed') label.textContent = `扫描失败：${scan.error || '未知错误'}。${counts}`;
  else if (scan.phase === 'completed') label.textContent = `上次扫描已完成：${counts}`;
  else if (scan.phase === 'paused') label.textContent = `已停止，点击“继续扫描”恢复剩余任务；已完成结果和续扫指针已保存。${counts}`;
  else label.textContent = '等待扫描；启动后会显示当前处理的照片。';
  const photo = scan.currentPhoto;
  $('#scanDirectory').textContent = photo?.directory || '—';
  $('#scanDirectory').title = photo?.directory || '';
  $('#scanFileName').textContent = photo?.fileName || '—';
  $('#scanFileName').title = photo?.filePath || '';
  $('#scanCapturedAt').textContent = photo ? photo.capturedAt ? formatTime(photo.capturedAt) : `未记录拍摄时间${photo.modifiedAt ? `（文件修改：${formatTime(photo.modifiedAt)}）` : ''}` : '—';
  $('#scanUpdatedAt').textContent = scan.startedAt ? `开始：${formatTime(scan.startedAt)} · ${scan.running ? '信息更新' : '结束'}：${formatTime(scan.running ? new Date().toISOString() : scan.finishedAt)}` : '扫描信息尚未更新';
  const progress = scan.progress;
  const segments = $('#scanProgressSegments');
  const pointer = $('#scanProgressPointer');
  const editingPointer = state.scanCursorDragging || state.scanCursorSaving || state.scanCursorPreview !== null;
  pointer.disabled = !progress?.total || state.scanCursorSaving || state.scanStarting || state.scanStopping || scan.stopRequested;
  pointer.classList.toggle('saving', state.scanCursorSaving);
  if (!editingPointer) {
    pointer.max = String(Math.max(0, (progress?.total ?? 0) - 1));
    pointer.value = String(Number(pointer.max) - Math.min(Number(pointer.max), progress?.pointerIndex ?? 0));
  }
  if (!progress || !progress.total) {
    segments.innerHTML = '<span class="scan-progress-segment unscanned" style="flex-basis:100%"></span>';
    $('#scanProgressStats').textContent = '尚未建立队列';
    $('#scanProgressPointerLabel').textContent = '续扫指针：队尾';
  } else {
    segments.innerHTML = [...progress.segments].reverse().map(segment => `<span class="scan-progress-segment ${segment.status}" style="flex-basis:${(segment.count / progress.total * 100).toFixed(4)}%" title="${segment.status === 'completed' ? '已完成' : segment.status === 'failed' ? '失败' : '未扫描'} ${segment.count} 张"></span>`).join('');
    $('#scanProgressStats').textContent = `已完成 ${progress.completed} · 失败 ${progress.failed} · 未扫描 ${progress.unscanned} · 共 ${progress.total}`;
    renderScanPointerLabel();
  }
  segments.setAttribute('aria-valuenow', String(progress?.completed ?? 0));
  segments.setAttribute('aria-valuemax', String(progress?.total ?? 0));
}
function renderScanPointerLabel() {
  const pointer = $('#scanProgressPointer');
  const total = Number(pointer.max) + 1;
  const position = Number(pointer.value) + 1;
  const suffix = state.scanCursorSaving ? '正在保存…' : state.scanCursorPreview !== null ? '松开后保存' : '从左向右';
  const text = `续扫指针：第 ${position} / ${total}（${suffix}）`;
  $('#scanProgressPointerLabel').textContent = text;
  pointer.title = `${text}；可拖动或用方向键调整`;
  pointer.setAttribute('aria-valuetext', `第 ${position} 张，共 ${total} 张`);
}
function renderSelectionStatus() {
  const selection = state.selectionStatus ?? { phase: 'idle', running: false };
  const phases = { idle: '待命', grouping: '按时间和地点归组', queueing: '生成待发布队列', completed: '已完成', failed: '筛选失败' };
  const button = $('#selectButton');
  button.disabled = Boolean(selection.running || state.selectionStarting);
  button.textContent = state.selectionStarting ? '正在启动…' : selection.running ? '筛选进行中…' : '立即筛选发布';
  $('#selectionPhase').textContent = state.selectionStarting ? '正在启动' : phases[selection.phase] || selection.phase;
  $('#selectionPhase').classList.toggle('running', Boolean(selection.running || state.selectionStarting));
  $('#selectionPhase').classList.toggle('failed', selection.phase === 'failed');
  const counts = `已评分 ${selection.scanned ?? 0} 张 · 可发布 ${selection.eligible ?? 0} 张 · 草稿 ${selection.draftsCreated ?? 0} 篇`;
  if (selection.running) $('#selectionStatus').textContent = `${phases[selection.phase] || selection.phase}：${counts}`;
  else if (state.selectionStarting) $('#selectionStatus').textContent = '正在启动筛选任务…';
  else if (selection.phase === 'failed') $('#selectionStatus').textContent = `筛选失败：${selection.error || '未知错误'}。${counts}`;
  else if (selection.phase === 'completed') $('#selectionStatus').textContent = `上次筛选已完成：${counts}`;
  else $('#selectionStatus').textContent = '每天遍历已评分照片，按拍摄时间和地点归组，生成待发布草稿。';
}

function renderSettings() {
  const settings = state.settings;
  if (!settings) return;
  $('#visionApiUrl').value = settings.visionApiUrl || '';
  $('#visionModel').value = settings.visionModel || '';
  $('#visionApiKey').value = '';
  $('#clearVisionKey').checked = false;
  $('#visionKeyHint').textContent = settings.visionApiKeyConfigured ? 'API Key 已保存；留空会继续使用原密钥。' : '尚未配置 API Key';
  $('#scheduleCycle').value = ['daily', 'every2days', 'every3days', 'weekly'].includes(settings.scheduleCycle) ? settings.scheduleCycle : 'daily';
  $('#publishTime').value = settings.publishTime || '09:00';
  $('#weeklyDay').value = String(settings.weeklyDay ?? 1);
  $('#xhsAccount').value = settings.xhsAccount || '';
  $('#xhsCreatorUrl').value = settings.xhsCreatorUrl || '';
  toggleWeeklyDay();
}
function toggleWeeklyDay() { $('#weeklyDayField').hidden = $('#scheduleCycle').value !== 'weekly'; }

function publishScheduleLabel(settings = state.settings) {
  if (!settings?.publishTime) return '当前规则未加载';
  const cycle = settings.scheduleCycle === 'weekly'
    ? `每周${weekDayLabels[Number(settings.weeklyDay)] ?? ''}`
    : scheduleCycleLabels[settings.scheduleCycle] || '每天';
  return `${cycle} ${settings.publishTime}${settings.timezone ? `（${settings.timezone}）` : ''}`;
}

function renderDrafts() {
  const drafts = state.drafts;
  state.selectedMergeDrafts = new Set([...state.selectedMergeDrafts].filter(id => drafts.some(draft => draft.id === id && draft.status === 'draft' && !state.savingDrafts.has(id))));
  $('#draftCount').textContent = `${drafts.length} 篇`;
  $('#draftScheduleRule').textContent = publishScheduleLabel();
  $('#rescheduleDrafts').disabled = drafts.length === 0;
  $('#draftEmpty').hidden = drafts.length > 0;
  $('#drafts').innerHTML = drafts.map(draft => {
    const photos = draft.photoIds.map(id => state.photos.get(id)).filter(Boolean);
    const orientation = draft.orientation === 'landscape' ? '横图' : '竖图';
    const scheduledAt = draft.scheduledAt ? formatTime(draft.scheduledAt) : '未安排';
    const saving = state.savingDrafts.has(draft.id) || ['publishing', 'submitted'].includes(draft.status);
    const locked = saving || state.deletingDrafts.has(draft.id);
    const saveError = state.draftSaveErrors.get(draft.id) || draft.error;
    const autoPublish = '<span class="auto-publish-badge disabled"><i aria-hidden="true"></i>人工交接</span>';
    return `<article class="draft-card${state.selectedMergeDrafts.has(draft.id) ? ' merge-selected' : ''}" data-draft-id="${draft.id}"><div class="draft-head"><div class="draft-head-main"><div class="draft-title-row"><label class="draft-select-label"><input type="checkbox" class="select-merge-draft" value="${draft.id}" ${state.selectedMergeDrafts.has(draft.id) ? 'checked' : ''} ${locked ? 'disabled' : ''} aria-label="选择笔记 ${draft.id} 合并">合并</label><h3>${escapeHtml(draft.title || '未命名草稿')}</h3></div><div class="record-meta"><span>${escapeHtml(draft.locationTag || draft.locationName || '未标记地点')}</span><span>${orientation}</span><span>${escapeHtml(draft.theme || '—')}</span></div></div><div class="draft-head-right"><span class="draft-schedule-inline"><span>计划发布时间</span><strong>${escapeHtml(scheduledAt)}</strong></span>${autoPublish}</div></div>
      <div class="photo-strip">${photos.map(photo => `<button type="button" class="photo photo-detail-trigger" data-record-id="${photo.id}" aria-label="查看照片 ${photo.id} 详情"><img loading="lazy" src="/api/photos/${photo.id}/thumbnail?width=480" alt="照片 ${photo.id}"><span class="score ${scoreBand(photo.totalScore)}">${escapeHtml(scoreLabel(photo.totalScore))}</span></button>`).join('')}</div>
      ${saving ? '<p class="draft-save-notice" role="status">历史操作尚未完成，请检查发布记录。</p>' : saveError ? `<p class="draft-save-notice error" role="status">历史操作提示：${escapeHtml(saveError)}</p>` : ''}
      <div class="draft-foot"><span class="draft-photo-count">照片 ${photos.length} 张</span><span class="draft-actions"><button type="button" class="button danger delete-draft" data-draft-id="${draft.id}" ${locked ? 'disabled' : ''}>${state.deletingDrafts.has(draft.id) ? '删除中…' : '删除'}</button><button class="button secondary edit-draft" data-draft-id="${draft.id}" ${locked ? 'disabled' : ''}>编辑草稿</button><button class="button primary publish-draft" data-draft-id="${draft.id}" ${locked ? 'disabled' : ''}>准备发布</button></span></div></article>`;
  }).join('');
  document.querySelectorAll('.edit-draft').forEach(button => button.addEventListener('click', () => openDraftEditor(Number(button.dataset.draftId))));
  document.querySelectorAll('.publish-draft').forEach(button => button.addEventListener('click', () => publishDraftNow(Number(button.dataset.draftId), button)));
  document.querySelectorAll('.delete-draft').forEach(button => button.addEventListener('click', () => {
    const draft = state.drafts.find(item => item.id === Number(button.dataset.draftId));
    if (!draft || state.deletingDrafts.has(draft.id)) return;
    state.draftToDelete = draft.id;
    $('#deleteDraftName').textContent = draft.title || '未命名草稿';
    $('#deleteDraftPhotoCount').textContent = String(draft.photoIds.length);
    openDialog('deleteDraftDialog');
  }));
  renderMergeSelection();
}

function renderMergeSelection() {
  const count = state.selectedMergeDrafts.size;
  $('#mergeDraftSelection').textContent = count ? `已选 ${count} 篇笔记，合并时可逐张选择照片` : '勾选两篇或更多笔记后合并';
  $('#mergeDraftsButton').disabled = count < 2 || state.mergingDrafts;
  $('#clearMergeSelection').disabled = count === 0 || state.mergingDrafts;
}

function openMergeDrafts() {
  const drafts = state.drafts.filter(draft => state.selectedMergeDrafts.has(draft.id) && draft.status === 'draft' && !state.savingDrafts.has(draft.id));
  if (drafts.length < 2) return;
  if (drafts.length > 100) { showToast('每次最多合并 100 篇笔记'); return; }
  const seen = new Set();
  const groups = drafts.map(draft => ({ draft, photos: draft.photoIds.filter(id => !seen.has(id) && seen.add(id)).map(id => state.photos.get(id)).filter(Boolean) }));
  const first = drafts[0];
  state.mergeContext = { sources: drafts.map(draft => ({ id: draft.id, revision: draft.revision })), groups };
  state.mergePhotoIds = new Set(); state.mergeVisibleCount = 36;
  $('#mergeDraftSummary').textContent = `${drafts.length} 篇笔记 · ${seen.size} 张候选照片`;
  $('#mergeTitle').value = first.title || '';
  $('#mergeDescription').value = (first.description || '').slice(0, 50);
  $('#mergeScheduledAt').value = dateTimeLocal(first.scheduledAt);
  const sameLocation = drafts.every(draft => draft.locationTag === first.locationTag);
  $('#mergeMetadataHint').textContent = `标题、文案、计划时间和话题默认沿用第一篇笔记。${sameLocation ? '地点沿用共同地点。' : '原草稿地点不同，合并后清空地点标记。'}合并后仍可通过“编辑草稿”调整话题和地点。`;
  $('#mergePhotoHint').textContent = `请勾选 1–${state.settings?.maxImagesPerPost ?? 6} 张照片，横图和竖图不能混选；点击图片可放大查看。`;
  $('#mergeDraftStatus').textContent = '';
  renderMergePhotos(); openDialog('mergeDraftDialog');
}

function renderMergePhotos() {
  if (!state.mergeContext) return;
  let remaining = state.mergeVisibleCount;
  const visible = state.mergeContext.groups.map(({ draft, photos }) => {
    const batch = photos.slice(0, Math.max(0, remaining)); remaining -= batch.length;
    if (!batch.length) return '';
    return `<section class="merge-photo-group"><h3>笔记 #${draft.id} · ${escapeHtml(draft.title || '未命名草稿')}</h3><div class="merge-photo-grid">${batch.map(photo => {
      const name = photo.filePath?.split(/[\\/]/).pop() || `照片 ${photo.id}`;
      const orientation = photo.metrics?.orientation === 'landscape' ? '横图' : '竖图';
      return `<article class="merge-photo"><button class="merge-photo-preview" type="button" data-merge-preview="${photo.id}" aria-label="查看合并照片 ${photo.id}"><img loading="lazy" data-src="/api/photos/${photo.id}/thumbnail?width=240" alt="${escapeHtml(name)}"></button><label><input type="checkbox" value="${photo.id}" ${state.mergePhotoIds.has(photo.id) ? 'checked' : ''} aria-label="合并入选照片 ${photo.id}"><span>${orientation} · <b class="${scoreBand(photo.totalScore)}">${escapeHtml(scoreLabel(photo.totalScore))}</b></span></label><span title="${escapeHtml(name)}">${escapeHtml(name)}</span><span>${escapeHtml(formatTime(photo.capturedAt))}</span></article>`;
    }).join('')}</div></section>`;
  }).join('');
  const total = state.mergeContext.groups.reduce((sum, group) => sum + group.photos.length, 0);
  $('#mergePhotoOptions').innerHTML = visible + (state.mergeVisibleCount < total ? `<div class="picker-more"><button class="button secondary" type="button" id="loadMoreMergePhotos">加载更多照片（剩余 ${total - state.mergeVisibleCount} 张）</button></div>` : '');
  hydrateLazyImages($('#mergeDraftDialog .merge-draft-body'));
  updateMergePhotoSelection();
}

function updateMergePhotoSelection() {
  const max = state.settings?.maxImagesPerPost ?? 6;
  const orientation = state.photos.get([...state.mergePhotoIds][0])?.metrics?.orientation;
  $('#mergePhotoCount').textContent = `已选 ${state.mergePhotoIds.size} / ${max} 张${orientation ? ` · ${orientation === 'landscape' ? '横图' : '竖图'}` : ''}`;
  $('#mergePhotoOptions').querySelectorAll('input[type="checkbox"]').forEach(input => {
    const selected = state.mergePhotoIds.has(Number(input.value));
    const photo = state.photos.get(Number(input.value));
    input.checked = selected;
    input.disabled = state.mergingDrafts || (!selected && (state.mergePhotoIds.size >= max || (orientation && orientation !== photo?.metrics?.orientation)));
  });
  $('#confirmMergeDrafts').disabled = state.mergingDrafts || state.mergePhotoIds.size === 0;
}

$('#drafts').addEventListener('change', event => {
  const input = event.target.closest('.select-merge-draft');
  if (!input) return;
  if (input.checked) state.selectedMergeDrafts.add(Number(input.value)); else state.selectedMergeDrafts.delete(Number(input.value));
  input.closest('.draft-card').classList.toggle('merge-selected', input.checked); renderMergeSelection();
});
$('#mergeDraftsButton').addEventListener('click', openMergeDrafts);
$('#clearMergeSelection').addEventListener('click', () => { state.selectedMergeDrafts.clear(); renderDrafts(); });
$('#mergePhotoOptions').addEventListener('change', event => {
  const input = event.target.closest('input[type="checkbox"]');
  if (!input || state.mergingDrafts) return;
  if (input.checked) state.mergePhotoIds.add(Number(input.value)); else state.mergePhotoIds.delete(Number(input.value));
  updateMergePhotoSelection();
});
$('#mergePhotoOptions').addEventListener('click', event => {
  const preview = event.target.closest('[data-merge-preview]');
  if (preview) void openPhotoDetail(Number(preview.dataset.mergePreview), true);
  if (event.target.closest('#loadMoreMergePhotos')) { state.mergeVisibleCount += 36; renderMergePhotos(); }
});
$('#clearMergePhotos').addEventListener('click', () => { if (!state.mergingDrafts) { state.mergePhotoIds.clear(); updateMergePhotoSelection(); } });
$('#mergeDraftDialog').addEventListener('cancel', event => { if (state.mergingDrafts) event.preventDefault(); });
$('#mergeDraftForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (state.mergingDrafts || !state.mergeContext || !state.mergePhotoIds.size) return;
  const context = state.mergeContext;
  state.mergingDrafts = true;
  $('#mergeDraftStatus').textContent = ''; $('#confirmMergeDrafts').textContent = '正在合并…';
  $('#mergeDraftDialog').querySelectorAll('input, textarea, button').forEach(element => { element.disabled = true; });
  try {
    const result = await getJson('/api/drafts/merge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sources: context.sources, photoIds: [...state.mergePhotoIds], title: $('#mergeTitle').value, description: $('#mergeDescription').value, scheduledAt: $('#mergeScheduledAt').value || null }) });
    state.refreshRequest++;
    $('#pageContent').setAttribute('aria-busy', 'false');
    state.drafts = state.drafts.filter(draft => !context.sources.some(source => source.id === draft.id)).concat(result.draft).sort((a, b) => a.id - b.id);
    state.selectedMergeDrafts.clear(); closeDialog('mergeDraftDialog');
    if (state.page === 'queue') renderDrafts();
    showToast(`已将 ${context.sources.length} 篇笔记合并为一篇，入选 ${result.draft.photoIds.length} 张照片`);
  } catch (error) { $('#mergeDraftStatus').textContent = error.message; showToast(`合并失败：${error.message}`); }
  finally {
    state.mergingDrafts = false;
    $('#mergeDraftDialog').querySelectorAll('input, textarea, button').forEach(element => { element.disabled = false; });
    $('#confirmMergeDrafts').textContent = '确认合并'; updateMergePhotoSelection(); renderMergeSelection();
  }
});

async function deleteDraft(id) {
  if (state.deletingDrafts.has(id)) return;
  state.deletingDrafts.add(id); renderDrafts();
  try {
    await getJson(`/api/drafts/${id}`, { method: 'DELETE' });
    // Discard any list request started before the deletion completed, so it
    // cannot temporarily put the removed draft back on screen.
    state.refreshRequest++;
    $('#pageContent').setAttribute('aria-busy', 'false');
    state.drafts = state.drafts.filter(draft => draft.id !== id);
    renderDrafts();
    closeDialog('deleteDraftDialog');
    showToast('草稿已删除');
  } catch (error) { showToast(`删除草稿失败：${error.message}`); }
  finally {
    state.deletingDrafts.delete(id);
    if (state.page === 'queue') renderDrafts();
  }
}

function photoScanLabel(photo) {
  return photo.scanState === 'unscanned' ? '尚未分析' : photo.scanState === 'failed' ? '分析失败' : '已扫描';
}
function photoStatusClass(photo) {
  if (photo.assessment) return 'rated';
  if (photo.scanState === 'failed') return 'scan-failed';
  if (photo.evaluationState === 'skipped') return 'technical-rejected';
  return 'unscanned';
}
function locationText(photo) {
  if (photo.locationName) return photo.locationName;
  return Number.isFinite(photo.latitude) && Number.isFinite(photo.longitude) ? `GPS ${photo.latitude.toFixed(4)}, ${photo.longitude.toFixed(4)}` : '未记录地点';
}
function coordinateText(photo) {
  return Number.isFinite(photo.latitude) && Number.isFinite(photo.longitude) ? `${photo.latitude.toFixed(6)}, ${photo.longitude.toFixed(6)}` : '未读取到 GPS 坐标';
}
function readPhotoFilters() {
  return Object.fromEntries(Object.entries(photoFilterFields).map(([key, id]) => [key, document.getElementById(id).value.trim()]));
}
function photoLibraryQuery({ filters = state.photoLibrary.filters, limit = state.photoLibrary.pageSize, offset = (state.photoLibrary.page - 1) * state.photoLibrary.pageSize } = {}) {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  Object.entries(filters).forEach(([key, value]) => { if (value && value !== 'all') params.set(key, value); });
  return `/api/photo-library?${params.toString()}`;
}
function hasOtherPhotoFilters(filters) {
  return ['directory', 'location', ...Object.keys(photoFilterLabels)].some(key => filters[key] && filters[key] !== 'all');
}
function renderAppliedPhotoFilters() {
  const filters = state.photoLibrary.appliedFilters || {};
  const labels = [];
  if (filters.from || filters.to) labels.push(`${photoTimeLabels[filters.timeField || 'captured']}：${filters.from || '不限'} ～ ${filters.to || '不限'}${filters.to ? '（含结束当天）' : ''}`);
  if (filters.directory) labels.push(`目录：${filters.directory.replace(/^\/photos\//, '')}`);
  if (filters.location) labels.push(`地点：${filters.location}`);
  Object.entries(photoFilterLabels).forEach(([key, definition]) => {
    if (definition.options[filters[key]]) labels.push(`${definition.name}：${definition.options[filters[key]]}`);
  });
  $('#photoAppliedFilters').innerHTML = '<strong>已执行筛选：</strong>' + (labels.length ? labels : ['全部照片']).map(label => `<span class="filter-chip">${escapeHtml(label)}</span>`).join('');
}
function renderPhotoLibraryEmpty() {
  const library = state.photoLibrary;
  const filters = library.appliedFilters || {};
  const canQueryTimeOnly = Boolean((filters.from || filters.to) && hasOtherPhotoFilters(filters));
  $('#photoDateOnlyQuery').hidden = !canQueryTimeOnly;
  let message = '没有符合所有筛选条件的照片。';
  if (canQueryTimeOnly) {
    if (library.timeMatchTotal > 0) message = `在全部目录中，仅按当前${photoTimeLabels[filters.timeField || 'captured']}范围可找到 ${library.timeMatchTotal} 张照片；叠加其他筛选后结果为 0 张。`;
    else if (library.timeMatchTotal === 0) message = '仅按当前时间范围也没有结果，请检查时间类型和日期。缺少拍摄时间的照片可改按文件修改时间查询。';
    else message += '可以保留时间范围，清除目录、地点、扫描和评分等条件后重新查询。';
  } else if (filters.from || filters.to) {
    message += filters.timeField === 'analyzed' ? '尚未分析的照片没有分析时间，可改按拍摄时间或文件修改时间查询。' : '请检查时间类型和日期；缺少拍摄时间的照片可按文件修改时间查询。';
  }
  $('#photoLibraryEmptyText').textContent = message;
}
function renderPhotoLibrary() {
  const library = state.photoLibrary;
  const items = library.items;
  $('#photoLibraryCount').textContent = `${library.total} 张`;
  const counts = library.counts ?? {};
  $('#photoLibrarySummary').textContent = `全部文件 ${counts.total ?? 0} · 尚未分析 ${counts.unscanned ?? 0} · 已评估 ${counts.assessed ?? 0} · 评估失败 ${counts.failed ?? 0} · 技术筛选未通过 ${counts.skipped ?? 0}`;
  $('#photoLibraryEmpty').hidden = items.length > 0;
  renderAppliedPhotoFilters(); renderPhotoLibraryEmpty();
  $('#photoLibrary').innerHTML = items.map(photo => {
    const location = locationText(photo);
    const score = photo.totalScore === null ? '无评分' : `综合 ${photo.totalScore}`;
    const stamp = encodeURIComponent(photo.modifiedAt);
    return `<button class="library-card" type="button" data-photo-id="${photo.fileId}" title="查看 ${escapeHtml(photo.fileName)} 的详细评价">
      <span class="library-image"><span class="preview-fallback" aria-hidden="true">预览加载中</span><img loading="lazy" src="/api/photo-library/${photo.fileId}/thumbnail?v=${stamp}" alt="${escapeHtml(photo.fileName)}"><span class="library-badge ${photoStatusClass(photo)}">${escapeHtml(evaluationText[photo.evaluationState])}</span>${photo.totalScore !== null ? `<span class="score-badge card-score ${scoreBand(photo.totalScore)}">${escapeHtml(scoreLabel(photo.totalScore))}</span>` : '<span class="score-badge card-score score-none">无评分</span>'}</span>
      <span class="library-card-body"><strong>${escapeHtml(photo.fileName)}</strong><span class="card-state">${photoScanLabel(photo)} · <span class="${scoreBand(photo.totalScore)} score-inline">${escapeHtml(score)}</span></span><span>${photo.capturedAt ? escapeHtml(formatTime(photo.capturedAt)) : '缺少拍摄时间'}</span><span>${escapeHtml(location)}</span><small title="${escapeHtml(photo.directory)}">${escapeHtml(photo.directory)}</small></span>
    </button>`;
  }).join('');
  const pages = Math.max(1, Math.ceil(library.total / library.pageSize));
  $('#photoPageInfo').textContent = `第 ${library.page} / ${pages} 页`;
  $('#photoPageInput').max = String(pages); $('#photoPageInput').value = String(library.page);
  $('#photoPrevPage').disabled = library.page <= 1;
  $('#photoNextPage').disabled = library.page >= pages;
  document.querySelectorAll('.library-card').forEach(button => button.addEventListener('click', () => openPhotoDetail(Number(button.dataset.photoId))));
  document.querySelectorAll('.library-image img').forEach(img => img.addEventListener('error', () => { img.hidden = true; img.parentElement.querySelector('.preview-fallback').textContent = '预览不可用'; }));
}
function normalizePhotoDetail(photo) {
  return { ...photo, photoId: photo.photoId ?? photo.id,
    fileName: photo.fileName ?? photo.filePath.split(/[\\/]/).pop(),
    evaluationState: photo.assessment ? 'assessed' : photo.evaluationState ?? photo.analysisOutcome ?? 'unassessed',
    scanState: photo.assessment ? 'scanned' : photo.scanState ?? (photo.analysisOutcome === 'failed' ? 'failed' : photo.analysisAttemptedAt || photo.metrics ? 'scanned' : 'unscanned') };
}
function renderScoreSection(photo) {
  const canEdit = photo.photoId && photo.metrics && photo.analysisAttemptedAt;
  return `<section class="detail-section photo-scores"><div class="score-heading"><h3>照片评分</h3>${canEdit ? '<button type="button" class="button secondary" id="editPhotoScores">修改评分</button>' : ''}</div>
    <div class="score-overview"><span>综合评分</span><strong id="photoTotalScore" class="${scoreBand(photo.totalScore)}">${photo.totalScore ?? '—'}</strong></div>
    <div id="photoScoreReadout" class="score-grid">${editableScores.map(([key, label]) => {const value = key === 'technicalScore' ? photo.metrics?.technicalScore : photo.assessment?.[key]; return `<span class="${scoreBand(value)}">${label}<strong>${value ?? '—'}</strong></span>`;}).join('')}</div>
    ${canEdit ? `<form id="photoScoreForm" hidden><fieldset class="score-edit-fields"><legend class="sr-only">修改照片各项评分</legend><div class="score-input-grid">${editableScores.map(([key, label, weight]) => `<label>${label}<small>权重 ${weight}%</small><input name="${key}" type="number" min="0" max="100" step="any" required aria-label="${label}评分" value="${key === 'technicalScore' ? photo.metrics.technicalScore : photo.assessment?.[key] ?? ''}"></label>`).join('')}</div><p class="form-hint">每项 0–100 分，综合分按原权重自动计算；保存后立即用于筛选发布。</p><div class="score-edit-actions"><span id="photoScoreMessage" role="status"></span><button type="button" class="button secondary" id="cancelPhotoScores">取消</button><button type="submit" class="button primary">保存评分</button></div></fieldset></form>` : ''}
    <p class="form-hint">${photo.manualScoresAt ? `人工调整：${escapeHtml(formatTime(photo.manualScoresAt))}` : photo.assessment ? '当前为模型评分，可人工调整。' : canEdit ? '已扫描，可填写完整评分；缺失分数不会自动补齐。' : '扫描完成后可修改评分。'}</p></section>`;
}
function renderPhotoDetail(photo) {
  photo = normalizePhotoDetail(photo);
  state.detailPhoto = photo;
  const assessment = photo.assessment;
  const metrics = photo.metrics;
  const location = locationText(photo);
  const originalUrl = photo.fileId ? `/api/photo-library/${photo.fileId}/file` : `/api/photos/${photo.photoId}/file`;
  const previewUrl = photo.fileId ? `/api/photo-library/${photo.fileId}/thumbnail?large=1` : `/api/photos/${photo.photoId}/thumbnail?width=640`;
  const stamp = encodeURIComponent(photo.modifiedAt);
  $('#photoDetailTitle').textContent = photo.fileName;
  $('#photoDetailMeta').textContent = `${photoScanLabel(photo)} · ${evaluationText[photo.evaluationState]} · ${photoStatusText[photo.status] || photo.status}`;
  $('#photoDetail').innerHTML = `<div class="photo-detail-grid"><div><img class="photo-detail-image" src="${previewUrl}&v=${stamp}" alt="${escapeHtml(photo.fileName)}"><a class="original-link" href="${originalUrl}" target="_blank" rel="noreferrer">打开原图 ↗</a></div><div class="photo-detail-fields">
    ${renderScoreSection(photo)}
    <div class="detail-row"><b>文件</b><span>${escapeHtml(photo.filePath)}${Number.isFinite(photo.size) ? ` · ${(photo.size / 1024 / 1024).toFixed(2)} MB` : ''}</span></div><div class="detail-row"><b>拍摄时间</b><span>${photo.capturedAt ? escapeHtml(formatTime(photo.capturedAt)) : '未读取到拍摄时间'}</span></div><div class="detail-row"><b>修改时间</b><span>${escapeHtml(formatTime(photo.modifiedAt))}</span></div><div class="detail-row"><b>经纬度</b><span>${escapeHtml(coordinateText(photo))}</span></div><div class="detail-row"><b>分析时间</b><span>${escapeHtml(formatTime(photo.analysisAttemptedAt))}</span></div><div class="detail-row"><b>流程状态</b><span>${escapeHtml(photoStatusText[photo.status] || photo.status)}${photo.photoId ? ` · 评价记录 #${photo.photoId}` : ''}</span></div>${photo.error ? `<div class="detail-row"><b>${photo.evaluationState === 'failed' ? '失败原因' : '筛选说明'}</b><span>${escapeHtml(photo.error)}</span></div>` : ''}
    ${assessment ? `<div class="detail-section"><h3>视觉评价</h3><h4>画面描述</h4><p class="detail-summary">${escapeHtml(assessment.summary)}</p><h4>评价理由</h4><p class="detail-reason">${escapeHtml(assessment.reason)}</p><p class="detail-theme">主题：${escapeHtml(assessment.theme)}</p><h4>可见证据</h4><ul>${assessment.observations.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul><p class="form-hint">分析版本：${escapeHtml(photo.analysisVersion || '—')}</p></div>` : `<div class="detail-section"><h3>视觉评价</h3><p class="muted">${photo.evaluationState === 'skipped' ? '照片未通过技术筛选，因此未调用视觉模型评分。' : photo.evaluationState === 'failed' ? '分析失败，尚未保存有效的模型评分。具体原因见上方。' : '尚未评估，等待扫描任务分析。'}</p></div>`}
    ${metrics ? `<div class="detail-section"><h3>技术信息</h3><p class="muted">尺寸 ${metrics.width} × ${metrics.height} · ${metrics.orientation === 'landscape' ? '横图' : metrics.orientation === 'portrait' ? '竖图' : '方图'} · 技术分 ${metrics.technicalScore} · 清晰度 ${metrics.sharpness.toFixed(1)}</p><p class="muted">亮度 ${(metrics.brightness * 100).toFixed(1)}% · 暗部占比 ${(metrics.darkFraction * 100).toFixed(1)}% · 亮部占比 ${(metrics.lightFraction * 100).toFixed(1)}%</p></div>` : ''}
  </div></div>`;
  $('#photoDetail .photo-detail-image').addEventListener('error', (event) => { event.target.hidden = true; });
  $('#editPhotoScores')?.addEventListener('click', () => {
    $('#photoScoreForm').hidden = false; $('#photoScoreReadout').hidden = true; $('#editPhotoScores').hidden = true;
  });
  $('#cancelPhotoScores')?.addEventListener('click', () => { if (!state.scoreSaving) renderPhotoDetail(photo); });
  $('#photoScoreForm')?.addEventListener('input', () => {
    const scores = readManualScores();
    const valid = Object.values(scores).every(value => Number.isFinite(value) && value >= 0 && value <= 100);
    const score = valid ? Math.round(editableScores.reduce((sum, [key, , weight]) => sum + scores[key] * weight / 100, 0)) : null;
    $('#photoTotalScore').textContent = score ?? '—'; $('#photoTotalScore').className = scoreBand(score);
  });
  $('#photoScoreForm')?.addEventListener('submit', savePhotoScores);
}
function readManualScores() {
  return Object.fromEntries(editableScores.map(([key]) => [key, $('#photoScoreForm').elements.namedItem(key).valueAsNumber]));
}
async function savePhotoScores(event) {
  event.preventDefault();
  if (state.scoreSaving) return;
  const photo = state.detailPhoto, navigation = state.navigation;
  const scores = readManualScores();
  state.scoreSaving = true;
  $('#photoScoreForm fieldset').disabled = true;
  $('#photoScoreMessage').textContent = '正在保存…';
  try {
    const result = await getJson(`/api/photos/${photo.photoId}/scores`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scores, revision: photo.scoreRevision ?? 0 }) });
    state.photos.set(result.photo.id, result.photo);
    state.editingCandidates = state.editingCandidates.map(item => item.id === result.photo.id ? result.photo : item);
    if (navigation === state.navigation && state.detailPhoto?.photoId === photo.photoId && $('#photoDetailDialog').open) {
      renderPhotoDetail({ ...photo, ...result.photo }); showToast('评分已保存，综合分和筛选结果已更新');
    }
    if ($('#draftDialog').open) renderDraftSelectedPhotos();
    if (navigation === state.navigation) await refresh(true);
  } catch (error) {
    if ($('#photoScoreMessage')) $('#photoScoreMessage').textContent = error.message;
    showToast(`保存评分失败：${error.message}`);
  } finally {
    state.scoreSaving = false;
    if ($('#photoScoreForm fieldset')) $('#photoScoreForm fieldset').disabled = false;
  }
}
async function openPhotoDetail(id, record = false) {
  const navigation = state.navigation;
  const request = ++state.detailRequest;
  try {
    const photo = await getJson(record ? `/api/photos/${id}` : `/api/photo-library/${id}`);
    if (navigation !== state.navigation || request !== state.detailRequest) return;
    renderPhotoDetail(photo); openDialog('photoDetailDialog');
  } catch (error) { if (navigation === state.navigation) showToast(`读取照片详情失败：${error.message}`); }
}
function renderDirectoryOptions(directories) {
  const current = $('#photoDirectoryFilter').value;
  const dirs = new Map();
  directories.forEach(item => {
    let directory = item.directory;
    while (directory && directory !== '/photos' && directory !== '/') {
      dirs.set(directory, (dirs.get(directory) || 0) + item.count);
      directory = directory.slice(0, directory.lastIndexOf('/'));
    }
  });
  $('#photoDirectoryFilter').innerHTML = '<option value="">全部目录</option>' + [...dirs].sort(([a], [b]) => a.localeCompare(b, 'zh-CN')).map(([directory, count]) => `<option value="${escapeHtml(directory)}">${escapeHtml(directory.replace(/^\/photos\//, ''))} (${count})</option>`).join('');
  $('#photoDirectoryFilter').value = current;
}
async function refreshPhotoLibrary(silent = false) {
  if (state.page !== 'photos') return;
  const request = ++state.photoLibrary.request;
  if (!silent) $('#photoLibraryMessage').textContent = '正在查询…';
  try {
    const result = await getJson(photoLibraryQuery());
    if (state.page !== 'photos' || request !== state.photoLibrary.request) return;
    state.photoLibrary.items = result.photos ?? []; state.photoLibrary.total = result.total ?? 0; state.photoLibrary.counts = result.counts;
    state.photoLibrary.appliedFilters = { ...state.photoLibrary.filters };
    state.photoLibrary.timeMatchTotal = null;
    const pages = Math.max(1, Math.ceil(result.total / state.photoLibrary.pageSize));
    if (state.photoLibrary.page > pages) { state.photoLibrary.page = pages; return refreshPhotoLibrary(silent); }
    renderDirectoryOptions(result.directories ?? []); renderPhotoLibrary();
    $('#photoLibraryMessage').textContent = `找到 ${result.total} 张 · 目录列表更新：${formatTime(result.indexedAt)}`;
    const filters = state.photoLibrary.filters;
    if (result.total === 0 && (filters.from || filters.to) && hasOtherPhotoFilters(filters)) {
      try {
        const timeOnly = { timeField: filters.timeField || 'captured', from: filters.from, to: filters.to };
        const comparison = await getJson(photoLibraryQuery({ filters: timeOnly, limit: 1, offset: 0 }));
        if (state.page !== 'photos' || request !== state.photoLibrary.request) return;
        state.photoLibrary.timeMatchTotal = comparison.total;
        renderPhotoLibraryEmpty();
      } catch { /* Keep the original result usable if the optional comparison fails. */ }
    }
  } catch (error) {
    if (state.page !== 'photos' || request !== state.photoLibrary.request) return;
    $('#photoLibraryMessage').textContent = `查询失败：${error.message}`;
    throw error;
  }
}

function renderRecords() {
  const filter = $('#statusFilter').value;
  const records = state.publications.filter(item => filter === 'all' || item.status === filter);
  $('#emptyState').hidden = records.length > 0;
  $('#records').innerHTML = records.map(item => {
    const photos = item.photoIds.map(id => state.photos.get(id)).filter(Boolean);
    const status = item.status ?? 'failed';
    const orientation = item.orientation === 'landscape' ? '横图' : item.orientation === 'portrait' ? '竖图' : item.orientation === 'legacy' ? '旧记录' : item.orientation;
    return `<article class="record"><div class="record-head"><div><h3 class="record-title">${escapeHtml(item.title || '未命名笔记')}</h3><div class="record-meta"><span>${escapeHtml(channelText[item.channel] || item.channel || '未知渠道')}</span><span>${escapeHtml(item.locationTag || item.locationName || '未标记地点')}</span><span>${orientation}</span><span>${escapeHtml(item.theme || '—')}</span></div></div><span class="status ${escapeHtml(status)}">${item.manualConfirmedAt ? (status === 'draft_saved' ? '人工确认已暂存（未发布）' : '人工确认已发布') : status === 'draft_saved' ? '历史 NAS 本地暂存（未发布）' : statusText[status] || escapeHtml(status)}</span></div>
      <div class="photo-strip">${photos.length ? photos.map(photo => `<div class="photo"><img loading="lazy" src="/api/photos/${photo.id}/thumbnail?width=480" alt="照片 ${photo.id}"><span class="score">美学 ${photo.assessment?.aesthetics ?? '—'}</span></div>`).join('') : '<span class="muted">没有照片记录</span>'}</div>
      <div class="record-foot"><span>创建：${formatTime(item.createdAt)} · ${status === 'draft_saved' ? `暂存：${formatTime(item.draftSavedAt)}` : `发布：${formatTime(item.publishedAt)}`}</span>${item.remoteUrl ? `<a href="${escapeHtml(item.remoteUrl)}" target="_blank" rel="noreferrer">打开发布页 ↗</a>` : ''}${item.error ? `<span class="error">${escapeHtml(item.error)}</span>` : ''}${status === 'draft_saved' ? '<span class="record-actions"><button type="button" class="button primary open-xhs-draft" data-post-id="' + item.id + '">准备发布 / 确认结果</button><button type="button" class="button link-button resolve-post" data-post-id="' + item.id + '" data-published="false">退回待发布队列</button></span><span class="draft-local-note">' + (item.manualConfirmedAt ? '由你确认已在自己的浏览器暂存。实际发布后，请打开准备发布窗口确认已发布。' : '历史记录：草稿曾存于 NAS 浏览器本地。可下载原素材，在自己的浏览器重新上传并暂存或发布。') + '</span>' : ''}</div></article>`;
  }).join('');
}

async function getJson(url, options) { const response = await fetch(url, options); if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `HTTP ${response.status}`); return response.status === 204 ? null : response.json(); }
async function refresh(silent = false) {
  const page = state.page;
  const request = ++state.refreshRequest;
  if (!silent || !state.loadedPages.has(page)) showPageMessage(`正在加载${pages[page].title}…`);
  $('#pageContent').setAttribute('aria-busy', 'true');
  try {
    const content = page === 'photos' ? refreshPhotoLibrary(silent) : getJson(page === 'queue' ? '/api/drafts' : '/api/publications');
    const [status, settings, scanStatus, selectionStatus, result] = await Promise.all([getJson('/api/status'), getJson('/api/settings'), getJson('/api/scan/status'), getJson('/api/selection/status'), content]);
    if (request !== state.refreshRequest || page !== state.page) return;
    state.status = status; state.scanStatus = scanStatus; state.selectionStatus = selectionStatus; state.settings = settings;
    renderSummary(); renderScanStatus(); renderSelectionStatus(); if (!state.settingsDirty) renderSettings();
    if (scanStatus.running) watchScan();
    if (selectionStatus.running) watchSelection();
    if (page !== 'photos') {
      const posts = page === 'queue' ? (result.drafts ?? []) : result;
      const ids = [...new Set(posts.flatMap(item => item.photoIds))];
      const chunks = Array.from({ length: Math.ceil(ids.length / 500) }, (_, i) => ids.slice(i * 500, (i + 1) * 500));
      const photos = (await Promise.all(chunks.map(chunk => getJson(`/api/photos?ids=${chunk.join(',')}`)))).flat();
      if (request !== state.refreshRequest || page !== state.page) return;
      photos.forEach(photo => state.photos.set(photo.id, photo));
      if (page === 'queue') { state.drafts = posts; renderDrafts(); }
      else { state.publications = posts; renderRecords(); }
    }
    state.loadedPages.add(page);
    showPageMessage();
    $('#lastUpdated').textContent = `最近刷新：${formatTime(new Date().toISOString())}`;
  } catch (error) {
    if (request !== state.refreshRequest || page !== state.page) return;
    showPageMessage(`加载失败：${error.message}。请点击“刷新”重试。`, true);
    if (!silent) showToast(`刷新失败：${error.message}`);
  } finally {
    if (request === state.refreshRequest) $('#pageContent').setAttribute('aria-busy', 'false');
  }
}

let scanPollTimer = null;
let scanPolling = false;
let selectionPollTimer = null;
let selectionPolling = false;
async function pollScanStatus() {
  if (scanPolling || state.page !== 'photos') return;
  scanPollTimer = null; scanPolling = true;
  try {
    state.scanStatus = await getJson('/api/scan/status');
    renderScanStatus();
    if (!state.scanStatus.running && state.page === 'photos') await refresh(true);
  } catch (error) {
    if (state.page === 'photos') $('#scanStatus').textContent = `扫描信息暂时无法更新：${error.message}，正在重试…`;
  } finally {
    scanPolling = false;
    if (state.page === 'photos' && state.scanStatus?.running) scanPollTimer = setTimeout(pollScanStatus, 1000);
  }
}
function watchScan() { if (state.page === 'photos' && !scanPollTimer && !scanPolling) void pollScanStatus(); }
async function pollSelectionStatus() {
  if (selectionPolling || state.page !== 'photos') return;
  selectionPollTimer = null; selectionPolling = true;
  try {
    state.selectionStatus = await getJson('/api/selection/status');
    renderSelectionStatus();
    if (!state.selectionStatus.running && state.page === 'photos') await refresh(true);
  } catch (error) {
    if (state.page === 'photos') $('#selectionStatus').textContent = `筛选信息暂时无法更新：${error.message}，正在重试…`;
  } finally {
    selectionPolling = false;
    if (state.page === 'photos' && state.selectionStatus?.running) selectionPollTimer = setTimeout(pollSelectionStatus, 1000);
  }
}
function watchSelection() { if (state.page === 'photos' && !selectionPollTimer && !selectionPolling) void pollSelectionStatus(); }

function renderDraftSelectedPhotos() {
  const selected = [...state.editingPhotoIds].map(id => state.photos.get(id)).filter(Boolean);
  $('#draftPhotoOptions').innerHTML = selected.length ? selected.map(photo => `<article class="draft-selected-photo"><button type="button" class="photo-detail-trigger selected-photo-preview" data-record-id="${photo.id}" aria-label="查看照片 ${photo.id} 详情"><img loading="lazy" data-src="/api/photos/${photo.id}/thumbnail?width=240" alt="照片 ${photo.id}"></button><div><strong>${escapeHtml(photo.filePath?.split(/[\\/]/).pop() || `照片 ${photo.id}`)}</strong><span class="${scoreBand(photo.totalScore)}">${escapeHtml(scoreLabel(photo.totalScore))} · ${photo.metrics?.orientation === 'landscape' ? '横图' : '竖图'}</span></div><button type="button" class="icon-button remove-draft-photo" data-photo-id="${photo.id}" aria-label="移除照片">×</button></article>`).join('') : '<p class="form-hint">尚未选择照片，请点击“添加照片”。</p>';
  hydrateLazyImages($('#draftPhotoOptions'));
  document.querySelectorAll('.remove-draft-photo').forEach(button => button.addEventListener('click', () => {
    state.editingPhotoIds.delete(Number(button.dataset.photoId));
    renderDraftSelectedPhotos();
  }));
}

function renderDraftPicker() {
  const candidates = state.editingCandidates.filter(photo => !state.editingPhotoIds.has(photo.id));
  const visible = candidates.slice(0, state.pickerVisibleCount);
  $('#pickerPhotoOptions').innerHTML = visible.length ? visible.map(photo => `<label class="photo-option"><input type="checkbox" value="${photo.id}" ${state.pickerSelectedIds.has(photo.id) ? 'checked' : ''}><img loading="lazy" data-src="/api/photos/${photo.id}/thumbnail?width=240" alt="照片 ${photo.id}"><span>#${photo.id} · ${escapeHtml(scoreLabel(photo.totalScore))} · ${photo.metrics?.orientation === 'landscape' ? '横图' : '竖图'}</span></label>`).join('') : '<p class="form-hint">没有可添加的照片。</p>';
  const more = $('#loadMorePicker');
  more.hidden = visible.length >= candidates.length;
  more.textContent = `加载更多（剩余 ${Math.max(0, candidates.length - visible.length)} 张）`;
  hydrateLazyImages($('#pickerPhotoOptions'));
}

function renderDraftMetadata() {
  const metadata = state.draftMetadata;
  $('#draftLocationTag').value = metadata.locationTag || '';
  $('#draftTopics').value = metadata.topics.join(', ');
  const locationCandidates = metadata.locationCandidates ?? [];
  $('#draftLocationCandidates').innerHTML = locationCandidates.map(candidate => `<button type="button" class="xhs-candidate" data-xhs-kind="location" data-value="${escapeHtml(candidate)}">${escapeHtml(candidate)}</button>`).join('');
  $('#draftTopicCandidates').innerHTML = (metadata.topicCandidates ?? []).map(candidate => `<button type="button" class="xhs-candidate" data-xhs-kind="topic" data-value="${escapeHtml(candidate)}">${escapeHtml(candidate)}</button>`).join('');
  const location = metadata.locationTag
    ? `<span>${escapeHtml(metadata.locationTag)}</span> <span class="xhs-pending">发布时在小红书选择</span>`
    : '<span class="muted">未确认地点</span>';
  $('#draftLocationSelected').innerHTML = location;
  $('#draftTopicSelected').innerHTML = metadata.topics.length
    ? metadata.topics.map(topic => `<span class="xhs-tag">${escapeHtml(topic)}<button type="button" data-remove-topic="${escapeHtml(topic)}" aria-label="移除话题">×</button></span>`).join('')
    : '<span class="muted">尚未选择话题</span>';
  $('#searchTopicButton').disabled = metadata.searchingTopic;
  $('#searchTopicButton').textContent = '添加话题关键词';
  $('#searchLocationButton').disabled = metadata.searchingLocation;
  $('#searchLocationButton').textContent = '设置地点关键词';
}

async function lookupDraftMetadata(kind) {
  const metadata = state.draftMetadata;
  const input = kind === 'topic' ? $('#draftTopicQuery') : $('#draftLocationQuery');
  const query = input.value.trim();
  if (!query) { showToast(`请输入${kind === 'topic' ? '话题' : '地点'}关键词`); return; }
  if (kind === 'topic') {
    const topic = query.replace(/^#+/, '').trim();
    if (!topic) return;
    if ([...topic].length > 30) { showToast('每个话题最多 30 个字'); return; }
    if (!metadata.topics.includes(topic)) {
      if (metadata.topics.length >= 10) { showToast('最多添加 10 个话题'); return; }
      metadata.topics.push(topic);
    }
    metadata.verifiedTopics = []; input.value = '';
  } else { metadata.locationTag = query; metadata.locationVerified = false; }
  renderDraftMetadata();
}

async function openDraftEditor(id) {
  const draft = state.drafts.find(item => item.id === id); if (!draft) return;
  const navigation = state.navigation;
  try {
    const photos = (await Promise.all((draft.merged ? draft.eventIds : [draft.eventId]).map(eventId => getJson(`/api/photos?eventId=${eventId}&summary=1`)))).flat();
    photos.forEach(photo => state.photos.set(photo.id, { ...state.photos.get(photo.id), ...photo }));
  }
  catch (error) { showToast(`读取草稿照片失败：${error.message}`); return; }
  if (state.page !== 'queue' || navigation !== state.navigation) return;
  state.editingDraft = draft;
  state.editingPhotoIds = new Set(draft.photoIds);
  state.pickerVisibleCount = 36;
  state.pickerSelectedIds = new Set();
  const heldElsewhere = new Set(state.drafts.filter(item => item.id !== id).flatMap(item => item.photoIds));
  const eventIds = draft.merged ? draft.eventIds : [draft.eventId];
  state.editingCandidates = [...state.photos.values()].filter(photo => eventIds.includes(photo.eventId) && !heldElsewhere.has(photo.id) && (photo.status === 'pending' || state.editingPhotoIds.has(photo.id)))
    .sort((a, b) => (b.totalScore ?? -1) - (a.totalScore ?? -1) || a.id - b.id);
  $('#draftId').value = String(draft.id); $('#draftTitle').value = draft.title || ''; $('#draftDescription').value = (draft.description || '').trim().slice(0, 50);
  $('#draftScheduledAt').value = dateTimeLocal(draft.scheduledAt);
  state.draftMetadata = { topics: [...(draft.topics || [])], verifiedTopics: [...(draft.verifiedTopics || [])], locationTag: draft.locationTag || '', locationVerified: Boolean(draft.locationVerified), topicCandidates: [], locationCandidates: [], searchingTopic: false, searchingLocation: false };
  $('#draftLocationQuery').value = draft.locationTag || draft.locationName || '';
  $('#draftTopicQuery').value = '';
  $('#draftLocationSuggestion').textContent = `建议地点：${draft.locationName || '无'}。发布时请在自己的小红书网页搜索并选择。`;
  $('#draftMeta').textContent = `${draft.locationName || '未记录地点'} · ${draft.orientation === 'landscape' ? '横图' : '竖图'} · ${draft.theme || '—'}`;
  $('#draftPhotoRule').textContent = `${draft.merged ? '合并笔记可包含不同拍摄事件和主题，须保持方向一致' : '同一拍摄事件、同一方向和同一主题'}，最多 ${state.settings?.maxImagesPerPost ?? 6} 张。`;
  renderDraftMetadata(); renderDraftSelectedPhotos(); renderDraftPicker();
  $('#draftStatus').textContent = ''; openDialog('draftDialog');
}

function openDraftPicker() {
  state.pickerSelectedIds = new Set();
  $('#photoPickerHint').textContent = state.editingDraft?.merged ? '这里只显示合并笔记所含拍摄事件中尚未加入本篇草稿的可用照片。' : '这里只显示当前事件中尚未加入本篇草稿的可用照片。';
  renderDraftPicker();
  openDialog('photoPickerDialog');
}

async function publishDraftNow(id, button = null) {
  await openHandoff(id, async post => {
    state.refreshRequest++;
    state.drafts = state.drafts.filter(draft => draft.id !== id);
    state.publications = [post, ...state.publications.filter(item => item.id !== id)];
    $('#statusFilter').value = post.status;
    if (state.page !== 'publications') navigateToPage('publications');
    await refresh(true);
    showToast(post.status === 'published' ? '已按你的确认记为已发布' : '已按你的确认记为已暂存，已移入发布记录');
  });
}

document.querySelectorAll('[data-page-link]').forEach(link => link.addEventListener('click', (event) => {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault(); navigateToPage(link.dataset.pageLink);
}));
['drafts', 'draftPhotoOptions'].forEach(id => document.getElementById(id).addEventListener('click', event => {
  const button = event.target.closest('.photo-detail-trigger');
  if (button) void openPhotoDetail(Number(button.dataset.recordId), true);
}));
window.addEventListener('popstate', () => navigateToPage(pageFromPath(), { history: 'none' }));
$('#settingsButton').addEventListener('click', () => { state.settingsDirty = false; renderSettings(); openDialog('settingsDialog'); });
document.querySelectorAll('[data-close-dialog]').forEach(button => button.addEventListener('click', () => closeDialog(button.dataset.closeDialog)));
$('#refreshButton').addEventListener('click', () => refresh());
$('#deleteDraftForm').addEventListener('submit', async event => {
  event.preventDefault();
  const id = state.draftToDelete;
  if (id === null || state.deletingDrafts.has(id)) return;
  const buttons = [...document.querySelectorAll('#deleteDraftDialog button')];
  buttons.forEach(button => { button.disabled = true; });
  $('#confirmDeleteDraft').textContent = '删除中…';
  try { await deleteDraft(id); }
  finally {
    buttons.forEach(button => { button.disabled = false; });
    $('#confirmDeleteDraft').textContent = '确认删除';
  }
});
$('#deleteDraftDialog').addEventListener('cancel', event => { if (state.deletingDrafts.has(state.draftToDelete)) event.preventDefault(); });
$('#deleteDraftDialog').addEventListener('close', () => { state.draftToDelete = null; });
$('#statusFilter').addEventListener('change', renderRecords);
$('#records').addEventListener('click', async event => {
  const openButton = event.target.closest('.open-xhs-draft');
  if (openButton) { void publishDraftNow(Number(openButton.dataset.postId)); return; }
  const button = event.target.closest('.resolve-post');
  if (!button) return;
  const id = Number(button.dataset.postId);
  const published = button.dataset.published === 'true';
  if (!Number.isInteger(id)) return;
  button.disabled = true;
  try {
    await getJson(`/api/posts/${id}/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ published }) });
    showToast(published ? '已标记为手动发布成功' : '已退回待发布队列');
    await refresh(true);
  } catch (error) { showToast(`更新发布状态失败：${error.message}`); button.disabled = false; }
});
$('#photoLibraryFilters').addEventListener('input', () => { $('#photoFilterPending').hidden = false; });
$('#photoLibraryFilters').addEventListener('change', () => { $('#photoFilterPending').hidden = false; });
$('#photoLibraryFilters').addEventListener('submit', async (event) => {
  event.preventDefault();
  state.photoLibrary.filters = readPhotoFilters();
  state.photoLibrary.page = 1;
  $('#photoFilterPending').hidden = true;
  try { await refreshPhotoLibrary(); } catch (error) { showToast(`照片查询失败：${error.message}`); }
});
$('#resetPhotoFilters').addEventListener('click', async () => {
  $('#photoLibraryFilters').reset(); state.photoLibrary.filters = {}; state.photoLibrary.page = 1;
  $('#photoFilterPending').hidden = true;
  try { await refreshPhotoLibrary(); } catch (error) { showToast(`照片查询失败：${error.message}`); }
});
$('#photoDateOnlyQuery').addEventListener('click', async () => {
  const filters = state.photoLibrary.appliedFilters || {};
  const timeOnly = { timeField: filters.timeField || 'captured', from: filters.from || '', to: filters.to || '' };
  $('#photoLibraryFilters').reset();
  Object.entries(timeOnly).forEach(([key, value]) => { document.getElementById(photoFilterFields[key]).value = value; });
  state.photoLibrary.filters = readPhotoFilters(); state.photoLibrary.page = 1;
  $('#photoFilterPending').hidden = true;
  try { await refreshPhotoLibrary(); } catch (error) { showToast(`照片查询失败：${error.message}`); }
});
$('#refreshPhotoLibrary').addEventListener('click', async () => {
  const button = $('#refreshPhotoLibrary'); button.disabled = true;
  try { await getJson('/api/photo-library/refresh', { method: 'POST' }); await refreshPhotoLibrary(); showToast('图片列表已更新'); }
  catch (error) { showToast(`更新失败：${error.message}`); } finally { button.disabled = false; }
});
$('#photoPrevPage').addEventListener('click', async () => { if (state.photoLibrary.page > 1) { state.photoLibrary.page--; try { await refreshPhotoLibrary(); } catch (error) { showToast(`查询失败：${error.message}`); } } });
$('#photoNextPage').addEventListener('click', async () => { if (state.photoLibrary.page < Math.ceil(state.photoLibrary.total / state.photoLibrary.pageSize)) { state.photoLibrary.page++; try { await refreshPhotoLibrary(); } catch (error) { showToast(`查询失败：${error.message}`); } } });
async function jumpToPhotoPage() {
  const pages = Math.max(1, Math.ceil(state.photoLibrary.total / state.photoLibrary.pageSize));
  const input = $('#photoPageInput');
  const requested = Number(input.value);
  if (!Number.isInteger(requested) || requested < 1 || requested > pages) { input.value = String(state.photoLibrary.page); showToast(`请输入 1 到 ${pages} 之间的页码`); return; }
  if (requested === state.photoLibrary.page) return;
  state.photoLibrary.page = requested;
  try { await refreshPhotoLibrary(); } catch (error) { showToast(`查询失败：${error.message}`); }
}
$('#photoPageJump').addEventListener('click', jumpToPhotoPage);
$('#photoPageInput').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void jumpToPhotoPage(); } });
$('#rescheduleDrafts').addEventListener('click', async () => {
  const button = $('#rescheduleDrafts');
  button.disabled = true; button.textContent = '重置中…';
  try {
    const result = await getJson('/api/drafts/reschedule', { method: 'POST' });
    if (result.schedule) state.settings = result.schedule;
    state.drafts = result.drafts ?? [];
    renderDrafts();
    showToast(`已按当前规则重置 ${state.drafts.length} 篇待发布草稿的时间`);
  } catch (error) { showToast(`重置发布时间失败：${error.message}`); renderDrafts(); }
  finally { button.textContent = '按规则重置所有时间'; button.disabled = state.drafts.length === 0; }
});
$('#scheduleCycle').addEventListener('change', toggleWeeklyDay);
$('#settingsForm').addEventListener('input', () => { state.settingsDirty = true; });
$('#settingsForm').addEventListener('submit', async (event) => {
  event.preventDefault(); const button = $('#saveSettingsButton'); const status = $('#settingsStatus');
  button.disabled = true; button.textContent = '保存中…'; status.textContent = '';
  try {
    const payload = { publishEnabled: false, visionApiUrl: $('#visionApiUrl').value.trim(), visionModel: $('#visionModel').value.trim(), visionApiKey: $('#clearVisionKey').checked ? '' : ($('#visionApiKey').value || undefined), xhsAccount: $('#xhsAccount').value.trim(), xhsCreatorUrl: $('#xhsCreatorUrl').value.trim(), scheduleCycle: $('#scheduleCycle').value, publishTime: $('#publishTime').value, weeklyDay: Number($('#weeklyDay').value) };
    const result = await getJson('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    state.settings = result.settings; state.settingsDirty = false; renderSettings(); status.textContent = '已保存，配置已即时生效'; showToast('配置已保存并即时生效');
  } catch (error) { status.textContent = `保存失败：${error.message}`; showToast(`保存失败：${error.message}`); }
  finally { button.disabled = false; button.textContent = '保存配置'; }
});
$('#addDraftPhotos').addEventListener('click', openDraftPicker);
$('#loadMorePicker').addEventListener('click', () => { state.pickerVisibleCount += 36; renderDraftPicker(); });
$('#pickerPhotoOptions').addEventListener('change', event => {
  const input = event.target.closest('input[type="checkbox"]');
  if (!input) return;
  const id = Number(input.value);
  if (input.checked) state.pickerSelectedIds.add(id); else state.pickerSelectedIds.delete(id);
});
$('#photoPickerForm').addEventListener('submit', event => {
  event.preventDefault();
  state.pickerSelectedIds.forEach(id => state.editingPhotoIds.add(id));
  state.pickerSelectedIds = new Set();
  closeDialog('photoPickerDialog'); renderDraftSelectedPhotos();
});
$('#searchTopicButton').addEventListener('click', () => void lookupDraftMetadata('topic'));
$('#searchLocationButton').addEventListener('click', () => void lookupDraftMetadata('location'));
$('#draftTopicQuery').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void lookupDraftMetadata('topic'); } });
$('#draftLocationQuery').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void lookupDraftMetadata('location'); } });
$('#draftTopicCandidates').addEventListener('click', event => {
  const button = event.target.closest('[data-xhs-kind="topic"]');
  if (!button) return;
  const topic = button.dataset.value?.trim() || '';
  const metadata = state.draftMetadata;
  if (!topic || metadata.topics.includes(topic)) return;
  if (metadata.topics.length >= 10) { showToast('最多选择 10 个话题'); return; }
  if ([...topic].length > 30) { showToast('每个话题最多 30 个字'); return; }
  metadata.topics.push(topic); metadata.verifiedTopics = [...new Set([...metadata.verifiedTopics, topic])];
  metadata.topicCandidates = []; renderDraftMetadata();
});
$('#draftTopicSelected').addEventListener('click', event => {
  const button = event.target.closest('[data-remove-topic]');
  if (!button) return;
  const topic = button.dataset.removeTopic;
  state.draftMetadata.topics = state.draftMetadata.topics.filter(item => item !== topic);
  state.draftMetadata.verifiedTopics = state.draftMetadata.verifiedTopics.filter(item => item !== topic);
  renderDraftMetadata();
});
$('#draftLocationCandidates').addEventListener('click', event => {
  const button = event.target.closest('[data-xhs-kind="location"]');
  if (!button) return;
  state.draftMetadata.locationTag = button.dataset.value?.trim() || '';
  state.draftMetadata.locationVerified = Boolean(state.draftMetadata.locationTag);
  state.draftMetadata.locationCandidates = [];
  $('#draftLocationQuery').value = state.draftMetadata.locationTag;
  renderDraftMetadata();
});
$('#clearLocationButton').addEventListener('click', () => {
  state.draftMetadata.locationTag = ''; state.draftMetadata.locationVerified = false; state.draftMetadata.locationCandidates = [];
  $('#draftLocationQuery').value = ''; renderDraftMetadata();
});
$('#draftForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#draftForm button[type="submit"]'); const status = $('#draftStatus');
  const metadata = state.draftMetadata;
  const topics = metadata.topics;
  const photoIds = [...state.editingPhotoIds];
  button.disabled = true; status.textContent = '';
  try {
    await getJson(`/api/drafts/${$('#draftId').value}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      photoIds, title: $('#draftTitle').value, description: $('#draftDescription').value,
      scheduledAt: $('#draftScheduledAt').value || null, locationTag: metadata.locationTag || null, topics,
      verifiedTopics: metadata.verifiedTopics, locationVerified: metadata.locationVerified
    }) });
    closeDialog('draftDialog'); showToast('待发布草稿已更新'); await refresh(true);
  } catch (error) { status.textContent = error.message; showToast(`保存草稿失败：${error.message}`); }
  finally { button.disabled = false; }
});
const scanPointer = $('#scanProgressPointer');
scanPointer.addEventListener('pointerdown', () => { state.scanCursorDragging = true; });
scanPointer.addEventListener('pointerup', () => {
  state.scanCursorDragging = false;
  if (state.scanCursorPreview === null) renderScanStatus();
});
scanPointer.addEventListener('pointercancel', () => {
  state.scanCursorDragging = false;
  if (!state.scanCursorSaving) { state.scanCursorPreview = null; renderScanStatus(); }
});
scanPointer.addEventListener('input', () => {
  state.scanCursorPreview = { index: Number(scanPointer.max) - Number(scanPointer.value), total: Number(scanPointer.max) + 1 };
  renderScanPointerLabel();
});
scanPointer.addEventListener('change', async () => {
  if (state.scanCursorSaving || !state.scanCursorPreview) return;
  const position = state.scanCursorPreview;
  state.scanCursorDragging = false;
  state.scanCursorSaving = true; renderScanStatus();
  try {
    const result = await getJson('/api/scan/cursor', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(position) });
    state.scanStatus = result.status;
    showToast(result.resumed ? '指针已保存，扫描正在从新位置继续' : '指针已保存，点击“继续扫描”从这里开始');
    if (result.status.running) watchScan();
  } catch (error) {
    showToast(`移动指针失败：${error.message}`);
    try { state.scanStatus = await getJson('/api/scan/status'); } catch { /* Keep the last confirmed position. */ }
  } finally {
    state.scanCursorPreview = null; state.scanCursorSaving = false; state.scanCursorDragging = false; renderScanStatus();
  }
});
$('#scanButton').addEventListener('click', async () => {
  if (state.scanStarting || state.scanCursorSaving || state.scanCursorDragging || state.scanStatus?.running) return;
  state.scanStarting = true; renderScanStatus();
  try {
    const result = await getJson(state.scanStatus?.phase === 'paused' ? '/api/scan/resume' : '/api/scan', { method: 'POST' });
    state.scanStatus = result.status;
    showToast(result.accepted ? '扫描已开始，可在照片库顶部查看实时进度' : '已有扫描任务正在执行');
    if (result.status.running) watchScan();
  } catch (error) { showToast(`扫描启动失败：${error.message}`); }
  finally { state.scanStarting = false; renderScanStatus(); }
});
$('#scanStopButton').addEventListener('click', async () => {
  if (state.scanStopping || !state.scanStatus?.running || state.scanStatus.stopRequested) return;
  state.scanStopping = true; renderScanStatus();
  try {
    const result = await getJson('/api/scan/stop', { method: 'POST' });
    state.scanStatus = result.status;
    showToast(result.accepted ? '正在停止扫描，进度将自动保存' : '扫描已停止或已结束');
    if (result.status.running) watchScan();
    else await refresh(true);
  } catch (error) { showToast(`停止扫描失败：${error.message}`); }
  finally { state.scanStopping = false; renderScanStatus(); }
});
$('#selectButton').addEventListener('click', async () => {
  if (state.selectionStarting || state.selectionStatus?.running) return;
  state.selectionStarting = true; renderSelectionStatus();
  try {
    const result = await getJson('/api/select', { method: 'POST' });
    state.selectionStatus = result.status;
    showToast(result.accepted ? '筛选发布任务已开始，可在照片库顶部查看进度' : '已有筛选发布任务正在执行');
    if (result.status.running) watchSelection();
  } catch (error) { showToast(`筛选发布启动失败：${error.message}`); }
  finally { state.selectionStarting = false; renderSelectionStatus(); }
});
navigateToPage(pageFromPath(), { history: 'replace', initial: true });
setInterval(() => refresh(true), 30000);
