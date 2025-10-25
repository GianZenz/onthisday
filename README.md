On This Day — Wikipedia Web App

Overview
- Static web app that shows Events, Births, and Deaths for any given date using Wikipedia’s REST API.
- Client-side only: no backend required. Can be opened directly or served via a simple HTTP server.

How to run
- Option 1: Open `onthisday/index.html` in your browser.
- Option 2: Serve locally for a nicer experience:
  - PowerShell: `cd onthisday; python -m http.server 8000` then open http://localhost:8000
  - Or use any static server.

Deploy on GitHub Pages
- Ensure GitHub Pages is enabled for the repo:
  1) Open GitHub → repo → Settings → Pages
  2) Under "Build and deployment", choose "GitHub Actions"
  3) Save. Then push to `main` to trigger deployment.
  Note: If Actions shows "Resource not accessible by integration", Pages likely isn’t enabled yet for the repo.

Features
- Date picker (defaults to today).
- Language selector (en, it, es, de, fr, pt, ru, ja, zh, ar).
- Toggles for Events, Births, Deaths.
- Shareable URL params: `?date=MM-DD&lang=en`.
- Basic loading and error states.

Notes
- Data is fetched from `https://{lang}.wikipedia.org/api/rest_v1/feed/onthisday/{type}/{MM}/{DD}` with CORS enabled by Wikipedia.
- Credit: Content from Wikipedia; see their terms for usage and attribution.
