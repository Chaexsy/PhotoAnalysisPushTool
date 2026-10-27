const dialog = document.getElementById('xhsReviewDialog');
const frame = document.getElementById('xhsReviewFrame');
const status = document.getElementById('xhsReviewStatus');
let token = null, timer = null, imageUrl = null, opening = false, busy = false, version = 0;
let inputSequence = Promise.resolve();

async function request(path, options = {}) {
  const response = await fetch(`/api/xhs/review/${path}`, { ...options, cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-Xhs-Review': token || '', ...options.headers } });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || '小红书草稿窗口连接失败');
  return path === 'frame' ? response.blob() : response.json();
}
async function refreshFrame() {
  if (!token || !dialog.open) return;
  const currentToken = token;
  try {
    const blob = await request('frame');
    if (currentToken !== token || !dialog.open) return;
    const nextUrl = URL.createObjectURL(blob);
    frame.src = nextUrl; frame.hidden = false;
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    imageUrl = nextUrl;
    status.textContent = '已打开原草稿，实时连接中 · 10 分钟无操作将关闭连接';
  } catch (error) { status.textContent = error.message; clearTimeout(timer); timer = null; return; }
  clearTimeout(timer); timer = setTimeout(refreshFrame, 1200);
}
export async function openXhsDraft(postId) {
  if (opening || token) return;
  opening = true; const current = ++version;
  frame.hidden = true; status.textContent = '正在打开 NAS 浏览器中的原草稿，请稍候…'; dialog.showModal();
  try {
    const session = await request('start', { method: 'POST', body: JSON.stringify({ postId }) });
    if (!dialog.open || version !== current) {
      await request('close', { method: 'POST', headers: { 'X-Xhs-Review': session.token } }); return;
    }
    token = session.token;
    await refreshFrame();
  } catch (error) { if (version === current) status.textContent = error.message; }
  finally { opening = false; }
}
function sendInput(input) {
  if (!token || frame.hidden) return Promise.resolve(false);
  const currentToken = token;
  const operation = inputSequence.then(async () => {
    if (currentToken !== token) return false;
    busy = true; clearTimeout(timer);
    try { await request('input', { method: 'POST', body: JSON.stringify(input) }); return true; }
    catch (error) { status.textContent = error.message; return false; }
    finally { busy = false; }
  });
  inputSequence = operation.then(() => undefined, () => undefined);
  void operation.then(() => { if (currentToken === token) void refreshFrame(); });
  return operation;
}
function coordinates(event) {
  const box = frame.getBoundingClientRect();
  return { x: Math.min(1439, Math.max(0, (event.clientX - box.left) / box.width * 1440)), y: Math.min(999, Math.max(0, (event.clientY - box.top) / box.height * 1000)) };
}
frame.addEventListener('click', event => { frame.focus({ preventScroll: true }); void sendInput({ kind: 'click', ...coordinates(event) }); });
frame.addEventListener('wheel', event => { event.preventDefault(); void sendInput({ kind: 'scroll', ...coordinates(event), deltaY: Math.max(-1000, Math.min(1000, event.deltaY * (event.deltaMode === 1 ? 20 : 1))) }); }, { passive: false });
frame.addEventListener('keydown', event => {
  const allowed = ['Enter', 'Backspace', 'Delete', 'Tab', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
  if ((event.ctrlKey || event.metaKey) && ['a', 'z'].includes(event.key.toLowerCase())) { event.preventDefault(); void sendInput({ kind: 'key', key: `Control+${event.key.toUpperCase()}` }); }
  else if (allowed.includes(event.key) && event.key !== 'Escape') { event.preventDefault(); void sendInput({ kind: 'key', key: event.shiftKey && event.key === 'Tab' ? 'Shift+Tab' : event.key }); }
  else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.isComposing) { event.preventDefault(); void sendInput({ kind: 'text', text: event.key }); }
});
document.getElementById('xhsReviewTextForm').addEventListener('submit', async event => {
  event.preventDefault(); const input = document.getElementById('xhsReviewText');
  if (!input.value || busy || !token) return;
  const text = input.value;
  if (await sendInput({ kind: 'text', text })) { input.value = ''; frame.focus({ preventScroll: true }); }
});
document.getElementById('xhsReviewRefresh').addEventListener('click', () => void refreshFrame());
function closeConnection() {
  version++; clearTimeout(timer); timer = null;
  if (token) void request('close', { method: 'POST', keepalive: true }).catch(() => {});
  token = null; frame.hidden = true;
  if (imageUrl) URL.revokeObjectURL(imageUrl);
  imageUrl = null; frame.removeAttribute('src');
}
dialog.addEventListener('close', closeConnection);
window.addEventListener('pagehide', closeConnection);
