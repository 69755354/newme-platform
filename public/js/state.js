// state.js - 全局游戏状态 + AI 逻辑

// ============= 全局状态 =============
// 0=bottom(你), 1=right(AI1), 2=top(AI2), 3=left(AI3)
// 队友关系: 0-2(A队), 1-3(B队)
const state = {
  players: [[], [], [], []],     // 各玩家手牌
  level: '2',                      // 当前级数 ('2','3',...,'A')
  currentPlayer: 0,                // 当前出牌玩家
  lastPlay: null,                  // {type, value, length, cards}
  lastPlayPlayer: -1,              // 上一个出牌者下标
  passed: [false, false, false, false],
  selected: new Set(),             // 选中的牌 id
  gameOver: false,                 // 单局结束 (4 人都出完)
  round: 1,
  score: { A: 0, B: 0 },           // 总局分 (本游戏 session 内的总胜场)
  consecutivePasses: 0,
  difficulty: 'medium',            // easy/medium/hard
  finishingOrder: [],              // 出完顺序, e.g. [0, 1, 3, 2] = 玩家0头游, 玩家1二游...
  isPlaying: false,                // 防止 AI 重入
  // 持久化数据 (跨局保留)
  totalGames: 0,
  wins: 0,
  teamLevels: { A: '2', B: '2' },  // 两队各自的级数 (跨局保留)
};

// 难度参数
// brinkThreshold: 敌家手牌数 ≤ 该值视为"临界" (用于 P2 炸临界判断)
// reserveBombIfHandGt: 手牌 > 该值时省炸弹/王炸/同花顺 (null = 不省, 用于 P5)
// endgameIfHandLe: 手牌 ≤ 该值时进入残局控制 (用于 P6 控制单牌节奏)
const DIFFICULTY_PARAMS = {
  easy:   { teammatePassRate: 0.4,  bombWasteRate: 0.4,  mistakeRate: 0.25, brinkThreshold: 1, reserveBombIfHandGt: null, endgameIfHandLe: null },
  medium: { teammatePassRate: 0.7,  bombWasteRate: 0.15, mistakeRate: 0.10, brinkThreshold: 2, reserveBombIfHandGt: 10,  endgameIfHandLe: 2 },
  hard:   { teammatePassRate: 0.85, bombWasteRate: 0.05, mistakeRate: 0.02, brinkThreshold: 2, reserveBombIfHandGt: 6,   endgameIfHandLe: 4 },
};

// ============= 出牌流程 =============
function nextTurn() {
  state.currentPlayer = (state.currentPlayer + 1) % 4;
}

function passPlay(playerIdx) {
  state.passed[playerIdx] = true;
  state.consecutivePasses++;
  if (state.consecutivePasses >= 3) {
    // 3 人都过牌 -> 重新开始新一轮, 最后出牌者自由出牌
    state.lastPlay = null;
    state.lastPlayPlayer = playerIdx;
    state.passed = [false, false, false, false];
    state.consecutivePasses = 0;
  }
}

