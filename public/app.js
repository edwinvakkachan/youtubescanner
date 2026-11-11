'use strict';
const $ = s => document.querySelector(s);
const state = { view: 'overview', page: 1, limit: 25, sourceType: 'channel', timer: null };
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
async function api(url, options = {}) {
  const response = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  let body; try { body = await response.json(); } catch { body = {}; }
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}
function toast(message, error = false) { const el = $('#notice'); el.textContent = message; el.className = `notice${error ? ' error' : ''}`; el.hidden = false; clearTimeout(state.timer); state.timer = setTimeout(() => { el.hidden = true; }, 4500); }
function badge(value) { return `<span class="badge ${escapeHtml(value)}">${escapeHtml(value)}</span>`; }
function videoRows(items, actions = 'approval') {
  if (!items.length) return '<div class="empty"><strong>Nothing to show yet</strong>Videos that match this view will appear here.</div>';
  return `<div class="tablewrap"><table><thead><tr><th>Video</th><th>Priority</th><th>Approval</th><th>Import status</th><th>Discovered</th><th>Actions</th></tr></thead><tbody>${items.map(v => `<tr><td><div class="videocell"><img class="thumb" src="${escapeHtml(v.thumbnail || '')}" onerror="this.style.visibility='hidden'" alt=""><div><a class="title" href="${escapeHtml(v.url)}" target="_blank" rel="noopener">${escapeHtml(v.title || v.youtubeId)}</a><div class="sub">${escapeHtml(v.youtubeId)} · ${v.duration ? `${Math.floor(v.duration / 60)} min` : 'duration n/a'}</div></div></div></td><td>${badge(v.priority)}</td><td>${badge(v.approvalStatus)}</td><td>${badge(v.status)}${v.lastError ? `<div class="sub" title="${escapeHtml(v.lastError)}">${escapeHtml(v.lastError.slice(0, 48))}</div>` : ''}</td><td>${v.discoveredAt ? new Date(v.discoveredAt).toLocaleDateString() : '—'}</td><td><div class="actions">${actions === 'approval' && v.approvalStatus === 'PENDING' ? `<button class="smallbtn" data-act="approve" data-id="${v._id}">Approve</button><button class="smallbtn" data-act="reject" data-id="${v._id}">Reject</button>` : ''}${actions === 'failed' && v.status === 'FAILED' ? `<button class="smallbtn" data-act="retry" data-id="${v._id}">Retry</button><button class="smallbtn" data-act="reset" data-id="${v._id}">Reset</button>` : ''}</div></td></tr>`).join('')}</tbody></table></div>`;
}
function paging(data) { return `<div class="pagination"><span>${data.total} videos · page ${data.page} of ${Math.max(1, Math.ceil(data.total / data.limit))}</span><button class="smallbtn" data-page="${data.page - 1}" ${data.page <= 1 ? 'disabled' : ''}>Previous</button><button class="smallbtn" data-page="${data.page + 1}" ${data.page >= Math.ceil(data.total / data.limit) ? 'disabled' : ''}>Next</button></div>`; }
async function stats() {
  const d = await api('/api/stats');
  const cards = [['Configured sources', d.sources, 'Across all source types'], ['Videos discovered', d.total, 'Unique YouTube IDs'], ['Pending approval', d.pendingApproval, 'Awaiting a decision'], ['Approved videos', d.approved, 'Ready for importer'], ['Pending imports', d.pendingImports, 'Approved and waiting'], ['Processed / failed', `${d.processed} / ${d.failed}`, 'Completed / needs retry']];
  $('#stats').innerHTML = cards.map(([name, num, note]) => `<div class="stat"><div class="label">${name}</div><strong>${num}</strong><span>${note}</span></div>`).join('');
}
function shell(title, subtitle, right = '') { $('#heading').textContent = title; $('#crumb').textContent = `WORKSPACE / ${title.toUpperCase()}`; return `<div class="panel"><div class="panelhead"><div><h2>${title}</h2><p>${subtitle}</p></div>${right}</div>`; }
async function renderOverview() {
  const [latest, history, settings] = await Promise.all([
    api('/api/queue?limit=8&page=1'), api('/api/scan-history?limit=5&page=1'), api('/api/settings/scan')
  ]);
  const nextScan = settings.nextScanAt ? new Date(settings.nextScanAt).toLocaleString() : 'Automatic scanning is paused';
  const schedulePanel = `<div class="panel"><div class="panelhead"><div><h2>Automatic scanning</h2><p>Scans all enabled sources using the saved interval</p></div>${badge(settings.autoScanEnabled ? 'ENABLED' : 'DISABLED')}</div><form id="scanSettingsForm" class="toolbar"><label class="schedule-enable"><input name="autoScanEnabled" type="checkbox" ${settings.autoScanEnabled ? 'checked' : ''}> Enable automatic scans</label><label class="schedule-interval">Scan interval (minutes)<input name="scanIntervalMinutes" type="number" min="1" max="10080" value="${settings.scanIntervalMinutes}" required></label><button class="button primary">Save schedule</button></form><p class="sub schedule-next">Next scan: ${escapeHtml(nextScan)} · Default interval: 360 minutes. Allowed interval: 1–10080 minutes.</p></div>`;
  $('#content').innerHTML = `${schedulePanel}${shell('Recent discoveries', 'Latest videos added to the unique discovery queue', '<button class="button" data-goto="queue">View import queue</button>')}${videoRows(latest.items, 'none')}</div><div class="panel"><div class="panelhead"><div><h2>Recent scans</h2><p>Latest source scan activity</p></div><button class="button" data-goto="history">All scan history</button></div>${history.items.length ? `<div class="tablewrap"><table><thead><tr><th>Source</th><th>Status</th><th>Inspected</th><th>Matched</th><th>Errors</th><th>Started</th></tr></thead><tbody>${history.items.map(x => `<tr><td><b>${escapeHtml(x.sourceName)}</b><div class="sub">${escapeHtml(x.sourceType)}</div></td><td>${badge(x.status)}</td><td>${x.inspected}</td><td>${x.matched}</td><td>${x.errorCount ?? x.errors ?? 0}</td><td>${x.startedAt ? new Date(x.startedAt).toLocaleString() : '—'}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No scans have run.</div>'}</div>`;
}
async function renderSources() {
  const sources = await api('/api/sources');
  const tabs = `<div class="toolbar">${['channel', 'playlist', 'shorts'].map(t => `<button class="smallbtn ${state.sourceType === t ? 'active' : ''}" data-type="${t}">${t[0].toUpperCase() + t.slice(1)} (${sources.filter(s => s.type === t).length})</button>`).join('')}<button class="button primary" id="addSource">+ Add source</button></div>`;
  const shown = sources.filter(s => s.type === state.sourceType);
  const cards = shown.length ? `<div class="source-grid">${shown.map(s => `<article class="source-card"><div class="source-title"><div><h3>${escapeHtml(s.name)}</h3><div class="source-url" title="${escapeHtml(s.url)}">${escapeHtml(s.url)}</div></div>${badge(s.enabled ? 'ENABLED' : 'DISABLED')}</div><div class="tagrow">${badge(s.priority)}<span class="tag">${escapeHtml(s.matchMode)} match</span>${(s.keywords || []).map(k => `<span class="tag">${escapeHtml(k)}</span>`).join('')}${(s.excludeKeywords || []).map(k => `<span class="tag">− ${escapeHtml(k)}</span>`).join('')}</div><div class="cardfoot"><small>Last scan: ${s.lastScannedAt ? new Date(s.lastScannedAt).toLocaleString() : 'Never scanned'}</small><div class="actions"><button class="smallbtn" data-act="scan-source" data-id="${s._id}">Scan</button><button class="smallbtn" data-act="edit-source" data-id="${s._id}">Edit</button><button class="smallbtn" data-act="toggle-source" data-id="${s._id}">${s.enabled ? 'Disable' : 'Enable'}</button><button class="smallbtn" data-act="delete-source" data-id="${s._id}">Delete</button></div></div></article>`).join('')}</div>` : '<div class="empty"><strong>No sources configured</strong>Add a YouTube channel, playlist, or Shorts source to start discovering videos.</div>';
  $('#content').innerHTML = `${shell('Manage sources', 'Configure YouTube sources and their discovery rules', tabs)}${cards}</div>`;
}
const views = {
  approval: ['Pending Approval', 'Review matches before the importer can retrieve them', { approvalStatus: 'PENDING' }],
  approved: ['Approved Videos', 'Videos marked ready for the independent importer', { approvalStatus: 'APPROVED' }],
  queue: ['Import Queue', 'Approved videos are ordered by source priority, then discovery time', { status: 'PENDING' }],
  failed: ['Failed Videos', 'Retry eligible failures after checking the latest error', { status: 'FAILED' }]
};
async function renderQueue(view) {
  const [title, subtitle, filters] = views[view];
  const qs = new URLSearchParams({ page: String(state.page), limit: String(state.limit), ...filters });
  const data = await api(`/api/queue?${qs}`);
  const action = view === 'failed' ? 'failed' : (view === 'approval' ? 'approval' : 'none');
  const bulk = view === 'approval' ? '<button class="button" id="bulkApprove">Approve all on this page</button>' : '';
  $('#content').innerHTML = `${shell(title, subtitle, bulk)}${videoRows(data.items, action)}${paging(data)}</div>`;
}
async function renderKeywords() {
  const sources = await api('/api/sources');
  $('#content').innerHTML = `${shell('Keyword management', 'Edit include and exclusion words per source', '<select id="keywordSource"><option value="">Choose a source</option>' + sources.map(s => `<option value="${s._id}">${escapeHtml(s.name)} · ${s.type}</option>`).join('') + '</select>')}<div id="keywordEditor" class="empty">Select a source to edit its keyword rules.</div></div>`;
}
async function renderHistory() {
  const d = await api(`/api/scan-history?page=${state.page}&limit=${state.limit}`);
  const body = d.items.length ? `<div class="tablewrap"><table><thead><tr><th>Source</th><th>Status</th><th>Started</th><th>Completed</th><th>Inspected</th><th>Matched</th><th>Rejected</th><th>Errors</th></tr></thead><tbody>${d.items.map(x => `<tr><td><b>${escapeHtml(x.sourceName)}</b><div class="sub">${escapeHtml(x.sourceType)}</div></td><td>${badge(x.status)}</td><td>${x.startedAt ? new Date(x.startedAt).toLocaleString() : '—'}</td><td>${x.completedAt ? new Date(x.completedAt).toLocaleString() : '—'}</td><td>${x.inspected}</td><td>${x.matched}</td><td>${x.rejected}</td><td>${x.errorCount ?? x.errors ?? 0}${x.errorDetails?.length ? `<div class="sub historydetails" title="${escapeHtml(x.errorDetails.join('\n'))}">${escapeHtml(x.errorDetails[0])}</div>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No scans have run.</div>';
  $('#content').innerHTML = `${shell('Scan history', 'Recorded source scans and extraction errors')}${body}${paging(d)}</div>`;
}
async function render() {
  state.page = Math.max(1, state.page);
  $('#nav').querySelectorAll('.navitem').forEach(b => b.classList.toggle('active', b.dataset.view === state.view));
  await stats();
  if (state.view === 'overview') return renderOverview();
  if (state.view === 'sources') return renderSources();
  if (state.view === 'keywords') return renderKeywords();
  if (state.view === 'history') return renderHistory();
  return renderQueue(state.view);
}
function showSource(source = null) {
  const form = $('#sourceForm'); form.reset(); form.elements.id.value = source?._id || ''; $('#formTitle').textContent = source ? 'Edit source' : 'Add a source';
  form.elements.enabled.checked = source?.enabled ?? true;
  for (const key of ['name', 'url', 'type', 'priority', 'matchMode']) if (source && source[key] !== undefined) form.elements[key].value = source[key];
  form.elements.keywords.value = (source?.keywords || []).join(', '); form.elements.excludeKeywords.value = (source?.excludeKeywords || []).join(', '); $('#sourceDialog').showModal();
}
function splitWords(s) { return s.split(',').map(x => x.trim()).filter(Boolean); }
async function fillKeywords(source) {
  const box = $('#keywordEditor'); box.className = ''; box.innerHTML = `<div class="formgrid"><label>Include keywords<small> (comma separated)</small><textarea id="kwIncludes" rows="4">${escapeHtml((source.keywords || []).join(', '))}</textarea></label><label>Exclude keywords<small> (always take priority)</small><textarea id="kwExcludes" rows="4">${escapeHtml((source.excludeKeywords || []).join(', '))}</textarea></label><label>Match mode<select id="kwMode"><option ${source.matchMode === 'ANY' ? 'selected' : ''}>ANY</option><option ${source.matchMode === 'ALL' ? 'selected' : ''}>ALL</option></select></label><div class="actions"><button class="button" id="clearKeywords">Delete all keywords</button><button class="button primary" id="saveKeywords">Save keyword rules</button></div></div>`;
  $('#saveKeywords').onclick = async () => { await api(`/api/sources/${source._id}`, { method: 'PUT', body: JSON.stringify({ keywords: splitWords($('#kwIncludes').value), excludeKeywords: splitWords($('#kwExcludes').value), matchMode: $('#kwMode').value }) }); toast('Keyword rules saved'); await render(); };
  $('#clearKeywords').onclick = async () => { await api(`/api/sources/${source._id}`, { method: 'PUT', body: JSON.stringify({ keywords: [], excludeKeywords: [] }) }); toast('All keywords cleared'); await render(); };
}
$('#nav').addEventListener('click', e => { const b = e.target.closest('[data-view]'); if (!b) return; state.view = b.dataset.view; state.page = 1; render().catch(err => toast(err.message, true)); });
$('#content').addEventListener('click', async e => {
  const goto = e.target.closest('[data-goto]'); if (goto) { state.view = goto.dataset.goto; state.page = 1; return render().catch(err => toast(err.message, true)); }
  const type = e.target.closest('[data-type]'); if (type) { state.sourceType = type.dataset.type; return render().catch(err => toast(err.message, true)); }
  const page = e.target.closest('[data-page]'); if (page) { state.page = Number(page.dataset.page); return render().catch(err => toast(err.message, true)); }
  if (e.target.id === 'addSource') return showSource();
  if (e.target.id === 'bulkApprove') { const items = await api('/api/queue?approvalStatus=PENDING&page=1&limit=100'); if (!items.items.length) return toast('No pending approvals'); await api('/api/queue/bulk-approve', { method: 'POST', body: JSON.stringify({ ids: items.items.map(x => x._id) }) }); toast(`Approved ${items.items.length} videos`); return render(); }
  const btn = e.target.closest('[data-act]'); if (!btn) return;
  try {
    const id = btn.dataset.id;
    if (btn.dataset.act === 'approve' || btn.dataset.act === 'reject') { await api(`/api/queue/${id}/${btn.dataset.act}`, { method: 'POST' }); toast(`Video ${btn.dataset.act}d`); }
    if (btn.dataset.act === 'retry') { await api(`/api/queue/${id}/retry`, { method: 'POST' }); toast('Video returned to pending imports'); }
    if (btn.dataset.act === 'reset' && confirm('Reset this video and clear its retry count?')) { await api(`/api/queue/${id}/reset`, { method: 'POST' }); toast('Video reset for a fresh attempt'); }
    if (btn.dataset.act === 'edit-source') { const sources = await api('/api/sources'); return showSource(sources.find(s => s._id === id)); }
    if (btn.dataset.act === 'toggle-source') { const sources = await api('/api/sources'); const s = sources.find(x => x._id === id); await api(`/api/sources/${id}`, { method: 'PUT', body: JSON.stringify({ enabled: !s.enabled }) }); toast('Source updated'); }
    if (btn.dataset.act === 'delete-source' && confirm('Delete this source? Existing queue records and scan history will be preserved.')) { await api(`/api/sources/${id}`, { method: 'DELETE' }); toast('Source deleted'); }
    if (btn.dataset.act === 'scan-source') { btn.disabled = true; btn.textContent = 'Scanning…'; const r = await api(`/api/scan/${id}`, { method: 'POST' }); toast(`Scan complete: ${r.matched} matches, ${r.errors} errors`); }
    await render();
  } catch (err) { toast(err.message, true); }
});
$('#content').addEventListener('change', async e => { if (e.target.id === 'keywordSource') { try { const sources = await api('/api/sources'); const source = sources.find(s => s._id === e.target.value); if (source) await fillKeywords(source); } catch (err) { toast(err.message, true); } } });
$('#sourceForm').addEventListener('submit', async e => { e.preventDefault(); const f = e.currentTarget; const body = { name: f.elements.name.value.trim(), url: f.elements.url.value.trim(), type: f.elements.type.value, priority: f.elements.priority.value, matchMode: f.elements.matchMode.value, enabled: f.elements.enabled.checked, keywords: splitWords(f.elements.keywords.value), excludeKeywords: splitWords(f.elements.excludeKeywords.value) }; try { const id = f.elements.id.value; await api(id ? `/api/sources/${id}` : '/api/sources', { method: id ? 'PUT' : 'POST', body: JSON.stringify(body) }); $('#sourceDialog').close(); toast(id ? 'Source updated' : 'Source added'); await render(); } catch (err) { toast(err.message, true); } });
$('#content').addEventListener('submit', async e => {
  if (e.target.id !== 'scanSettingsForm') return;
  e.preventDefault();
  const form = e.target;
  try {
    const updated = await api('/api/settings/scan', { method: 'PUT', body: JSON.stringify({ autoScanEnabled: form.elements.autoScanEnabled.checked, scanIntervalMinutes: Number(form.elements.scanIntervalMinutes.value) }) });
    toast(updated.autoScanEnabled ? `Automatic scan interval saved: every ${updated.scanIntervalMinutes} minutes` : 'Automatic scanning paused');
    await render();
  } catch (err) { toast(err.message, true); }
});
$('#closeDialog').onclick = $('#cancelDialog').onclick = () => $('#sourceDialog').close();
$('#scanAll').onclick = async () => { try { await api('/api/scan', { method: 'POST' }); toast('Full scan started. Results appear in Scan History.'); } catch (err) { toast(err.message, true); } };
render().catch(err => toast(`Dashboard could not load: ${err.message}`, true));
