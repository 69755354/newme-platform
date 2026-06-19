// main.js - 入口模块, 串联所有功能

// 注意: 不要在顶层解构 window.GD, 会和 rules.js 中的 const 声明冲突
// 统一通过 window.GD.X 访问

// 复用 ui.js 的 getSelectedCards (实际是 players[0].filter)
function getSelectedCards() {
  return state.players[0].filter((c) => state.selected.has(c.id));
}
function playSelected() {
  if (state.currentPlayer !== 0 || state.gameOver) return;
  const cards = getSelectedCards();
  if (cards.length === 0) return;
  const ident = window.GD.identifyCards(cards, state.level);
  if (!ident) {
    if (window.GD.showMessage) window.GD.showMessage('无效的牌型');
    if (window.GD.Sounds) window.GD.Sounds.fail();
    return;
  }
  if (!window.GD.canBeat(state.lastPlay, ident, state.level)) {
    if (window.GD.showMessage) window.GD.showMessage('打不过当前牌型');
    if (window.GD.Sounds) window.GD.Sounds.fail();
    return;
  }
  // 玩家手动出牌, 取消托管倒计时
  if (window.GD.cancelAutoPlay) window.GD.cancelAutoPlay();
  // 播放出牌动画
  if (window.GD.animatePlayFromHand) {
    window.GD.animatePlayFromHand(0, cards).then(() => {
      doPlayCards(0, cards);
    });
  } else {
    doPlayCards(0, cards);
  }
}

function doPlayCards(playerIdx, cards) {
  if (window.GD.playCards) window.GD.playCards(playerIdx, cards);
  // 播放音效
  if (window.GD.Sounds) {
    const lastType = state.lastPlay ? state.lastPlay.type : '';
    if (lastType === 'rocket') window.GD.Sounds.rocket();
    else if (lastType === 'bomb') window.GD.Sounds.bomb();
    else if (lastType === 'flush_straight') window.GD.Sounds.flush();
    else window.GD.Sounds.play();
  }
  if (window.GD.renderHands) window.GD.renderHands();
  if (state.gameOver) {
    setTimeout(() => {
      if (window.GD.showGameOver) window.GD.showGameOver();
    }, 800);
    return;
  }
  nextTurn();
  if (window.GD.renderHands) window.GD.renderHands();
  // 玩家回合 -> 调度托管
  if (state.currentPlayer === 0) {
    if (window.GD.maybeScheduleAutoPlay) window.GD.maybeScheduleAutoPlay();
  } else {
    setTimeout(aiTurnLoop, 800);
  }
}

function passPlay0() {
  if (state.currentPlayer !== 0 || state.gameOver) return;
  if (state.lastPlayPlayer === 0 || !state.lastPlay) {
    if (window.GD.showMessage) window.GD.showMessage('你必须出牌');
    if (window.GD.Sounds) window.GD.Sounds.fail();
    return;
  }
  // 玩家手动过牌, 取消托管倒计时
  if (window.GD.cancelAutoPlay) window.GD.cancelAutoPlay();
  if (window.GD.Sounds) window.GD.Sounds.pass();
  if (window.GD.animatePass) window.GD.animatePass(0);
  passPlay(0);
  nextTurn();
  if (window.GD.renderHands) window.GD.renderHands();
  // 玩家回合 -> 调度托管
  if (state.currentPlayer === 0) {
    if (window.GD.maybeScheduleAutoPlay) window.GD.maybeScheduleAutoPlay();
  } else {
    setTimeout(aiTurnLoop, 800);
  }
}

