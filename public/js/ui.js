// ui.js - 渲染、动画、音效

// 注意: 不要在顶层解构 window.GD, 会和 rules.js 中的 const 声明冲突
// 统一通过 window.GD.X 访问

// ============= 音效 (Web Audio API, 不依赖外部文件) =============
let audioCtx = null;
let audioEnabled = true;
function getAudioCtx() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
    catch (e) { audioEnabled = false; }
  }
  return audioCtx;
}

// 单音发生器
function beep(freq, duration, type = 'sine', vol = 0.15) {
  if (!audioEnabled) return;
  const ctx = getAudioCtx();
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  osc.connect(gain);
  gain.connect(ctx.destination);
  const now = ctx.currentTime;
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(vol, now + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
  osc.start(now);
  osc.stop(now + duration);
}

// 预定义音效
const Sounds = {
  play:      () => { beep(660, 0.08, 'triangle'); },                            // 出牌
  pass:      () => { beep(220, 0.15, 'sine', 0.1); },                            // 过牌
  bomb:      () => { beep(150, 0.3, 'sawtooth', 0.2); setTimeout(() => beep(100, 0.3, 'sawtooth', 0.2), 100); }, // 炸弹
  rocket:    () => { // 王炸
    for (let i = 0; i < 5; i++) {
      setTimeout(() => beep(200 + i * 100, 0.1, 'square', 0.2), i * 80);
    }
  },
  flush:     () => { // 同花顺
    for (let i = 0; i < 6; i++) {
      setTimeout(() => beep(400 + i * 80, 0.12, 'triangle', 0.15), i * 60);
    }
  },
  win:       () => { // 胜利
    const melody = [523, 659, 784, 1047, 784, 1047];
    melody.forEach((f, i) => setTimeout(() => beep(f, 0.2, 'triangle', 0.2), i * 120));
  },
  lose:      () => { // 失败
    [523, 440, 392, 330, 262].forEach((f, i) => setTimeout(() => beep(f, 0.3, 'sine', 0.15), i * 200));
  },
  achieve:   () => { // 解锁成就
    [659, 784, 988, 1319].forEach((f, i) => setTimeout(() => beep(f, 0.15, 'triangle', 0.18), i * 80));
  },
  fail:      () => { beep(200, 0.15, 'square', 0.15); },                          // 出牌无效
  deal:      () => { // 发牌: 一串小音
    for (let i = 0; i < 8; i++) {
      setTimeout(() => beep(800 + Math.random() * 400, 0.04, 'triangle', 0.06), i * 40);
    }
  },
};

// ============= 渲染单张牌 =============
function renderCard(c, opts = {}) {
  const { small = false, tiny = false, interactive = true } = opts;
  const div = document.createElement('div');
  const cls = ['card'];
  if (small) cls.push('small');
  if (tiny) cls.push('tiny');
  if (c.rank === '小王' || c.rank === '大王') cls.push('joker');
  else cls.push(window.GD.SUIT_COLOR[c.suit] || 'black');
  div.className = cls.join(' ');
  div.dataset.id = c.id;
  if (state.selected.has(c.id)) div.classList.add('selected');
  if (c.rank === '小王' || c.rank === '大王') {
    div.innerHTML = `<div class="card-value">${c.rank === '小王' ? '小' : '大'}</div><div class="card-suit">👑</div>`;
  } else {
    div.innerHTML = `<div class="card-value">${c.rank}</div><div class="card-suit">${c.suit}</div>`;
  }
  if (interactive) {
    div.onclick = () => {
      if (state.currentPlayer !== 0 || state.gameOver) return;
      if (state.selected.has(c.id)) state.selected.delete(c.id);
      else state.selected.add(c.id);
      renderHands();
    };
  }
  return div;
}

// ============= 渲染桌面 =============
function renderHands() {
  if (!document.getElementById('hand-bottom')) return;
  // 自己的手牌
  const hb = document.getElementById('hand-bottom');
  hb.innerHTML = '';
  const candidates = state.currentPlayer === 0 ? findAllCombinations(state.players[0], state.level) : [];
  const mustPlay = state.lastPlayPlayer === 0 || !state.lastPlay;
  const playableIds = new Set();
  if (state.currentPlayer === 0) {
    const playable = mustPlay ? candidates : candidates.filter((c) => window.GD.canBeat(state.lastPlay, c, state.level));
    playable.forEach((c) => c.cards.forEach((card) => playableIds.add(card.id)));
  }
  state.players[0].forEach((c) => {
    const cardEl = renderCard(c);
    if (playableIds.has(c.id)) {
      cardEl.classList.add('playable');
    }
    if (mustPlay && state.currentPlayer === 0 && playableIds.has(c.id)) {
      cardEl.classList.add('forced-play');
    }
    hb.appendChild(cardEl);
  });
  // AI 手牌 (背面)
  ['top', 'right', 'left'].forEach((pos) => {
    const pi = pos === 'top' ? 2 : (pos === 'right' ? 1 : 3);
    const el = document.getElementById('hand-' + pos);
    el.innerHTML = '';
    const sizeClass = pos === 'top' ? 'small' : 'tiny';
    const isFinished = state.finishingOrder.includes(pi);
    if (isFinished) {
      // 已出完, 显示"完"标记
      const done = document.createElement('div');
      done.className = 'finished-mark';
      done.textContent = '✓ 已出完';
      el.appendChild(done);
    } else {
      const displayCount = Math.min(state.players[pi].length, 14);
      for (let i = 0; i < displayCount; i++) {
        const back = document.createElement('div');
        back.className = 'card ' + sizeClass + ' card-back';
        back.textContent = '🂠';
        el.appendChild(back);
      }
      if (state.players[pi].length > 14) {
        const more = document.createElement('div');
        more.className = 'more-cards';
        more.textContent = '+' + (state.players[pi].length - 14);
        el.appendChild(more);
      }
    }
    document.getElementById('count-' + pos).textContent = state.players[pi].length + '张';
  });
  document.getElementById('count-bottom').textContent = state.players[0].length + '张';
  document.getElementById('level-info').textContent = state.level;
  document.getElementById('turn-info').textContent = ['你', 'AI1', 'AI2', 'AI3'][state.currentPlayer];
  document.getElementById('round-info').textContent = state.round;
  document.getElementById('score-a').textContent = state.score.A;
  document.getElementById('score-b').textContent = state.score.B;

  // 当前玩家高亮
  document.querySelectorAll('.player').forEach((el) => el.classList.remove('active-turn'));
  const posMap = { 0: 'bottom', 1: 'right', 2: 'top', 3: 'left' };
  document.getElementById('player-' + posMap[state.currentPlayer]).classList.add('active-turn');

  // 中央区域
  document.getElementById('current-player').textContent =
    state.currentPlayer === 0 ? '你的回合' : (['AI1', 'AI2', 'AI3'][state.currentPlayer - 1] + ' 的回合');
  const pt = document.getElementById('play-type');
  if (state.lastPlay) {
    pt.textContent = window.GD.playTypeName(state.lastPlay.type, state.lastPlay.length);
  } else {
    pt.textContent = '请出牌';
  }
  const lp = document.getElementById('last-play');
  lp.innerHTML = '';
  if (state.lastPlay) {
    state.lastPlay.cards.forEach((c) => lp.appendChild(renderCard(c, { small: true, interactive: false })));
  }
  // 已过牌者盖 PASS 章
  ['bottom', 'top', 'left', 'right'].forEach((pos) => {
    const pi = pos === 'bottom' ? 0 : (pos === 'right' ? 1 : (pos === 'top' ? 2 : 3));
    const playerEl = document.getElementById('player-' + pos);
    // 移除旧的 pass-mark
    const oldMark = playerEl.querySelector('.pass-mark');
    if (oldMark) oldMark.remove();
    if (state.passed[pi] && state.lastPlay && state.lastPlayPlayer !== pi && state.consecutivePasses > 0) {
      const mark = document.createElement('div');
      mark.className = 'pass-mark';
      mark.textContent = '过';
      playerEl.appendChild(mark);
    }
  });

  // 按钮状态
  const isMyTurn = state.currentPlayer === 0 && !state.gameOver;
  const mustPlayNow = state.lastPlayPlayer === state.currentPlayer || state.lastPlay === null;
  document.getElementById('btn-play').disabled = !isMyTurn || state.selected.size === 0;
  document.getElementById('btn-pass').disabled = !isMyTurn || mustPlayNow;
  document.getElementById('btn-hint').disabled = !isMyTurn;
  // 提示
  if (window.GD.updateHint) window.GD.updateHint();
  // 牌型分析器
  if (state.currentPlayer === 0 && window.GD.updateHandAnalyzer) window.GD.updateHandAnalyzer();
  // 动画2: 手牌进度条
  if (window.GD.renderHandBars) window.GD.renderHandBars();
  // 动画3: AI 思考指示器
  if (window.GD.showThinking) window.GD.showThinking(state.currentPlayer);
}

// ============= 动画 =============
// 玩家出牌时, 牌飞向中央
function animatePlayFromHand(playerIdx, cards) {
  // 找到玩家位置
  const posMap = { 0: 'bottom', 1: 'right', 2: 'top', 3: 'left' };
  const pos = posMap[playerIdx];
  const playerEl = document.getElementById('player-' + pos);
  if (!playerEl) return Promise.resolve();
  // 找到源卡牌
  const cardIds = new Set(cards.map((c) => c.id));
  const sourceCards = Array.from(playerEl.querySelectorAll('.card')).filter((el) => cardIds.has(el.dataset.id));
  if (!sourceCards.length) return Promise.resolve();
  const centerArea = document.getElementById('center-area');
  const centerRect = centerArea.getBoundingClientRect();
  const promises = sourceCards.map((el) => {
    return new Promise((resolve) => {
      const rect = el.getBoundingClientRect();
      const clone = el.cloneNode(true);
      clone.style.position = 'fixed';
      clone.style.left = rect.left + 'px';
      clone.style.top = rect.top + 'px';
      clone.style.width = rect.width + 'px';
      clone.style.height = rect.height + 'px';
      clone.style.zIndex = '1500';
      clone.style.transition = 'all 0.4s cubic-bezier(0.4, 0.0, 0.2, 1)';
      clone.style.pointerEvents = 'none';
      document.body.appendChild(clone);
      // 触发重排
      clone.offsetWidth;
      const targetX = centerRect.left + centerRect.width / 2 - rect.width / 2;
      const targetY = centerRect.top + centerRect.height / 2 - rect.height / 2;
      clone.style.left = targetX + 'px';
      clone.style.top = targetY + 'px';
      clone.style.transform = 'scale(0.7)';
      clone.style.opacity = '0.6';
      setTimeout(() => { clone.remove(); resolve(); }, 450);
    });
  });
  // 动画1: 触发炸弹/王炸/同花顺屏幕震动
  if (window.GD.identifyCards) {
    const ident = window.GD.identifyCards(cards, state.level);
    if (ident) triggerImpact(ident.type);
  }
  return Promise.all(promises);
}

// 过牌动画 (盖 PASS 章 + 抖动)
function animatePass(playerIdx) {
  const posMap = { 0: 'bottom', 1: 'right', 2: 'top', 3: 'left' };
  const pos = posMap[playerIdx];
  const playerEl = document.getElementById('player-' + pos);
  if (!playerEl) return;
  playerEl.classList.add('pass-shake');
  setTimeout(() => playerEl.classList.remove('pass-shake'), 400);
  // 浮动的"过"字
  const stamp = document.createElement('div');
  stamp.className = 'pass-stamp-fly';
  stamp.textContent = '过';
  const rect = playerEl.getBoundingClientRect();
  stamp.style.left = (rect.left + rect.width / 2) + 'px';
  stamp.style.top = (rect.top + rect.height / 2) + 'px';
  document.body.appendChild(stamp);
  setTimeout(() => stamp.remove(), 700);
}

// 标记已出完
function markFinished(playerIdx) {
  const posMap = { 0: 'bottom', 1: 'right', 2: 'top', 3: 'left' };
  const pos = posMap[playerIdx];
  const playerEl = document.getElementById('player-' + pos);
  if (!playerEl) return;
  playerEl.classList.add('finished');
  // 飞一个"完成"特效
  const rect = playerEl.getBoundingClientRect();
  const done = document.createElement('div');
  done.className = 'finished-fly';
  done.textContent = '🎉';
  done.style.left = (rect.left + rect.width / 2) + 'px';
  done.style.top = (rect.top + rect.height / 2) + 'px';
  document.body.appendChild(done);
  setTimeout(() => done.remove(), 1500);
}

// ============= 提示消息 =============
function showMessage(msg, duration = 2000) {
  const m = document.getElementById('message');
  if (!m) return;
  m.textContent = msg;
  m.style.display = 'block';
  setTimeout(() => { m.style.display = 'none'; }, duration);
}

// ============= 成就 Toast =============
function showAchievement(msg) {
  const toast = document.getElementById('achievement-toast');
  if (!toast) return;
  toast.textContent = '🎉 解锁成就: ' + msg;
  toast.style.display = 'block';
  setTimeout(() => { toast.style.display = 'none'; }, 3000);
}

// ============= 行动日志 =============
const actionLog = [];
function logAction(msg, type) {
  const entry = { msg, type, time: Date.now() };
  actionLog.unshift(entry);
  if (actionLog.length > 30) actionLog.pop();
  renderActionLog();
}
function renderActionLog() {
  const el = document.getElementById('log-content');
  if (!el) return;
  el.innerHTML = actionLog.slice(0, 8).map((e) =>
    `<div class="log-entry ${e.type || ''}">${e.msg}</div>`
  ).join('');
}

// ============= 动画1: 炸弹/王炸/同花顺屏幕震动 + 闪光 =============
function triggerImpact(playType) {
  const t = document.getElementById('table');
  if (!t) return;
  const cls = playType === 'rocket' ? 'impact-rocket'
            : playType === 'flush_straight' ? 'impact-flush'
            : playType === 'bomb' ? 'impact-bomb' : null;
  if (!cls) return;
  t.classList.remove('impact-bomb', 'impact-flush', 'impact-rocket');
  void t.offsetWidth; // 强制重排, 重新触发动画
  t.classList.add(cls);
  setTimeout(() => t.classList.remove(cls), 1100);
}

// ============= 动画2: 手牌进度条 (27 → 0) =============
function renderHandBars() {
  const posMap = { 0: 'bottom', 1: 'right', 2: 'top', 3: 'left' };
  for (let pi = 0; pi < 4; pi++) {
    const playerEl = document.getElementById('player-' + posMap[pi]);
    if (!playerEl) continue;
    let bar = playerEl.querySelector('.hand-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'hand-bar';
      const fill = document.createElement('div');
      fill.className = 'hand-bar-fill';
      bar.appendChild(fill);
      // 插入到 .hand 之前, 如无 .hand 则追加到末尾
      const hand = playerEl.querySelector('.hand');
      if (hand && playerEl.insertBefore) {
        try { playerEl.insertBefore(bar, hand); } catch (e) { playerEl.appendChild(bar); }
      } else {
        playerEl.appendChild(bar);
      }
    }
    const fill = bar.firstElementChild;
    const len = (state.players[pi] && state.players[pi].length) || 0;
    const pct = Math.max(0, Math.min(100, len / 27 * 100));
    if (fill && fill.style) fill.style.width = pct + '%';
    const isUrgent = len > 0 && len <= 5;
    if (fill && fill.classList) {
      if (isUrgent) fill.classList.add('urgent');
      else fill.classList.remove('urgent');
    }
  }
}

// ============= 动画3: AI 思考指示器 =============
function showThinking(playerIdx) {
  // 先清除所有旧的 thinking 气泡
  ['bottom', 'right', 'top', 'left'].forEach((p) => {
    const pe = document.getElementById('player-' + p);
    if (pe) {
      const old = pe.querySelector('.thinking');
      if (old) old.remove();
    }
  });
  if (playerIdx === 0 || playerIdx === undefined || playerIdx === null) return; // 玩家不显示
  const posMap = { 1: 'right', 2: 'top', 3: 'left' };
  const pos = posMap[playerIdx];
  if (!pos) return;
  const playerEl = document.getElementById('player-' + pos);
  if (!playerEl) return;
  const t = document.createElement('div');
  t.className = 'thinking';
  t.innerHTML = '<span>💭</span><span class="dot"></span><span class="dot"></span><span class="dot"></span>';
  playerEl.appendChild(t);
}

// ============= 牌型分析器 =============
function updateHandAnalyzer() {
  const el = document.getElementById('analyzer-content');
  if (!el) return;
  const hand = state.players[0];
  const analysis = window.GD.analyzeHand ? window.GD.analyzeHand(hand, state.level) : {};
  const candidates = findAllCombinations(hand, state.level);
  const bombCount = candidates.filter((c) => c.type === 'bomb').length;
  const rocketCount = candidates.filter((c) => c.type === 'rocket').length;
  const flushCount = candidates.filter((c) => c.type === 'flush_straight').length;
  const planeCount = candidates.filter((c) => c.type === 'plane' || c.type === 'plane_single' || c.type === 'plane_pair').length;
  const straightCount = candidates.filter((c) => c.type === 'straight').length;
  el.innerHTML = `
    <div class="analyzer-row"><span class="label">总牌数:</span><span class="val">${hand.length}</span></div>
    <div class="analyzer-row"><span class="label">单张:</span><span class="val">${analysis.singles || 0}</span></div>
    <div class="analyzer-row"><span class="label">对子:</span><span class="val">${analysis.pairs || 0}</span></div>
    <div class="analyzer-row"><span class="label">三张:</span><span class="val">${analysis.triples || 0}</span></div>
    <div class="analyzer-row"><span class="label">炸弹:</span><span class="val" style="color:${bombCount ? '#ff6b6b' : '#888'}">${bombCount} 💣</span></div>
    <div class="analyzer-row"><span class="label">王炸:</span><span class="val" style="color:${rocketCount ? '#ff6b6b' : '#888'}">${rocketCount} 👑</span></div>
    <div class="analyzer-row"><span class="label">同花顺:</span><span class="val" style="color:${flushCount ? '#ffd700' : '#888'}">${flushCount} 🌟</span></div>
    <div class="analyzer-row"><span class="label">飞机:</span><span class="val" style="color:${planeCount ? '#ffd700' : '#888'}">${planeCount} ✈️</span></div>
    <div class="analyzer-row"><span class="label">普通顺子:</span><span class="val">${straightCount}</span></div>
    <div style="margin-top:8px;padding-top:5px;border-top:1px solid rgba(255,255,255,0.2);font-size:11px;color:#aaa;">
      💡 提示: 炸弹和王炸要省着用!
    </div>
  `;
}

window.GD = window.GD || {};
Object.assign(window.GD, {
  // 音效
  Sounds, audioEnabled, getAudioCtx, beep, audioCtx: () => audioCtx,
  // 渲染
  renderCard, renderHands, renderActionLog,
  // 动画
  animatePlayFromHand, animatePass, markFinished,
  triggerImpact, renderHandBars, showThinking,
  // 消息
  showMessage, showAchievement, logAction,
  // 分析器
  updateHandAnalyzer,
  // 暴露 actionLog 用于清空
  actionLog,
});
