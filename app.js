"use strict";

const $ = (selector) => document.querySelector(selector);

const canvas = $("#priceChart");
const ctx = canvas.getContext("2d");
const symbolSelect = $("#symbolSelect");
const candleSelect = $("#candleSelect");
const sensitivity = $("#sensitivity");
const connectButton = $("#connectButton");
const resetButton = $("#resetButton");
const connectionDot = $("#connectionDot");
const connectionText = $("#connectionText");
const statusStrip = $(".status-strip");
const lastPriceEl = $("#lastPrice");
const activePriceEl = $("#activePrice");
const activeMarketEl = $("#activeMarket");
const minuteChangeEl = $("#minuteChange");
const volatilityEl = $("#volatility");
const clockEl = $("#clock");
const logBody = $("#logBody");
const accuracyEl = $("#accuracy");
const predictionPanel = $(".prediction-panel");
const signalTitle = $("#signalTitle");
const signalMessage = $("#signalMessage");
const signalThreshold = $("#signalThreshold");
const signalThresholdValue = $("#signalThresholdValue");
const signalSoundToggle = $("#signalSoundToggle");

const horizons = [15, 30, 60];
const horizonEls = {
  15: { dir: $("#dir15"), bar: $("#bar15"), prob: $("#prob15"), analysis: $("#analysis15") },
  30: { dir: $("#dir30"), bar: $("#bar30"), prob: $("#prob30"), analysis: $("#analysis30") },
  60: { dir: $("#dir60"), bar: $("#bar60"), prob: $("#prob60"), analysis: $("#analysis60") },
};

const markets = {
  btcusdt: { stream: "btcusdt" },
  ethusdt: { stream: "ethusdt" },
  solusdt: { stream: "solusdt" },
  xrpusdt: { stream: "xrpusdt" },
  bnbusdt: { stream: "bnbusdt" },
};

let socket = null;
let reconnectTimer = 0;
let activeConnectionId = 0;
let manualDisconnect = false;
let ticks = [];
let candles = [];
let pendingSignals = [];
let settledSignals = [];
let lastPredictionAt = 0;
let animationId = 0;
let lastPrice = 0;
let signalStateKey = "normal";
let currentPredictions = [];
let audioContext = null;

const signalSoundStorageKey = "pulse-option-signal-sound";

const signalTitleTooltips = {
  standby: "3つの時間軸がまだ強く揃っていない待機状態です。",
  green: "3つの時間軸が上方向で揃った状態です。強いUPシグナルとして表示します。",
  red: "3つの時間軸が下方向で揃った状態です。強いDOWNシグナルとして表示します。",
  almost: "3つの時間軸のうち2つが同じ方向で強まりつつある予兆状態です。",
};

function formatPrice(value) {
  if (!Number.isFinite(value)) return "--";
  if (value >= 1000) return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (value >= 1) return value.toLocaleString("en-US", { maximumFractionDigits: 4 });
  return value.toLocaleString("en-US", { maximumFractionDigits: 7 });
}

function formatTime(timestamp = Date.now()) {
  return new Intl.DateTimeFormat("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(timestamp);
}

function setConnection(state, text) {
  connectionDot.className = `dot ${state}`;
  connectionText.textContent = text;
}

function prepareTooltips() {
  document.querySelectorAll("[data-tooltip]").forEach((element) => {
    if (!element.hasAttribute("tabindex")) element.tabIndex = 0;
  });
}

function loadSignalSoundSetting() {
  if (!signalSoundToggle) return;
  try {
    signalSoundToggle.checked = localStorage.getItem(signalSoundStorageKey) === "true";
  } catch {
    signalSoundToggle.checked = false;
  }
}

function saveSignalSoundSetting() {
  if (!signalSoundToggle) return;
  try {
    localStorage.setItem(signalSoundStorageKey, signalSoundToggle.checked ? "true" : "false");
  } catch {
    // Sound preferences are optional; ignore storage failures in private modes.
  }
}

function getAudioContext() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;
  if (!audioContext) audioContext = new AudioContextClass();
  return audioContext;
}