// 找出手中所有可识别的牌型组合 (合理子集, 用于 AI 决策和提示)
// 缓存: 同一手牌+级数反复分析, 避免每帧重算
const comboCache = new Map();
const COMBO_CACHE_MAX = 4;
function findAllCombinations(hand, level) {
  const sig = hand.map(c => c.rank + c.suit).sort().join('|') + '@' + level;
  if (comboCache.has(sig)) return comboCache.get(sig);
  if (comboCache.size >= COMBO_CACHE_MAX) {
    // 淘汰最旧条目 (Map 保留插入顺序)
    const firstKey = comboCache.keys().next().value;
    comboCache.delete(firstKey);
  }
  const results = findAllCombinationsUncached(hand, level, sig);
  comboCache.set(sig, results);
  return results;
}
function findAllCombinationsUncached(hand, level, sig) {
  const { cardValue } = window.GD;
  const results = [];
  const byValue = {};
  hand.forEach((c) => {
    const v = cardValue(c, level);
    if (!byValue[v]) byValue[v] = [];
    byValue[v].push(c);
  });
  const values = Object.keys(byValue).map(Number).sort((a, b) => a - b);
  // 王炸
  const hasJoker = hand.filter(c => c.rank === '小王' || c.rank === '大王');
  if (hasJoker.length === 2) {
    results.push({ type: 'rocket', value: 100, length: 2, cards: hasJoker });
  }
  if (hasJoker.length === 4) {
    results.push({ type: 'rocket', value: 200, length: 4, cards: hasJoker });
  }
  // 单张
  hand.forEach((c) => results.push({ type: 'single', value: cardValue(c, level), length: 1, cards: [c] }));
  // 对子
  for (const v of values) {
    if (byValue[v].length >= 2 && v < 17) {
      results.push({ type: 'pair', value: v, length: 2, cards: byValue[v].slice(0, 2) });
    }
  }
  // 三张
  for (const v of values) {
    if (byValue[v].length >= 3 && v < 17) {
      results.push({ type: 'triple', value: v, length: 3, cards: byValue[v].slice(0, 3) });
    }
  }
  // 炸弹
  for (const v of values) {
    if (byValue[v].length === 4 && v < 17) {
      results.push({ type: 'bomb', value: v, length: 4, cards: byValue[v] });
    }
  }
  // 三带一/三带二
  for (const v of values) {
    if (byValue[v].length >= 3 && v < 17) {
      const triple = byValue[v].slice(0, 3);
      // 三带一
      for (const ov of values) {
        if (ov !== v) {
          for (const oc of byValue[ov]) {
            if (!triple.includes(oc)) {
              results.push({ type: 'triple_single', value: v, length: 4, cards: [...triple, oc] });
              break;
            }
          }
        }
      }
      // 三带二
      for (const ov of values) {
        if (ov !== v && byValue[ov].length >= 2) {
          results.push({ type: 'triple_pair', value: v, length: 5, cards: [...triple, ...byValue[ov].slice(0, 2)] });
          break;
        }
      }
    }
  }
  // 钢板/飞机 (2+ 连续三张)
  const triples = [];
  for (let start = 0; start < values.length; start++) {
    if (values[start] >= 15) break;
    if (byValue[values[start]].length < 3) continue;
    let len = 1;
    const cards = [...byValue[values[start]].slice(0, 3)];
    while (start + len < values.length &&
           values[start + len] === values[start + len - 1] + 1 &&
           values[start + len] < 15 &&
           byValue[values[start + len]].length >= 3) {
      cards.push(...byValue[values[start + len]].slice(0, 3));
      len++;
    }
    if (len >= 2) {
      triples.push({ startValue: values[start], length: len, cards: cards.slice() });
    }
  }
  // 纯飞机
  for (const t of triples) {
    results.push({ type: 'plane', value: t.startValue, length: t.length * 3, cards: t.cards });
  }
  // 飞机带单/带对
  for (const t of triples) {
    const usedIds = new Set(t.cards.map((c) => c.id));
    const remaining = hand.filter((c) => {
      if (usedIds.has(c.id)) return false;
      const v = cardValue(c, level);
      if (v >= 15) return false; // 排除 2 和大小王
      return true;
    });
    // 飞机带单
    const singleWings = [];
    const usedWingValues = new Set();
    for (const c of remaining) {
      if (singleWings.length >= t.length) break;
      const v = cardValue(c, level);
      if (usedWingValues.has(v)) continue;
      singleWings.push(c);
      usedWingValues.add(v);
    }
    if (singleWings.length === t.length) {
      results.push({ type: 'plane_single', value: t.startValue, length: t.length * 4, cards: [...t.cards, ...singleWings] });
    }
    // 飞机带对
    const pairWings = [];
    const usedPairValues = new Set();
    for (const c of remaining) {
      if (pairWings.length >= t.length * 2) break;
      const v = cardValue(c, level);
      if (usedPairValues.has(v)) continue;
      const pair = remaining.filter((x) => cardValue(x, level) === v);
      if (pair.length >= 2) {
        pairWings.push(pair[0], pair[1]);
        usedPairValues.add(v);
      }
    }
    if (pairWings.length >= t.length * 2) {
      results.push({ type: 'plane_pair', value: t.startValue, length: t.length * 5, cards: [...t.cards, ...pairWings.slice(0, t.length * 2)] });
    }
  }
  // 顺子 (5-12 张)
  const straightValues = values.filter((v) => v < 15);
  for (let len = 5; len <= 12; len++) {
    for (let start = 0; start + len - 1 < straightValues.length; start++) {
      let ok = true;
      for (let i = 0; i < len; i++) {
        if (i > 0 && straightValues[start + i] !== straightValues[start + i - 1] + 1) { ok = false; break; }
      }
      if (ok) {
        const cards = [];
        for (let i = 0; i < len; i++) {
          cards.push(byValue[straightValues[start + i]][0]);
        }
        results.push({ type: 'straight', value: straightValues[start], length: len, cards });
      }
    }
  }
  // 连对 (3-6 对)
  const pairValues = values.filter((v) => v < 15 && byValue[v].length >= 2);
  for (let len = 3; len <= 6; len++) {
    for (let start = 0; start + len - 1 < pairValues.length; start++) {
      let ok = true;
      for (let i = 0; i < len; i++) {
        if (i > 0 && pairValues[start + i] !== pairValues[start + i - 1] + 1) { ok = false; break; }
      }
      if (ok) {
        const cards = [];
        for (let i = 0; i < len; i++) {
          cards.push(byValue[pairValues[start + i]][0]);
          cards.push(byValue[pairValues[start + i]][1]);
        }
        results.push({ type: 'pair_straight', value: pairValues[start], length: len * 2, cards });
      }
    }
  }
  // 同花顺
  const suitGroups = {};
  hand.forEach((c) => {
    if (c.rank === '小王' || c.rank === '大王') return;
    if (cardValue(c, level) >= 15) return;
    if (!suitGroups[c.suit]) suitGroups[c.suit] = [];
    suitGroups[c.suit].push(c);
  });
  for (const suit in suitGroups) {
    const arr = suitGroups[suit].sort((a, b) => cardValue(a, level) - cardValue(b, level));
    for (let len = 5; len <= 12; len++) {
      for (let i = 0; i + len <= arr.length; i++) {
        let ok = true;
        for (let j = 1; j < len; j++) {
          if (cardValue(arr[i + j], level) !== cardValue(arr[i + j - 1], level) + 1) { ok = false; break; }
        }
        if (ok) {
          results.push({ type: 'flush_straight', value: cardValue(arr[i], level), length: len, cards: arr.slice(i, i + len) });
        }
      }
    }
  }
  return results;
}

