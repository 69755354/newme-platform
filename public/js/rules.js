// rules.js - 掼蛋核心规则
// 纯规则模块, 不依赖 DOM, 可被 Node 测试环境 require

// ============= 基础定义 =============
const SUITS = ['♠', '♥', '♦', '♣'];
const SUIT_COLOR = { '♠': 'black', '♥': 'red', '♦': 'red', '♣': 'black' };

// 牌值: 3-10, J, Q, K, A, 2, 小王, 大王
// 数字越小牌越小. 2 > A > K > ... > 3
// 级牌(2 之外)作为"主级"替换
const RANKS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
const RANK_VALUE = {};
RANKS.forEach((r, i) => { RANK_VALUE[r] = i + 3; }); // 3=3 ... A=14, 2=15

// 级数升级顺序: 2 → 3 → ... → A
// (level 2 是初始级数, 玩到 A 即"打A"胜利)
const LEVEL_ORDER = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

// ============= 牌值计算 =============
function getRankValue(rank, level) {
  // level 牌的等级 (默认 2)
  const lvValue = RANK_VALUE[String(level)] || 15;
  if (rank === '小王') return 16;
  if (rank === '大王') return 17;
  let v = RANK_VALUE[rank];
  // 级牌比2大一档 (level=2 时此分支不触发, 2 保持 15 仍然最大)
  if (v < 15 && v === lvValue) return 16;
  return v;
}

function cardKey(card) {
  return card.rank === '小王' || card.rank === '大王' ? card.rank : card.rank + card.suit;
}

function cardValue(c, level) {
  return getRankValue(c.rank, level);
}

// 把级数名 ('2', '3', ..., 'A') 转成下标
function levelIndex(level) {
  return LEVEL_ORDER.indexOf(String(level));
}

// 给定下标, 返回新的级数 (超过 A 则停在 A)
function levelAt(idx) {
  if (idx < 0) return LEVEL_ORDER[0];
  if (idx >= LEVEL_ORDER.length) return LEVEL_ORDER[LEVEL_ORDER.length - 1];
  return LEVEL_ORDER[idx];
}

// 给定当前级数和获胜方, 返回升级后两队的新级数
// 头游方 +3, 末游方 -3 (倒升级)
function applyLevelChange(currentLevel, winningTeam) {
  const curIdx = levelIndex(currentLevel);
  let aNew, bNew;
  if (winningTeam === 'A') {
    aNew = levelAt(curIdx + 3);
    bNew = levelAt(curIdx - 3);
  } else {
    aNew = levelAt(curIdx - 3);
    bNew = levelAt(curIdx + 3);
  }
  return { A: aNew, B: bNew };
}

// ============= 牌型识别 =============
// 验证按值排序的 values 数组中, 每连续 3 个是否构成等值三张且三张之间值连续
// 成功则返回三张牌的值数组, 失败返回 null
function isConsecutiveTriples(values, planeLen) {
  const tripleValues = [];
  for (let i = 0; i < planeLen; i++) {
    const v = values[i * 3];
    if (values[i * 3] !== values[i * 3 + 1] || values[i * 3 + 1] !== values[i * 3 + 2]) {
      return null;
    }
    tripleValues.push(v);
  }
  for (let i = 1; i < planeLen; i++) {
    if (tripleValues[i] !== tripleValues[i - 1] + 1) return null;
  }
  return tripleValues;
}

