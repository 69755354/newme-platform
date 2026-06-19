// extras.js - 教程、成就、提示、快捷出牌、游戏结束弹窗、手牌分析

// 注意: 不要在顶层解构 window.GD, 会和 rules.js 中的 const 声明冲突
// 统一通过 window.GD.X 访问

// ============= 手牌分析 =============
function analyzeHand(hand, level) {
  const { cardValue } = window.GD;
  const analysis = {
    singles: 0, pairs: 0, triples: 0, bombs: 0,
    rockets: 0, jokers: 0,
    smallestSingle: null, largestSingle: null,
  };
  const singles = hand.filter((c) => c.rank !== '小王' && c.rank !== '大王');
  singles.sort((a, b) => cardValue(a, level) - cardValue(b, level));
  if (singles.length) {
    analysis.smallestSingle = singles[0];
    analysis.largestSingle = singles[singles.length - 1];
  }
  const byValue = {};
  hand.forEach((c) => {
    const v = cardValue(c, level);
    if (!byValue[v]) byValue[v] = [];
    byValue[v].push(c);
  });
  for (const v in byValue) {
    const n = byValue[v].length;
    if (n === 1) analysis.singles++;
    else if (n === 2) analysis.pairs++;
    else if (n === 3) analysis.triples++;
    else if (n === 4) analysis.bombs++;
  }
  const jokers = hand.filter((c) => c.rank === '小王' || c.rank === '大王');
  analysis.jokers = jokers.length;
  if (jokers.length === 2) analysis.rockets = 1;
  if (jokers.length === 4) analysis.rockets = 2;
  return analysis;
}

// ============= 成就系统 =============
const achievements = {
  firstBomb:          { name: '💣 初识炸弹',     desc: '第一次打出炸弹',          unlocked: false },
  firstRocket:        { name: '🚀 王炸!',         desc: '第一次打出王炸',          unlocked: false },
  firstFlushStraight: { name: '🌟 同花顺!',       desc: '第一次打出同花顺',        unlocked: false },
  firstPlane:         { name: '✈️ 飞机起飞',     desc: '第一次打出飞机',          unlocked: false },
  firstWin:           { name: '🏆 首次胜利',     desc: '赢得第一局',              unlocked: false },
  threeWins:          { name: '🎖️ 三连胜',       desc: '累计赢得 3 局',           unlocked: false },
  playAllTypes:       { name: '🎴 牌型大师',     desc: '在一局中使用过 10 种牌型', unlocked: false },
  passMaster:         { name: '🤝 团队合作',     desc: '在队友出牌时连续过牌 5 次', unlocked: false },
  levelUp:            { name: '⬆️ 步步高升',     desc: '级数提升',                unlocked: false },
  levelDown:          { name: '⬇️ 跌宕起伏',     desc: '级数下降',                unlocked: false },
  reachAce:           { name: '👑 打上 A',        desc: '级数打到 A',              unlocked: false },
  easyVictory:        { name: '🌱 新手起步',     desc: '在简单难度获胜',          unlocked: false },
  hardVictory:        { name: '🔥 高手过招',     desc: '在困难难度获胜',          unlocked: false },
  singleHandWin:      { name: '💎 一气呵成',     desc: '一手牌打完 (头游)',        unlocked: false },
  // === 新增 7 个成就 ===
  bombSpammer:        { name: '💣 炸弹狂人',     desc: '累计打出 10 个炸弹',       unlocked: false },
  flushFan:           { name: '🌟 同花顺达人',   desc: '累计打出 3 次同花顺',     unlocked: false },
  winStreak3:         { name: '🔥 三连胜',       desc: '任意 3 连胜',             unlocked: false },
  winStreak5:         { name: '⚡ 五连胜',       desc: '任意 5 连胜',             unlocked: false },
  veteran:            { name: '🎖️ 老兵',         desc: '完成 50 局',              unlocked: false },
  centurion:          { name: '👴 百战老将',     desc: '完成 100 局',             unlocked: false },
  luckyDraw:          { name: '🍀 天选之人',     desc: '开局手牌含 4 张大小王',   unlocked: false },
};

const stats = {
  wins: 0,
  totalGames: 0,
  typesPlayed: new Set(),
  teammatePasses: 0,
  gameStats: [], // 每局结果
  // === 新增统计字段 ===
  bombPlayCount: 0,         // 累计打出炸弹数
  flushStraightCount: 0,    // 累计打出同花顺数
  currentStreak: 0,         // 当前连胜
  bestStreak: 0,            // 最长连胜
};

