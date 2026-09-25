// 台账：损耗数据的持久化层，只管读写 data/app.db 里的三张 wear_* 表，
// 不判断 409、不决定放行/停用（那是入口与损耗计算的事）。

const { runSql, select, sqlValue } = require('../db');

function initWearTables() {
  runSql(`
CREATE TABLE IF NOT EXISTS wear_orders (
  id TEXT PRIMARY KEY,
  puppet_head_id TEXT NOT NULL,
  level TEXT NOT NULL,
  minutes REAL NOT NULL,
  repairs INTEGER NOT NULL DEFAULT 0,
  points REAL NOT NULL,
  status TEXT NOT NULL,
  maintenance_id TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wear_orders_head ON wear_orders(puppet_head_id);
CREATE TABLE IF NOT EXISTS wear_maintenances (
  id TEXT PRIMARY KEY,
  puppet_head_id TEXT NOT NULL,
  handler TEXT NOT NULL,
  before_reading REAL NOT NULL,
  after_reading REAL NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wear_maint_head ON wear_maintenances(puppet_head_id);
CREATE TABLE IF NOT EXISTS wear_head_state (
  puppet_head_id TEXT PRIMARY KEY,
  deactivated INTEGER NOT NULL DEFAULT 0,
  deactivated_at TEXT,
  updated_at TEXT NOT NULL
);
`);
}

function toOrder(row) {
  return {
    id: row.id,
    puppetHeadId: row.puppet_head_id,
    level: row.level,
    minutes: row.minutes,
    repairs: row.repairs,
    points: row.points,
    status: row.status,
    maintenanceId: row.maintenance_id,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    updatedAt: row.updated_at
  };
}

function toMaintenance(row) {
  return {
    id: row.id,
    puppetHeadId: row.puppet_head_id,
    handler: row.handler,
    beforeReading: row.before_reading,
    afterReading: row.after_reading,
    note: row.note,
    createdAt: row.created_at
  };
}

function toHeadState(row) {
  return {
    puppetHeadId: row.puppet_head_id,
    deactivated: row.deactivated === 1,
    deactivatedAt: row.deactivated_at,
    updatedAt: row.updated_at
  };
}

function createOrder({ id, puppetHeadId, level, minutes, repairs, points, status, createdAt, updatedAt }) {
  runSql(
    'INSERT INTO wear_orders (id, puppet_head_id, level, minutes, repairs, points, status, maintenance_id, created_at, finished_at, updated_at) VALUES (' +
    [
      sqlValue(id),
      sqlValue(puppetHeadId),
      sqlValue(level),
      sqlValue(minutes),
      sqlValue(repairs),
      sqlValue(points),
      sqlValue(status),
      'NULL',
      sqlValue(createdAt),
      'NULL',
      sqlValue(updatedAt)
    ].join(', ') +
    ');'
  );
  return getOrder(id);
}

function getOrder(id) {
  const rows = select('SELECT * FROM wear_orders WHERE id = ' + sqlValue(id) + ' LIMIT 1;');
  return rows[0] ? toOrder(rows[0]) : null;
}

function listOrders({ puppetHeadId, status } = {}) {
  const conditions = [];
  if (puppetHeadId) conditions.push('puppet_head_id = ' + sqlValue(puppetHeadId));
  if (status) conditions.push('status = ' + sqlValue(status));
  const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
  return select('SELECT * FROM wear_orders' + where + ' ORDER BY created_at ASC, rowid ASC;').map(toOrder);
}

// 未结束演出：进行中的那一场，一只偶头至多一场。
function findOpenOrder(puppetHeadId) {
  const rows = select(
    'SELECT * FROM wear_orders WHERE puppet_head_id = ' + sqlValue(puppetHeadId) +
    " AND status = '进行中' ORDER BY created_at ASC LIMIT 1;"
  );
  return rows[0] ? toOrder(rows[0]) : null;
}

function updateOrder(id, fields, updatedAt) {
  const allowed = ['level', 'minutes', 'repairs', 'points'];
  const assignments = allowed
    .filter((key) => fields[key] !== undefined)
    .map((key) => ({ level: 'level', minutes: 'minutes', repairs: 'repairs', points: 'points' }[key]) + ' = ' + sqlValue(fields[key]));
  if (!assignments.length) return getOrder(id);
  runSql(
    'UPDATE wear_orders SET ' + assignments.join(', ') + ', updated_at = ' + sqlValue(updatedAt) +
    ' WHERE id = ' + sqlValue(id) + ';'
  );
  return getOrder(id);
}

