// 入口：排演登记、结束、改单重算、保养回台、台账查询。
// 规则校验都在这里，计算交给 wear.js，状态推导交给 ledger.js。
const express = require('express');
const db = require('./db');
const wear = require('./wear');
const ledger = require('./ledger');

const router = express.Router();

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function parseMinutes(value) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw httpError(400, 'minutes 必须为大于 0 的数字');
  }
  return minutes;
}

function parseRepairCount(value) {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 0) {
    throw httpError(400, 'repairCount 必须为不小于 0 的整数');
  }
  return count;
}

function requireHead(puppetHeadId) {
  const head = db.loadRecord(ledger.HEAD_COLLECTION, puppetHeadId);
  if (!head) throw httpError(404, '偶头不存在: ' + puppetHeadId);
  return head;
}

function stripMeta(record) {
  const data = { ...record };
  delete data.id;
  delete data.collection;
  delete data.createdAt;
  delete data.updatedAt;
  return data;
}

// 登记排演新单：偶头 + 场次等级 + 分钟数 + 修补次数。
// 有未结束演出或已停用时返回 409，且不保存新单。
router.post('/rehearsals', (req, res, next) => {
  try {
    const body = req.body || {};
    const missing = [];
    if (!body.puppetHeadId) missing.push('puppetHeadId');
    if (!body.level) missing.push('level');
    if (body.minutes === undefined || body.minutes === '') missing.push('minutes');
    if (missing.length) throw httpError(400, 'missing required fields: ' + missing.join(', '));
    if (!wear.isValidLevel(body.level)) {
      throw httpError(400, 'invalid level: ' + body.level + '（可选：轻场/常演/重场）');
    }
    const minutes = parseMinutes(body.minutes);
    const repairCount = body.repairCount === undefined ? 0 : parseRepairCount(body.repairCount);
    requireHead(body.puppetHeadId);

    const state = ledger.ledgerForHead(body.puppetHeadId);
    if (state.openSession) {
      throw httpError(409, '偶头有未结束演出（' + state.openSession.id + '），不能再排一场');
    }
    if (state.deactivated) {
      throw httpError(409, '偶头累计损耗 ' + state.totalPoints + ' 点已停用，须保养回台后再排');
    }

    const record = db.insertRecord(ledger.SESSION_COLLECTION, {
      puppetHeadId: body.puppetHeadId,
      level: body.level,
      minutes,
      repairCount,
      points: wear.pointsFor({ level: body.level, minutes }),
      note: body.note || '',
      status: '进行中'
    }, '进行中', { action: '登记排演', actor: body.actor, note: body.note });

    const nextState = ledger.syncHeadWear(body.puppetHeadId, body.actor);
    res.status(201).json({ record, ledger: nextState });
  } catch (error) {
    next(error);
  }
});