function checkAchievement(key) {
  if (achievements[key] && !achievements[key].unlocked) {
    achievements[key].unlocked = true;
    if (window.GD.showAchievement) window.GD.showAchievement(achievements[key].name + ' - ' + achievements[key].desc);
    if (window.GD.Sounds && window.GD.Sounds.achieve) window.GD.Sounds.achieve();
  }
}

// ============= 提示系统 =============
const HINTS = {
  intro: '欢迎来到掼蛋! 点击「📖 教程」学习规则, 或点击「提示」让系统帮你出牌。',
  firstPlay: '你是先出者, 可以出任意牌型。建议先出手中零散的小牌。',
  mustPlay: '轮到你先出, 上一手是你自己出的。点击「提示」可自动选牌。',
  respond: '轮到你回应上家。点击「提示」, 系统会帮你选最小的压制牌; 没有大牌就「过牌」。',
  cannotBeat: '当前牌型你压不过, 建议「过牌」, 把大牌留给后面的关键轮次。',
  fewCards: '手牌不多了! 找机会出大牌, 一鼓作气出完。',
  fewOpponent: '对手快出完了! 用炸弹/王炸阻止, 或自己赶紧出完获胜。',
  teammate: '队友在出牌, 尽量过牌, 配合队友节奏。',
  allTypes: '手牌丰富, 可以多种打法混用。',
};

function getContextualHint() {
  if (state.gameOver) return '本局已结束, 点击「新游戏」开始下一局。';
  if (state.currentPlayer !== 0) {
    const name = ['AI1', 'AI2', 'AI3'][state.currentPlayer - 1];
    return `${name} 正在思考... 等他出完就轮到你。`;
  }
  const handSize = state.players[0].length;
  const mustPlay = state.lastPlayPlayer === 0 || !state.lastPlay;
  if (mustPlay) {
    if (handSize <= 5) return HINTS.fewCards;
    return HINTS.mustPlay;
  }
  const candidates = findAllCombinations(state.players[0], state.level);
  const playable = candidates.filter((c) => window.GD.canBeat(state.lastPlay, c, state.level));
  if (playable.length === 0) return HINTS.cannotBeat;
  if (handSize <= 5) return HINTS.fewCards;
  if (state.lastPlayPlayer === 2) {
    return '队友(上方)刚出了牌, 你可以选择配合过牌, 让队友继续; 但如果你能压过, 也可帮队友解围。';
  }
  return HINTS.respond;
}

function updateHint() {
  const hintContent = document.getElementById('hint-content');
  if (hintContent) {
    hintContent.textContent = getContextualHint();
  }
}

// 教学式提示: 自动选中最佳牌型
function teachingHint() {
  if (state.currentPlayer !== 0 || state.gameOver) return;
  const hand = state.players[0];
  const candidates = findAllCombinations(hand, state.level);
  const mustPlay = state.lastPlayPlayer === 0 || !state.lastPlay;
  let playable = candidates.filter((c) => window.GD.canBeat(state.lastPlay, c, state.level));

  if (mustPlay) {
    playable = candidates.slice();
    playable.sort((a, b) => {
      const typeOrder = { single: 0, pair: 1, triple: 2, triple_single: 3, triple_pair: 4, straight: 5, pair_straight: 6, plane: 7, plane_single: 7, plane_pair: 7, flush_straight: 8, bomb: 9, rocket: 10 };
      const oa = typeOrder[a.type], ob = typeOrder[b.type];
      if (oa !== ob) return oa - ob;
      if (a.value !== b.value) return a.value - b.value;
      return a.length - b.length;
    });
    const nonBomb = playable.filter((c) => c.type !== 'bomb' && c.type !== 'rocket' && c.type !== 'flush_straight');
    const chosen = nonBomb[0] || playable[0];
    state.selected.clear();
    chosen.cards.forEach((c) => state.selected.add(c.id));
    let tip = window.GD.playTypeName(chosen.type, chosen.length);
    const tips = {
      single: ' - 先出最小的单张!',
      pair: ' - 先出最小的对子!',
      triple: ' - 出三张, 很强!',
      triple_single: ' - 三带一, 拖出小单张!',
      triple_pair: ' - 三带对, 拖出小对子!',
      straight: ' - 顺子! 一次性出多张!',
      pair_straight: ' - 连对!',
      plane: ' - 飞机!',
      plane_single: ' - 飞机带单!',
      plane_pair: ' - 飞机带对!',
    };
    if (tips[chosen.type]) tip += tips[chosen.type];
    if (window.GD.showMessage) window.GD.showMessage('💡 教学: ' + tip);
    return;
  }

  if (playable.length === 0) {
    if (window.GD.showMessage) window.GD.showMessage('💡 教学: 没有能压过的牌, 应该过牌把大牌省下来!');
    return;
  }
  playable.sort((a, b) => a.cards.length - b.cards.length || a.value - b.value);
  const nonBomb = playable.filter((c) => c.type !== 'bomb' && c.type !== 'rocket' && c.type !== 'flush_straight');
  const chosen = nonBomb[0] || playable[0];
  state.selected.clear();
  chosen.cards.forEach((c) => state.selected.add(c.id));
  let tip = window.GD.playTypeName(chosen.type, chosen.length);
  if (chosen.type === 'bomb') tip += ' 💣 炸弹! 用完要省着用啊!';
  else if (chosen.type === 'rocket') tip += ' 👑 王炸! 用了就没了!';
  else if (chosen.type === 'flush_straight') tip += ' 🌟 同花顺!';
  if (window.GD.showMessage) window.GD.showMessage('💡 教学: ' + tip + ' - 用最小能压过的牌');
}

