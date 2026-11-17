'use strict';
const $ = s => document.querySelector(s);
const state = { view: 'overview', page: 1, limit: 25, sourceType: 'channel', sourceSearch: '', sourceSearchRegex: false, approvalChannelId: '', timer: null, sorts: {} };
let visualPreviewUrls = [];
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
function applyTheme(theme, persist = true) {
  const selected = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = selected;
  const button = $('#themeToggle');
  if (button) {
    button.textContent = selected === 'dark' ? '☀ Light mode' : '☾ Dark mode';
    button.setAttribute('aria-label', `Switch to ${selected === 'dark' ? 'light' : 'dark'} mode`);
  }
  if (persist) { try { localStorage.setItem('tube-scout-theme', selected); } catch {} }
}
async function api(url, options = {}) {
  const response = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  let body; try { body = await response.json(); } catch { body = {}; }
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}
function toast(message, error = false) { const el = $('#notice'); el.textContent = message; el.className = `notice${error ? ' error' : ''}`; el.hidden = false; clearTimeout(state.timer); state.timer = setTimeout(() => { el.hidden = true; }, 4500); }
function badge(value) { return `<span class="badge ${escapeHtml(value)}">${escapeHtml(value)}</span>`; }
function compileSourceSearchRegex(pattern) {
  if (pattern.length > 256) throw new Error('Regex search is limited to 256 characters');
  if (/\\[1-9]|\([^)]*\)[*+{]/.test(pattern)) throw new Error('Backreferences and repeated groups are not supported in source search');
  const quantifiers = pattern.match(/(?<!\\)[*+]|(?<!\\)\{\d+(?:,\d*)?\}/g) || [];
  if (quantifiers.length > 8 || quantifiers.filter(q => q === '*' || q === '+').length > 3 || quantifiers.some(q => { const n = q.match(/\d+/); return n && Number(n[0]) > 1000; })) throw new Error('Use at most 8 simple regex quantifiers, including 3 unbounded repetitions (counts up to 1000)');
  return new RegExp(pattern.normalize('NFC'), 'iu');
}
function applySourceSearch() {
  const query = state.sourceSearch.trim();
  let matcher = null; let errorMessage = '';
  if (query && state.sourceSearchRegex) {
    try { matcher = compileSourceSearchRegex(query); }
    catch (err) { errorMessage = err.message; }
  }
  const error = $('#sourceSearchError');
  if (error) { error.textContent = errorMessage; error.hidden = !errorMessage; }
  let visible = 0;
  $('#content').querySelectorAll('.source-card').forEach(card => {
    const name = card.dataset.sourceName || '';
    const url = card.dataset.sourceUrl || '';
    const haystack = `${name} ${url}`;
    const matches = !query || (state.sourceSearchRegex ? (matcher ? matcher.test(haystack) : true) : haystack.includes(query.normalize('NFC').toLocaleLowerCase()));
    card.hidden = !matches;
    if (!card.hidden) visible++;
  });
  const empty = $('#sourceSearchEmpty');
  if (empty) empty.hidden = visible > 0 || Boolean(errorMessage);
}
function renderVisualReferences(saved = [], selectedFiles = []) {
  visualPreviewUrls.forEach(url => URL.revokeObjectURL(url));
  visualPreviewUrls = [];
  const gallery = $('#visualReferenceGallery');
  if (!gallery) return;
  const savedCards = saved.map((ref, index) => `<div class="visual-reference-card"><img src="${escapeHtml(ref.url)}" alt="Reference image ${index + 1}">${ref._id ? `<button type="button" class="visual-reference-remove" data-reference-id="${escapeHtml(ref._id)}" aria-label="Remove reference image ${index + 1}">×</button>` : ''}</div>`);
  const selectedCards = selectedFiles.map((file, index) => {
    const url = URL.createObjectURL(file); visualPreviewUrls.push(url);
    return `<div class="visual-reference-card visual-reference-pending"><img src="${url}" alt="Selected reference ${index + 1}"><span>${escapeHtml(file.name)}</span></div>`;
  });
  gallery.innerHTML = [...savedCards, ...selectedCards].join('');
  const total = saved.length + selectedFiles.length;
  $('#visualReferenceStatus').textContent = total ? `${saved.length} saved reference${saved.length === 1 ? '' : 's'}${selectedFiles.length ? ` · ${selectedFiles.length} selected to upload` : ''}` : 'No reference images uploaded';
  $('#removeVisualReference').hidden = saved.length === 0;
}
function uniqueChannelSources(video) {
  const seen = new Set();
  return (video.discoveredSources || []).filter(source => source.type === 'channel').filter(source => {
    const key = String(source.name || source.sourceId || '').trim().toLocaleLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function videoRows(items, actions = 'approval') {
  if (!items.length) return '<div class="empty"><strong>Nothing to show yet</strong>Videos that match this view will appear here.</div>';
  const showChannels = actions === 'approval';
  return `<div class="tablewrap"><table><thead><tr><th>Video</th>${showChannels ? '<th>Channel</th>' : ''}<th>Priority</th><th>Approval</th><th>Import status</th><th>Discovered</th><th>Actions</th></tr></thead><tbody>${items.map(v => `<tr><td><div class="videocell"><img class="thumb" src="${escapeHtml(v.thumbnail || '')}" onerror="this.style.visibility='hidden'" alt=""><div><a class="title" href="${escapeHtml(v.url)}" target="_blank" rel="noopener">${escapeHtml(v.title || v.youtubeId)}</a><div class="sub">${escapeHtml(v.youtubeId)} · ${v.duration ? `${Math.floor(v.duration / 60)} min` : 'duration n/a'}</div></div></div></td>${showChannels ? `<td>${uniqueChannelSources(v).map(source => source.sourceId ? `<button class="source-link" type="button" data-act="edit-source" data-id="${escapeHtml(source.sourceId)}" title="Edit ${escapeHtml(source.name)}">${escapeHtml(source.name)}</button>` : `<span>${escapeHtml(source.name)}</span>`).join('<br>') || '—'}</td>` : ''}<td>${badge(v.priority)}</td><td>${badge(v.approvalStatus)}</td><td>${badge(v.status)}${v.status === 'SENT' && v.approvalStatus !== 'APPROVED' ? '<div class="sub">Already sent before approval; remove manually from TubeArchivist.</div>' : ''}${v.lastError ? `<div class="sub" title="${escapeHtml(v.lastError)}">${escapeHtml(v.lastError.slice(0, 48))}</div>` : ''}</td><td>${v.discoveredAt ? new Date(v.discoveredAt).toLocaleDateString() : '—'}</td><td><div class="actions">${actions === 'approval' && v.approvalStatus === 'PENDING' && ['PENDING', 'AWAITING_APPROVAL'].includes(v.status) ? `<button class="smallbtn" data-act="approve" data-id="${v._id}">Approve</button><button class="smallbtn" data-act="reject" data-id="${v._id}">Reject</button>` : ''}${actions === 'failed' && v.status === 'FAILED' ? `<button class="smallbtn" data-act="retry" data-id="${v._id}">Retry</button><button class="smallbtn" data-act="reset" data-id="${v._id}">Reset</button>` : ''}</div></td></tr>`).join('')}</tbody></table></div>`;
}
function paging(data) { return `<div class="pagination"><span>${data.total} videos · page ${data.page} of ${Math.max(1, Math.ceil(data.total / data.limit))}</span><button class="smallbtn" data-page="${data.page - 1}" ${data.page <= 1 ? 'disabled' : ''}>Previous</button><button class="smallbtn" data-page="${data.page + 1}" ${data.page >= Math.ceil(data.total / data.limit) ? 'disabled' : ''}>Next</button></div>`; }
const queueSorts = [['discoveredAt:desc','Newest discovered'],['discoveredAt:asc','Oldest discovered'],['title:asc','Title A–Z'],['title:desc','Title Z–A'],['priorityRank:asc','Priority: high first'],['duration:desc','Duration: longest first'],['duration:asc','Duration: shortest first'],['status:asc','Import status A–Z']];
const historySorts = [['startedAt:desc','Newest scan'],['startedAt:asc','Oldest scan'],['sourceName:asc','Source A–Z'],['sourceName:desc','Source Z–A'],['matched:desc','Most matches'],['matched:asc','Fewest matches'],['errors:desc','Most errors'],['errors:asc','Fewest errors']];
function sortControl(options, fallback) { const selected = state.sorts[state.view] || fallback; return `<label class="sort-control">Sort by <select data-sort>${options.map(([value,label]) => `<option value="${value}" ${value === selected ? 'selected' : ''}>${label}</option>`).join('')}</select></label>`; }
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
  const tabs = `<div class="toolbar"><label class="source-search">Search sources<input id="sourceSearch" type="search" placeholder="Channel/source name or regex" value="${escapeHtml(state.sourceSearch)}"></label><label class="source-regex-toggle"><input id="sourceSearchRegex" type="checkbox" ${state.sourceSearchRegex ? 'checked' : ''}> Regex</label>${['channel', 'playlist', 'shorts'].map(t => `<button class="smallbtn ${state.sourceType === t ? 'active' : ''}" data-type="${t}">${t[0].toUpperCase() + t.slice(1)} (${sources.filter(s => s.type === t).length})</button>`).join('')}<button class="button primary" id="addSource">+ Add source</button></div><p class="sub regex-search-error" id="sourceSearchError" hidden></p>`;
  const shown = sources.filter(s => s.type === state.sourceType);
  const cards = shown.length ? `<div class="source-grid">${shown.map(s => `<article class="source-card" data-source-name="${escapeHtml(s.name.normalize('NFC').toLocaleLowerCase())}" data-source-url="${escapeHtml(s.url.normalize('NFC').toLocaleLowerCase())}"><div class="source-title"><div><h3>${escapeHtml(s.name)}</h3><div class="source-url" title="${escapeHtml(s.url)}">${escapeHtml(s.url)}</div></div>${badge(s.enabled ? 'ENABLED' : 'DISABLED')}</div><div class="tagrow">${badge(s.priority)}<span class="tag">${escapeHtml(s.matchMode)} match</span><span class="tag">${s.videosPerScan || 50} videos/scan</span>${s.adaptiveDiscoveryEnabled ? '<span class="tag">Adaptive Top 10</span>' : ''}<span class="tag">Description ${s.scanDescription === false && !s.generateNfo ? 'off' : 'on'}</span>${s.generateNfo ? '<span class="tag">NFO enabled</span>' : ''}${s.thumbnailGeminiEnabled ? '<span class="tag">Gemini thumbnail analysis enabled</span>' : ''}${(s.keywords || []).map(k => `<span class="tag">${escapeHtml(k)}</span>`).join('')}${(s.excludeKeywords || []).map(k => `<span class="tag">− ${escapeHtml(k)}</span>`).join('')}</div><div class="cardfoot"><small>Last scan: ${s.lastScannedAt ? new Date(s.lastScannedAt).toLocaleString() : 'Never scanned'}</small><div class="actions"><button class="smallbtn" data-act="scan-source" data-id="${s._id}">Scan</button>${s.adaptiveDiscoveryEnabled ? `<button class="smallbtn" data-act="adaptive-rankings" data-id="${s._id}">Top 10</button>` : ''}<button class="smallbtn" data-act="toggle-gemini" data-id="${s._id}">${s.thumbnailGeminiEnabled ? 'Disable Gemini' : 'Enable Gemini'}</button><button class="smallbtn" data-act="edit-source" data-id="${s._id}">Edit</button><button class="smallbtn" data-act="toggle-source" data-id="${s._id}">${s.enabled ? 'Disable' : 'Enable'}</button><button class="smallbtn" data-act="delete-source" data-id="${s._id}">Delete</button></div></div></article>`).join('')}</div><div id="sourceSearchEmpty" class="empty" hidden><strong>No matching sources</strong>Try another source name.</div>` : '<div class="empty"><strong>No sources configured</strong>Add a YouTube channel, playlist, or Shorts source to start discovering videos.</div>';
  $('#content').innerHTML = `${shell('Manage sources', 'Configure YouTube sources and their discovery rules', tabs)}${cards}</div>`;
}
function adaptiveRankingTable(title, rows) {
  if (!rows.length) return `<div class="panel"><h2>${title}</h2><div class="empty">No ranked videos yet. Run a source scan to populate this list.</div></div>`;
  return `<div class="panel"><div class="panelhead"><h2>${title}</h2></div><div class="tablewrap"><table><thead><tr><th>Rank</th><th>Video</th><th>Views</th><th>Likes</th><th>Comments</th><th>Engagement</th><th>Relative</th><th>Import</th></tr></thead><tbody>${rows.map(item => `<tr><td>${item.rank}</td><td><div class="videocell"><img class="thumb" src="${escapeHtml(item.thumbnail || '')}" alt=""><a class="title" href="${escapeHtml(item.videoUrl || `https://www.youtube.com/watch?v=${item.youtubeId}`)}" target="_blank" rel="noopener">${escapeHtml(item.title || item.youtubeId)}</a></div></td><td>${item.views == null ? '—' : Number(item.views).toLocaleString()}</td><td>${item.likes == null ? '—' : Number(item.likes).toLocaleString()}</td><td>${item.comments == null ? '—' : Number(item.comments).toLocaleString()}</td><td>${item.engagementRate == null ? '—' : `${Number(item.engagementRate).toFixed(2)}%`}</td><td>${item.relativeEngagement == null ? '—' : `${Number(item.relativeEngagement).toFixed(2)}×`}</td><td>${escapeHtml(item.queueStatus || '—')}</td></tr>`).join('')}</tbody></table></div></div>`;
}
async function renderAdaptiveRankings(sourceId) {
  const data = await api(`/api/adaptive/${sourceId}`); const profile = data.profile || {};
  $('#heading').textContent = `${data.source.name} · Top 10`; $('#crumb').textContent = 'WORKSPACE / ADAPTIVE RANKINGS';
  const metric = (label, value) => `<div class="stat"><div class="label">${label}</div><strong>${value}</strong></div>`;
  $('#content').innerHTML = `<div class="panel"><div class="panelhead"><div><h2>Adaptive channel profile</h2><p>Updated ${profile.calculatedAt ? new Date(profile.calculatedAt).toLocaleString() : 'after the first adaptive scan'} · Last scan ${data.source.adaptiveLastRunAt ? new Date(data.source.adaptiveLastRunAt).toLocaleString() : 'not run'}</p></div><button class="button" id="backToSources">Back to sources</button></div><div class="stats">${metric('Candidates', profile.candidateCount ?? 0)}${metric('25th percentile view threshold', profile.minimumViewsThreshold == null ? '—' : Number(profile.minimumViewsThreshold).toLocaleString())}${metric('Median views', profile.medianViews == null ? '—' : Number(profile.medianViews).toLocaleString())}${metric('Median engagement', profile.medianEngagementRate == null ? '—' : `${Number(profile.medianEngagementRate).toFixed(2)}%`)}${metric('Uploads / day · 7d', Number(profile.averageUploadsPerDay7d || 0).toFixed(2))}${metric('Uploads / day · 30d', Number(profile.averageUploadsPerDay30d || 0).toFixed(2))}</div><p class="sub">${profile.thresholdProvisional ? 'View threshold is provisional because fewer than 30 candidates were available.' : 'Engagement ranking uses the channel-specific 25th percentile view threshold.'} New ranked videos enter the existing TubeArchivist import queue.</p></div>${adaptiveRankingTable('Recent Top 10', data.rankings.recent)}${adaptiveRankingTable('Engagement Top 10', data.rankings.engagement)}`;
}
const views = {
  approval: ['Pending Approval', 'Review matches before the importer can retrieve them', { approvalStatus: 'PENDING' }],
  approved: ['Approved Videos', 'Videos marked ready for the independent importer', { approvalStatus: 'APPROVED' }],
  queue: ['Import Queue', 'Approved videos are ordered by source priority, then discovery time', { status: 'PENDING' }],
  failed: ['Failed Videos', 'Retry eligible failures after checking the latest error', { status: 'FAILED' }]
};
async function renderQueue(view) {
  const [title, subtitle, filters] = views[view];
  const channels = view === 'approval' ? (await api('/api/sources')).filter(source => source.type === 'channel') : [];
  const defaultSort = view === 'queue' ? 'priorityRank:asc' : 'discoveredAt:desc';
  const selectedSort = state.sorts[view] || defaultSort;
  const [sort, order] = selectedSort.split(':');
  const qs = new URLSearchParams({ page: String(state.page), limit: String(state.limit), sort, order, ...filters });
  if (view === 'approval' && state.approvalChannelId) qs.set('sourceId', state.approvalChannelId);
  const data = await api(`/api/queue?${qs}`);
  const action = view === 'failed' ? 'failed' : (view === 'approval' ? 'approval' : 'none');
  const bulk = view === 'approval' ? '<button class="button" id="bulkApprove">Approve all on this page</button>' : '';
  const channelFilter = view === 'approval' ? `<label class="source-filter">Channel <select id="approvalChannelFilter"><option value="">All channels</option>${channels.map(source => `<option value="${source._id}" ${source._id === state.approvalChannelId ? 'selected' : ''}>${escapeHtml(source.name)}</option>`).join('')}</select></label>` : '';
  $('#content').innerHTML = `${shell(title, subtitle, `${channelFilter}${sortControl(queueSorts, defaultSort)}${bulk}`)}${videoRows(data.items, action)}${paging(data)}</div>`;
}
async function renderKeywords() {
  const sources = await api('/api/sources');
  $('#content').innerHTML = `${shell('Keyword management', 'Edit include and exclusion words per source', '<select id="keywordSource"><option value="">Choose a source</option>' + sources.map(s => `<option value="${s._id}">${escapeHtml(s.name)} · ${s.type}</option>`).join('') + '</select>')}<div id="keywordEditor" class="empty">Select a source to edit its keyword rules.</div></div>`;
}
async function renderHistory() {
  const selectedSort = state.sorts.history || 'startedAt:desc';
  const [sort, order] = selectedSort.split(':');
  const d = await api(`/api/scan-history?page=${state.page}&limit=${state.limit}&sort=${sort}&order=${order}`);
  const body = d.items.length ? `<div class="tablewrap"><table><thead><tr><th>Source</th><th>Status</th><th>Started</th><th>Completed</th><th>Inspected</th><th>Matched</th><th>Rejected</th><th>Errors</th></tr></thead><tbody>${d.items.map(x => `<tr><td><b>${escapeHtml(x.sourceName)}</b><div class="sub">${escapeHtml(x.sourceType)}</div></td><td>${badge(x.status)}</td><td>${x.startedAt ? new Date(x.startedAt).toLocaleString() : '—'}</td><td>${x.completedAt ? new Date(x.completedAt).toLocaleString() : '—'}</td><td>${x.inspected}</td><td>${x.matched}</td><td>${x.rejected}</td><td>${x.errorCount ?? x.errors ?? 0}${x.errorDetails?.length ? `<div class="sub historydetails" title="${escapeHtml(x.errorDetails.join('\n'))}">${escapeHtml(x.errorDetails[0])}</div>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No scans have run.</div>';
  $('#content').innerHTML = `${shell('Scan history', 'Recorded source scans and extraction errors', sortControl(historySorts, 'startedAt:desc'))}${body}${paging(d)}</div>`;
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
  form.elements.autoApproveVideos.checked = source?.autoApproveVideos ?? false;
  form.elements.videosPerScan.value = source?.videosPerScan || 50;
  form.elements.adaptiveDiscoveryEnabled.checked = source?.adaptiveDiscoveryEnabled ?? false;
  form.elements.generateNfo.checked = source?.generateNfo ?? false;
  form.elements.thumbnailGeminiEnabled.checked = source?.thumbnailGeminiEnabled ?? false;
  form.elements.keywordSearchMode.value = source?.keywordSearchMode ?? 'TEXT';
  form.elements.visualMatchEnabled.checked = source?.visualMatchEnabled ?? false;
  form.elements.visualMatchAutoApprove.checked = source?.visualMatchAutoApprove ?? true;
  form.elements.visualMatchAction.value = source?.visualMatchAction ?? 'ACCEPT';
  const savedReferences = source?.visualReferences?.length ? source.visualReferences : source?.visualReferenceUrl ? [{ url: source.visualReferenceUrl, mimeType: source.visualReferenceMimeType }] : [];
  form.dataset.hasVisualReference = String(savedReferences.length > 0 || Boolean(source?.visualReferenceMimeType));
  form.dataset.visualReferenceCount = String(savedReferences.length);
  form.dataset.savedVisualReferences = JSON.stringify(savedReferences);
  renderVisualReferences(savedReferences);
  if (!savedReferences.length && source?.visualReferenceMimeType) {
    $('#visualReferenceStatus').textContent = 'Legacy reference saved; its thumbnail will appear after ImageKit migration';
    $('#removeVisualReference').hidden = false;
  }
  $('#visualMatchActionField').hidden = !form.elements.visualMatchEnabled.checked;
  $('#visualAutoApproveField').hidden = !form.elements.visualMatchEnabled.checked || form.elements.visualMatchAction.value === 'REJECT';
  form.elements.scanDescription.checked = source?.scanDescription !== false || form.elements.generateNfo.checked;
  for (const key of ['name', 'url', 'type', 'priority', 'matchMode']) if (source && source[key] !== undefined) form.elements[key].value = source[key];
  $('#autoApproveField').hidden = form.elements.type.value !== 'channel';
  $('#adaptiveDiscoveryField').hidden = form.elements.type.value !== 'channel';
  $('#adaptiveDiscoveryHelp').hidden = form.elements.type.value !== 'channel';
  form.dataset.keywordSearchMode = form.elements.keywordSearchMode.value;
  form.elements.keywords.value = formatKeywordEntries(source?.keywords || [], form.elements.keywordSearchMode.value);
  form.elements.excludeKeywords.value = formatKeywordEntries(source?.excludeKeywords || [], form.elements.keywordSearchMode.value);
  updateKeywordSearchHelp(form.elements.keywordSearchMode.value);
  $('#sourceDialog').showModal();
}
$('#sourceForm').elements.visualMatchEnabled.addEventListener('change', e => { $('#visualAutoApproveField').hidden = !e.target.checked || e.currentTarget.form.elements.visualMatchAction.value === 'REJECT'; $('#visualMatchActionField').hidden = !e.target.checked; });
$('#sourceForm').elements.visualMatchAction.addEventListener('change', e => { $('#visualAutoApproveField').hidden = !e.currentTarget.form.elements.visualMatchEnabled.checked || e.target.value === 'REJECT'; });
$('#sourceForm').elements.keywordSearchMode.addEventListener('change', e => {
  const form = e.currentTarget.form; const oldMode = form.dataset.keywordSearchMode || 'TEXT'; const newMode = e.target.value;
  form.elements.keywords.value = formatKeywordEntries(parseKeywordEntries(form.elements.keywords.value, oldMode), newMode);
  form.elements.excludeKeywords.value = formatKeywordEntries(parseKeywordEntries(form.elements.excludeKeywords.value, oldMode), newMode);
  form.dataset.keywordSearchMode = newMode;
  updateKeywordSearchHelp(newMode);
});
$('#sourceForm').elements.visualReferenceFile.addEventListener('change', e => {
  const files = [...e.target.files];
  if (files.length) { e.currentTarget.form.elements.visualMatchEnabled.checked = true; $('#visualAutoApproveField').hidden = e.currentTarget.form.elements.visualMatchAction.value === 'REJECT'; $('#visualMatchActionField').hidden = false; }
  const saved = e.currentTarget.form.dataset.savedVisualReferences ? JSON.parse(e.currentTarget.form.dataset.savedVisualReferences) : [];
  renderVisualReferences(saved, files);
});
$('#visualReferenceGallery').addEventListener('click', async e => {
  const button = e.target.closest('[data-reference-id]'); if (!button) return;
  const form = $('#sourceForm'); const sourceId = form.elements.id.value; const referenceId = button.dataset.referenceId;
  try {
    const result = await api(`/api/sources/${sourceId}/visual-references/${referenceId}`, { method: 'DELETE' });
    form.dataset.savedVisualReferences = JSON.stringify(result.visualReferences || []);
    form.dataset.visualReferenceCount = String(result.visualReferences?.length || 0);
    form.dataset.hasVisualReference = String(Boolean(result.visualReferences?.length));
    if (!result.visualMatchEnabled) form.elements.visualMatchEnabled.checked = false;
    renderVisualReferences(result.visualReferences || [], [...form.elements.visualReferenceFile.files]);
    $('#visualAutoApproveField').hidden = !result.visualMatchEnabled || form.elements.visualMatchAction.value === 'REJECT'; $('#visualMatchActionField').hidden = !result.visualMatchEnabled;
    toast('Reference image removed');
  } catch (err) { toast(err.message, true); }
});
$('#removeVisualReference').addEventListener('click', async () => {
  const form = $('#sourceForm'); const id = form.elements.id.value;
  try {
    if (id && form.dataset.hasVisualReference === 'true') await api(`/api/sources/${id}/visual-reference`, { method: 'DELETE' });
    form.dataset.hasVisualReference = 'false'; form.elements.visualReferenceFile.value = ''; form.elements.visualMatchEnabled.checked = false;
    form.dataset.visualReferenceCount = '0'; form.dataset.savedVisualReferences = '[]';
    renderVisualReferences(); $('#visualMatchActionField').hidden = true; $('#visualAutoApproveField').hidden = true;
    toast('All reference images removed');
  } catch (err) { toast(err.message, true); }
});
$('#sourceForm').elements.type.addEventListener('change', e => { $('#autoApproveField').hidden = e.target.value !== 'channel'; $('#adaptiveDiscoveryField').hidden = e.target.value !== 'channel'; $('#adaptiveDiscoveryHelp').hidden = e.target.value !== 'channel'; });
function splitWords(s) { return s.split(',').map(x => x.trim()).filter(Boolean); }
function parseKeywordEntries(value, mode = 'TEXT') {
  return mode === 'REGEX' ? value.split(/\r?\n/).map(part => part.trim()).filter(Boolean) : splitWords(value);
}
function formatKeywordEntries(entries, mode = 'TEXT') { return entries.join(mode === 'REGEX' ? '\n' : ', '); }
function updateKeywordSearchHelp(mode, element = $('#keywordSearchHelp')) {
  if (element) element.textContent = mode === 'REGEX'
    ? 'Enter one case-insensitive Unicode regex per line. Malayalam text is supported; repeated groups and backreferences are disabled for scan safety.'
    : 'Comma-separated text keywords. Malayalam and other Unicode scripts are supported.';
}
async function fillKeywords(source) {
  let activeMode = source.keywordSearchMode || 'TEXT';
  const box = $('#keywordEditor'); box.className = '';
  box.innerHTML = `<div class="formgrid"><label>Include keywords<small> (one regex per line in regex mode)</small><textarea id="kwIncludes" rows="4">${escapeHtml(formatKeywordEntries(source.keywords || [], activeMode))}</textarea></label><label>Exclude keywords<small> (always take priority)</small><textarea id="kwExcludes" rows="4">${escapeHtml(formatKeywordEntries(source.excludeKeywords || [], activeMode))}</textarea></label><label>Keyword search<select id="kwSearchMode"><option value="TEXT" ${activeMode === 'TEXT' ? 'selected' : ''}>Text keywords</option><option value="REGEX" ${activeMode === 'REGEX' ? 'selected' : ''}>Regular expressions</option></select></label><p class="sub wide" id="kwSearchHelp"></p><label>Match mode<select id="kwMode"><option ${source.matchMode === 'ANY' ? 'selected' : ''}>ANY</option><option ${source.matchMode === 'ALL' ? 'selected' : ''}>ALL</option></select></label><div class="actions"><button class="button" id="clearKeywords">Delete all keywords</button><button class="button primary" id="saveKeywords">Save keyword rules</button></div></div>`;
  updateKeywordSearchHelp(activeMode, $('#kwSearchHelp'));
  $('#kwSearchMode').addEventListener('change', e => {
    const newMode = e.target.value;
    $('#kwIncludes').value = formatKeywordEntries(parseKeywordEntries($('#kwIncludes').value, activeMode), newMode);
    $('#kwExcludes').value = formatKeywordEntries(parseKeywordEntries($('#kwExcludes').value, activeMode), newMode);
    activeMode = newMode;
    updateKeywordSearchHelp(newMode, $('#kwSearchHelp'));
  });
  $('#saveKeywords').onclick = async () => {
    const selectedMode = $('#kwSearchMode').value;
    await api(`/api/sources/${source._id}`, { method: 'PUT', body: JSON.stringify({ keywords: parseKeywordEntries($('#kwIncludes').value, selectedMode), excludeKeywords: parseKeywordEntries($('#kwExcludes').value, selectedMode), matchMode: $('#kwMode').value, keywordSearchMode: selectedMode }) });
    toast('Keyword rules saved'); await render();
  };
  $('#clearKeywords').onclick = async () => {
    await api(`/api/sources/${source._id}`, { method: 'PUT', body: JSON.stringify({ keywords: [], excludeKeywords: [] }) });
    toast('All keywords cleared'); await render();
  };
}$('#nav').addEventListener('click', e => { const b = e.target.closest('[data-view]'); if (!b) return; state.view = b.dataset.view; state.page = 1; render().catch(err => toast(err.message, true)); });
$('#themeToggle').addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
applyTheme(document.documentElement.dataset.theme || 'dark', false);
$('#content').addEventListener('click', async e => {
  const goto = e.target.closest('[data-goto]'); if (goto) { state.view = goto.dataset.goto; state.page = 1; return render().catch(err => toast(err.message, true)); }
  const type = e.target.closest('[data-type]'); if (type) { state.sourceType = type.dataset.type; return render().catch(err => toast(err.message, true)); }
  const page = e.target.closest('[data-page]'); if (page) { state.page = Number(page.dataset.page); return render().catch(err => toast(err.message, true)); }
  if (e.target.id === 'addSource') return showSource();
  if (e.target.id === 'backToSources') { state.view = 'sources'; return render().catch(err => toast(err.message, true)); }
  if (e.target.id === 'bulkApprove') { const params = new URLSearchParams({ approvalStatus: 'PENDING', page: String(state.page), limit: String(state.limit) }); if (state.approvalChannelId) params.set('sourceId', state.approvalChannelId); const items = await api(`/api/queue?${params}`); if (!items.items.length) return toast('No pending approvals'); const result = await api('/api/queue/bulk-approve', { method: 'POST', body: JSON.stringify({ ids: items.items.map(x => x._id) }) }); toast(`Approved ${result.modified} videos`); return render(); }
  const btn = e.target.closest('[data-act]'); if (!btn) return;
  try {
    const id = btn.dataset.id;
    if (btn.dataset.act === 'adaptive-rankings') return await renderAdaptiveRankings(id);
    if (btn.dataset.act === 'approve' || btn.dataset.act === 'reject') { await api(`/api/queue/${id}/${btn.dataset.act}`, { method: 'POST' }); toast(`Video ${btn.dataset.act}d`); }
    if (btn.dataset.act === 'retry') { await api(`/api/queue/${id}/retry`, { method: 'POST' }); toast('Video returned to pending imports'); }
    if (btn.dataset.act === 'reset' && confirm('Reset this video and clear its retry count?')) { await api(`/api/queue/${id}/reset`, { method: 'POST' }); toast('Video reset for a fresh attempt'); }
    if (btn.dataset.act === 'edit-source') { const sources = await api('/api/sources'); const source = sources.find(s => s._id === id); if (!source) return toast('This channel source no longer exists', true); return showSource(source); }
    if (btn.dataset.act === 'toggle-gemini') { const sources = await api('/api/sources'); const s = sources.find(x => x._id === id); await api(`/api/sources/${id}`, { method: 'PUT', body: JSON.stringify({ thumbnailGeminiEnabled: !s.thumbnailGeminiEnabled }) }); toast(`Gemini thumbnail analysis ${s.thumbnailGeminiEnabled ? 'disabled' : 'enabled'}`); }
    if (btn.dataset.act === 'toggle-source') { const sources = await api('/api/sources'); const s = sources.find(x => x._id === id); await api(`/api/sources/${id}`, { method: 'PUT', body: JSON.stringify({ enabled: !s.enabled }) }); toast('Source updated'); }
    if (btn.dataset.act === 'delete-source' && confirm('Delete this source? Existing queue records and scan history will be preserved.')) { await api(`/api/sources/${id}`, { method: 'DELETE' }); toast('Source deleted'); }
    if (btn.dataset.act === 'scan-source') { btn.disabled = true; btn.textContent = 'Scanning…'; const r = await api(`/api/scan/${id}`, { method: 'POST' }); toast(`Scan complete: ${r.matched} matches, ${r.errors} errors`); }
    await render();
  } catch (err) { toast(err.message, true); }
});
$('#content').addEventListener('input', e => {
  if (e.target.id !== 'sourceSearch') return;
  state.sourceSearch = e.target.value;
  applySourceSearch();
});
$('#content').addEventListener('change', e => {
  if (e.target.id !== 'sourceSearchRegex') return;
  state.sourceSearchRegex = e.target.checked;
  applySourceSearch();
});
$('#content').addEventListener('change', e => { if (!e.target.matches('[data-sort]')) return; state.sorts[state.view] = e.target.value; state.page = 1; render().catch(err => toast(err.message, true)); });
$('#content').addEventListener('change', e => { if (e.target.id !== 'approvalChannelFilter') return; state.approvalChannelId = e.target.value; state.page = 1; render().catch(err => toast(err.message, true)); });
$('#content').addEventListener('change', async e => { if (e.target.id === 'keywordSource') { try { const sources = await api('/api/sources'); const source = sources.find(s => s._id === e.target.value); if (source) await fillKeywords(source); } catch (err) { toast(err.message, true); } } });
$('#sourceForm').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.currentTarget;
  const id = f.elements.id.value;
  let savedSourceId = id;
  let imageUploadAttempted = false;
  const images = [...f.elements.visualReferenceFile.files];
  const wantsVisualMatch = f.elements.visualMatchEnabled.checked;
  if (wantsVisualMatch && !images.length && f.dataset.hasVisualReference !== 'true') return toast('Choose a reference image before enabling visual matching', true);
  const existingCount = Number(f.dataset.visualReferenceCount || '0');
  if (existingCount + images.length > 10) return toast('A source can have up to 10 reference images', true);
  const selectedBytes = images.reduce((sum, file) => sum + file.size, 0);
  if (selectedBytes > 8 * 1024 * 1024) return toast('Selected reference images must total 8 MB or less', true);
  const body = {
    name: f.elements.name.value.trim(), url: f.elements.url.value.trim(), type: f.elements.type.value,
    priority: f.elements.priority.value, matchMode: f.elements.matchMode.value, enabled: f.elements.enabled.checked,
    adaptiveDiscoveryEnabled: f.elements.type.value === 'channel' && f.elements.adaptiveDiscoveryEnabled.checked,
    videosPerScan: Number(f.elements.videosPerScan.value), scanDescription: f.elements.scanDescription.checked || f.elements.generateNfo.checked,
    generateNfo: f.elements.generateNfo.checked, thumbnailGeminiEnabled: f.elements.thumbnailGeminiEnabled.checked,
    visualMatchEnabled: wantsVisualMatch && !images.length, visualMatchAutoApprove: f.elements.visualMatchAutoApprove.checked,
    visualMatchAction: f.elements.visualMatchAction.value,
    keywordSearchMode: f.elements.keywordSearchMode.value,
    autoApproveVideos: f.elements.type.value === 'channel' && f.elements.autoApproveVideos.checked,
    keywords: parseKeywordEntries(f.elements.keywords.value, f.elements.keywordSearchMode.value),
    excludeKeywords: parseKeywordEntries(f.elements.excludeKeywords.value, f.elements.keywordSearchMode.value)
  };
  try {
    const saved = await api(id ? `/api/sources/${id}` : '/api/sources', { method: id ? 'PUT' : 'POST', body: JSON.stringify(body) });
    const sourceId = id || saved._id;
    savedSourceId = sourceId;
    if (images.length) {
      let result;
      for (let index = 0; index < images.length; index++) {
        const image = images[index];
        $('#visualReferenceStatus').textContent = `Uploading reference image ${index + 1} of ${images.length}…`;
        imageUploadAttempted = true;
        const response = await fetch(`/api/sources/${sourceId}/visual-reference`, { method: 'PUT', headers: { 'Content-Type': image.type }, body: image });
        try { result = await response.json(); } catch { result = {}; }
        if (!response.ok) throw new Error(result.error || `Image upload failed (${response.status})`);
        f.dataset.savedVisualReferences = JSON.stringify(result.visualReferences || []);
        f.dataset.visualReferenceCount = String(result.visualReferences?.length || 0);
        f.dataset.hasVisualReference = String(Boolean(result.visualReferences?.length));
      }
      if (wantsVisualMatch) await api(`/api/sources/${sourceId}`, { method: 'PUT', body: JSON.stringify({ visualMatchEnabled: true }) });
    }
    $('#sourceDialog').close(); toast(id ? 'Source updated' : 'Source added'); await render();
  } catch (err) {
    if (imageUploadAttempted && savedSourceId) {
      try { const sources = await api('/api/sources'); const savedSource = sources.find(source => source._id === savedSourceId); if (savedSource) showSource(savedSource); } catch {}
    }
    toast(err.message, true);
  }
});
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
