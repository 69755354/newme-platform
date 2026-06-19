// deck.js - 牌组管理: 创建、洗牌、发牌

// 创建一副牌 (2 副普通牌 + 4 张大小王 = 108 张)
function createDeck() {
  const { SUITS, RANKS } = window.GD;
  const deck = [];
  for (let d = 0; d < 2; d++) {
    for (const s of SUITS) {
      for (const r of RANKS) {
        deck.push({ rank: r, suit: s, id: d + '-' + r + s });
      }
    }
  }
  // 4 张大小王 (2 小王 + 2 大王, 凑成 108 张)
  deck.push({ rank: '小王', suit: '', id: 'sj' });
  deck.push({ rank: '大王', suit: '', id: 'bj' });
  deck.push({ rank: '小王', suit: '', id: 'sj2' });
  deck.push({ rank: '大王', suit: '', id: 'bj2' });
  return deck;
}

// Fisher-Yates 洗牌
function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// 发牌: 每人 27 张
function dealCards() {
  const deck = shuffle(createDeck());
  state.players = [[], [], [], []];
  for (let i = 0; i < deck.length; i++) {
    state.players[i % 4].push(deck[i]);
  }
  // 按当前级数排序
  for (let p = 0; p < 4; p++) {
    state.players[p].sort((a, b) => window.GD.cardValue(a, state.level) - window.GD.cardValue(b, state.level));
  }
}

window.GD = window.GD || {};
Object.assign(window.GD, { createDeck, shuffle, dealCards });