function showHint() {
  teachingHint();
  if (window.GD.renderHands) window.GD.renderHands();
}

// ============= 快捷出牌 (修复 biggest 逻辑) =============
function quickAction(type) {
  if (state.currentPlayer !== 0 || state.gameOver) {
    if (window.GD.showMessage) window.GD.showMessage('现在不是你的回合');
    return;
  }
  const hand = state.players[0];
  const candidates = findAllCombinations(hand, state.level);
  const mustPlay = state.lastPlayPlayer === 0 || !state.lastPlay;
  let playable = mustPlay ? candidates.slice() : candidates.filter((c) => window.GD.canBeat(state.lastPlay, c, state.level));

  let chosen = null;
  if (type === 'smallest') {
    // 最小单张 (按 value 升序) — 排除大小王 (它们应留作王炸)
    const singles = playable.filter((c) => c.type === 'single' && c.rank !== '小王' && c.rank !== '大王');
    chosen = singles.sort((a, b) => a.value - b.value)[0];
  } else if (type === 'biggest') {
    // 最大单张 (按 value 降序) — 排除大小王, 包含级牌
    const singles = playable.filter((c) => c.type === 'single' && c.rank !== '小王' && c.rank !== '大王');
    chosen = singles.sort((a, b) => b.value - a.value)[0];
  } else if (type === 'smallestPair') {
    chosen = playable.filter((c) => c.type === 'pair').sort((a, b) => a.value - b.value)[0];
  } else if (type === 'smallestStraight') {
    chosen = playable.filter((c) => c.type === 'straight').sort((a, b) => a.value - b.value || a.length - b.length)[0];
  } else if (type === 'smallestBomb') {
    chosen = playable.filter((c) => c.type === 'bomb').sort((a, b) => a.value - b.value)[0];
  } else if (type === 'plane') {
    chosen = playable.filter((c) => c.type === 'plane' || c.type === 'plane_single' || c.type === 'plane_pair').sort((a, b) => a.value - b.value)[0];
  }

  if (!chosen) {
    if (window.GD.showMessage) window.GD.showMessage('没有可用的 ' + type + ' 牌型');
    return;
  }
  state.selected.clear();
  chosen.cards.forEach((c) => state.selected.add(c.id));
  if (window.GD.renderHands) window.GD.renderHands();
  setTimeout(() => {
    if (window.GD.playSelected) window.GD.playSelected();
  }, 300);
}

