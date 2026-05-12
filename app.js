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
const lastPriceEl = $("#lastPrice");
const activePriceEl = $("#activePrice");
const activeMarketEl = $("#activeMarket");
const minuteChangeEl = $("#minuteChange");
const volatilityEl = $("#volatility");
const clockEl = $("#clock");
const logBody = $("#logBody");
const accuracyEl = $("#accuracy");

const horizons = [15, 30, 60];
const horizonEls = {
  15: { dir: $("#dir15"), bar: $("#bar15"), prob: $("#prob15"), analysis: $("#analysis15") },
  30: { dir: $("#dir30"), bar: $("#bar30"), prob: $("#prob30"), analysis: $("#analysis30") },
  60: { dir: $("#dir60"), bar: $("#bar60"), prob: $("#prob60"), analysis: $("#analysis60") },
};

const markets = {
  btcusdt: { type: "binance", stream: "btcusdt" },
  ethusdt: { type: "binance", stream: "ethusdt" },
  solusdt: { type: "binance", stream: "solusdt" },
  xrpusdt: { type: "binance", stream: "xrpusdt" },
  bnbusdt: { type: "binance", stream: "bnbusdt" },
  usdjpy: { type: "fx", base: "USD", quote: "JPY", pollMs: 5000 },
};

let socket = null;
let fxTimer = 0;
let ticks = [];
let candles = [];
let pendingSignals = [];
let settledSignals = [];
let lastPredictionAt = 0;
let animationId = 0;
let lastPrice = 0;

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

function resetState() {
  ticks = [];
  candles = [];
  pendingSignals = [];
  settledSignals = [];
  lastPredictionAt = 0;
  lastPrice = 0;
  logBody.textContent = "";
  accuracyEl.textContent = "的中率 --";
  lastPriceEl.textContent = "--";
  activePriceEl.textContent = "--";
  minuteChangeEl.textContent = "--";
  volatilityEl.textContent = "--";
  for (const horizon of horizons) {
    renderPrediction(horizon, null);
  }
  drawChart();
}

function connect() {
  disconnect();
  resetState();
  const market = markets[symbolSelect.value];
  const label = symbolSelect.selectedOptions[0].textContent;
  activeMarketEl.textContent = label;
  setConnection("", "接続中");

  if (market.type === "fx") {
    connectFx(market);
    return;
  }

  socket = new WebSocket(`wss://stream.binance.com:9443/ws/${market.stream}@trade`);
  socket.addEventListener("open", () => setConnection("live", "ライブ"));
  socket.addEventListener("close", () => setConnection("", "切断"));
  socket.addEventListener("error", () => setConnection("error", "エラー"));
  socket.addEventListener("message", (event) => {
    const trade = JSON.parse(event.data);
    const price = Number(trade.p);
    const timestamp = Number(trade.T) || Date.now();
    ingestTick(price, timestamp);
  });
}

function disconnect() {
  if (fxTimer) {
    clearInterval(fxTimer);
    fxTimer = 0;
  }
  if (socket) {
    socket.close();
    socket = null;
  }
}

async function connectFx(market) {
  const poll = async () => {
    try {
      const rate = await fetchFxRate(market.base, market.quote);
      ingestTick(rate, Date.now());
      setConnection("live", "FXライブ");
    } catch (error) {
      console.error(error);
      setConnection("error", "FX取得エラー");
    }
  };

  await poll();
  fxTimer = window.setInterval(poll, market.pollMs);
}

async function fetchFxRate(base, quote) {
  const providers = [
    async () => {
      const response = await fetch(`https://fxapi.app/api/${base}/${quote}.json`, { cache: "no-store" });
      if (!response.ok) throw new Error("fxapi failed");
      const data = await response.json();
      return Number(data.rate);
    },
    async () => {
      const response = await fetch("https://convertz.app/api/currency", { cache: "no-store" });
      if (!response.ok) throw new Error("convertz failed");
      const data = await response.json();
      if (base !== "USD") throw new Error("convertz supports USD base in this app");
      return Number(data.rates?.[quote]);
    },
    async () => {
      const response = await fetch(`https://api.frankfurter.dev/v1/latest?base=${base}&symbols=${quote}`, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error("frankfurter failed");
      const data = await response.json();
      return Number(data.rates?.[quote]);
    },
  ];

  for (const provider of providers) {
    try {
      const rate = await provider();
      if (Number.isFinite(rate) && rate > 0) return rate;
    } catch {
      // Try the next public endpoint. Browser CORS and provider uptime vary.
    }
  }
  throw new Error(`${base}/${quote} rate unavailable`);
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
    for (const prediction of predictions) {
      renderPrediction(prediction.horizon, prediction);
      pendingSignals.push(prediction);
    }
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

function renderPrediction(horizon, prediction) {
  const card = document.querySelector(`[data-horizon="${horizon}"]`);
  const els = horizonEls[horizon];
  card.classList.remove("up", "down");
  if (!prediction) {
    els.dir.textContent = "--";
    els.bar.style.width = "0";
    els.prob.textContent = "--";
    els.analysis.textContent = "接続後に分析を表示します。";
    return;
  }
  els.dir.textContent = prediction.direction;
  els.bar.style.width = `${prediction.probability}%`;
  els.prob.textContent = `${prediction.probability}%`;
  els.analysis.textContent = prediction.analysis;
  if (prediction.direction === "UP") card.classList.add("up");
  if (prediction.direction === "DOWN") card.classList.add("down");
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

connectButton.addEventListener("click", connect);
resetButton.addEventListener("click", resetState);
candleSelect.addEventListener("change", rebuildCandles);
symbolSelect.addEventListener("change", () => {
  activeMarketEl.textContent = symbolSelect.selectedOptions[0].textContent;
  if (socket || fxTimer) connect();
});

window.addEventListener("beforeunload", () => {
  disconnect();
  cancelAnimationFrame(animationId);
});

resetState();
loop();
