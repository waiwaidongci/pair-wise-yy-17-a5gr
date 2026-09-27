const express = require('express');
const fs = require('fs/promises');
const path = require('path');

const app = express();
const config = require('./project.config');
const PORT = process.env.PORT || config.port || 3900;
const DB_FILE = path.join(__dirname, 'data', 'db.json');
const MS_DAY = 24 * 3600 * 1000;

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

async function readDb() {
  const raw = await fs.readFile(DB_FILE, 'utf8');
  return JSON.parse(raw);
}

async function writeDb(db) {
  await fs.writeFile(DB_FILE, JSON.stringify(db, null, 2) + '\n');
}

function stamp(action, note) {
  return {
    at: new Date().toISOString(),
    action,
    note: note || ''
  };
}

function sortNewest(a, b) {
  return new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0);
}

// ---------- 夜出台判定引擎 ----------

function getEmergenceThreshold(db) {
  const setting = (db.settings || []).find((entry) => entry.id === 'settings-emergence') || (db.settings || [])[0];
  const value = Number(setting && setting.juvenileRatioThreshold);
  return Number.isFinite(value) && value > 0 && value < 1 ? value : 0.15;
}

function emergenceRatio(record) {
  const adult = Number(record.adultCount) || 0;
  const juvenile = Number(record.juvenileCount) || 0;
  const total = adult + juvenile;
  return total > 0 ? juvenile / total : 0;
}

function emergenceIsHigh(record, threshold) {
  return emergenceRatio(record) > threshold || record.abandonedFlight === '有';
}

// 依据全部夜出记录重判单个样点的封护状态：
// - 幼蝠占比超阈值或出现弃飞 -> 封护
// - 封护后须换人连续两晚复核，读数都低且间隔满24小时 -> 解除
// - 人工暂停开放不自动变更
function rejudgeSite(db, siteId) {
  const site = (db.sites || []).find((entry) => entry.id === siteId);
  if (!site) return;
  const threshold = getEmergenceThreshold(db);
  const records = (db.emergences || [])
    .filter((entry) => entry.siteId === siteId)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)) || (new Date(a.createdAt || 0) - new Date(b.createdAt || 0)));
  const now = new Date().toISOString();

  // 重判每条记录的判定结果与占比（计数或阈值改正后保持一致）
  for (const record of records) {
    const judgment = emergenceIsHigh(record, threshold) ? '触发封护' : '读数正常';
    const ratioPct = Math.round(emergenceRatio(record) * 1000) / 10;
    if (record.judgment !== judgment || record.juvenileRatio !== ratioPct) {
      record.judgment = judgment;
      record.juvenileRatio = ratioPct;
      record.updatedAt = now;
    }
  }

  // 按夜晚顺序回放：触发即封护，低读数复核须换人且两晚间隔满24小时
  let sealed = false;
  let trigger = null;
  let reviews = [];
  let liftedByReview = false;
  for (const record of records) {
    const high = record.judgment === '触发封护';
    if (!sealed) {
      if (high) {
        sealed = true;
        trigger = record;
        reviews = [];
      }
      continue;
    }
    if (high) {
      trigger = record;
      reviews = [];
      continue;
    }
    if (trigger && record.observer === trigger.observer) continue; // 复核须换人
    const last = reviews[reviews.length - 1];
    if (last) {
      // 连续两晚：两次复核须为相邻自然夜（隔二十四小时），否则复核链从头计
      if (Date.parse(record.date) - Date.parse(last.date) !== MS_DAY) reviews = [];
    }
    reviews.push(record);
    if (reviews.length >= 2) {
      sealed = false;
      liftedByReview = true;
      reviews = [];
    }
  }

  site.history = site.history || [];
  if (site.protectedStatus === '暂停开放') {
    // 人工暂停开放：不自动放开，也不覆盖
    if (site.sealInfo) {
      delete site.sealInfo;
      site.updatedAt = now;
    }
    return;
  }
  if (sealed) {
    if (site.protectedStatus !== '封护') {
      site.protectedStatus = '封护';
      site.updatedAt = now;
      site.history.unshift(stamp('自动封护', `幼蝠占比超${Math.round(threshold * 100)}%或出现弃飞`));
    }
    site.sealInfo = {
      triggerDate: trigger ? trigger.date : '',
      triggerObserver: trigger ? trigger.observer : '',
      reviews: reviews.map((record) => ({ date: record.date, observer: record.observer })),
      needed: 2
    };
  } else {
    if (site.protectedStatus === '封护') {
      site.protectedStatus = '常规观察';
      site.updatedAt = now;
      site.history.unshift(stamp('解除封护', liftedByReview ? '换人连续两晚复核读数均低且间隔满24小时' : '订正后未再触发封护条件'));
    }
    if (site.sealInfo) delete site.sealInfo;
  }
}