// ============= 教程系统 =============
const TUTORIAL_PAGES = [
  {
    title: '🎴 欢迎来到掼蛋',
    content: `
      <h3>什么是掼蛋?</h3>
      <p>掼蛋是流行于江苏、安徽一带的扑克牌游戏, 使用 <b>2 副牌 + 4 张大小王</b> 共 108 张牌, 由 <b>4 名玩家</b> 分成 <b>2 队</b> 进行 (对家为一队)。</p>
      <h3>游戏目标</h3>
      <p>本队成员 <b>率先出完所有手牌</b> 即获胜。出完牌的玩家越多, 队伍得分越高。</p>
      <h3>基本流程</h3>
      <ul>
        <li>每人发 <b>27 张</b> 牌</li>
        <li>持 <b>红桃 3</b> 的玩家先出牌</li>
        <li>逆时针轮流, 每人可 <b>出牌</b> (同类型且更大) 或 <b>过牌</b></li>
        <li>3 人都过牌后, 最后出牌者获得本轮, 重新自由出牌</li>
      </ul>
      <h3>🆕 升级机制</h3>
      <p>每局结束后, <b>头游方升 3 级, 末游方降 3 级</b> (倒升级)。级数从 2 打到 A 即通关!</p>
      <p style="text-align:center;margin-top:15px;color:#ffd700">👇 继续学习牌型</p>
    `,
  },
  {
    title: '🃏 基本牌型',
    content: `
      <h3>1. 单张 (Single)</h3>
      <p>任意一张牌, 比大小: 3 &lt; 4 &lt; ... &lt; K &lt; A &lt; 2 &lt; 小王 &lt; 大王</p>
      <h3>2. 对子 (Pair)</h3>
      <p>两张相同点数的牌, 如 <span class="combo-card black">8♠</span><span class="combo-card red">8♥</span></p>
      <h3>3. 三张 (Triple)</h3>
      <p>三张相同点数的牌, 如 <span class="combo-card black">J♠</span><span class="combo-card red">J♥</span><span class="combo-card red">J♦</span></p>
      <h3>4. 三带一 / 三带二</h3>
      <p>三张 + 一张单牌 / 三张 + 一对, 例如: 三张 K + 一张 5 + 一对 7</p>
      <h3>5. 顺子 (Straight)</h3>
      <p><b>5 张以上</b> 连续点数的单张, 不能包含 2 和大小王, 如: 3-4-5-6-7</p>
      <h3>6. 连对 (Pair Straight)</h3>
      <p><b>3 对以上</b> 连续点数的对子, 如: 33-44-55</p>
      <h3>7. 钢板 / 飞机 (Plane)</h3>
      <p><b>2 个以上</b> 连续的三张, 如: 333-444</p>
    `,
  },
  {
    title: '💣 炸弹与王炸',
    content: `
      <h3>炸弹 (Bomb) - 4 张相同</h3>
      <p>四张相同点数的牌, 如 <span class="combo-card black">9♠</span><span class="combo-card red">9♥</span><span class="combo-card red">9♦</span><span class="combo-card black">9♣</span></p>
      <p>炸弹可以 <b>炸任何非炸弹牌型</b>! 大炸弹可以炸小炸弹。</p>
      <h3>同花顺 (Flush Straight) - 5 张同花顺子</h3>
      <p>相同花色 + 连续点数 (5 张以上), 比普通炸弹还大! 例: ♠7-♠8-♠9-♠10-♠J</p>
      <h3>王炸 (Rocket) - 最大!</h3>
      <p>小王 + 大王, 可以 <b>炸任何牌型</b>, 是掼蛋中最强的牌!</p>
      <h3>大小比较 (从大到小)</h3>
      <ol>
        <li>👑 王炸 (最大)</li>
        <li>🌟 同花顺</li>
        <li>💣 炸弹 (4 张)</li>
        <li>其他牌型按规则比较</li>
      </ol>
      <p style="color:#ffd700;margin-top:10px">💡 同类型比较: 必须张数相同, 然后比最小那张牌的点数</p>
    `,
  },
  {
    title: '🎯 出牌技巧',
    content: `
      <h3>1. 怎么出牌?</h3>
      <p>点击手牌选择要出的牌, 再点击「<b>出牌</b>」按钮。系统会自动识别牌型。</p>
      <h3>2. 「提示」按钮有什么用?</h3>
      <p>点击「提示」, 系统会帮你 <b>自动选中</b> 当前能出的 <b>最小牌型</b>, 适合新手学习如何压牌。</p>
      <h3>3. 「过牌」是什么意思?</h3>
      <p>轮到你时, 如果 <b>不想/不能</b> 压过当前牌, 就「过牌」。但 <b>每轮必须有人先出</b>, 你的回合如果上一手是你的牌, 必须出。</p>
      <h3>4. 配牌建议 (新手)</h3>
      <ul>
        <li>✦ 尽量拆散大牌组合, 留作后手</li>
        <li>✦ 同花顺、炸弹要省着用, 关键时刻才出</li>
        <li>✦ 关注 <b>队友</b> 已出/剩的牌, 配合出牌</li>
        <li>✦ 顶家有单张, 自己有单张且较小, 忍一忍别炸</li>
      </ul>
    `,
  },
  {
    title: '🏆 实战示例',
    content: `
      <h3>场景 1: 我先出, 怎么出?</h3>
      <p>你是先出者 (无上家), 可以 <b>出任意牌型</b>。建议: 出手中 <b>零散的小牌</b> 或 <b>较少的组合</b>。</p>
      <p>例: 你手中有 3-4-5-6-7 顺子, 单出 5 张顺子, 这样不浪费大牌。</p>
      <h3>场景 2: 上家出了对子 8, 我要压</h3>
      <p>必须出 <b>2 张更大的对子</b> (如 99, 1010, JJ, QQ, KK, AA, 22), 或用 <b>炸弹/王炸</b> 炸掉。</p>
      <h3>场景 3: 上家出了 333444 钢板</h3>
      <p>必须出 <b>同长度</b> 的钢板, 且 <b>最小那张更大</b>。如: 555666 可以压过 333444。</p>
      <h3>场景 4: 三人都过牌了</h3>
      <p>最后出牌者 <b>自由出牌</b>, 轮到下一位玩家。系统会自动切换。</p>
      <h3>💡 关键提示</h3>
      <p>队友关系: <b>你 (下方) ↔ 上方 AI</b> 为一队, <b>右 AI ↔ 左 AI</b> 为一队。要学会配合队友!</p>
      <p style="text-align:center;margin-top:20px;font-size:18px;color:#ffd700">🎉 教程结束, 开始你的掼蛋之旅吧!</p>
    `,
  },
];

