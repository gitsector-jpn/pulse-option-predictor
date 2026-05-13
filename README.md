# Pulse Option Predictor

Live direction lab for short-horizon chart observation.

## What It Does

- Displays a live candlestick-style chart.
- Predicts direction for 15 seconds, 30 seconds, and 1 minute.
- Shows a short explanation for each prediction.
- Keeps a verification log and simple accuracy score.

## Markets

- BTC/USDT, ETH/USDT, SOL/USDT, XRP/USDT, BNB/USDT: Binance trade WebSocket

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

## Static Hosting

This app is a static site. It runs with:

- `index.html`
- `styles.css`
- `app.js`
- `favicon.svg`

No build step, server runtime, database, `.env`, or API key is required.

### External Data Sources

- Crypto pairs use Binance public trade WebSocket streams.

The app uses the browser `WebSocket` API only. No API key or backend server is required.

### GitHub Pages

Recommended for the current repository.

1. Open the repository on GitHub.
2. Go to `Settings` -> `Pages`.
3. Set `Source` to `Deploy from a branch`.
4. Select `main` and `/ (root)`.
5. Save.

Expected URL:

```text
https://gitsector-jpn.github.io/pulse-option-predictor/
```

### Vercel / Netlify

Import the GitHub repository as a static project.

- Build command: leave empty
- Output directory: leave empty or use repository root
- Install command: leave empty