function rejudgeAllSites(db) {
  for (const site of db.sites || []) rejudgeSite(db, site.id);
}

// ---------- 基础接口 ----------

app.get('/api/config', (req, res) => {
  res.json(config);
});

app.get('/api/db', async (req, res) => {
  const db = await readDb();
  for (const key of Object.keys(db)) {
    if (Array.isArray(db[key])) db[key].sort(sortNewest);
  }
  res.json(db);
});

// 夜出台登记：同一样点同晚只认首条，重复上报只累加
app.post('/api/emergences', async (req, res) => {
  const db = await readDb();
  const body = req.body || {};
  const { siteId, date, observer } = body;
  if (!siteId || !date || !observer) return res.status(400).json({ error: '样点、日期、观察员必填' });
  if (!(db.sites || []).some((entry) => entry.id === siteId)) return res.status(400).json({ error: '样点不存在' });
  const adultCount = Number(body.adultCount) || 0;
  const juvenileCount = Number(body.juvenileCount) || 0;
  const now = new Date().toISOString();
  const existing = (db.emergences || []).find((entry) => entry.siteId === siteId && entry.date === date);
  if (existing) {
    existing.adultCount = (Number(existing.adultCount) || 0) + adultCount;
    existing.juvenileCount = (Number(existing.juvenileCount) || 0) + juvenileCount;
    existing.updatedAt = now;
    existing.history = existing.history || [];
    const flightNote = body.abandonedFlight === '有' ? '，报告弃飞' : '';
    existing.history.unshift(stamp('重复上报累加', `成蝠+${adultCount} 幼蝠+${juvenileCount}（${observer}）${flightNote}`));
    rejudgeSite(db, siteId);
    await writeDb(db);
    return res.json({ ...existing, deduplicated: true });
  }
  const item = {
    id: `emergences-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
    siteId,
    date,
    adultCount,
    juvenileCount,
    temperature: Number(body.temperature) || 0,
    observer,
    abandonedFlight: body.abandonedFlight === '有' ? '有' : '无',
    note: body.note || '',
    createdAt: now,
    updatedAt: now,
    history: [stamp('创建', body.note || '夜出登记')]
  };
  db.emergences.push(item);
  rejudgeSite(db, siteId);
  await writeDb(db);
  res.status(201).json(item);
});

app.post('/api/:collection', async (req, res) => {
  const db = await readDb();
  const { collection } = req.params;
  if (!Array.isArray(db[collection])) return res.status(404).json({ error: 'unknown collection' });
  const now = new Date().toISOString();
  const item = {
    id: `${collection}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
    ...req.body,
    createdAt: now,
    updatedAt: now,
    history: [stamp('创建', req.body.note || req.body.memo || '')]
  };
  db[collection].push(item);
  await writeDb(db);
  res.status(201).json(item);
});

app.patch('/api/:collection/:id', async (req, res) => {
  const db = await readDb();
  const { collection, id } = req.params;
  if (!Array.isArray(db[collection])) return res.status(404).json({ error: 'unknown collection' });
  const item = db[collection].find((entry) => entry.id === id);
  if (!item) return res.status(404).json({ error: 'not found' });
  const previousSiteId = item.siteId;
  if (collection === 'emergences') {
    // 改正后不得与他人记录撞晚：同一样点同晚只认首条
    const nextSiteId = req.body.siteId !== undefined ? req.body.siteId : item.siteId;
    const nextDate = req.body.date !== undefined ? req.body.date : item.date;
    const clash = db.emergences.find((entry) => entry.id !== id && entry.siteId === nextSiteId && entry.date === nextDate);
    if (clash) return res.status(409).json({ error: '同一样点同晚只认首条，该晚已存在记录' });
  }
  const historyAction = req.body.historyAction;
  delete req.body.historyAction;
  Object.assign(item, req.body, { updatedAt: new Date().toISOString() });
  item.history = item.history || [];
  if (historyAction || req.body.note || req.body.memo || req.body.status) {
    item.history.unshift(stamp(historyAction || req.body.status || '更新', req.body.note || req.body.memo || ''));
  }
  // 原计数、阈值或样点状态改正后按新值重判
  if (collection === 'emergences') {
    rejudgeSite(db, item.siteId);
    if (previousSiteId && previousSiteId !== item.siteId) rejudgeSite(db, previousSiteId);
  }
  if (collection === 'sites' && Object.prototype.hasOwnProperty.call(req.body, 'protectedStatus')) {
    rejudgeSite(db, id);
  }
  if (collection === 'settings') {
    rejudgeAllSites(db);
  }
  await writeDb(db);
  res.json(item);
});