let tutorialPage = 0;
function renderTutorialPage() {
  const page = TUTORIAL_PAGES[tutorialPage];
  const isFirst = tutorialPage === 0;
  const isLast = tutorialPage === TUTORIAL_PAGES.length - 1;
  document.getElementById('tutorial-panel').innerHTML = `
    <h2>${page.title}</h2>
    ${page.content}
    <div class="tutorial-nav">
      <button onclick="prevTutorial()" ${isFirst ? 'disabled' : ''}>← 上页</button>
      <span style="line-height:32px">第 ${tutorialPage + 1} / ${TUTORIAL_PAGES.length} 页</span>
      <button onclick="${isLast ? 'toggleTutorial()' : 'nextTutorial()'}">${isLast ? '✓ 完成' : '下页 →'}</button>
    </div>
  `;
}
function toggleTutorial() {
  const overlay = document.getElementById('tutorial-overlay');
  if (overlay.style.display === 'flex') {
    overlay.style.display = 'none';
  } else {
    tutorialPage = 0;
    renderTutorialPage();
    overlay.style.display = 'flex';
  }
}
function nextTutorial() {
  if (tutorialPage < TUTORIAL_PAGES.length - 1) {
    tutorialPage++;
    renderTutorialPage();
  } else {
    toggleTutorial();
  }
}
function prevTutorial() {
  if (tutorialPage > 0) {
    tutorialPage--;
    renderTutorialPage();
  }
}