function unlockSignalAudio() {
  const context = getAudioContext();
  if (!context || context.state !== "suspended") return;
  context.resume().catch(() => {});
}

function playSignalSound(direction) {
  if (!signalSoundToggle?.checked) return;
  const context = getAudioContext();
  if (!context) return;
  const play = () => {
    try {
      if (direction === "UP") playCatCue(context);
      if (direction === "DOWN") playDogCue(context);
    } catch {
      // Audio feedback must never interrupt chart updates.
    }
  };
  if (context.state === "suspended") {
    context.resume().then(play).catch(() => {});
    return;
  }
  play();
}

function tone(context, { type, start, duration, from, to, volume }) {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(from, start);
  oscillator.frequency.exponentialRampToValueAtTime(Math.max(1, to), start + duration);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + 0.025);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.03);
}

function playCatCue(context) {
  const start = context.currentTime + 0.015;
  tone(context, { type: "sine", start, duration: 0.34, from: 520, to: 760, volume: 0.035 });
  tone(context, { type: "triangle", start: start + 0.04, duration: 0.3, from: 760, to: 430, volume: 0.018 });
}

function playDogCue(context) {
  const start = context.currentTime + 0.015;
  tone(context, { type: "square", start, duration: 0.12, from: 210, to: 92, volume: 0.04 });
  tone(context, { type: "sawtooth", start: start + 0.16, duration: 0.15, from: 170, to: 78, volume: 0.034 });
}

function resetState() {
  ticks = [];
  candles = [];
  pendingSignals = [];
  settledSignals = [];
  lastPredictionAt = 0;
  lastPrice = 0;
  signalStateKey = "normal";
  currentPredictions = [];
  logBody.textContent = "";
  accuracyEl.textContent = "的中率 --";
  lastPriceEl.textContent = "--";
  activePriceEl.textContent = "--";
  minuteChangeEl.textContent = "--";
  volatilityEl.textContent = "--";
  for (const horizon of horizons) {
    renderPrediction(horizon, null);
  }
  updateSignalState([]);
  drawChart();
}

