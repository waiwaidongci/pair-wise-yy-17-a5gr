const state = {
  config: null,
  db: {},
  activeTab: ''
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function fmtDate(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 1800);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || '请求失败');
  }
  if (res.status === 204) return null;
  return res.json();
}

function valueByPath(source, pathName) {
  return pathName.split('.').reduce((value, key) => value?.[key], source);
}

function displayField(item, field) {
  const value = item[field.name] ?? '';
  if (field.type === 'select' && field.options) return value || field.options[0];
  return value;
}

function collectionLabel(collection) {
  return state.config.collections[collection]?.label || collection;
}

function relationLabel(relation, id) {
  const item = state.db[relation.collection]?.find((entry) => entry.id === id);
  if (!item) return '未关联';
  return relation.labelFields.map((field) => item[field]).filter(Boolean).join(' / ');
}

function optionList(items, labelFields) {
  return items.map((item) => {
    const label = labelFields.map((field) => item[field]).filter(Boolean).join(' / ');
    return `<option value="${item.id}">${escapeHtml(label)}</option>`;
  }).join('');
}

function formField(field) {
  const required = field.required ? 'required' : '';
  const value = field.default ? `value="${escapeHtml(field.default)}"` : '';
  if (field.type === 'textarea') {
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<textarea name="${field.name}" ${required}></textarea></label>`;
  }
  if (field.type === 'select') {
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<select name="${field.name}" ${required}>${field.options.map((option) => `<option>${escapeHtml(option)}</option>`).join('')}</select></label>`;
  }
  if (field.type === 'relation') {
    const items = state.db[field.collection] || [];
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<select name="${field.name}" ${required}>${optionList(items, field.labelFields)}</select></label>`;
  }
  return `<label class="${field.wide ? 'wide' : ''}">${field.label}<input type="${field.type || 'text'}" name="${field.name}" ${value} ${required}></label>`;
}

function pill(value, tone = '') {
  return `<span class="pill ${tone}">${escapeHtml(value || '-')}</span>`;
}

function toneFor(value) {
  return state.config.tones?.[value] || '';
}

function historyHtml(item) {
  const history = item.history || [];
  if (!history.length) return '';
  return `<div class="history">${history.slice(0, 5).map((entry) => `
    <div class="history-item"><span>${fmtDate(entry.at)}</span><span>${escapeHtml(entry.action)}${entry.note ? '：' + escapeHtml(entry.note) : ''}</span></div>
  `).join('')}</div>`;
}

function values(form, view) {
  const payload = Object.fromEntries(new FormData(form).entries());
  for (const field of view.fields) {
    if (field.type === 'number') payload[field.name] = Number(payload[field.name] || 0);
  }
  return { ...view.defaults, ...payload };
}

function renderTabs() {
  $('#tabs').innerHTML = state.config.views.map((view, index) => `
    <button class="tab${index === 0 ? ' active' : ''}" data-tab="${view.id}">${escapeHtml(view.label)}</button>
  `).join('');
  state.activeTab = state.config.views[0].id;
}

function setTab(tabId) {
  state.activeTab = tabId;
  $$('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === tabId));
  $$('.view').forEach((view) => view.classList.toggle('active', view.id === tabId));
}

function renderStats() {
  return `<div class="stats">${state.config.stats.map((stat) => {
    const items = state.db[stat.collection] || [];
    const value = stat.filter ? items.filter((item) => item[stat.filter.field] === stat.filter.value).length : items.length;
    return `<div class="stat"><span>${escapeHtml(stat.label)}</span><strong>${value}</strong></div>`;
  }).join('')}</div>`;
}

function renderCard(item, collection, view) {
  const title = view.titleFields.map((field) => item[field]).filter(Boolean).join(' / ') || item.id;
  const statusValue = item[view.statusField];
  const relation = view.relation ? `<div class="meta">${escapeHtml(relationLabel(view.relation, item[view.relation.localKey]))}</div>` : '';
  const details = (view.detailFields || []).map((field) => {
    const raw = item[field.name];
    const value = field.type === 'relation' ? relationLabel(field, raw) : raw;
    return `<div>${escapeHtml(field.label)}<br><strong>${escapeHtml(value || '-')}</strong></div>`;
  }).join('');
  const summary = (view.summaryFields || []).map((field) => item[field]).filter(Boolean).join(' · ');
  const actions = state.config.actions
    .filter((action) => action.collection === collection)
    .map((action) => `<button class="${action.danger ? 'danger' : 'ghost'}" data-action="${action.id}" data-id="${item.id}">${escapeHtml(action.label)}</button>`)
    .join('');
  return `<article class="card">
    <div class="card-head"><h3>${escapeHtml(title)}</h3>${statusValue ? pill(statusValue, toneFor(statusValue)) : ''}</div>
    ${relation}
    ${summary ? `<p>${escapeHtml(summary)}</p>` : ''}
    ${details ? `<div class="detail">${details}</div>` : ''}
    ${actions ? `<div class="actions">${actions}</div>` : ''}
    ${historyHtml(item)}
  </article>`;
}

function renderList(view) {
  const collection = view.collection;
  const query = $(`#search-${view.id}`)?.value.trim() || '';
  const status = $(`#status-${view.id}`)?.value || '';
  let items = [...(state.db[collection] || [])];
  if (query) {
    items = items.filter((item) => view.searchFields.some((field) => String(item[field] || '').includes(query)));
  }
  if (status) {
    items = items.filter((item) => item[view.statusField] === status);
  }
  return items.length ? items.map((item) => renderCard(item, collection, view)).join('') : `<div class="empty">暂无${escapeHtml(collectionLabel(collection))}</div>`;
}

function renderDashboardView(view) {
  const source = view.focus;
  let items = [...(state.db[source.collection] || [])];
  if (source.field) items = items.filter((item) => source.values.includes(item[source.field]));
  items = items.slice(0, source.limit || 8);
  const cardView = state.config.views.find((entry) => entry.collection === source.collection) || source;
  return `<section class="view active" id="${view.id}">
    ${renderStats()}
    <div class="panel"><h2>${escapeHtml(view.focusTitle)}</h2><div class="list">${items.length ? items.map((item) => renderCard(item, source.collection, cardView)).join('') : '<div class="empty">暂无重点事项</div>'}</div></div>
  </section>`;
}

// ---------- 夜出台 ----------
let nightEditId = '';

function siteById(id) {
  return (state.db.sites || []).find((site) => site.id === id);
}

function siteLabel(site) {
  if (!site) return '未关联样点';
  return [site.cave, site.zone, site.pointCode].filter(Boolean).join(' / ');
}

function localToday() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

function isAbandoned(rec) {
  return rec.abandoned === true || rec.abandoned === '是';
}

function ratioText(rec) {
  const total = Number(rec.adultCount || 0) + Number(rec.juvenileCount || 0);
  if (!total) return '—';
  return `${(Number(rec.juvenileCount || 0) / total * 100).toFixed(1)}%`;
}

function batLimit() {
  const row = (state.db.settings || []).find((entry) => entry.id === 'bat-rules');
  const limit = Number(row?.juvenileRatioLimit);
  return Number.isFinite(limit) && limit > 0 ? limit : 0.15;
}

function renderNightForm() {
  const sites = state.db.sites || [];
  return `<form class="panel" id="nightForm">
    <h2>登记夜出${nightEditId ? ' <span class="pill warn">改正中</span>' : ''}</h2>
    <div class="form-grid">
      <label class="wide">样点<select name="siteId" required>${optionList(sites, ['cave', 'zone', 'pointCode'])}</select></label>
      <label>日期<input type="date" name="date" value="${localToday()}" required></label>
      <label>观察员<input name="observer" required></label>
      <label>成蝠数<input type="number" name="adultCount" min="0" value="0" required></label>
      <label>幼蝠数<input type="number" name="juvenileCount" min="0" value="0" required></label>
      <label>温度℃<input type="number" name="temperature" step="0.1" required></label>
      <label>弃飞<select name="abandoned"><option value="否">否</option><option value="是">是</option></select></label>
    </div>
    <p class="hint">同一样点同晚只认首条，重复上报只累加；幼蝠占比超过 ${(batLimit() * 100).toFixed(0)}% 或出现弃飞即封护。</p>
    <div class="actions">
      <button>${nightEditId ? '保存改正' : '保存夜出'}</button>
      ${nightEditId ? '<button type="button" class="ghost" id="nightCancelEdit">取消改正</button>' : ''}
    </div>
  </form>`;
}

function renderNightBoard() {
  const rank = { '封护': 0, '人工暂停': 1, '开放': 2 };
  const sites = [...(state.db.sites || [])].sort((a, b) => (rank[a.closureStatus] ?? 3) - (rank[b.closureStatus] ?? 3));
  const cards = sites.map((site) => {
    const status = site.closureStatus || '开放';
    const open = status === '开放';
    const lines = [];
    if (status === '封护') {
      lines.push(`触发：${escapeHtml(site.closureReason || '-')}`);
      lines.push(`复核进度 ${site.reviewStreak || 0}/2 晚（须换人·非${escapeHtml(site.closureObserver || '原观察员')}，读数均低且间隔≥24小时）`);
    }
    if (status === '人工暂停') lines.push('人工暂停开放，复核不自动放开，需人工解除');
    const actions = state.config.actions
      .filter((action) => action.collection === 'sites' && action.id.startsWith('site-manual'))
      .map((action) => `<button class="${action.danger ? 'danger' : 'ghost'}" data-action="${action.id}" data-id="${site.id}">${escapeHtml(action.label)}</button>`)
      .join('');
    return `<article class="card">
      <div class="card-head"><h3>${escapeHtml(siteLabel(site))}</h3>${pill(status, toneFor(status))}</div>
      <div class="meta">今晚进洞：<strong>${open ? '可进洞' : '禁止进洞'}</strong></div>
      ${lines.map((line) => `<div class="meta">${line}</div>`).join('')}
      <div class="actions">${actions}</div>
    </article>`;
  }).join('');
  return `<div class="panel">
    <h2>洞口通行状态</h2>
    <div class="threshold">
      <label>幼蝠占比阈值（%）<input id="nightLimit" type="number" min="1" max="100" step="1" value="${(batLimit() * 100).toFixed(0)}"></label>
      <button type="button" class="ghost" id="nightLimitSave">保存阈值</button>
    </div>
    <div class="list">${cards || '<div class="empty">暂无样点</div>'}</div>
  </div>`;
}

function renderNightRecords(view) {
  const query = ($('#nightSearch')?.value || '').trim();
  const verdict = $('#nightVerdict')?.value || '';
  const items = [...(state.db.emergences || [])];
  items.sort((a, b) => String(b.date).localeCompare(String(a.date)) || new Date(b.createdAt) - new Date(a.createdAt));
  const filtered = items.filter((rec) => {
    if (verdict && rec.verdict !== verdict) return false;
    if (!query) return true;
    return [rec.observer, siteLabel(siteById(rec.siteId))].some((text) => String(text || '').includes(query));
  });
  if (!filtered.length) return '<div class="empty">暂无夜出记录</div>';
  return filtered.map((rec) => {
    const dup = rec.verdict === '有效' && rec.duplicateCount > 0
      ? ` <span class="pill warn">重复上报 ×${rec.duplicateCount} 已累加</span>` : '';
    return `<article class="card">
      <div class="card-head"><h3>${escapeHtml(siteLabel(siteById(rec.siteId)))} · ${escapeHtml(rec.date || '-')}</h3>
        <span>${pill(rec.verdict || '有效', toneFor(rec.verdict || '有效'))}${dup}</span></div>
      <div class="detail">
        <div>成蝠<br><strong>${escapeHtml(rec.adultCount ?? '-')}</strong></div>
        <div>幼蝠<br><strong>${escapeHtml(rec.juvenileCount ?? '-')}</strong></div>
        <div>幼蝠占比<br><strong>${ratioText(rec)}</strong></div>
        <div>温度℃<br><strong>${escapeHtml(rec.temperature ?? '-')}</strong></div>
        <div>观察员<br><strong>${escapeHtml(rec.observer || '-')}</strong></div>
        <div>弃飞<br><strong>${isAbandoned(rec) ? '是' : '否'}</strong></div>
      </div>
      <div class="actions"><button class="ghost" data-edit="${rec.id}">改正</button></div>
      ${historyHtml(rec)}
    </article>`;
  }).join('');
}

function renderNightView(view) {
  return `<section class="view" id="${view.id}">
    <div class="grid">
      ${renderNightForm()}
      ${renderNightBoard()}
    </div>
    <div class="panel night-records">
      <h2>${escapeHtml(view.listTitle)}</h2>
      <div class="toolbar">
        <input id="nightSearch" placeholder="${escapeHtml(view.searchPlaceholder || '搜索')}">
        <select id="nightVerdict"><option value="">全部判定</option>${(view.statusOptions || []).map((option) => `<option>${escapeHtml(option)}</option>`).join('')}</select>
      </div>
      <div class="list" id="nightList">${renderNightRecords(view)}</div>
    </div>
  </section>`;
}

function renderCrudView(view) {
  const statusOptions = view.statusOptions || [];
  return `<section class="view" id="${view.id}">
    <div class="grid">
      <form class="panel" data-create="${view.collection}" data-view="${view.id}">
        <h2>${escapeHtml(view.formTitle)}</h2>
        <div class="form-grid">${view.fields.map(formField).join('')}</div>
        <div class="actions"><button>${escapeHtml(view.submitLabel || '保存')}</button></div>
      </form>
      <div class="panel">
        <h2>${escapeHtml(view.listTitle)}</h2>
        <div class="toolbar">
          <input id="search-${view.id}" placeholder="${escapeHtml(view.searchPlaceholder || '搜索')}">
          <select id="status-${view.id}">
            <option value="">全部状态</option>
            ${statusOptions.map((option) => `<option>${escapeHtml(option)}</option>`).join('')}
          </select>
        </div>
        <div class="list" id="list-${view.id}">${renderList(view)}</div>
      </div>
    </div>
  </section>`;
}

function render() {
  $('#title').textContent = state.config.title;
  document.title = state.config.title;
  $('#lede').textContent = state.config.lede;
  $('#main').innerHTML = state.config.views.map((view) => {
    if (view.type === 'dashboard') return renderDashboardView(view);
    if (view.type === 'night') return renderNightView(view);
    return renderCrudView(view);
  }).join('');
  setTab(state.activeTab || state.config.views[0].id);
}

async function load() {
  state.db = await api('/api/db');
  render();
}

document.addEventListener('click', async (event) => {
  const tab = event.target.closest('.tab');
  const action = event.target.closest('[data-action]');
  if (tab) setTab(tab.dataset.tab);
  if (action) {
    try {
      await api(`/api/action/${action.dataset.action}/${action.dataset.id}`, { method: 'POST' });
      await load();
      toast('已更新');
    } catch (error) {
      toast(error.message);
    }
  }
});

document.addEventListener('input', (event) => {
  const view = state.config.views.find((entry) => entry.id && (event.target.id === `search-${entry.id}` || event.target.id === `status-${entry.id}`));
  if (view) $(`#list-${view.id}`).innerHTML = renderList(view);
});

document.addEventListener('submit', async (event) => {
  const form = event.target.closest('[data-create]');
  if (!form) return;
  event.preventDefault();
  const view = state.config.views.find((entry) => entry.id === form.dataset.view);
  await api(`/api/${form.dataset.create}`, { method: 'POST', body: JSON.stringify(values(form, view)) });
  form.reset();
  await load();
  toast('已保存');
});

// 夜出台：登记与改正提交
document.addEventListener('submit', async (event) => {
  if (event.target.id !== 'nightForm') return;
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target).entries());
  const payload = {
    siteId: data.siteId,
    date: data.date,
    observer: data.observer,
    adultCount: Number(data.adultCount || 0),
    juvenileCount: Number(data.juvenileCount || 0),
    temperature: Number(data.temperature || 0),
    abandoned: data.abandoned === '是'
  };
  try {
    if (nightEditId) {
      await api(`/api/emergences/${nightEditId}`, { method: 'PATCH', body: JSON.stringify({ ...payload, historyAction: '改正计数' }) });
      toast('已改正，按新值重判');
    } else {
      await api('/api/emergences', { method: 'POST', body: JSON.stringify(payload) });
      toast('已保存');
    }
    nightEditId = '';
    await load();
  } catch (error) {
    toast(error.message);
  }
});