// ============= 游戏结束弹窗 =============
function showGameOver() {
  // 弹出模态框, 显示结果 + 名次 + 级数变化
  const order = state.finishingOrder; // [头游, 二游, 三游, 末游]
  const placeNames = ['🥇 头游', '🥈 二游', '🥉 三游', '💀 末游'];
  const playerNames = ['你', 'AI1', 'AI2', 'AI3'];

  // 头游所在队 = 获胜方
  const firstFinisher = order[0];
  const winningTeam = firstFinisher % 2 === 0 ? 'A' : 'B';
  const userTeam = 'A'; // 玩家在 A 队

  // 计算级数变化
  const newLevels = window.GD.computeLevelChange(order, state.level);
  const levelDelta = {
    A: (window.GD.levelIndex(newLevels.A) - window.GD.levelIndex(state.level)),
    B: (window.GD.levelIndex(newLevels.B) - window.GD.levelIndex(state.level)),
  };
  // 旧级数保留, 弹窗用
  const oldLevel = state.level;
  state.teamLevels = newLevels;
  state.level = newLevels[userTeam]; // 玩家所在队的级数作为当前级数 (实际两边都更新, 下一局用用户队)
  // 注意: 简单起见, 下一局的级数使用用户所在队的新级数

  // 记录到 stats
  stats.totalGames++;
  const userPlace = order.indexOf(0) + 1;
  const userWon = winningTeam === userTeam;
  if (userWon) {
    stats.wins++;
    state.score.A++;
    // 连胜统计
    stats.currentStreak++;
    if (stats.currentStreak > stats.bestStreak) stats.bestStreak = stats.currentStreak;
    checkAchievement('firstWin');
    if (stats.wins >= 3) checkAchievement('threeWins');
    if (state.difficulty === 'easy') checkAchievement('easyVictory');
    if (state.difficulty === 'hard') checkAchievement('hardVictory');
    if (userPlace === 1) checkAchievement('singleHandWin');
    // 新成就: 任意连胜
    if (stats.currentStreak >= 3) checkAchievement('winStreak3');
    if (stats.currentStreak >= 5) checkAchievement('winStreak5');
  } else {
    state.score.B++;
    stats.currentStreak = 0; // 失败重置连胜
  }
  // 新成就: 总局数
  if (stats.totalGames >= 50) checkAchievement('veteran');
  if (stats.totalGames >= 100) checkAchievement('centurion');
  // 级数成就
  if (levelDelta.A > 0 || levelDelta.B > 0) checkAchievement('levelUp');
  if (levelDelta.A < 0 || levelDelta.B < 0) checkAchievement('levelDown');
  if (state.level === 'A') checkAchievement('reachAce');
  stats.gameStats.push({
    place: userPlace, won: userWon, teamLevel: state.level, delta: levelDelta,
  });
  if (stats.gameStats.length > 10) stats.gameStats.shift();

  // 播放胜利/失败音效
  if (userWon && window.GD.Sounds) window.GD.Sounds.win();
  else if (window.GD.Sounds) window.GD.Sounds.lose();

  // 构建弹窗 HTML
  let orderHtml = order.map((p, i) =>
    `<div class="place-row ${i === 0 ? 'first' : (i === 3 ? 'last' : '')}">
      <span class="place-name">${placeNames[i]}</span>
      <span class="player-name ${p % 2 === 0 ? 'team-A' : 'team-B'}">${playerNames[p]}${p % 2 === 0 ? ' (A)' : ' (B)'}</span>
    </div>`
  ).join('');
  const teamHtml = (team, level) => `
    <div class="result-team ${team === winningTeam ? 'winner' : 'loser'}">
      <div class="team-title">${team} 队 ${team === winningTeam ? '🏆 胜' : ''}</div>
      <div class="team-level">级数: <span class="old-level">${oldLevel}</span> → <span class="new-level">${level}</span> (${levelDelta[team] > 0 ? '+' : ''}${levelDelta[team]})</div>
    </div>
  `;

  // 创建/显示弹窗
  let modal = document.getElementById('gameover-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'gameover-modal';
    modal.className = 'modal-overlay';
    document.body.appendChild(modal);
  }
  modal.innerHTML = `
    <div class="modal-panel">
      <h2>${userWon ? '🎉 恭喜获胜!' : '😢 本局失利'}</h2>
      <div class="result-headline">
        ${winningTeam} 队以 <b>${placeNames[0]}</b> 优势获胜<br>
        你的名次: <b>${placeNames[userPlace - 1]}</b>
      </div>
      <div class="placing-list">${orderHtml}</div>
      <div class="level-change">${teamHtml('A', newLevels.A)}${teamHtml('B', newLevels.B)}</div>
      <div class="stats-summary">
        总局数: ${stats.totalGames} | 你的胜场: ${stats.wins} (${stats.totalGames ? Math.round(stats.wins / stats.totalGames * 100) : 0}%)
      </div>
      <div class="modal-actions">
        <button id="modal-next" class="primary">▶ 下一局</button>
        <button id="modal-stats">📊 战绩</button>
        <button id="modal-dashboard">📈 数据</button>
        <button id="modal-close">关闭</button>
      </div>
    </div>
  `;
  modal.style.display = 'flex';
  document.getElementById('modal-next').onclick = () => {
    modal.style.display = 'none';
    if (window.GD.newGame) window.GD.newGame();
  };
  document.getElementById('modal-stats').onclick = () => {
    showStatsModal();
  };
  document.getElementById('modal-dashboard').onclick = () => {
    showDashboard();
  };
  document.getElementById('modal-close').onclick = () => {
    modal.style.display = 'none';
  };
}

