// level.js - 级数升级逻辑

// 升级规则 (掼蛋倒升级 / 上下游):
//  头游方 +3 级, 二游方 +1 级, 三游方 -1 级, 末游方 -3 级
const PLACE_DELTA = { 1: 3, 2: 1, 3: -1, 4: -3 };

// 给定一个 finishingOrder 数组 (0..3 的玩家下标, 按名次先后) 和当前级数
// 返回 { A: newLevel, B: newLevel }
// 规则: 每队按"本队最好名次"决定 delta
//   头游+3, 二游+1, 三游-1, 末游-3
// (一队即使 1+3 名, 也只算 +3; 1+4 名, 也只算 +3; 2+3 名, 只算 +1)
function computeLevelChange(finishingOrder, currentLevel) {
  // 计算每队的最佳名次 (数字越小名次越好)
  const bestPlace = { A: 99, B: 99 };
  finishingOrder.forEach((p, idx) => {
    const place = idx + 1; // 1..4
    const team = p % 2 === 0 ? 'A' : 'B';
    if (place < bestPlace[team]) bestPlace[team] = place;
  });
  // 应用每队最佳名次的 delta
  const teamLevel = {};
  for (const team of ['A', 'B']) {
    const delta = PLACE_DELTA[bestPlace[team]];
    const curIdx = window.GD.levelIndex(currentLevel);
    teamLevel[team] = window.GD.levelAt(curIdx + delta);
  }
  return teamLevel;
}

window.GD = window.GD || {};
Object.assign(window.GD, {
  PLACE_DELTA, computeLevelChange,
});
