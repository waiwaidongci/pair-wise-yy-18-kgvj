// 损耗计算：纯函数模块，不碰数据库与 HTTP，方便单独核对规则。
//
// 规则（巡演连排损耗）：
//   轻场每分钟 1 点，常演每分钟 2 点，重场每分钟 3 点；
//   每场登记的修补次数另计损耗（每次 REPAIR_POINTS 点，妆面/机关/提线修补都算损耗事件）；
//   自上次保养的“保养后读数”起累计，累计 >= THRESHOLD 即停用；
//   停用是“粘住”的：重算只会把放行变成停用，只有保养单写明处理人和前后读数后才能回台。

const LEVEL_RATES = {
  轻场: 1,
  常演: 2,
  重场: 3
};

const REPAIR_POINTS = 1;
const THRESHOLD = 120;

function isValidLevel(level) {
  return Object.prototype.hasOwnProperty.call(LEVEL_RATES, level);
}

function levelRate(level) {
  return LEVEL_RATES[level];
}

// 一单演出的损耗点 = 分钟数 × 等级费率 + 修补次数 × 每次修补点
function pointsForOrder({ level, minutes, repairs = 0 }) {
  return minutes * LEVEL_RATES[level] + repairs * REPAIR_POINTS;
}

// 汇总某偶头自上次保养以来的累计损耗。
// baseline：上次保养的保养后读数（没有保养记录则为 0）
// orders：尚未被任何保养单结算的演出单（按时间正序）
// latchedDeactivated：台账上已停用且尚未经保养解除
function summarize({ baseline = 0, orders = [], latchedDeactivated = false } = {}) {
  const orderPoints = orders.reduce((sum, order) => sum + order.points, 0);
  const cumulative = baseline + orderPoints;
  const deactivated = latchedDeactivated || cumulative >= THRESHOLD;
  return {
    baseline,
    orderPoints,
    cumulative,
    threshold: THRESHOLD,
    remaining: Math.max(0, THRESHOLD - cumulative),
    deactivated,
    clearance: deactivated ? '停用' : '放行'
  };
}

// 台账流水：合并演出单与保养单并按时间排列，逐笔给出累计读数；
// 保养单把读数重置为保养后读数，演出单在当前读数上累加本单损耗。
function buildLedger({ orders = [], maintenances = [] } = {}) {
  const entries = [
    ...orders.map((order) => ({
      type: '演出单',
      id: order.id,
      time: order.createdAt,
      level: order.level,
      minutes: order.minutes,
      repairs: order.repairs,
      points: order.points,
      status: order.status
    })),
    ...maintenances.map((maintenance) => ({
      type: '保养单',
      id: maintenance.id,
      time: maintenance.createdAt,
      handler: maintenance.handler,
      beforeReading: maintenance.beforeReading,
      afterReading: maintenance.afterReading,
      note: maintenance.note
    }))
  ].sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));

  let reading = 0;
  for (const entry of entries) {
    reading = entry.type === '保养单' ? entry.afterReading : reading + entry.points;
    entry.reading = reading;
    entry.deactivatedHere = reading >= THRESHOLD;
  }
  return entries;
}

module.exports = {
  LEVEL_RATES,
  REPAIR_POINTS,
  THRESHOLD,
  isValidLevel,
  levelRate,
  pointsForOrder,
  summarize,
  buildLedger
};