function aiTurnLoop() {
  if (state.gameOver) return;
  if (state.currentPlayer === 0) return;
  const playerIdx = state.currentPlayer;
  // AI 决策
  const hand = state.players[playerIdx];
  const cb = window.GD.canBeat;
  const candidates = findAllCombinations(hand, state.level);
  const teammate = playerIdx % 2 === 0 ? (playerIdx === 0 ? 2 : 0) : (playerIdx === 1 ? 3 : 1);
  const params = window.GD.DIFFICULTY_PARAMS[state.difficulty];
  const mustPlay = state.lastPlayPlayer === playerIdx;
  let playable = candidates.filter((c) => cb(state.lastPlay, c, state.level));

  // 队友出 -> 让队友
  if (!mustPlay && state.lastPlayPlayer === teammate && Math.random() < params.teammatePassRate) {
    state.passed[playerIdx] = true;
    state.consecutivePasses++;
    if (window.GD.Sounds) window.GD.Sounds.pass();
    if (window.GD.animatePass) window.GD.animatePass(playerIdx);
    logAction(`AI${playerIdx}: 过牌 (让队友继续)`, playerIdx % 2 === 0 ? 'partner' : 'enemy');
    state.stats = state.stats || (window.GD.stats);
    if (window.GD.stats) {
      window.GD.stats.teammatePasses++;
      if (window.GD.stats.teammatePasses >= 5) window.GD.checkAchievement && window.GD.checkAchievement('passMaster');
    }
    finishTurn();
    return;
  }
  if (!playable.length) {
    state.passed[playerIdx] = true;
    state.consecutivePasses++;
    if (window.GD.Sounds) window.GD.Sounds.pass();
    if (window.GD.animatePass) window.GD.animatePass(playerIdx);
    logAction(`AI${playerIdx}: 过牌 (压不过)`, playerIdx % 2 === 0 ? 'partner' : 'enemy');
    finishTurn();
    return;
  }
  // 选牌: 优先最小
  playable.sort((a, b) => a.cards.length - b.cards.length || a.value - b.value);
  let chosen = playable[0];
  if (chosen.type === 'rocket' && hand.length > 4) {
    const nb = playable.filter((p) => p.type !== 'rocket' && p.type !== 'bomb' && p.type !== 'flush_straight');
    if (nb.length) chosen = nb[0];
  }
  if (chosen.type === 'bomb' && hand.length > 6) {
    const nb = playable.filter((p) => p.type !== 'bomb' && p.type !== 'rocket' && p.type !== 'flush_straight');
    if (nb.length) chosen = nb[0];
  }
  if (!mustPlay && state.lastPlayPlayer === teammate) {
    if (chosen.type === 'bomb' || chosen.type === 'rocket' || chosen.type === 'flush_straight') {
      if (Math.random() > params.bombWasteRate) {
        const nb = playable.filter((p) => p.type !== 'bomb' && p.type !== 'rocket' && p.type !== 'flush_straight');
        if (nb.length) chosen = nb[0];
        else {
          state.passed[playerIdx] = true;
          state.consecutivePasses++;
          if (window.GD.Sounds) window.GD.Sounds.pass();
          if (window.GD.animatePass) window.GD.animatePass(playerIdx);
          logAction(`AI${playerIdx}: 过牌 (不炸队友)`, playerIdx % 2 === 0 ? 'partner' : 'enemy');
          finishTurn();
          return;
        }
      }
    }
  }
  // 简单模式随机
  if (state.difficulty === 'easy' && Math.random() < params.mistakeRate && playable.length > 1) {
    chosen = playable[Math.floor(Math.random() * Math.min(3, playable.length))];
  }
  // 播放动画
  if (window.GD.animatePlayFromHand) {
    window.GD.animatePlayFromHand(playerIdx, chosen.cards).then(() => {
      doPlayCards(playerIdx, chosen.cards);
    });
  } else {
    doPlayCards(playerIdx, chosen.cards);
  }
}

function finishTurn() {
  // 3 人过牌 -> 重新开始新一轮
  if (state.consecutivePasses >= 3) {
    state.lastPlay = null;
    state.lastPlayPlayer = state.currentPlayer;
    state.passed = [false, false, false, false];
    state.consecutivePasses = 0;
  }
  nextTurn();
  if (window.GD.renderHands) window.GD.renderHands();
  if (state.gameOver) {
    setTimeout(() => {
      if (window.GD.showGameOver) window.GD.showGameOver();
    }, 800);
    return;
  }
  // 玩家回合 -> 调度托管
  if (state.currentPlayer === 0) {
    if (window.GD.maybeScheduleAutoPlay) window.GD.maybeScheduleAutoPlay();
  } else {
    setTimeout(aiTurnLoop, 800);
  }
}