// 显示战绩弹窗
function showStatsModal() {
  const achievementsList = Object.entries(achievements)
    .map(([k, v]) => `<div class="achv-row ${v.unlocked ? 'unlocked' : 'locked'}">
      <span class="achv-status">${v.unlocked ? '✅' : '⬜'}</span>
      <span class="achv-name">${v.name}</span>
      <span class="achv-desc">${v.desc}</span>
    </div>`).join('');
  const games = stats.gameStats.map((g, i) =>
    `<tr><td>${stats.gameStats.length - i}</td><td>${g.place}</td><td>${g.won ? '✅ 胜' : '❌ 负'}</td><td>${g.teamLevel}</td></tr>`
  ).join('');
  let modal = document.getElementById('stats-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'stats-modal';
    modal.className = 'modal-overlay';
    document.body.appendChild(modal);
  }
  modal.innerHTML = `
    <div class="modal-panel wide">
      <h2>📊 战绩 & 成就</h2>
      <h3>近期对局</h3>
      <table class="game-stats">
        <tr><th>局次</th><th>名次</th><th>结果</th><th>当前级数</th></tr>
        ${games || '<tr><td colspan="4" style="text-align:center;color:#888">暂无</td></tr>'}
      </table>
      <h3>成就 (${Object.values(achievements).filter((a) => a.unlocked).length}/${Object.keys(achievements).length})</h3>
      <div class="achievements-list">${achievementsList}</div>
      <div class="modal-actions">
        <button id="stats-close">关闭</button>
      </div>
    </div>
  `;
  modal.style.display = 'flex';
  document.getElementById('stats-close').onclick = () => { modal.style.display = 'none'; };
  // 关闭其他模态
  const gom = document.getElementById('gameover-modal');
  if (gom) gom.style.display = 'none';
}

window.GD = window.GD || {};
Object.assign(window.GD, {
  // 分析
  analyzeHand,
  // 成就
  achievements, stats, checkAchievement,
  // 提示
  HINTS, getContextualHint, updateHint, teachingHint, showHint,
  // 快捷
  quickAction,
  // 教程
  TUTORIAL_PAGES, renderTutorialPage, toggleTutorial, nextTutorial, prevTutorial,
  // 弹窗
  showGameOver, showStatsModal, showDashboard,
  // 托管
  toggleAutoPlay, maybeScheduleAutoPlay, cancelAutoPlay,
  // 每日挑战
  djb2, mulberry32, startDailyChallenge,
});

// ============= Feature 1 续: 包装 logAction 跟踪炸弹/同花顺 =============
// ui.js 暴露的 logAction 在 state.js 的 playCards 中被调用, 用来记录每次出牌
// 这里包装它, 在原始日志后增量统计并检查新成就
const _origLogAction = window.GD.logAction;
window.GD.logAction = function (msg, type) {
  _origLogAction(msg, type);
  // 增量统计炸弹和同花顺
  if (typeof msg === 'string') {
    if (msg.indexOf('炸弹') !== -1) {
      stats.bombPlayCount = (stats.bombPlayCount || 0) + 1;
      if (stats.bombPlayCount >= 10) checkAchievement('bombSpammer');
    }
    if (msg.indexOf('同花顺') !== -1) {
      stats.flushStraightCount = (stats.flushStraightCount || 0) + 1;
      if (stats.flushStraightCount >= 3) checkAchievement('flushFan');
    }
  }
};

// ============= Feature 2: 托管模式 (3 秒自动出牌) =============
let autoPlay = false;        // 托管开关
let autoPlayTimer = null;    // 倒计时定时器
let autoPlayCountdown = 0;   // 当前倒计时秒数

// 切换托管模式
function toggleAutoPlay() {
  autoPlay = !autoPlay;
  const btn = document.getElementById('btn-autoplay');
  if (btn) btn.classList.toggle('btn-active', autoPlay);
  if (window.GD.showMessage) {
    window.GD.showMessage(autoPlay ? '🤖 托管模式已开启 (3秒自动出牌)' : '托管模式已关闭');
  }
  if (window.GD.logAction) {
    window.GD.logAction(autoPlay ? '🤖 开启托管' : '关闭托管', 'system');
  }
  if (!autoPlay) cancelAutoPlay();
}

// 调度托管出牌 (在玩家回合开始时调用)
function maybeScheduleAutoPlay() {
  if (!autoPlay) return;
  if (state.currentPlayer !== 0 || state.gameOver) return;
  if (autoPlayTimer) return; // 已有倒计时
  autoPlayCountdown = 3;
  const tick = () => {
    // 状态变化则取消
    if (state.currentPlayer !== 0 || state.gameOver || !autoPlay) {
      autoPlayTimer = null;
      return;
    }
    if (autoPlayCountdown <= 0) {
      autoPlayTimer = null;
      // 自动选牌 + 出牌
      if (window.GD.showHint) window.GD.showHint();
      setTimeout(() => {
        if (window.GD.playSelected && state.currentPlayer === 0 && !state.gameOver) {
          window.GD.playSelected();
        }
      }, 200);
      return;
    }
    if (window.GD.showMessage) window.GD.showMessage('🤖 托管中: ' + autoPlayCountdown + '...', 900);
    autoPlayCountdown--;
    autoPlayTimer = setTimeout(tick, 1000);
  };
  tick();
}

