// 损耗计算：只负责点数规则，不碰存储。
// 轻场每分钟 1 点，常演 2 点，重场 3 点；累计到 120 点停用。
const LEVEL_RATES = {
  '轻场': 1,
  '常演': 2,
  '重场': 3
};

const DEACTIVATE_THRESHOLD = 120;

function isValidLevel(level) {
  return Object.prototype.hasOwnProperty.call(LEVEL_RATES, level);
}

function pointsFor(session) {
  const rate = LEVEL_RATES[session.level] || 0;
  return rate * Number(session.minutes || 0);
}

// 汇总一段排演单（通常是上次保养以来的全部场次），得出累计点数与是否停用。
function summarize(sessions) {
  const entries = sessions.map((session) => ({
    sessionId: session.id,
    level: session.level,
    minutes: session.minutes,
    repairCount: session.repairCount || 0,
    status: session.status,
    points: pointsFor(session),
    createdAt: session.createdAt
  }));
  const totalPoints = entries.reduce((sum, entry) => sum + entry.points, 0);
  return {
    entries,
    totalPoints,
    threshold: DEACTIVATE_THRESHOLD,
    deactivated: totalPoints >= DEACTIVATE_THRESHOLD
  };
}

module.exports = {
  LEVEL_RATES,
  DEACTIVATE_THRESHOLD,
  isValidLevel,
  pointsFor,
  summarize
};