function newGame() {
  // 保留 teamLevels, 玩家队的新级数 (从游戏结束弹窗设置)
  // 如果是第一局或用户没玩过, 用默认 2
  if (!state.teamLevels) state.teamLevels = { A: '2', B: '2' };
  // 当前级数使用 A 队的级数 (玩家队)
  state.level = state.teamLevels.A;
  state.round = 1;
  state.gameOver = false;
  state.lastPlay = null;
  state.lastPlayPlayer = -1;
  state.passed = [false, false, false, false];
  state.selected.clear();
  state.consecutivePasses = 0;
  state.finishingOrder = [];
  if (window.GD.actionLog) window.GD.actionLog.length = 0;
  if (window.GD.renderActionLog) window.GD.renderActionLog();
  dealCards();
  // 找到拿红桃 3 的玩家
  for (let p = 0; p < 4; p++) {
    if (state.players[p].some((c) => c.suit === '♥' && c.rank === '3')) {
      state.currentPlayer = p;
      break;
    }
  }
  // 新成就: 检查 luckyDraw (玩家开局手牌含 4 张大小王)
  const myJokers = state.players[0].filter((c) => c.rank === '小王' || c.rank === '大王').length;
  if (myJokers === 4) {
    if (window.GD.checkAchievement) window.GD.checkAchievement('luckyDraw');
  }
  if (window.GD.renderHands) window.GD.renderHands();
  if (window.GD.Sounds) window.GD.Sounds.deal();
  if (window.GD.logAction) {
    window.GD.logAction('🎴 新一局开始, 级数: ' + state.level, 'system');
  }
  if (state.currentPlayer !== 0) {
    setTimeout(aiTurnLoop, 1200);
  } else {
    // 玩家先出, 调度托管
    if (window.GD.maybeScheduleAutoPlay) window.GD.maybeScheduleAutoPlay();
  }
}

function setDifficulty(level) {
  state.difficulty = level;
  if (window.GD.showMessage) window.GD.showMessage('难度已设置为: ' + (level === 'easy' ? '简单' : level === 'medium' ? '中等' : '困难'));
  if (window.GD.logAction) window.GD.logAction('⚙️ 难度: ' + level, 'system');
}

// ============= 初始化 =============
window.addEventListener('DOMContentLoaded', () => {
  // 绑定按钮
  document.getElementById('btn-play').onclick = playSelected;
  document.getElementById('btn-pass').onclick = passPlay0;
  document.getElementById('btn-hint').onclick = showHint;
  document.getElementById('btn-new').onclick = newGame;
  // 难度选择
  const diffSel = document.getElementById('difficulty');
  if (diffSel) {
    state.difficulty = diffSel.value;
    diffSel.onchange = (e) => setDifficulty(e.target.value);
  }
  // 教程按钮
  const tBtn = document.getElementById('tutorial-btn');
  if (tBtn) tBtn.onclick = toggleTutorial;
  // 开始游戏
  newGame();
  // 首次进入显示教程
  setTimeout(() => {
    if (!localStorage.getItem('guandan_tutorial_seen')) {
      toggleTutorial();
      localStorage.setItem('guandan_tutorial_seen', '1');
    }
  }, 500);
  // 提示自动更新
  setInterval(updateHint, 1500);
  // 记录 stats
  if (window.GD) {
    window.GD.stats = stats;
  }
});

window.GD = window.GD || {};
Object.assign(window.GD, {
  playSelected, passPlay0, newGame, aiTurnLoop, setDifficulty, getSelectedCards,
  finishTurn, doPlayCards,
});