// ============= AI 辅助函数 =============
// isBombClass: 牌型属于"高价值炸类" (普通炸弹 / 王炸 / 同花顺)
// 用于: P2 (炸临界), P5 (省炸), P7 (不让炸队友), scoreLead P2
function isBombClass(play) {
  if (!play) return false;
  return play.type === 'bomb' || play.type === 'rocket' || play.type === 'flush_straight';
}

// isBigSingle: 单张且牌值 ≥ 14 (A, 2, 级牌, 小/大王)
// 用于: P6 单牌控制, scoreLead 反向鼓励出大牌
function isBigSingle(play) {
  if (!play) return false;
  return play.type === 'single' && play.value >= 14;
}

// efficiency: 打出张数 / max(1, 牌值) — 单位"牌力"消耗的牌数
// 越大说明"用小牌力换多张牌"越划算, 用于 P4 鼓励出高效牌型
function efficiency(play) {
  if (!play) return 0;
  return play.cards.length / Math.max(1, play.value);
}

// wouldBombTeammate: 当前若用炸类追打队友刚出的牌, 等于"炸队友"
// 用于: P7 在评分中作为硬门 (-Infinity)
function wouldBombTeammate(play, teammate) {
  if (!play || !isBombClass(play)) return false;
  if (state.lastPlayPlayer !== teammate) return false;
  if (!state.lastPlay) return false;
  return true;
}