// 返回 {type, value, length, cards} 或 null
function identifyCards(cards, level, opts = {}) {
  if (!cards || cards.length === 0) return null;
  if (!opts.presorted) {
    cards = [...cards].sort((a, b) => cardValue(a, level) - cardValue(b, level));
  }
  const n = cards.length;
  const isJoker = c => c.rank === '小王' || c.rank === '大王';
  const values = cards.map(c => cardValue(c, level));
  const noJoker = !isJoker(cards[0]);
  let hasTwo = false, hasLevel = false;
  for (const v of values) {
    if (v === 15) hasTwo = true;
    else if (v === 16) hasLevel = true;
  }
  const noHigh = !hasTwo && !hasLevel;

  // 王炸 (必须包含大小王各一, 不能是双小王/双大王)
  const hasSmall = cards.some(c => c.rank === '小王');
  const hasBig = cards.some(c => c.rank === '大王');
  if (n === 2 && hasSmall && hasBig) {
    return { type: 'rocket', value: 100, length: 2, cards };
  }
  if (n === 4 && hasSmall && hasBig) {
    return { type: 'rocket', value: 200, length: 4, cards };
  }
  // 四张相同(炸弹)
  if (n === 4 && values.every(v => v === values[0]) && noJoker) {
    return { type: 'bomb', value: values[0], length: 4, cards };
  }
  // 单张
  if (n === 1) return { type: 'single', value: values[0], length: 1, cards };
  // 对子
  if (n === 2 && values[0] === values[1] && noJoker) {
    return { type: 'pair', value: values[0], length: 2, cards };
  }
  // 三张
  if (n === 3 && values.every(v => v === values[0]) && noJoker) {
    return { type: 'triple', value: values[0], length: 3, cards };
  }
  // 三带一
  if (n === 4) {
    const groups = {};
    values.forEach((v) => { groups[v] = (groups[v] || 0) + 1; });
    const triples = Object.keys(groups).filter(k => groups[k] === 3);
    if (triples.length === 1) {
      return { type: 'triple_single', value: parseInt(triples[0]), length: 4, cards };
    }
  }
  // 三带二
  if (n === 5) {
    const groups = {};
    values.forEach((v) => { groups[v] = (groups[v] || 0) + 1; });
    const triples = Object.keys(groups).filter(k => groups[k] === 3);
    if (triples.length === 1) {
      return { type: 'triple_pair', value: parseInt(triples[0]), length: 5, cards };
    }
  }
  // 顺子(5+张) - 含同花顺
  if (n >= 5 && n <= 12 && noJoker && noHigh) {
    const suit0 = cards[0].suit;
    const isFlush = cards.every(c => c.suit === suit0);
    let consecutive = true;
    for (let i = 1; i < n; i++) {
      if (values[i] !== values[i - 1] + 1) { consecutive = false; break; }
    }
    if (consecutive) {
      return isFlush
        ? { type: 'flush_straight', value: values[0], length: n, cards }
        : { type: 'straight', value: values[0], length: n, cards };
    }
  }
  // 连对(3+对, 6+张)
  if (n >= 6 && n % 2 === 0 && noJoker && noHigh) {
    let ok = true;
    for (let i = 0; i < n; i += 2) {
      if (values[i] !== values[i + 1]) { ok = false; break; }
      if (i > 0 && values[i] !== values[i - 2] + 1) { ok = false; break; }
    }
    if (ok) return { type: 'pair_straight', value: values[0], length: n, cards };
  }
  // 钢板(2+连续三张)
  if (n >= 6 && n % 3 === 0 && noJoker && noHigh) {
    let ok = true;
    for (let i = 0; i < n; i += 3) {
      if (!(values[i] === values[i + 1] && values[i + 1] === values[i + 2])) { ok = false; break; }
      if (i > 0 && values[i] !== values[i - 3] + 1) { ok = false; break; }
    }
    if (ok) return { type: 'plane', value: values[0], length: n, cards };
  }
  // 飞机带单(连续三张 + 等量单张翅膀, n=planeLen*4)
  if (n >= 8 && n % 4 === 0 && noJoker && noHigh) {
    const planeLen = n / 4;
    const tripleValues = isConsecutiveTriples(values, planeLen);
    if (tripleValues) {
      // 验证翅膀是单张 (相邻翅膀值不重复)
      let wingsOk = true;
      const wingStart = planeLen * 3;
      for (let i = 0; i < planeLen; i++) {
        if (i + 1 < planeLen && values[wingStart + i] === values[wingStart + i + 1]) {
          wingsOk = false; break;
        }
      }
      if (wingsOk) {
        return { type: 'plane_single', value: tripleValues[0], length: n, cards };
      }
    }
  }
  // 飞机带对(连续三张 + 等量对子翅膀, n=planeLen*5)
  if (n >= 10 && n % 5 === 0 && noJoker && noHigh) {
    const planeLen = n / 5;
    const tripleValues = isConsecutiveTriples(values, planeLen);
    if (tripleValues) {
      // 验证翅膀是对子
      let wingsOk = true;
      const wingStart = planeLen * 3;
      for (let i = 0; i < planeLen; i++) {
        const w1 = values[wingStart + i * 2];
        const w2 = values[wingStart + i * 2 + 1];
        if (w1 !== w2) { wingsOk = false; break; }
      }
      if (wingsOk) {
        return { type: 'plane_pair', value: tripleValues[0], length: n, cards };
      }
    }
  }
  return null;
}

// 是否能压过
function canBeat(prev, curr, level) {
  if (!prev) return true;
  // 王炸最大
  if (curr.type === 'rocket') {
    if (prev.type === 'rocket') return curr.value > prev.value;
    return true;
  }
  if (prev.type === 'rocket') return false;
  // 同花顺比大小
  if (curr.type === 'flush_straight' && prev.type === 'flush_straight') {
    return curr.length === prev.length && curr.value > prev.value;
  }
  if (curr.type === 'flush_straight') return true;
  if (prev.type === 'flush_straight') return false;
  // 炸弹比大小
  if (curr.type === 'bomb' && prev.type === 'bomb') return curr.value > prev.value;
  if (curr.type === 'bomb') return true;
  if (prev.type === 'bomb') return false;
  // 同类型比较
  if (prev.type !== curr.type) return false;
  if (prev.length !== curr.length) return false;
  return curr.value > prev.value;
}

// ============= 牌型名称 =============
function playTypeName(type, len) {
  const map = {
    single: '单张',
    pair: '对子',
    triple: '三张',
    triple_single: '三带一',
    triple_pair: '三带二',
    straight: len + '张顺子',
    pair_straight: '连对',
    plane: '钢板',
    plane_single: '飞机带单',
    plane_pair: '飞机带对',
    bomb: '炸弹',
    rocket: '王炸',
    flush_straight: '同花顺',
  };
  return map[type] || type;
}

// ============= 模块导出 (浏览器全局) =============
window.GD = window.GD || {};
Object.assign(window.GD, {
  SUITS, SUIT_COLOR, RANKS, RANK_VALUE, LEVEL_ORDER,
  getRankValue, cardKey, cardValue,
  levelIndex, levelAt, applyLevelChange,
  identifyCards, canBeat, playTypeName,
});
