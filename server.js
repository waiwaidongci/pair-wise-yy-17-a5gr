const express = require('express');
const fs = require('fs/promises');
const path = require('path');

const app = express();
const config = require('./project.config');
const PORT = process.env.PORT || config.port || 3900;
const DB_FILE = path.join(__dirname, 'data', 'db.json');

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

// ---------- 夜出台判定（服务端） ----------
const DAY_MS = 24 * 60 * 60 * 1000;

function batSettings(db) {
  const row = (db.settings || []).find((entry) => entry.id === 'bat-rules') || {};
  const limit = Number(row.juvenileRatioLimit);
  return { juvenileRatioLimit: Number.isFinite(limit) && limit > 0 ? limit : 0.15 };
}

function dayStart(dateStr) {
  const time = new Date(`${dateStr}T00:00:00Z`).getTime();
  return Number.isFinite(time) ? time : 0;
}

function isAbandoned(rec) {
  return rec.abandoned === true || rec.abandoned === '是';
}

function juvenileRatioOf(rec) {
  const total = Number(rec.adultCount || 0) + Number(rec.juvenileCount || 0);
  return total > 0 ? Number(rec.juvenileCount || 0) / total : 0;
}

// 触发封护：出现弃飞，或幼蝠占比超过阈值
function triggersClosure(rec, limit) {
  return isAbandoned(rec) || juvenileRatioOf(rec) > limit;
}

function closureReasonOf(rec) {
  if (isAbandoned(rec)) return `出现弃飞（${rec.date}）`;
  return `幼蝠占比 ${(juvenileRatioOf(rec) * 100).toFixed(1)}%（${rec.date}）`;
}

function applyClosure(site, status, info) {
  const changed = site.closureStatus !== status
    || (site.closureReason || '') !== (info.reason || '')
    || Number(site.reviewStreak || 0) !== Number(info.streak || 0);
  if (site.closureStatus !== status) {
    site.history = site.history || [];
    let note = '复核达标，恢复进洞';
    let action = '解除封护';
    if (status === '封护') {
      action = '封护';
      note = `触发封护：${info.reason}`;
    } else if (status === '人工暂停') {
      action = '人工暂停';
      note = '人工暂停开放，需人工解除，复核不自动放开';
    } else if (site.closureStatus === '人工暂停') {
      note = '人工解除，恢复开放';
    }
    site.history.unshift(stamp(action, note));
    site.closureSince = status === '开放' ? '' : (info.since || new Date().toISOString());
  }
  site.closureStatus = status;
  site.closureReason = info.reason || '';
  site.closureTriggerId = info.triggerId || '';
  site.closureObserver = info.observer || '';
  site.reviewStreak = status === '封护' ? Math.min(info.streak || 0, 2) : 0;
  if (changed) site.updatedAt = new Date().toISOString();
}

