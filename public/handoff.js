const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let current = null;
let request = 0;

function initialize() {
  if (document.getElementById('handoffDialog')) return;
  document.body.insertAdjacentHTML('beforeend', `<dialog id="handoffDialog" class="modal handoff-modal" aria-labelledby="handoffTitle"><div class="modal-card">
    <div class="modal-header"><div><p class="eyebrow">准备发布</p><h2 id="handoffTitle">准备发布</h2></div><button type="button" class="icon-button" id="closeHandoff" aria-label="关闭">×</button></div>
    <p class="handoff-notice">下载素材 → 在自己的小红书网页上传并暂存或发布 → 回这里确认结果。网页草稿保存在操作它的浏览器本地。</p>
    <div id="handoffBody" class="handoff-body"></div><p id="handoffMessage" class="form-hint" role="status"></p>
    <div class="handoff-actions"><button type="button" class="button primary" id="downloadHandoff">下载照片包</button><a class="button secondary" href="https://creator.xiaohongshu.com/publish/publish" target="_blank" rel="noopener noreferrer">打开小红书发布页 ↗</a></div>
    <div class="handoff-confirm-actions"><span class="form-hint">仅完成小红书页面操作后确认</span><button type="button" class="button secondary" data-handoff-result="draft_saved">确认已暂存</button><button type="button" class="button primary" data-handoff-result="published">确认已发布</button></div>
  </div></dialog>
  <dialog id="handoffConfirmDialog" class="modal handoff-confirm-modal" aria-labelledby="handoffConfirmTitle"><div class="modal-card"><h2 id="handoffConfirmTitle">确认操作结果</h2><p id="handoffConfirmText"></p><form id="handoffConfirmForm"><label class="checkbox-label"><input type="checkbox" id="handoffAcknowledged" required> 我已在自己的小红书页面完成上述操作，并确认成功</label><p class="form-hint">系统只记录你的确认，不会代为点击小红书的暂存或发布按钮。</p><p id="handoffConfirmError" class="form-hint error" role="status"></p><div class="settings-actions"><button type="button" class="button secondary" id="cancelHandoffConfirm">取消</button><button type="submit" class="button primary" id="submitHandoffConfirm">确认记录</button></div></form></div></dialog>`);
  const dialog = document.getElementById('handoffDialog');
  document.getElementById('closeHandoff').onclick = () => dialog.close();
  document.getElementById('cancelHandoffConfirm').onclick = () => document.getElementById('handoffConfirmDialog').close();
  dialog.addEventListener('click', async event => {
    const copy = event.target.closest('[data-handoff-copy]');
    if (copy && current) {
      const field = document.getElementById(copy.dataset.handoffCopy);
      try {
        if (navigator.clipboard?.writeText && window.isSecureContext) await navigator.clipboard.writeText(field.value);
        else {
          field.focus(); field.select(); field.setSelectionRange(0, field.value.length);
          if (!document.execCommand('copy')) throw new Error('请选中文本手动复制');
        }
        document.getElementById('handoffMessage').textContent = '已复制；请到小红书页面填写。';
      } catch { field.focus(); field.select(); document.getElementById('handoffMessage').textContent = '自动复制不可用，文本已选中，请按 Ctrl+C（手机可长按复制）。'; }
    }
    const confirm = event.target.closest('[data-handoff-result]');
    if (!confirm || !current) return;
    current.result = confirm.dataset.handoffResult;
    const saved = current.result === 'draft_saved';
    document.getElementById('handoffConfirmTitle').textContent = saved ? '确认已在小红书暂存' : '确认已在小红书发布';
    document.getElementById('handoffConfirmText').textContent = saved ? '确认后，这篇笔记将进入发布记录，标记为“人工确认已暂存（未发布）”。请先在自己的浏览器草稿箱确认能看到它。' : '确认后，这篇笔记将进入发布记录，标记为“人工确认已发布”。请先在小红书确认笔记已发布。';
    document.getElementById('handoffConfirmForm').reset();
    document.getElementById('handoffConfirmError').textContent = '';
    document.getElementById('handoffConfirmDialog').showModal();
  });
  document.getElementById('downloadHandoff').onclick = async event => {
    if (!current) return;
    const { details } = current;
    const button = event.currentTarget; button.disabled = true; button.textContent = '正在打包…';
    try {
      const response = await fetch(`/api/drafts/${details.postId}/package?revision=${details.revision}`);
      if (!response.ok) throw new Error((await response.json()).error || '下载失败');
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = url; link.download = `小红书-${details.postId}-${details.title || '未命名'}.zip`; document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      document.getElementById('handoffMessage').textContent = '已发起下载，请解压后按编号上传；笔记状态未改变。';
    } catch (error) { document.getElementById('handoffMessage').textContent = `下载失败：${error.message}`; }
    finally { button.disabled = false; button.textContent = '下载照片包'; }
  };
  document.getElementById('handoffConfirmForm').onsubmit = async event => {
    event.preventDefault();
    if (!current || !document.getElementById('handoffAcknowledged').checked) return;
    const context = current;
    const buttons = [...document.querySelectorAll('#handoffConfirmDialog button')]; buttons.forEach(b => { b.disabled = true; });
    try {
      const response = await fetch(`/api/drafts/${context.details.postId}/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: context.details.revision, result: context.result, confirmed: true }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error || '确认失败');
      document.getElementById('handoffConfirmDialog').close(); dialog.close();
      await context.onConfirmed(result.post);
    } catch (error) { document.getElementById('handoffConfirmError').textContent = error.message; }
    finally { buttons.forEach(b => { b.disabled = false; }); }
  };
}

export async function openHandoff(id, onConfirmed) {
  initialize();
  const dialog = document.getElementById('handoffDialog');
  if (document.getElementById('handoffConfirmDialog').open) return;
  const token = ++request; current = null;
  document.getElementById('handoffBody').textContent = '正在读取笔记素材…';
  document.getElementById('handoffMessage').textContent = '';
  document.getElementById('handoffTitle').textContent = '准备发布';
  document.querySelectorAll('#handoffDialog button:not(#closeHandoff)').forEach(b => { b.disabled = true; });
  if (!dialog.open) dialog.showModal();
  try {
    const response = await fetch(`/api/drafts/${id}/handoff`, { cache: 'no-store' });
    const details = await response.json(); if (!response.ok) throw new Error(details.error || '读取失败');
    if (token !== request || !dialog.open) return;
    current = { details, onConfirmed };
    document.getElementById('handoffTitle').textContent = details.title || '未命名笔记';
    const field = (label, key, value) => `<div class="handoff-field"><div><strong>${label}</strong><button type="button" class="button link-button" data-handoff-copy="handoff-${key}" ${value ? '' : 'disabled'}>复制</button></div><textarea id="handoff-${key}" readonly rows="${key === 'description' ? 2 : 1}" aria-label="${label}">${escapeHtml(value)}</textarea></div>`;
    document.getElementById('handoffBody').innerHTML = `<p class="form-hint">笔记 #${details.postId} · ${details.photos.length} 张照片 · 按以下顺序上传</p><div class="handoff-photos">${details.photos.map(photo => `<figure><img loading="lazy" src="${escapeHtml(photo.thumbnail)}" alt="第 ${photo.position} 张照片"><figcaption>${escapeHtml(photo.filename)}</figcaption></figure>`).join('')}</div><div class="handoff-fields">${field('标题（可留空）', 'title', details.title)}${field('文案', 'description', details.description)}${field('话题关键词', 'topics', details.topics.map(t => `#${t}`).join(' '))}${field('地点关键词', 'location', details.location || details.suggestedLocation)}</div><p class="form-hint">建议地点：${escapeHtml(details.suggestedLocation || '无')}。话题和地点需要在小红书网页搜索并点选真实候选，复制关键词不代表已设置。</p>`;
    document.getElementById('downloadHandoff').disabled = false;
    document.querySelectorAll('[data-handoff-result]').forEach(b => { b.disabled = details.status === 'draft_saved' && Boolean(details.manualConfirmedAt) && b.dataset.handoffResult === 'draft_saved'; });
  } catch (error) { document.getElementById('handoffBody').textContent = `读取失败：${error.message}`; }
}