// scorePlay: 跟牌场景下给候选牌打分 (分数越高越优先)
// 实现 8 条启发式 P1-P8, 见脚本注释
function scorePlay(play, ctx) {
  // P7 硬门: 炸队友直接否决
  if (wouldBombTeammate(play, ctx.teammate)) return -Infinity;
  const params = DIFFICULTY_PARAMS[state.difficulty];
  let score = 0;
  // P1 直接清完手牌: +1000
  if (play.cards.length === ctx.hand.length) score += 1000;
  // P2 敌家已临界, 用炸/王炸/同花顺压: +950
  if (ctx.oppAtBrink && isBombClass(play)) score += 950;
  // P3 队友刚出 -> 跟牌, 不帮队友添牌: -500 (非清完情况)
  if (state.lastPlayPlayer === ctx.teammate && play.cards.length !== ctx.hand.length) score -= 500;
  // P4 卡牌效率: 出越多牌/越低牌力 越好
  score += efficiency(play) * 70;
  // P5 省炸: 手牌较多且非清完时, 优先用非炸类
  if (params.reserveBombIfHandGt !== null && isBombClass(play) &&
      ctx.hand.length > params.reserveBombIfHandGt &&
      play.cards.length !== ctx.hand.length) score -= 60;
  // P6 残局单牌控制: 残局时保留大牌不乱出 (-55)
  if (params.endgameIfHandLe !== null && !ctx.isLead &&
      ctx.hand.length <= params.endgameIfHandLe && isBigSingle(play)) score -= 55;
  // P8 缺省倾向: 出小牌/短牌型
  const sortKey = play.cards.length * 1000 + play.value;
  score -= sortKey * 0.3;
  return score;
}

// scoreLead: 领牌 (或被逼领牌) 场景下的评分变体
// 与 scorePlay 区别: P6 翻转 +55 (残局领牌要出大牌), P2 调幅 +200
function scoreLead(play, ctx) {
  // P7 硬门同样生效
  if (wouldBombTeammate(play, ctx.teammate)) return -Infinity;
  const params = DIFFICULTY_PARAMS[state.difficulty];
  let score = 0;
  // P1 直接清完
  if (play.cards.length === ctx.hand.length) score += 1000;
  // P2 lead amp: 敌家临界时领炸分更高 (相比 P2 跟牌 950)
  if (ctx.oppAtBrink && isBombClass(play)) score += 200;
  // P3 队友刚出 (mustPlay 边界情况下保留)
  if (state.lastPlayPlayer === ctx.teammate && play.cards.length !== ctx.hand.length) score -= 500;
  // P4 卡牌效率
  score += efficiency(play) * 70;
  // P5 省炸
  if (params.reserveBombIfHandGt !== null && isBombClass(play) &&
      ctx.hand.length > params.reserveBombIfHandGt &&
      play.cards.length !== ctx.hand.length) score -= 60;
  // P6 flip: 残局领牌时, 主动出大牌控制节奏 (+55)
  if (params.endgameIfHandLe !== null && ctx.hand.length <= params.endgameIfHandLe &&
      isBigSingle(play)) score += 55;
  // P8 缺省倾向
  const sortKey = play.cards.length * 1000 + play.value;
  score -= sortKey * 0.3;
  return score;
}

