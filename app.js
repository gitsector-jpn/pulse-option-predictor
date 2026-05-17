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
const accuracySummary = $("#accuracySummary");
const accuracyBreakdown = $("#accuracyBreakdown");
const sessionStatsReset = $("#sessionStatsReset");
const lifetimeStatsReset = $("#lifetimeStatsReset");
const predictionPanel = $(".prediction-panel");
const signalTitle = $("#signalTitle");
const signalMessage = $("#signalMessage");
const signalThreshold = $("#signalThreshold");
const signalThresholdValue = $("#signalThresholdValue");
const signalSoundToggle = $("#signalSoundToggle");
const signalSoundTestGreen = $("#signalSoundTestGreen");
const signalSoundTestRed = $("#signalSoundTestRed");

const horizons = [15, 30, 60];
const accuracyThresholds = [60, 65, 70, 80, 90];
const accuracyMinSamples = 5;
const statsVersion = "v1";
const lifetimeStatsStorageKey = `pulseStats_${statsVersion}`;
const sessionStatsLabel = "今回の稼働";
const lifetimeStatsLabel = "累計戦績";
const sessionStatsTooltip = "アプリ起動後から現在までの成績です。ページ更新でリセットされます。";
const lifetimeStatsTooltip = "ブラウザへ保存された累積データです。長期的な傾向確認に使用します。";
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
let signalAudioReady = false;
let previewTimer = 0;
let previewActive = false;
let lifetimeStats = createEmptyStatsStore();

const signalSoundStorageKey = "pulse-option-signal-sound";
const signalSoundDebug = true;
const signalSoundVolume = 0.24;
const signalSounds = {
  UP: createSignalAudio("sounds/cat_meow.mp3"),
  DOWN: createSignalAudio("sounds/dog_bark.mp3"),
};

const signalTitleTooltips = {
  standby: "3つの時間軸がまだ強く揃っていない待機状態です。",
  green: "3つの時間軸が上方向で揃った状態です。強いUPシグナルとして表示します。",
  red: "3つの時間軸が下方向で揃った状態です。強いDOWNシグナルとして表示します。",
  almost: "3つの時間軸のうち2つが同じ方向で強まりつつある予兆状態です。",
};

const signalTiers = [
  { key: "extreme", label: "Extreme Signal", min: 90 },
  { key: "very-strong", label: "Very Strong", min: 80 },
  { key: "strong", label: "Strong Signal", min: 70 },
];

const previewDurationMs = 3600;

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

function createEmptyStatsStore() {
  return {
    version: statsVersion,
    updatedAt: 0,
    buckets: {},
  };
}

function normalizeStatsStore(store) {
  if (!store || store.version !== statsVersion || !store.buckets) return createEmptyStatsStore();
  return {
    version: statsVersion,
    updatedAt: Number(store.updatedAt) || 0,
    buckets: store.buckets,
  };
}

function loadLifetimeStats() {
  try {
    const stored = JSON.parse(localStorage.getItem(lifetimeStatsStorageKey) || "null");
    lifetimeStats = normalizeStatsStore(stored);
  } catch {
    lifetimeStats = createEmptyStatsStore();
  }
}

