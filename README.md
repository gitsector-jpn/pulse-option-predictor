# Pulse Option Predictor

Live direction lab for short-horizon chart observation.

## What It Does

- Displays a live candlestick-style chart.
- Predicts direction for 15 seconds, 30 seconds, and 1 minute.
- Shows a short explanation for each prediction.
- Keeps a verification log and simple accuracy score.

## Markets

- BTC/USDT, ETH/USDT, SOL/USDT, XRP/USDT, BNB/USDT: Binance trade WebSocket
- USD/JPY: public FX rate API polling with fallback providers

## Run

Open `index.html` directly in a browser.

For local server mode with Node.js:

```powershell
node dev-server.mjs
```

Then open:

```text
http://127.0.0.1:4173/
```

## Notes

This is a validation tool, not financial advice. Short-term price movement is noisy, and the app does not guarantee profit or win rate.