// ============= AI 出牌 (评分式) =============
function aiPlay(playerIdx) {
  if (state.gameOver) return;
  const { canBeat } = window.GD;
  const hand = state.players[playerIdx];
  const teammate = playerIdx % 2 === 0 ? (playerIdx === 0 ? 2 : 0) : (playerIdx === 1 ? 3 : 1);
  const params = DIFFICULTY_PARAMS[state.difficulty];
  const isLead = !state.lastPlay;
  const mustPlay = state.lastPlayPlayer === playerIdx;

  // 队友刚出牌 -> 让队友继续 (高概率过牌, 除非自身即将清完)
  if (!mustPlay && !isLead && state.lastPlayPlayer === teammate &&
      Math.random() < params.teammatePassRate) {
    passPlay(playerIdx);
    return;
  }

  // 构造评分上下文 (敌家临界: 任意敌家手牌 ≤ brinkThreshold)
  const opponents = [0, 1, 2, 3].filter((p) => p !== playerIdx && p !== teammate);
  const oppAtBrink = opponents.some((p) => state.players[p].length <= params.brinkThreshold);
  const ctx = { hand, teammate, isLead, oppAtBrink };

  const candidates = findAllCombinations(hand, state.level);
  let playable = candidates.filter((c) => canBeat(state.lastPlay, c, state.level));

  // 领牌 / 必须出牌 (无压牌或上家是自己)
  if (mustPlay || isLead) {
    if (candidates.length === 0) return;
    let best = null;
    let bestScore = -Infinity;
    for (const c of candidates) {
      const s = scoreLead(c, ctx);
      if (s > bestScore) { bestScore = s; best = c; }
    }
    if (!best) {
      candidates.sort((a, b) => a.cards.length - b.cards.length || a.value - b.value);
      best = candidates[0];
    }
    playCards(playerIdx, best.cards);
    return;
  }

  // 跟牌: 没有可压 -> 过
  if (!playable.length) { passPlay(playerIdx); return; }
  let best = null;
  let bestScore = -Infinity;
  for (const c of playable) {
    const s = scorePlay(c, ctx);
    if (s > bestScore) { bestScore = s; best = c; }
  }
  // 硬门命中 (炸队友) -> 过牌
  if (!best || bestScore === -Infinity) { passPlay(playerIdx); return; }
  // 简单模式: 概率犯蠢
  if (state.difficulty === 'easy' && Math.random() < params.mistakeRate && playable.length > 1) {
    best = playable[Math.floor(Math.random() * Math.min(3, playable.length))];
  }
  playCards(playerIdx, best.cards);
}

// ============= 玩家出牌 (通用) =============
function playCards(playerIdx, cards) {
  const { identifyCards, playTypeName } = window.GD;
  const ident = identifyCards(cards, state.level);
  if (!ident) return false;
  // 移除手牌
  const ids = new Set(cards.map((c) => c.id));
  state.players[playerIdx] = state.players[playerIdx].filter((c) => !ids.has(c.id));
  comboCache.clear();
  state.lastPlay = ident;
  state.lastPlayPlayer = playerIdx;
  state.passed = [false, false, false, false];
  state.selected.clear();
  state.consecutivePasses = 0;

  // 记录到日志
  const playerName = playerIdx === 0 ? '你' : 'AI' + playerIdx;
  const cardStr = cards.slice(0, 3).map((c) => c.rank + c.suit).join('') + (cards.length > 3 ? '...' : '');
  const typeName = playTypeName(ident.type, ident.length);
  let typeClass = 'enemy';
  if (playerIdx === 0) typeClass = 'mine';
  else if (playerIdx % 2 === 0) typeClass = 'partner';
  logAction(`${playerName}: ${typeName} (${cardStr})`, typeClass);

  // 记录牌型
  if (window.GD.stats) {
    window.GD.stats.typesPlayed.add(ident.type);
    if (ident.type === 'bomb') window.GD.checkAchievement && window.GD.checkAchievement('firstBomb');
    if (ident.type === 'rocket') window.GD.checkAchievement && window.GD.checkAchievement('firstRocket');
    if (ident.type === 'flush_straight') window.GD.checkAchievement && window.GD.checkAchievement('firstFlushStraight');
    if (ident.type.startsWith('plane')) window.GD.checkAchievement && window.GD.checkAchievement('firstPlane');
    if (window.GD.stats.typesPlayed.size >= 10) window.GD.checkAchievement && window.GD.checkAchievement('playAllTypes');
  }

  // 出完牌了 -> 记录名次
  if (state.players[playerIdx].length === 0) {
    state.finishingOrder.push(playerIdx);
    // 给该玩家盖"出完"标记
    if (window.GD.markFinished) window.GD.markFinished(playerIdx);
  }
  // 所有玩家都出完才结束
  if (state.finishingOrder.length >= 4) {
    state.gameOver = true;
    return true;
  }
  return true;
}

window.GD = window.GD || {};
Object.assign(window.GD, {
  state, DIFFICULTY_PARAMS,
  nextTurn, passPlay, findAllCombinations, aiPlay, playCards,
  comboCache,
  // AI 评分辅助
  isBombClass, isBigSingle, efficiency, wouldBombTeammate,
  scorePlay, scoreLead,
});
