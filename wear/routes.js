// 入口：HTTP 层。只做参数校验、状态冲突（409）、错误码与响应组装；
// 损耗怎么算问 calculator，数据怎么存取问 ledgerStore。

const express = require('express');
const { randomUUID } = require('crypto');
const calculator = require('./calculator');
const store = require('./ledgerStore');
const { now } = require('../db');

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function requireHeadId(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw httpError(400, 'puppetHeadId（偶头）必填');
  }
  return value.trim();
}

function requireLevel(value) {
  if (!calculator.isValidLevel(value)) {
    throw httpError(400, '场次等级须为：' + Object.keys(calculator.LEVEL_RATES).join(' / '));
  }
  return value;
}

function requireMinutes(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw httpError(400, '分钟数须为正数');
  }
  return value;
}

function requireRepairs(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw httpError(400, '修补次数须为非负整数');
  }
  return value;
}

function requireReading(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw httpError(400, '保养单须写明' + label + '（非负数字）');
  }
  return value;
}

module.exports = function createWearRouter(deps = {}) {
  const syncHeadStatus = deps.syncHeadStatus || (() => {});
  const router = express.Router();

  // 首次请求时建表（此时数据库已就绪），之后每请求仅检查一次标记。
  let tablesReady = false;
  router.use((req, res, next) => {
    if (!tablesReady) {
      store.initWearTables();
      tablesReady = true;
    }
    next();
  });

  // 当前损耗快照：自上次保养的读数 + 未结算演出单 + 台账上的停用标记。
  function loadSummary(puppetHeadId) {
    const state = store.getHeadState(puppetHeadId);
    const maintenance = store.latestMaintenance(puppetHeadId);
    const orders = store.unsettledOrders(puppetHeadId);
    return calculator.summarize({
      baseline: maintenance ? maintenance.afterReading : 0,
      orders,
      latchedDeactivated: state ? state.deactivated : false
    });
  }

  // 重算后若越线则登记停用（停用粘住，等保养单解除），并联动偶头档案。
  function applyDeactivation(puppetHeadId, summary) {
    if (!summary.deactivated) return;
    const state = store.getHeadState(puppetHeadId);
    if (state && state.deactivated) return;
    store.saveHeadState(puppetHeadId, true, now());
    syncHeadStatus(puppetHeadId, {
      status: '不可演出',
      currentUsable: false,
      action: '损耗停用',
      note: '累计损耗 ' + summary.cumulative + ' 点，达到 ' + summary.threshold + ' 点停用线',
      data: { cumulative: summary.cumulative, threshold: summary.threshold }
    });
  }

  router.get('/', (req, res) => {
    res.json({
      title: '偶头损耗台账',
      levelRates: calculator.LEVEL_RATES,
      repairPoints: calculator.REPAIR_POINTS,
      threshold: calculator.THRESHOLD,
      endpoints: [
        'POST /api/wear/orders 登记一场演出（偶头、场次等级、分钟数、修补次数）',
        'POST /api/wear/orders/:id/finish 收场（结束演出）',
        'PATCH /api/wear/orders/:id 改时长/等级/修补次数，从上次保养重算，旧放行失效',
        'POST /api/wear/maintenances 保养单（处理人 + 前后读数）后回台',
        'GET /api/wear/heads/:puppetHeadId 当前损耗快照',
        'GET /api/wear/heads/:puppetHeadId/ledger 台账流水'
      ]
    });
  });

  // 登记一场演出。有未结束演出或已停用都返回 409，且不保存新单。
  router.post('/orders', (req, res, next) => {
    try {
      const puppetHeadId = requireHeadId(req.body.puppetHeadId);
      const level = requireLevel(req.body.level);
      const minutes = requireMinutes(req.body.minutes);
      const repairs = req.body.repairs === undefined ? 0 : requireRepairs(req.body.repairs);

      const before = loadSummary(puppetHeadId);
      if (before.deactivated) {
        throw httpError(409, '偶头已停用，须保养回台后才能再排场');
      }
      const open = store.findOpenOrder(puppetHeadId);
      if (open) {
        throw httpError(409, '偶头还有未结束演出（单号 ' + open.id + '），不能再排一场');
      }

      const timestamp = now();
      const order = store.createOrder({
        id: randomUUID(),
        puppetHeadId,
        level,
        minutes,
        repairs,
        points: calculator.pointsForOrder({ level, minutes, repairs }),
        status: '进行中',
        createdAt: timestamp,
        updatedAt: timestamp
      });
      const summary = loadSummary(puppetHeadId);
      applyDeactivation(puppetHeadId, summary);
      res.status(201).json({ order, wear: summary });
    } catch (error) {
      next(error);
    }
  });

  router.get('/orders', (req, res, next) => {
    try {
      res.json(store.listOrders({ puppetHeadId: req.query.puppetHeadId, status: req.query.status }));
    } catch (error) {
      next(error);
    }
  });

  router.get('/orders/:id', (req, res, next) => {
    try {
      const order = store.getOrder(req.params.id);
      if (!order) throw httpError(404, '演出单不存在');
      res.json({ order, wear: loadSummary(order.puppetHeadId) });
    } catch (error) {
      next(error);
    }
  });

  // 收场：结束当前这场，才允许排下一场。
  router.post('/orders/:id/finish', (req, res, next) => {
    try {
      const order = store.getOrder(req.params.id);
      if (!order) throw httpError(404, '演出单不存在');
      if (order.status === '已结束') throw httpError(409, '演出单已结束，不能重复收场');
      const finished = store.finishOrder(order.id, now());
      res.json({ order: finished, wear: loadSummary(order.puppetHeadId) });
    } catch (error) {
      next(error);
    }
  });

  // 改时长、等级或修补次数：从上次保养重算，旧放行失效（可能当场转为停用）。
  router.patch('/orders/:id', (req, res, next) => {
    try {
      const order = store.getOrder(req.params.id);
      if (!order) throw httpError(404, '演出单不存在');

      const patch = {};
      if (req.body.minutes !== undefined) patch.minutes = requireMinutes(req.body.minutes);
      if (req.body.level !== undefined) patch.level = requireLevel(req.body.level);
      if (req.body.repairs !== undefined) patch.repairs = requireRepairs(req.body.repairs);
      if (!Object.keys(patch).length) {
        throw httpError(400, '仅支持修改时长（minutes）、等级（level）或修补次数（repairs）');
      }

      const nextValues = {
        level: patch.level !== undefined ? patch.level : order.level,
        minutes: patch.minutes !== undefined ? patch.minutes : order.minutes,
        repairs: patch.repairs !== undefined ? patch.repairs : order.repairs
      };
      patch.points = calculator.pointsForOrder(nextValues);
      const updated = store.updateOrder(order.id, patch, now());

      const summary = loadSummary(order.puppetHeadId);
      applyDeactivation(order.puppetHeadId, summary);
      res.json({ order: updated, wear: summary, recalculated: true });
    } catch (error) {
      next(error);
    }
  });

  // 保养单：写明处理人和前后读数后才回台（解除停用、读数重置为保养后读数）。
  router.post('/maintenances', (req, res, next) => {
    try {
      const puppetHeadId = requireHeadId(req.body.puppetHeadId);
      const handler = typeof req.body.handler === 'string' ? req.body.handler.trim() : '';
      if (!handler) throw httpError(400, '保养单须写明处理人（handler）');
      const beforeReading = requireReading(req.body.beforeReading, '保养前读数（beforeReading）');
      const afterReading = requireReading(req.body.afterReading, '保养后读数（afterReading）');

      const computedReading = loadSummary(puppetHeadId).cumulative;
      const maintenance = store.createMaintenance({
        id: randomUUID(),
        puppetHeadId,
        handler,
        beforeReading,
        afterReading,
        note: typeof req.body.note === 'string' ? req.body.note : '',
        createdAt: now()
      });
      store.settleOrders(puppetHeadId, maintenance.id);

      // 保养后读数仍达停用线的，不算回台。
      const backOnStage = afterReading < calculator.THRESHOLD;
      store.saveHeadState(puppetHeadId, !backOnStage, now());
      syncHeadStatus(puppetHeadId, backOnStage
        ? {
            status: '可演出',
            currentUsable: true,
            action: '保养回台',
            note: '保养后读数 ' + afterReading + ' 点，处理人：' + handler,
            data: { maintenanceId: maintenance.id, beforeReading, afterReading }
          }
        : {
            status: '不可演出',
            currentUsable: false,
            action: '保养登记',
            note: '保养后读数 ' + afterReading + ' 点仍达停用线，未回台，处理人：' + handler,
            data: { maintenanceId: maintenance.id, beforeReading, afterReading }
          });

      res.status(201).json({
        maintenance,
        wear: loadSummary(puppetHeadId),
        computedReading,
        backOnStage
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/maintenances', (req, res, next) => {
    try {
      if (!req.query.puppetHeadId) throw httpError(400, '请用 ?puppetHeadId= 指定偶头');
      res.json(store.listMaintenances(req.query.puppetHeadId));
    } catch (error) {
      next(error);
    }
  });

  // 当前损耗快照：累计读数、放行/停用、未结束演出、上次保养。
  router.get('/heads/:puppetHeadId', (req, res, next) => {
    try {
      const puppetHeadId = req.params.puppetHeadId;
      const state = store.getHeadState(puppetHeadId);
      const maintenance = store.latestMaintenance(puppetHeadId);
      const unsettled = store.unsettledOrders(puppetHeadId);
      if (!state && !maintenance && !unsettled.length) {
        throw httpError(404, '该偶头暂无损耗台账');
      }
      res.json({
        puppetHeadId,
        ...loadSummary(puppetHeadId),
        openOrder: store.findOpenOrder(puppetHeadId),
        lastMaintenance: maintenance,
        ordersSinceMaintenance: unsettled.length,
        deactivatedAt: state ? state.deactivatedAt : null
      });
    } catch (error) {
      next(error);
    }
  });

  // 台账流水：演出单与保养单按时间排列，逐笔给出累计读数。
  router.get('/heads/:puppetHeadId/ledger', (req, res, next) => {
    try {
      const puppetHeadId = req.params.puppetHeadId;
      const orders = store.listOrders({ puppetHeadId });
      const maintenances = store.listMaintenances(puppetHeadId);
      if (!orders.length && !maintenances.length) {
        throw httpError(404, '该偶头暂无损耗台账');
      }
      res.json({
        puppetHeadId,
        entries: calculator.buildLedger({ orders, maintenances }),
        wear: loadSummary(puppetHeadId)
      });
    } catch (error) {
      next(error);
    }
  });

  router.use((req, res) => {
    res.status(404).json({ error: 'unknown wear endpoint' });
  });

  return router;
};