// 夜出台：改正入口、取消改正、阈值保存
document.addEventListener('click', async (event) => {
  const editBtn = event.target.closest('[data-edit]');
  if (editBtn) {
    const rec = (state.db.emergences || []).find((entry) => entry.id === editBtn.dataset.edit);
    if (!rec) return;
    nightEditId = rec.id;
    render();
    const form = $('#nightForm');
    form.siteId.value = rec.siteId;
    form.date.value = rec.date;
    form.observer.value = rec.observer || '';
    form.adultCount.value = rec.adultCount ?? 0;
    form.juvenileCount.value = rec.juvenileCount ?? 0;
    form.temperature.value = rec.temperature ?? '';
    form.abandoned.value = isAbandoned(rec) ? '是' : '否';
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  if (event.target.id === 'nightCancelEdit') {
    nightEditId = '';
    render();
    return;
  }
  if (event.target.id === 'nightLimitSave') {
    const pct = Number($('#nightLimit').value);
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
      toast('阈值需在 1-100 之间');
      return;
    }
    try {
      await api('/api/settings/bat-rules', {
        method: 'PATCH',
        body: JSON.stringify({ juvenileRatioLimit: pct / 100, historyAction: '调整阈值', note: `幼蝠占比阈值调整为 ${pct}%` })
      });
      await load();
      toast('阈值已保存，按新值重判');
    } catch (error) {
      toast(error.message);
    }
  }
});

// 夜出台：记录筛选
document.addEventListener('input', (event) => {
  if (event.target.id !== 'nightSearch' && event.target.id !== 'nightVerdict') return;
  const view = state.config.views.find((entry) => entry.type === 'night');
  if (view) $('#nightList').innerHTML = renderNightRecords(view);
});

$('#refreshBtn').addEventListener('click', () => load().then(() => toast('已刷新')));

async function boot() {
  state.config = await api('/api/config');
  renderTabs();
  await load();
}

boot().catch((error) => toast(error.message));