// 取消托管倒计时 (玩家手动操作时)
function cancelAutoPlay() {
  if (autoPlayTimer) {
    clearTimeout(autoPlayTimer);
    autoPlayTimer = null;
  }
}

// ============= Feature 3: 数据统计仪表盘 =============
function showDashboard() {
  const games = stats.gameStats || [];
  const total = stats.totalGames || 0;
  const wins = stats.wins || 0;
  // 胜率
  const winRate = total ? Math.round(wins / total * 100) : 0;
  // 平均名次
  const avgPlace = games.length ? (games.reduce((s, g) => s + g.place, 0) / games.length).toFixed(2) : '-';
  // 名次分布
  const placeDist = [0, 0, 0, 0];
  games.forEach((g) => { if (g.place >= 1 && g.place <= 4) placeDist[g.place - 1]++; });
  // 最长连胜 (从 gameStats 推算)
  let longest = 0, cur = 0;
  for (const g of games) {
    if (g.won) { cur++; if (cur > longest) longest = cur; }
    else cur = 0;
  }
  // 与 stats.bestStreak 取最大值
  if (stats.bestStreak > longest) longest = stats.bestStreak;

  const placeRows = [
    { name: '🥇 头游', count: placeDist[0] },
    { name: '🥈 二游', count: placeDist[1] },
    { name: '🥉 三游', count: placeDist[2] },
    { name: '💀 末游', count: placeDist[3] },
  ].map((p) => {
    const pct = total ? Math.round(p.count / total * 100) : 0;
    return `<tr><td>${p.name}</td><td>${p.count}</td><td>${pct}%</td></tr>`;
  }).join('');

  const html = `
    <div class="dashboard-grid">
      <div class="dash-card">
        <div class="dash-label">总胜率</div>
        <div class="dash-value">${winRate}%</div>
        <div class="dash-sub">${wins} / ${total} 局</div>
      </div>
      <div class="dash-card">
        <div class="dash-label">平均名次</div>
        <div class="dash-value">${avgPlace}</div>
        <div class="dash-sub">基于 ${games.length} 局</div>
      </div>
      <div class="dash-card">
        <div class="dash-label">最长连胜</div>
        <div class="dash-value">${longest}</div>
        <div class="dash-sub">当前 ${stats.currentStreak || 0} 连胜</div>
      </div>
      <div class="dash-card">
        <div class="dash-label">总局数</div>
        <div class="dash-value">${total}</div>
        <div class="dash-sub">炸弹 ${stats.bombPlayCount || 0} | 同花顺 ${stats.flushStraightCount || 0}</div>
      </div>
    </div>
    <h3>名次分布</h3>
    <table class="game-stats">
      <tr><th>名次</th><th>次数</th><th>占比</th></tr>
      ${placeRows || '<tr><td colspan="3" style="text-align:center;color:#888">暂无数据</td></tr>'}
    </table>
  `;

  let modal = document.getElementById('dashboard-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'dashboard-modal';
    modal.className = 'modal-overlay';
    document.body.appendChild(modal);
  }
  modal.innerHTML = `
    <div class="modal-panel wide">
      <h2>📈 数据统计</h2>
      ${html}
      <div class="modal-actions">
        <button id="dash-close">关闭</button>
      </div>
    </div>
  `;
  modal.style.display = 'flex';
  document.getElementById('dash-close').onclick = () => { modal.style.display = 'none'; };
  // 关闭其他模态
  const gom = document.getElementById('gameover-modal');
  if (gom) gom.style.display = 'none';
}

// ============= Feature 4: 每日挑战 =============
// 简单字符串哈希 (djb2)
function djb2(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h) + str.charCodeAt(i);
    h = h & 0xffffffff;
  }
  return h >>> 0;
}

// 基于种子的伪随机数生成器 (mulberry32)
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 启动每日挑战: 用今天日期作为种子, 替换 Math.random 后开始新游戏
function startDailyChallenge() {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const seed = djb2('guandan-daily-' + today);
  const rng = mulberry32(seed);
  const origRandom = Math.random;
  Math.random = rng;
  try {
    if (state) state.dailyMode = true;
    if (window.GD.newGame) window.GD.newGame();
  } finally {
    Math.random = origRandom;
  }
  // 提示
  if (window.GD.showMessage) {
    window.GD.showMessage('📅 今日挑战开始! 种子: ' + today);
  }
  if (window.GD.logAction) {
    window.GD.logAction('📅 今日挑战 - 种子: ' + today, 'system');
  }
}