function finishOrder(id, finishedAt) {
  runSql(
    "UPDATE wear_orders SET status = '已结束', finished_at = " + sqlValue(finishedAt) +
    ', updated_at = ' + sqlValue(finishedAt) + ' WHERE id = ' + sqlValue(id) + ';'
  );
  return getOrder(id);
}

function createMaintenance({ id, puppetHeadId, handler, beforeReading, afterReading, note, createdAt }) {
  runSql(
    'INSERT INTO wear_maintenances (id, puppet_head_id, handler, before_reading, after_reading, note, created_at) VALUES (' +
    [
      sqlValue(id),
      sqlValue(puppetHeadId),
      sqlValue(handler),
      sqlValue(beforeReading),
      sqlValue(afterReading),
      sqlValue(note || ''),
      sqlValue(createdAt)
    ].join(', ') +
    ');'
  );
  return getMaintenance(id);
}

function getMaintenance(id) {
  const rows = select('SELECT * FROM wear_maintenances WHERE id = ' + sqlValue(id) + ' LIMIT 1;');
  return rows[0] ? toMaintenance(rows[0]) : null;
}

function listMaintenances(puppetHeadId) {
  return select(
    'SELECT * FROM wear_maintenances WHERE puppet_head_id = ' + sqlValue(puppetHeadId) +
    ' ORDER BY created_at ASC, rowid ASC;'
  ).map(toMaintenance);
}

function latestMaintenance(puppetHeadId) {
  const rows = select(
    'SELECT * FROM wear_maintenances WHERE puppet_head_id = ' + sqlValue(puppetHeadId) +
    ' ORDER BY created_at DESC, rowid DESC LIMIT 1;'
  );
  return rows[0] ? toMaintenance(rows[0]) : null;
}

// 保养单登记后，把还挂着的演出单都结到这张保养单上；之后累计从保养后读数重新开始。
function settleOrders(puppetHeadId, maintenanceId) {
  runSql(
    'UPDATE wear_orders SET maintenance_id = ' + sqlValue(maintenanceId) +
    ' WHERE puppet_head_id = ' + sqlValue(puppetHeadId) + ' AND maintenance_id IS NULL;'
  );
}

// 自上次保养重算的范围：未被保养单结算过的演出单。
function unsettledOrders(puppetHeadId) {
  return select(
    'SELECT * FROM wear_orders WHERE puppet_head_id = ' + sqlValue(puppetHeadId) +
    ' AND maintenance_id IS NULL ORDER BY created_at ASC, rowid ASC;'
  ).map(toOrder);
}

function getHeadState(puppetHeadId) {
  const rows = select('SELECT * FROM wear_head_state WHERE puppet_head_id = ' + sqlValue(puppetHeadId) + ' LIMIT 1;');
  return rows[0] ? toHeadState(rows[0]) : null;
}

// 停用粘住：从停用置回可用只有保养回台一条路；再次停用保留首次停用时间。
function saveHeadState(puppetHeadId, deactivated, timestamp) {
  const existing = getHeadState(puppetHeadId);
  const deactivatedAt = deactivated
    ? (existing && existing.deactivated ? existing.deactivatedAt : timestamp)
    : null;
  if (existing) {
    runSql(
      'UPDATE wear_head_state SET deactivated = ' + (deactivated ? '1' : '0') +
      ', deactivated_at = ' + sqlValue(deactivatedAt) +
      ', updated_at = ' + sqlValue(timestamp) +
      ' WHERE puppet_head_id = ' + sqlValue(puppetHeadId) + ';'
    );
  } else {
    runSql(
      'INSERT INTO wear_head_state (puppet_head_id, deactivated, deactivated_at, updated_at) VALUES (' +
      [sqlValue(puppetHeadId), deactivated ? '1' : '0', sqlValue(deactivatedAt), sqlValue(timestamp)].join(', ') +
      ');'
    );
  }
  return getHeadState(puppetHeadId);
}

module.exports = {
  initWearTables,
  createOrder,
  getOrder,
  listOrders,
  findOpenOrder,
  updateOrder,
  finishOrder,
  createMaintenance,
  getMaintenance,
  listMaintenances,
  latestMaintenance,
  settleOrders,
  unsettledOrders,
  getHeadState,
  saveHeadState
};