function saveLifetimeStats() {
  try {
    localStorage.setItem(lifetimeStatsStorageKey, JSON.stringify(lifetimeStats));
  } catch {
    // Lifetime stats are optional; keep the live session usable if storage is blocked.
  }
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

function debugSignalSound(message) {
  if (!signalSoundDebug) return;
  console.info(`[Pulse Sound] ${message}`);
}

function createSignalAudio(src) {
  if (typeof Audio === "undefined") return null;
  const audio = new Audio(src);
  audio.preload = "auto";
  audio.volume = signalSoundVolume;
  return audio;
}

async function unlockSignalAudio() {
  const sounds = Object.values(signalSounds).filter(Boolean);
  if (!sounds.length) {
    debugSignalSound("HTMLAudioElement is not available");
    return false;
  }
  for (const sound of sounds) {
    sound.load();
    sound.volume = signalSoundVolume;
  }
  signalAudioReady = true;
  debugSignalSound("audio files loaded and ready");
  return true;
}

async function playSignalSound(direction, options = {}) {
  if (!options.force && !signalSoundToggle?.checked) {
    debugSignalSound(`skip ${direction}: disabled`);
    return;
  }
  const sound = signalSounds[direction];
  if (!sound) {
    debugSignalSound(`skip ${direction}: sound is missing`);
    return;
  }
  try {
    sound.pause();
    sound.currentTime = 0;
    sound.volume = signalSoundVolume;
    await sound.play();
    signalAudioReady = true;
    debugSignalSound(`played ${direction} file: ${sound.currentSrc || sound.src}`);
  } catch (error) {
    signalAudioReady = false;
    debugSignalSound(`blocked ${direction}: ${error?.message || error}`);
  }
}

function resetState({ resetStats = true } = {}) {
  ticks = [];
  candles = [];
  pendingSignals = [];
  if (resetStats) settledSignals = [];
  lastPredictionAt = 0;
  lastPrice = 0;
  signalStateKey = "normal";
  currentPredictions = [];
  if (resetStats) logBody.textContent = "";
  updateAccuracy();
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
  resetState({ resetStats: false });
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

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function analyzeCandles(directionSign) {
  const recent = candles.slice(-5);
  if (recent.length < 3) {
    return {
      continuity: 0,
      bodyStrength: 0,
      wickRisk: 0.35,
    };
  }

  let aligned = 0;
  const bodyRatios = [];
  const wickRisks = [];

  for (const candle of recent) {
    const range = Math.max(candle.high - candle.low, candle.close * 0.000001);
    const body = Math.abs(candle.close - candle.open);
    const candleSign = candle.close >= candle.open ? 1 : -1;
    if (candleSign === directionSign && body / range > 0.18) aligned += 1;
    bodyRatios.push(clamp(body / range, 0, 1));

    const upperWick = candle.high - Math.max(candle.open, candle.close);
    const lowerWick = Math.min(candle.open, candle.close) - candle.low;
    const opposingWick = directionSign > 0 ? upperWick : lowerWick;
    wickRisks.push(clamp(opposingWick / range, 0, 1));
  }

  return {
    continuity: aligned / recent.length,
    bodyStrength: average(bodyRatios),
    wickRisk: average(wickRisks),
  };
}

function calculateConditionQuality(directionSign, factors) {
  const candleProfile = analyzeCandles(directionSign);
  const emaDistance = clamp(Math.abs(factors.trend) / (factors.vol * 2.8), 0, 1);
  const rsiDirection = directionSign > 0 ? factors.rsiSlope : -factors.rsiSlope;
  const rsiAlignment = clamp((rsiDirection + 2.5) / 7.5, 0, 1);
  const volStability = clamp(1 - Math.abs(factors.shortVol / factors.longVol - 1), 0, 1);
  const suddenMoveRisk = clamp((factors.lastMove / (factors.vol * 2.8) - 1) / 1.6, 0, 1);

  const positive =
    candleProfile.continuity * 0.24 +
    candleProfile.bodyStrength * 0.18 +
    emaDistance * 0.2 +
    rsiAlignment * 0.16 +
    volStability * 0.14 +
    (1 - candleProfile.wickRisk) * 0.08;
  const penalty = candleProfile.wickRisk * 0.18 + suddenMoveRisk * 0.2 + (1 - volStability) * 0.1;

  return {
    quality: clamp(positive - penalty, 0, 1),
    candleProfile,
    emaDistance,
    rsiAlignment,
    volStability,
    suddenMoveRisk,
  };
}

function scoreAgreement(predictions) {
  const actionable = predictions.filter((prediction) => prediction.direction !== "WAIT");
  if (actionable.length < 3) return { aligned: false, bonus: 0 };
  const sameDirection = actionable.every((prediction) => prediction.direction === actionable[0].direction);
  if (!sameDirection) return { aligned: false, bonus: 0 };

  const strengths = actionable.map((prediction) => Math.abs(prediction.score));
  const mean = average(strengths);
  const dispersion = average(strengths.map((strength) => Math.abs(strength - mean)));
  const consistency = clamp(1 - dispersion / Math.max(mean, 0.01), 0, 1);
  return {
    aligned: true,
    bonus: Math.round(consistency * clamp((mean - 0.75) / 1.15, 0, 1) * 7),
  };
}

function buildAnalysis(horizon, direction, probability, factors) {
  if (!factors.ready) {
    return `データ蓄積中です。最低45tick集まるまでは、短期ノイズを避けるためWAITにしています。現在${factors.samples}tick。`;
  }

  const trendText = directionWord(factors.trend, "上向き", "下向き");
  const shortMomentum = directionWord(factors.momentum15, "買い優勢", "売り優勢", "勢い薄め");
  const midMomentum = directionWord(factors.momentum45, "上昇寄り", "下落寄り", "中立");
  const rsiText = factors.rsiValue >= 58 ? "買われ気味" : factors.rsiValue <= 42 ? "売られ気味" : "中立圏";
  const rsiSlopeText = directionWord(factors.rsiSlope / 100, "上向き", "下向き", "横ばい");
  const candleText = factors.condition
    ? `連続性${Math.round(factors.condition.candleProfile.continuity * 100)}%、実体${Math.round(factors.condition.candleProfile.bodyStrength * 100)}%、ヒゲリスク${Math.round(factors.condition.candleProfile.wickRisk * 100)}%`
    : "";
  const stabilityText = factors.condition ? `ボラ安定${Math.round(factors.condition.volStability * 100)}%` : "";
  const tier = getPredictionTier(probability);
  const confidence =
    tier.key === "extreme"
      ? "例外的に強い条件一致"
      : tier.key === "very-strong"
        ? "かなり強い条件一致"
        : tier.key === "strong"
          ? "強い条件一致"
          : probability >= 62
            ? "やや強め"
            : probability >= 57
              ? "中程度"
              : "弱め";
  const horizonNote = horizon === 15 ? "直近の勢いを重視。" : horizon === 30 ? "直近要因を少し減衰。" : "時間が長いので確信度を控えめに補正。";

  if (direction === "WAIT") {
    return `EMAは${trendText}、短期は${shortMomentum}、45tickは${midMomentum}。RSI ${factors.rsiValue.toFixed(1)}で${rsiText}、変化は${rsiSlopeText}。優位性が小さいため見送り。`;
  }

  const alignmentText = factors.scoreAligned ? "3軸スコア一致。" : "";
  return `EMAは${trendText}、短期は${shortMomentum}(${describePercent(factors.momentum15)})、45tickは${midMomentum}。RSI ${factors.rsiValue.toFixed(1)}は${rsiSlopeText}。${candleText}、${stabilityText}。${alignmentText}条件一致度は${confidence}。${horizonNote}`;
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
  const previousRsiValue = rsi(prices.slice(0, -8), 14);
  const returns = getReturns(90);
  const vol = Math.max(standardDeviation(returns), 0.00008);
  const shortVol = Math.max(standardDeviation(returns.slice(-18)), 0.00008);
  const longVol = Math.max(standardDeviation(returns.slice(-70)), 0.00008);
  const lastMove = Math.abs(returns.at(-1) || 0);
  const trend = (fast - slow) / price;
  const rsiPressure = (rsiValue - 50) / 50;
  const rsiSlope = rsiValue - previousRsiValue;
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
    rsiSlope,
    vol,
    shortVol,
    longVol,
    lastMove,
  };

  const predictions = horizons.map((horizon) => {
    const decay = horizon === 15 ? 1 : horizon === 30 ? 0.78 : 0.58;
    const score = tunedScore * decay;
    const directionSign = score >= 0 ? 1 : -1;
    const condition = calculateConditionQuality(directionSign, factors);
    const scorePower = clamp((Math.abs(score) - 0.65) / 1.35, 0, 1);
    const baseEdge = Math.min(16, Math.abs(score) * 6.2);
    const qualityEdge = condition.quality * scorePower * 22;
    const riskPenalty = condition.suddenMoveRisk * 8 + condition.candleProfile.wickRisk * 5;
    const edge = clamp(baseEdge + qualityEdge - riskPenalty, 0, 42);
    const probability = Math.round(50 + edge);
    const direction = probability < 55 ? "WAIT" : score >= 0 ? "UP" : "DOWN";
    return {
      horizon,
      timestamp,
      expiry: timestamp + horizon * 1000,
      entry: price,
      direction,
      probability,
      score,
      condition,
      analysis: buildAnalysis(horizon, direction, probability, { ...factors, condition }),
    };
  });

  const agreement = scoreAgreement(predictions);
  return predictions.map((prediction) => {
    if (!agreement.aligned || prediction.direction === "WAIT") return prediction;
    const probability = Math.min(92, prediction.probability + agreement.bonus);
    return {
      ...prediction,
      probability,
      analysis: buildAnalysis(prediction.horizon, prediction.direction, probability, {
        ...factors,
        condition: prediction.condition,
        scoreAligned: agreement.aligned,
      }),
    };
  });
}

function displayDirection(direction) {
  return direction;
}

function getPredictionTier(probability) {
  return signalTiers.find((tier) => probability >= tier.min) || { key: "base", label: "Signal", min: 0 };
}

function getSignalTier(predictions, direction) {
  const aligned = predictions.filter((prediction) => prediction.direction === direction);
  const strength = aligned.length ? Math.max(...aligned.map((prediction) => prediction.probability)) : 0;
  const tier = getPredictionTier(strength);
  return { ...tier, strength };
}

function getSignalThreshold() {
  return Number(signalThreshold.value);
}

function renderPrediction(horizon, prediction) {
  const card = document.querySelector(`[data-horizon="${horizon}"]`);
  const els = horizonEls[horizon];
  card.classList.remove("up", "down", "signal-hit", "tier-strong", "tier-very-strong", "tier-extreme");
  if (!prediction) {
    els.dir.textContent = "--";
    els.bar.style.width = "0";
    els.prob.textContent = "--";
    els.analysis.textContent = "接続後に分析を表示します。";
    els.analysis.dataset.fulltext = els.analysis.textContent;
    els.analysis.tabIndex = 0;
    return;
  }
  els.dir.textContent = displayDirection(prediction.direction);
  els.bar.style.width = `${prediction.probability}%`;
  const tier = getPredictionTier(prediction.probability);
  els.prob.textContent = tier.key === "base" ? `${prediction.probability}%` : `${prediction.probability}% · ${tier.label}`;
  els.analysis.textContent = prediction.analysis;
  els.analysis.dataset.fulltext = prediction.analysis;
  els.analysis.tabIndex = 0;
  if (prediction.direction === "UP") card.classList.add("up");
  if (prediction.direction === "DOWN") card.classList.add("down");
  card.classList.toggle("tier-strong", tier.key === "strong");
  card.classList.toggle("tier-very-strong", tier.key === "very-strong");
  card.classList.toggle("tier-extreme", tier.key === "extreme");
  if (prediction.direction !== "WAIT" && prediction.probability >= getSignalThreshold()) {
    card.classList.add("signal-hit");
  }
}

function updateSignalState(predictions) {
  if (previewActive) return;
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
  const signalTier = getSignalTier(predictions, direction);
  const nextStateKey = matched >= 3 ? `all-${direction}` : matched === 2 ? `almost-${direction}` : "normal";
  const stateChanged = nextStateKey !== signalStateKey;
  signalStateKey = nextStateKey;

  clearSignalClasses();

  if (matched >= 3) {
    const allStateClass = direction === "UP" ? "is-all-green" : "is-all-red";
    predictionPanel.classList.add(
      "signal-all",
      allStateClass,
      direction === "UP" ? "signal-buy" : "signal-down",
      direction === "DOWN" ? "signal-red" : "signal-buy",
    );
    if (signalTier.key !== "base") predictionPanel.classList.add(`tier-${signalTier.key}`);
    statusStrip.classList.add("live-synced");
    if (stateChanged) {
      predictionPanel.classList.add("signal-pulse");
      window.setTimeout(() => predictionPanel.classList.remove("signal-pulse"), 2800);
      debugSignalSound(`state transition ${nextStateKey}, enabled=${Boolean(signalSoundToggle?.checked)}, ready=${signalAudioReady}`);
      playSignalSound(direction);
    }
    signalTitle.textContent = direction === "UP" ? "ALL GREEN" : "ALL RED";
    signalTitle.dataset.tooltip = direction === "UP" ? signalTitleTooltips.green : signalTitleTooltips.red;
    const tierLabel = signalTier.key === "base" ? "Signal" : signalTier.label;
    signalMessage.textContent = `3つすべてが${threshold}%以上！ ${label} / ${tierLabel} ${signalTier.strength}%`;
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

function clearSignalClasses() {
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
    "tier-strong",
    "tier-very-strong",
    "tier-extreme",
    "is-preview",
  );
  statusStrip.classList.remove("live-synced");
}

function previewSignal(direction, probability) {
  const tier = getPredictionTier(probability);
  const allStateClass = direction === "UP" ? "is-all-green" : "is-all-red";
  const label = direction === "UP" ? "ALL GREEN" : "ALL RED";
  const display = displayDirection(direction);

  if (previewTimer) window.clearTimeout(previewTimer);
  previewActive = true;
  clearSignalClasses();
  predictionPanel.classList.add(
    "is-preview",
    "signal-all",
    allStateClass,
    direction === "UP" ? "signal-buy" : "signal-down",
    direction === "DOWN" ? "signal-red" : "signal-buy",
    "signal-pulse",
  );
  if (tier.key !== "base") predictionPanel.classList.add(`tier-${tier.key}`);
  statusStrip.classList.add("live-synced");
  window.setTimeout(() => predictionPanel.classList.remove("signal-pulse"), 2600);

  signalTitle.textContent = label;
  signalTitle.dataset.tooltip = direction === "UP" ? signalTitleTooltips.green : signalTitleTooltips.red;
  signalMessage.textContent = `DEMO MODE / ${display} / ${tier.label} ${probability}%`;
  playSignalSound(direction, { force: true });

  previewTimer = window.setTimeout(() => {
    previewActive = false;
    clearSignalClasses();
    updateSignalState(currentPredictions);
  }, previewDurationMs);
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
  let lifetimeStatsChanged = false;
  for (const signal of pendingSignals) {
    if (signal.direction === "WAIT") continue;
    if (timestamp < signal.expiry) {
      remaining.push(signal);
      continue;
    }
    const actual = price >= signal.entry ? "UP" : "DOWN";
    const won = actual === signal.direction;
    const settledSignal = { ...signal, actual, won };
    settledSignals.push(settledSignal);
    addLogRow(settledSignal);
    recordLifetimeSignal(settledSignal);
    lifetimeStatsChanged = true;
  }
  if (lifetimeStatsChanged) saveLifetimeStats();
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
  if (!settledSignals.length) {
    accuracyEl.textContent = "的中率 --";
    updateAccuracyBreakdown();
    return;
  }
  const wins = settledSignals.filter((signal) => signal.won).length;
  accuracyEl.textContent = `的中率 ${((wins / settledSignals.length) * 100).toFixed(1)}% / ${settledSignals.length}件`;
  updateAccuracyBreakdown();
}

function summarizeSignals(signals) {
  const total = signals.length;
  const wins = signals.filter((signal) => signal.won).length;
  return {
    total,
    wins,
    rate: total ? (wins / total) * 100 : 0,
  };
}

function createAccuracyItems() {
  const horizonItems = horizons.map((horizon) => ({
    label: `${horizon}秒のみ`,
    sessionSignals: settledSignals.filter((signal) => signal.horizon === horizon),
    key: `horizon:${horizon}`,
  }));

  const thresholdItems = accuracyThresholds.map((threshold) => ({
    label: `${threshold}%以上`,
    sessionSignals: settledSignals.filter((signal) => signal.probability >= threshold),
    key: `prob:${threshold}`,
  }));

  const matrixItems = [];
  for (const threshold of accuracyThresholds) {
    for (const horizon of horizons) {
      matrixItems.push({
        label: `${horizon}秒・${threshold}%以上`,
        sessionSignals: settledSignals.filter(
          (signal) => signal.horizon === horizon && signal.probability >= threshold,
        ),
        key: `horizon:${horizon}|prob:${threshold}`,
      });
    }
  }

  return { horizonItems, thresholdItems, matrixItems };
}

function getStatKeys(signal) {
  const keys = ["overall", `horizon:${signal.horizon}`];
  for (const threshold of accuracyThresholds) {
    if (signal.probability >= threshold) {
      keys.push(`prob:${threshold}`, `horizon:${signal.horizon}|prob:${threshold}`);
    }
  }
  return keys;
}

function recordLifetimeSignal(signal) {
  for (const key of getStatKeys(signal)) {
    if (!lifetimeStats.buckets[key]) lifetimeStats.buckets[key] = { wins: 0, total: 0 };
    lifetimeStats.buckets[key].total += 1;
    if (signal.won) lifetimeStats.buckets[key].wins += 1;
  }
  lifetimeStats.updatedAt = Date.now();
}

function summarizeBucket(bucket) {
  const total = Number(bucket?.total) || 0;
  const wins = Number(bucket?.wins) || 0;
  return {
    total,
    wins,
    rate: total ? (wins / total) * 100 : 0,
  };
}

function hasLifetimeStats() {
  return Object.values(lifetimeStats.buckets).some((bucket) => Number(bucket?.total) > 0);
}

function formatAccuracyValue(summary, { minSamples = accuracyMinSamples } = {}) {
  if (!summary.total) return "-- / 0件";
  if (summary.total < minSamples) return `件数不足 / ${summary.total}件`;
  return `${summary.rate.toFixed(1)}% / ${summary.total}件`;
}

function formatAccuracySummary(signals, options) {
  return formatAccuracyValue(summarizeSignals(signals), options);
}

function formatLifetimeAccuracy(key) {
  return formatAccuracyValue(summarizeBucket(lifetimeStats.buckets[key]));
}

function renderAccuracyGroup(title, items) {
  return `
    <section class="accuracy-group">
      <h3>${title}</h3>
      <dl>
        ${items
          .map(
            (item) => `
              <div>
                <dt>${item.label}</dt>
                <dd>
                  <span><b data-tooltip="${sessionStatsTooltip}" tabindex="0">${sessionStatsLabel}</b>${formatAccuracySummary(item.sessionSignals)}</span>
                  <span><b data-tooltip="${lifetimeStatsTooltip}" tabindex="0">${lifetimeStatsLabel}</b>${formatLifetimeAccuracy(item.key)}</span>
                </dd>
              </div>
            `,
          )
          .join("")}
      </dl>
    </section>
  `;
}

function updateAccuracyBreakdown() {
  if (!accuracySummary || !accuracyBreakdown) return;

  const hasSession = settledSignals.length > 0;
  const hasLifetime = hasLifetimeStats();

  if (!hasSession && !hasLifetime) {
    accuracySummary.textContent = "データ待機中";
    accuracyBreakdown.innerHTML = `
      <section class="accuracy-group is-empty">
        <p>検証ログが蓄積されると、今回の稼働と累計戦績の条件別的中率を表示します。</p>
      </section>
    `;
    return;
  }

  const strongSignals = settledSignals.filter((signal) => signal.probability >= 65);
  accuracySummary.textContent = `${sessionStatsLabel} ${formatAccuracySummary(strongSignals)} / ${lifetimeStatsLabel} ${formatLifetimeAccuracy("prob:65")}`;

  const { horizonItems, thresholdItems, matrixItems } = createAccuracyItems();
  accuracyBreakdown.innerHTML = [
    renderAccuracyGroup("期限別", horizonItems),
    renderAccuracyGroup("確率別", thresholdItems),
    renderAccuracyGroup("期限 × 確率", matrixItems),
  ].join("");
}

function resetSessionStats() {
  settledSignals = [];
  logBody.textContent = "";
  updateAccuracy();
}

function resetLifetimeStats() {
  lifetimeStats = createEmptyStatsStore();
  try {
    localStorage.removeItem(lifetimeStatsStorageKey);
  } catch {
    // Ignore blocked storage; the in-memory reset still applies.
  }
  updateAccuracyBreakdown();
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
sessionStatsReset?.addEventListener("click", resetSessionStats);
lifetimeStatsReset?.addEventListener("click", resetLifetimeStats);
candleSelect.addEventListener("change", rebuildCandles);
signalThreshold.addEventListener("input", refreshSignalThreshold);
signalSoundToggle?.addEventListener("change", () => {
  saveSignalSoundSetting();
  unlockSignalAudio();
  debugSignalSound(`setting changed: ${signalSoundToggle.checked ? "on" : "off"}`);
});
signalSoundTestGreen?.addEventListener("click", async () => {
  await unlockSignalAudio();
  playSignalSound("UP", { force: true });
});
signalSoundTestRed?.addEventListener("click", async () => {
  await unlockSignalAudio();
  playSignalSound("DOWN", { force: true });
});
document.querySelectorAll("[data-preview-signal]").forEach((button) => {
  button.addEventListener("click", async () => {
    await unlockSignalAudio();
    previewSignal(button.dataset.previewSignal, Number(button.dataset.previewTier));
  });
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
loadLifetimeStats();
resetState();
loop();