app.delete('/api/:collection/:id', async (req, res) => {
  const db = await readDb();
  const { collection, id } = req.params;
  if (!Array.isArray(db[collection])) return res.status(404).json({ error: 'unknown collection' });
  const target = db[collection].find((entry) => entry.id === id);
  if (!target) return res.status(404).json({ error: 'not found' });
  db[collection] = db[collection].filter((entry) => entry.id !== id);
  if (collection === 'emergences') rejudgeSite(db, target.siteId);
  await writeDb(db);
  res.status(204).end();
});

app.post('/api/action/:actionId/:id', async (req, res) => {
  const db = await readDb();
  const action = config.actions.find((entry) => entry.id === req.params.actionId);
  if (!action) return res.status(404).json({ error: 'unknown action' });
  const item = db[action.collection]?.find((entry) => entry.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'not found' });
  if (action.handler === 'rejudge') {
    rejudgeSite(db, item.id);
    await writeDb(db);
    return res.json(item);
  }
  const result = runAction(db, action, item);
  if (result.error) return res.status(409).json({ error: result.error });
  // 状态流转后按新值重判
  if (action.collection === 'sites') rejudgeSite(db, item.id);
  if (action.relation && action.relation.collection === 'sites') rejudgeSite(db, item[action.relation.localKey]);
  await writeDb(db);
  res.json(result.item);
});

function getValue(source, pathName) {
  return pathName.split('.').reduce((value, key) => value?.[key], source);
}

function setValue(target, pathName, value) {
  const keys = pathName.split('.');
  let cursor = target;
  while (keys.length > 1) {
    const key = keys.shift();
    cursor[key] = cursor[key] || {};
    cursor = cursor[key];
  }
  cursor[keys[0]] = value;
}

function findRelated(db, relation, item) {
  return db[relation.collection]?.find((entry) => entry.id === item[relation.localKey]);
}

function runAction(db, action, item) {
  const related = action.relation ? findRelated(db, action.relation, item) : null;
  const context = { item, related };
  const levelRank = { '低': 1, '中': 2, '高': 3 };
  for (const guard of action.guards || []) {
    const left = getValue(context, guard.left);
    const right = guard.rightPath ? getValue(context, guard.rightPath) : guard.right;
    if (guard.op === 'missing' && left) continue;
    if (guard.op === 'missing' && !left) return { error: guard.message };
    if (guard.op === 'eq' && left !== right) return { error: guard.message };
    if (guard.op === 'neq' && left === right) return { error: guard.message };
    if (guard.op === 'gte' && Number(left) < Number(right)) return { error: guard.message };
    if (guard.op === 'levelGte' && (levelRank[left] || 0) < (levelRank[right] || 0)) return { error: guard.message };
    if (guard.op === 'notIn' && guard.values.includes(left)) return { error: guard.message };
  }
  for (const patch of action.patches || []) {
    const target = patch.target === 'related' ? related : item;
    if (!target) continue;
    const next = patch.valuePath ? getValue(context, patch.valuePath) : patch.value;
    setValue(target, patch.field, next);
    target.updatedAt = new Date().toISOString();
    target.history = target.history || [];
    target.history.unshift(stamp(action.label, action.note || '状态流转'));
  }
  for (const delta of action.deltas || []) {
    const target = delta.target === 'related' ? related : item;
    if (!target) continue;
    const sourceAmount = delta.amountPath ? Number(getValue(context, delta.amountPath)) : 1;
    const multiplier = delta.amount === undefined ? 1 : Number(delta.amount);
    const amount = sourceAmount * multiplier;
    const current = Number(getValue({ target }, `target.${delta.field}`) || 0);
    setValue(target, delta.field, current + amount);
    target.updatedAt = new Date().toISOString();
    target.history = target.history || [];
    target.history.unshift(stamp(action.label, action.note || '数量调整'));
  }
  return { item };
}

app.listen(PORT, () => {
  console.log(`${config.title} running at http://localhost:${PORT}`);
});