function connect() {
  disconnect({ preserveStatus: true });
  resetState();
  manualDisconnect = false;
  activeConnectionId += 1;
  const connectionId = activeConnectionId;
  const market = markets[symbolSelect.value];
  const label = symbolSelect.selectedOptions[0].textContent;
  activeMarketEl.textContent = label;
  setConnection("", "接続中");

  const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${market.stream}@trade`);
  socket = ws;
  ws.addEventListener("open", () => {
    if (connectionId !== activeConnectionId || socket !== ws) return;
    setConnection("live", "ライブ");
  });
  ws.addEventListener("close", () => {
    if (connectionId !== activeConnectionId || socket !== ws) return;
    socket = null;
    if (manualDisconnect) {
      setConnection("", "切断");
      return;
    }
    setConnection("", "再接続中");
    scheduleReconnect(connectionId);
  });
  ws.addEventListener("error", () => {
    if (connectionId !== activeConnectionId || socket !== ws) return;
    setConnection("error", "接続エラー");
  });
  ws.addEventListener("message", (event) => {
    if (connectionId !== activeConnectionId || socket !== ws) return;
    const trade = JSON.parse(event.data);
    const price = Number(trade.p);
    const timestamp = Number(trade.T) || Date.now();
    ingestTick(price, timestamp);
  });
}

function disconnect(options = {}) {
  manualDisconnect = true;
  activeConnectionId += 1;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = 0;
  }
  if (socket) {
    socket.close();
    socket = null;
  }
  if (!options.preserveStatus) setConnection("", "切断");
}

function scheduleReconnect(connectionId) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = window.setTimeout(() => {
    if (connectionId !== activeConnectionId || manualDisconnect) return;
    reconnectTimer = 0;
    connect();
  }, 1500);
}

function ingestTick(price, timestamp) {
  if (!Number.isFinite(price)) return;
  lastPrice = price;
  ticks.push({ price, timestamp });
  const cutoff = timestamp - 5 * 60 * 1000;
  while (ticks.length && ticks[0].timestamp < cutoff) ticks.shift();
  rebuildCandles();
  updateMetrics();
  settleSignals(timestamp, price);

  if (timestamp - lastPredictionAt >= 1000) {
    const predictions = buildPredictions(timestamp, price);
    currentPredictions = predictions;
    for (const prediction of predictions) {
      renderPrediction(prediction.horizon, prediction);
      pendingSignals.push(prediction);
    }
    updateSignalState(predictions);
    lastPredictionAt = timestamp;
  }
}

function rebuildCandles() {
  const seconds = Number(candleSelect.value);
  const bucketMs = seconds * 1000;
  const byBucket = new Map();

  for (const tick of ticks) {
    const bucket = Math.floor(tick.timestamp / bucketMs) * bucketMs;
    const candle = byBucket.get(bucket);
    if (!candle) {
      byBucket.set(bucket, {
        time: bucket,
        open: tick.price,
        high: tick.price,
        low: tick.price,
        close: tick.price,
      });
    } else {
      candle.high = Math.max(candle.high, tick.price);
      candle.low = Math.min(candle.low, tick.price);
      candle.close = tick.price;
    }
  }

  candles = Array.from(byBucket.values()).sort((a, b) => a.time - b.time).slice(-140);
}

function updateMetrics() {
  lastPriceEl.textContent = formatPrice(lastPrice);
  activePriceEl.textContent = formatPrice(lastPrice);

  const oneMinuteAgo = ticks.find((tick) => tick.timestamp >= Date.now() - 60_000);
  if (oneMinuteAgo) {
    const change = ((lastPrice - oneMinuteAgo.price) / oneMinuteAgo.price) * 100;
    minuteChangeEl.textContent = `${change >= 0 ? "+" : ""}${change.toFixed(3)}%`;
    minuteChangeEl.className = change >= 0 ? "win" : "lose";
  }

  const returns = getReturns(40);
  if (returns.length > 3) {
    const vol = standardDeviation(returns) * 100;
    volatilityEl.textContent = `${vol.toFixed(3)}%`;
  }
}

function ema(values, period) {
  if (!values.length) return 0;
  const alpha = 2 / (period + 1);
  return values.reduce((prev, value) => prev + alpha * (value - prev), values[0]);
}

function getReturns(limit) {
  const prices = ticks.slice(-limit).map((tick) => tick.price);
  const returns = [];
  for (let i = 1; i < prices.length; i += 1) {
    returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
  }
  return returns;
}

function standardDeviation(values) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function rsi(prices, period = 14) {
  if (prices.length <= period) return 50;
  const sample = prices.slice(-period - 1);
  let gains = 0;
  let losses = 0;
  for (let i = 1; i < sample.length; i += 1) {
    const diff = sample[i] - sample[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

function describePercent(value) {
  const percent = value * 100;
  return `${percent >= 0 ? "+" : ""}${percent.toFixed(3)}%`;
}

function directionWord(value, upWord, downWord, flatWord = "横ばい") {
  if (Math.abs(value) < 0.00003) return flatWord;
  return value > 0 ? upWord : downWord;
}

function buildAnalysis(horizon, direction, probability, factors) {
  if (!factors.ready) {
    return `データ蓄積中です。最低45tick集まるまでは、短期ノイズを避けるためWAITにしています。現在${factors.samples}tick。`;
  }

  const trendText = directionWord(factors.trend, "上向き", "下向き");
  const shortMomentum = directionWord(factors.momentum15, "買い優勢", "売り優勢", "勢い薄め");
  const midMomentum = directionWord(factors.momentum45, "上昇寄り", "下落寄り", "中立");
  const rsiText = factors.rsiValue >= 58 ? "買われ気味" : factors.rsiValue <= 42 ? "売られ気味" : "中立圏";
  const confidence = probability >= 64 ? "やや強め" : probability >= 57 ? "中程度" : "弱め";
  const horizonNote = horizon === 15 ? "直近の勢いを重視。" : horizon === 30 ? "直近要因を少し減衰。" : "時間が長いので確信度を控えめに補正。";

  if (direction === "WAIT") {
    return `EMAは${trendText}、短期は${shortMomentum}、45tickは${midMomentum}。RSI ${factors.rsiValue.toFixed(1)}で${rsiText}ですが、優位性が小さいため見送り。`;
  }

  return `EMAは${trendText}、短期は${shortMomentum}(${describePercent(factors.momentum15)})、45tickは${midMomentum}。RSI ${factors.rsiValue.toFixed(1)}、ボラ${(factors.vol * 100).toFixed(3)}%。確信度は${confidence}。${horizonNote}`;
}

function buildPredictions(timestamp, price) {
  const prices = ticks.slice(-160).map((tick) => tick.price);
  if (prices.length < 45) {
    return horizons.map((horizon) => ({
      horizon,
      timestamp,
      expiry: timestamp + horizon * 1000,
      entry: price,
      direction: "WAIT",
      probability: 50,
      score: 0,
      analysis: buildAnalysis(horizon, "WAIT", 50, { ready: false, samples: prices.length }),
    }));
  }

  const fast = ema(prices.slice(-30), 8);
  const slow = ema(prices.slice(-80), 21);
  const momentum15 = (price - prices[Math.max(0, prices.length - 15)]) / price;
  const momentum45 = (price - prices[Math.max(0, prices.length - 45)]) / price;
  const rsiValue = rsi(prices, 14);
  const returns = getReturns(90);
  const vol = Math.max(standardDeviation(returns), 0.00008);
  const trend = (fast - slow) / price;
  const rsiPressure = (rsiValue - 50) / 50;
  const rawScore = trend * 8 + momentum15 * 6 + momentum45 * 4 + rsiPressure * vol * 1.8;
  const sampleConfidence = Math.min(1, Math.max(0.35, prices.length / 150));
  const tunedScore = Math.max(-2.2, Math.min(2.2, (rawScore / vol) * Number(sensitivity.value) * sampleConfidence));
  const factors = {
    ready: true,
    samples: prices.length,
    trend,
    momentum15,
    momentum45,
    rsiValue,
    vol,
  };

  return horizons.map((horizon) => {
    const decay = horizon === 15 ? 1 : horizon === 30 ? 0.78 : 0.58;
    const score = tunedScore * decay;
    const edge = Math.min(18, Math.abs(score) * 8);
    const probability = Math.round(50 + edge);
    const direction = probability < 54 ? "WAIT" : score >= 0 ? "UP" : "DOWN";
    return {
      horizon,
      timestamp,
      expiry: timestamp + horizon * 1000,
      entry: price,
      direction,
      probability,
      score,
      analysis: buildAnalysis(horizon, direction, probability, factors),
    };
  });
}

function displayDirection(direction) {
  return direction;
}

function getSignalThreshold() {
  return Number(signalThreshold.value);
}

function renderPrediction(horizon, prediction) {
  const card = document.querySelector(`[data-horizon="${horizon}"]`);
  const els = horizonEls[horizon];
  card.classList.remove("up", "down", "signal-hit");
  if (!prediction) {
    els.dir.textContent = "--";
    els.bar.style.width = "0";
    els.prob.textContent = "--";
    els.analysis.textContent = "接続後に分析を表示します。";
    return;
  }
  els.dir.textContent = displayDirection(prediction.direction);
  els.bar.style.width = `${prediction.probability}%`;
  els.prob.textContent = `${prediction.probability}%`;
  els.analysis.textContent = prediction.analysis;
  if (prediction.direction === "UP") card.classList.add("up");
  if (prediction.direction === "DOWN") card.classList.add("down");
  if (prediction.direction !== "WAIT" && prediction.probability >= getSignalThreshold()) {
    card.classList.add("signal-hit");
  }
}

function updateSignalState(predictions) {
  const threshold = getSignalThreshold();
  const qualified = predictions.filter(
    (prediction) => prediction.direction !== "WAIT" && prediction.probability >= threshold,
  );
  const counts = qualified.reduce(
    (acc, prediction) => {
      acc[prediction.direction] += 1;
      return acc;
    },
    { UP: 0, DOWN: 0 },
  );
  const direction = counts.UP >= counts.DOWN ? "UP" : "DOWN";
  const matched = Math.max(counts.UP, counts.DOWN);
  const label = displayDirection(direction);
  const nextStateKey = matched >= 3 ? `all-${direction}` : matched === 2 ? `almost-${direction}` : "normal";
  const stateChanged = nextStateKey !== signalStateKey;
  signalStateKey = nextStateKey;

  predictionPanel.classList.remove(
    "signal-almost",
    "signal-all",
    "is-almost-ready",
    "is-all-green",
    "is-all-red",
    "signal-buy",
    "signal-down",
    "signal-red",
    "signal-pulse",
  );
  statusStrip.classList.remove("live-synced");

  if (matched >= 3) {
    const allStateClass = direction === "UP" ? "is-all-green" : "is-all-red";
    predictionPanel.classList.add(
      "signal-all",
      allStateClass,
      direction === "UP" ? "signal-buy" : "signal-down",
      direction === "DOWN" ? "signal-red" : "signal-buy",
    );
    statusStrip.classList.add("live-synced");
    if (stateChanged) {
      predictionPanel.classList.add("signal-pulse");
      window.setTimeout(() => predictionPanel.classList.remove("signal-pulse"), 2800);
      playSignalSound(direction);
    }
    signalTitle.textContent = direction === "UP" ? "ALL GREEN" : "ALL RED";
    signalTitle.dataset.tooltip = direction === "UP" ? signalTitleTooltips.green : signalTitleTooltips.red;
    signalMessage.textContent = `3つすべてが${threshold}%以上！ ${label} シグナル成立`;
    return;
  }

  if (matched === 2) {
    predictionPanel.classList.add(
      "signal-almost",
      "is-almost-ready",
      direction === "UP" ? "signal-buy" : "signal-down",
    );
    signalTitle.textContent = "Almost Ready";
    signalTitle.dataset.tooltip = signalTitleTooltips.almost;
    signalMessage.textContent = `2つが${threshold}%以上で${label}方向。あと1つで成立`;
    return;
  }

  signalTitle.textContent = "Signal Standby";
  signalTitle.dataset.tooltip = signalTitleTooltips.standby;
  signalMessage.textContent = "3つの時間軸が揃うと強調表示します。";
}

function refreshSignalThreshold() {
  signalThresholdValue.textContent = `${getSignalThreshold()}%`;
  for (const prediction of currentPredictions) {
    renderPrediction(prediction.horizon, prediction);
  }
  updateSignalState(currentPredictions);
}

function settleSignals(timestamp, price) {
  const remaining = [];
  for (const signal of pendingSignals) {
    if (signal.direction === "WAIT") continue;
    if (timestamp < signal.expiry) {
      remaining.push(signal);
      continue;
    }
    const actual = price >= signal.entry ? "UP" : "DOWN";
    const won = actual === signal.direction;
    settledSignals.push({ ...signal, actual, won });
    addLogRow({ ...signal, actual, won });
  }
  pendingSignals = remaining.slice(-240);
  settledSignals = settledSignals.slice(-300);
  updateAccuracy();
}

function addLogRow(signal) {
  const row = document.createElement("tr");
  row.innerHTML = `
    <td>${formatTime(signal.timestamp)}</td>
    <td>${signal.horizon}秒</td>
    <td>${signal.direction}</td>
    <td>${signal.probability}%</td>
    <td class="${signal.won ? "win" : "lose"}">${signal.won ? "WIN" : "LOSE"} (${signal.actual})</td>
  `;
  logBody.prepend(row);
  while (logBody.children.length > 60) logBody.lastElementChild.remove();
}

function updateAccuracy() {
  if (!settledSignals.length) return;
  const wins = settledSignals.filter((signal) => signal.won).length;
  accuracyEl.textContent = `的中率 ${((wins / settledSignals.length) * 100).toFixed(1)}% / ${settledSignals.length}件`;
}

function drawChart() {
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);

  ctx.strokeStyle = "rgba(153,168,181,0.13)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 6; i += 1) {
    const y = 60 + ((height - 110) / 6) * i;
    ctx.beginPath();
    ctx.moveTo(40, y);
    ctx.lineTo(width - 30, y);
    ctx.stroke();
  }

  if (candles.length < 2) {
    ctx.fillStyle = "#99a8b5";
    ctx.font = "20px system-ui";
    ctx.fillText("接続するとライブチャートを描画します", 54, height / 2);
    return;
  }

  const visible = candles.slice(-90);
  const min = Math.min(...visible.map((candle) => candle.low));
  const max = Math.max(...visible.map((candle) => candle.high));
  const range = Math.max(max - min, max * 0.0002);
  const plotLeft = 46;
  const plotRight = width - 34;
  const plotTop = 74;
  const plotBottom = height - 42;
  const xStep = (plotRight - plotLeft) / visible.length;
  const yFor = (price) => plotBottom - ((price - min) / range) * (plotBottom - plotTop);

  visible.forEach((candle, index) => {
    const x = plotLeft + index * xStep + xStep / 2;
    const yOpen = yFor(candle.open);
    const yClose = yFor(candle.close);
    const yHigh = yFor(candle.high);
    const yLow = yFor(candle.low);
    const up = candle.close >= candle.open;
    ctx.strokeStyle = up ? "#35d28f" : "#ff5d6c";
    ctx.fillStyle = up ? "#35d28f" : "#ff5d6c";
    ctx.beginPath();
    ctx.moveTo(x, yHigh);
    ctx.lineTo(x, yLow);
    ctx.stroke();
    const bodyHeight = Math.max(2, Math.abs(yClose - yOpen));
    ctx.fillRect(x - Math.max(2, xStep * 0.3), Math.min(yOpen, yClose), Math.max(4, xStep * 0.6), bodyHeight);
  });

  ctx.fillStyle = "#99a8b5";
  ctx.font = "13px system-ui";
  ctx.fillText(formatPrice(max), 48, plotTop - 12);
  ctx.fillText(formatPrice(min), 48, plotBottom + 24);
}

function loop() {
  clockEl.textContent = formatTime();
  drawChart();
  animationId = requestAnimationFrame(loop);
}

connectButton.addEventListener("click", () => {
  unlockSignalAudio();
  connect();
});
resetButton.addEventListener("click", resetState);
candleSelect.addEventListener("change", rebuildCandles);
signalThreshold.addEventListener("input", refreshSignalThreshold);
signalSoundToggle?.addEventListener("change", () => {
  saveSignalSoundSetting();
  unlockSignalAudio();
});
symbolSelect.addEventListener("change", () => {
  activeMarketEl.textContent = symbolSelect.selectedOptions[0].textContent;
  if (socket) connect();
});

window.addEventListener("beforeunload", () => {
  disconnect();
  cancelAnimationFrame(animationId);
});

prepareTooltips();
loadSignalSoundSetting();
resetState();
loop();