// 结束一场演出，之后才能排下一场。
router.post('/rehearsals/:id/finish', (req, res, next) => {
  try {
    const body = req.body || {};
    const record = db.loadRecord(ledger.SESSION_COLLECTION, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    if (record.status !== '进行中') throw httpError(409, '该场演出已结束，不能重复结束');
    const nextData = stripMeta(record);
    nextData.status = '已结束';
    nextData.finishedAt = db.now();
    db.saveRecord(ledger.SESSION_COLLECTION, record.id, nextData, '已结束');
    db.insertEvent({
      recordId: record.id,
      collection: ledger.SESSION_COLLECTION,
      action: '演出结束',
      status: '已结束',
      actor: body.actor || '',
      note: body.note || '',
      data: {}
    });
    const state = ledger.syncHeadWear(record.puppetHeadId, body.actor);
    res.json({ record: db.loadRecord(ledger.SESSION_COLLECTION, record.id), ledger: state });
  } catch (error) {
    next(error);
  }
});

// 改单：改了时长、等级或修补次数，就从上次保养重算，旧放行失效。
router.patch('/rehearsals/:id', (req, res, next) => {
  try {
    const body = req.body || {};
    const record = db.loadRecord(ledger.SESSION_COLLECTION, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });

    if (body.level !== undefined && !wear.isValidLevel(body.level)) {
      throw httpError(400, 'invalid level: ' + body.level + '（可选：轻场/常演/重场）');
    }
    const parsed = {};
    if (body.minutes !== undefined) parsed.minutes = parseMinutes(body.minutes);
    if (body.repairCount !== undefined) parsed.repairCount = parseRepairCount(body.repairCount);
    if (body.level !== undefined) parsed.level = body.level;
    if (body.note !== undefined) parsed.note = String(body.note);

    const recalcFields = ['minutes', 'level', 'repairCount'];
    const touched = recalcFields.filter((field) => parsed[field] !== undefined && parsed[field] !== record[field]);

    const nextData = { ...stripMeta(record), ...parsed };
    nextData.points = wear.pointsFor(nextData);
    db.saveRecord(ledger.SESSION_COLLECTION, record.id, nextData, record.status);

    let state;
    if (touched.length) {
      db.insertEvent({
        recordId: record.id,
        collection: ledger.SESSION_COLLECTION,
        action: '重算损耗',
        status: record.status,
        actor: body.actor || '',
        note: '改动' + touched.join('、') + '，从上次保养重算，旧放行失效',
        data: { touched, changes: parsed }
      });
      state = ledger.syncHeadWear(record.puppetHeadId, body.actor);
    } else {
      db.insertEvent({
        recordId: record.id,
        collection: ledger.SESSION_COLLECTION,
        action: '更新排演单',
        status: record.status,
        actor: body.actor || '',
        note: body.note || '',
        data: parsed
      });
      state = ledger.ledgerForHead(record.puppetHeadId);
    }
    res.json({ record: db.loadRecord(ledger.SESSION_COLLECTION, record.id), recalculated: touched.length > 0, ledger: state });
  } catch (error) {
    next(error);
  }
});

// 保养单：写明处理人和前后读数才回台，累计点数从这次保养起算。
router.post('/maintenance', (req, res, next) => {
  try {
    const body = req.body || {};
    const missing = [];
    if (!body.puppetHeadId) missing.push('puppetHeadId');
    if (!body.handler) missing.push('handler（处理人）');
    if (body.readingBefore === undefined || body.readingBefore === '') missing.push('readingBefore（保养前读数）');
    if (body.readingAfter === undefined || body.readingAfter === '') missing.push('readingAfter（保养后读数）');
    if (missing.length) throw httpError(400, '保养单须写明处理人和前后读数，缺少: ' + missing.join(', '));
    requireHead(body.puppetHeadId);

    const before = ledger.ledgerForHead(body.puppetHeadId);
    const record = db.insertRecord(ledger.MAINTENANCE_COLLECTION, {
      puppetHeadId: body.puppetHeadId,
      handler: body.handler,
      readingBefore: body.readingBefore,
      readingAfter: body.readingAfter,
      pointsAtMaintenance: before.totalPoints,
      note: body.note || '',
      status: '已回台'
    }, '已回台', { action: '保养回台', actor: body.actor || body.handler, note: body.note });

    const state = ledger.syncHeadWear(body.puppetHeadId, body.actor || body.handler, {
      resumedAction: '保养回台',
      resumedNote: '保养回台，累计点数从本次保养起算'
    });
    res.status(201).json({ record, ledger: state });
  } catch (error) {
    next(error);
  }
});

// 台账：某只偶头上次保养以来的场次明细与累计点数。
router.get('/rehearsals/ledger/:puppetHeadId', (req, res, next) => {
  try {
    const head = requireHead(req.params.puppetHeadId);
    const state = ledger.ledgerForHead(req.params.puppetHeadId);
    res.json({
      head: {
        id: head.id,
        role: head.role,
        play: head.play,
        status: head.status,
        wearStatus: head.wearStatus || '正常',
        wearPoints: head.wearPoints || 0
      },
      ...state
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