// 重判：同一样点同晚只认首条，重复上报只累加；按当前计数与阈值回放封护/解除
function rejudgeBat(db) {
  const sites = db.sites || [];
  const emergences = db.emergences || [];
  if (!sites.length) return;
  const { juvenileRatioLimit: limit } = batSettings(db);

  const groups = new Map();
  for (const rec of emergences) {
    const key = `${rec.siteId}|${rec.date}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(rec);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    group.forEach((rec, index) => {
      rec.verdict = index === 0 ? '有效' : '重复上报';
      rec.duplicateCount = index === 0 ? group.length - 1 : 0;
    });
  }

  for (const site of sites) {
    const records = emergences
      .filter((rec) => rec.siteId === site.id && rec.verdict === '有效')
      .sort((a, b) => dayStart(a.date) - dayStart(b.date) || new Date(a.createdAt) - new Date(b.createdAt));
    let closed = false;
    let trigger = null;
    let reviews = [];
    for (const rec of records) {
      if (!closed) {
        if (triggersClosure(rec, limit)) {
          closed = true;
          trigger = rec;
          reviews = [];
        }
        continue;
      }
      reviews.push(rec);
      if (reviews.length < 2) continue;
      const prev = reviews[reviews.length - 2];
      const consecutiveNights = dayStart(rec.date) - dayStart(prev.date) === DAY_MS;
      const apart24h = new Date(rec.createdAt) - new Date(prev.createdAt) >= DAY_MS;
      const swapped = prev.observer !== trigger.observer && rec.observer !== trigger.observer;
      const bothLow = !triggersClosure(prev, limit) && !triggersClosure(rec, limit);
      // 换人连续两晚复核、读数都低且间隔满二十四小时，自动解除
      if (consecutiveNights && apart24h && swapped && bothLow) {
        closed = false;
        trigger = null;
        reviews = [];
      }
    }
    let streak = 0;
    let prev = null;
    if (closed && trigger) {
      for (const rec of reviews) {
        const counts = !triggersClosure(rec, limit) && rec.observer !== trigger.observer;
        streak = counts && prev && dayStart(rec.date) - dayStart(prev.date) === DAY_MS ? streak + 1 : (counts ? 1 : 0);
        prev = rec;
      }
    }
    if (site.manualHold) {
      applyClosure(site, '人工暂停', { reason: '人工暂停开放' });
    } else if (closed && trigger) {
      applyClosure(site, '封护', {
        reason: closureReasonOf(trigger),
        triggerId: trigger.id,
        observer: trigger.observer,
        since: trigger.createdAt,
        streak
      });
    } else {
      applyClosure(site, '开放', {});
    }
  }
}

function sortNewest(a, b) {
  return new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0);
}

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
  rejudgeBat(db);
  await writeDb(db);
  res.status(201).json(item);
});

app.patch('/api/:collection/:id', async (req, res) => {
  const db = await readDb();
  const { collection, id } = req.params;
  if (!Array.isArray(db[collection])) return res.status(404).json({ error: 'unknown collection' });
  const item = db[collection].find((entry) => entry.id === id);
  if (!item) return res.status(404).json({ error: 'not found' });
  const historyAction = req.body.historyAction;
  delete req.body.historyAction;
  Object.assign(item, req.body, { updatedAt: new Date().toISOString() });
  item.history = item.history || [];
  if (historyAction || req.body.note || req.body.memo || req.body.status) {
    item.history.unshift(stamp(historyAction || req.body.status || '更新', req.body.note || req.body.memo || ''));
  }
  rejudgeBat(db);
  await writeDb(db);
  res.json(item);
});

app.delete('/api/:collection/:id', async (req, res) => {
  const db = await readDb();
  const { collection, id } = req.params;
  if (!Array.isArray(db[collection])) return res.status(404).json({ error: 'unknown collection' });
  const before = db[collection].length;
  db[collection] = db[collection].filter((entry) => entry.id !== id);
  if (db[collection].length === before) return res.status(404).json({ error: 'not found' });
  rejudgeBat(db);
  await writeDb(db);
  res.status(204).end();
});

app.post('/api/action/:actionId/:id', async (req, res) => {
  const db = await readDb();
  const action = config.actions.find((entry) => entry.id === req.params.actionId);
  if (!action) return res.status(404).json({ error: 'unknown action' });
  const item = db[action.collection]?.find((entry) => entry.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'not found' });
  const result = runAction(db, action, item);
  if (result.error) return res.status(409).json({ error: result.error });
  rejudgeBat(db);
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

async function boot() {
  // 启动即按当前计数、阈值与样点状态重判一遍，保证派生状态与数据一致
  const db = await readDb();
  rejudgeBat(db);
  await writeDb(db);
  app.listen(PORT, () => {
    console.log(`${config.title} running at http://localhost:${PORT}`);
  });
}

boot().catch((error) => {
  console.error('启动失败', error);
  process.exit(1);
});
