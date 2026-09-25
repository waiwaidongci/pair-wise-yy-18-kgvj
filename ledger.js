// 台账：读取排演单与保养单，推导每只偶头当前的损耗状态。
// 累计点数始终从上次保养起算；改动排演单后重新调用即完成重算，旧放行自然失效。
const { select, sqlValue, toRecord, loadRecord, saveRecord, insertEvent } = require('./db');
const wear = require('./wear');

const SESSION_COLLECTION = 'rehearsalSessions';
const MAINTENANCE_COLLECTION = 'maintenanceOrders';
const HEAD_COLLECTION = 'puppetHeads';

function rowsFor(collection) {
  return select(
    'SELECT rowid AS rowId, * FROM records WHERE collection = ' + sqlValue(collection) + ' ORDER BY rowid ASC;'
  ).map((row) => ({ ...toRecord(row), rowId: row.rowId }));
}

function sessionsForHead(puppetHeadId) {
  return rowsFor(SESSION_COLLECTION).filter((record) => record.puppetHeadId === puppetHeadId);
}

function lastMaintenanceForHead(puppetHeadId) {
  const records = rowsFor(MAINTENANCE_COLLECTION).filter((record) => record.puppetHeadId === puppetHeadId);
  return records.length ? records[records.length - 1] : null;
}

function openSessionForHead(puppetHeadId) {
  return sessionsForHead(puppetHeadId).find((record) => record.status === '进行中') || null;
}

// 台账全貌：上次保养、保养以来的场次明细、累计点数、是否停用、未结束场次。
function ledgerForHead(puppetHeadId) {
  const lastMaintenance = lastMaintenanceForHead(puppetHeadId);
  const baseRowId = lastMaintenance ? lastMaintenance.rowId : 0;
  const sessions = sessionsForHead(puppetHeadId).filter((record) => record.rowId > baseRowId);
  const summary = wear.summarize(sessions);
  return {
    puppetHeadId,
    threshold: summary.threshold,
    totalPoints: summary.totalPoints,
    deactivated: summary.deactivated,
    entries: summary.entries,
    openSession: openSessionForHead(puppetHeadId),
    lastMaintenance
  };
}

// 把台账结果同步到偶头档案（wearStatus/wearPoints），状态翻转时在偶头时间线上留痕。
function syncHeadWear(puppetHeadId, actor, options) {
  const resumedAction = (options && options.resumedAction) || '损耗放行';
  const resumedNote = (options && options.resumedNote) || '重算后累计点数低于停用线，恢复可排';
  const head = loadRecord(HEAD_COLLECTION, puppetHeadId);
  if (!head) return null;
  const ledger = ledgerForHead(puppetHeadId);
  const wearStatus = ledger.deactivated ? '停用' : '正常';
  const nextData = { ...head };
  delete nextData.id;
  delete nextData.collection;
  delete nextData.createdAt;
  delete nextData.updatedAt;
  nextData.wearStatus = wearStatus;
  nextData.wearPoints = ledger.totalPoints;
  nextData.lastMaintenanceAt = ledger.lastMaintenance ? ledger.lastMaintenance.createdAt : null;
  saveRecord(HEAD_COLLECTION, puppetHeadId, nextData, head.status);
  if (head.wearStatus !== wearStatus) {
    if (wearStatus === '停用') {
      insertEvent({
        recordId: puppetHeadId,
        collection: HEAD_COLLECTION,
        action: '损耗停用',
        status: head.status,
        actor: actor || '',
        note: '累计损耗 ' + ledger.totalPoints + ' 点，达到 ' + ledger.threshold + ' 点停用线',
        data: { wearPoints: ledger.totalPoints, wearStatus }
      });
    } else if (head.wearStatus === '停用') {
      insertEvent({
        recordId: puppetHeadId,
        collection: HEAD_COLLECTION,
        action: resumedAction,
        status: head.status,
        actor: actor || '',
        note: resumedNote + '（当前累计 ' + ledger.totalPoints + ' 点）',
        data: { wearPoints: ledger.totalPoints, wearStatus }
      });
    }
  }
  return ledger;
}

module.exports = {
  SESSION_COLLECTION,
  MAINTENANCE_COLLECTION,
  HEAD_COLLECTION,
  sessionsForHead,
  lastMaintenanceForHead,
  openSessionForHead,
  ledgerForHead,
  syncHeadWear
};
