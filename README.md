# ShoppingSmart

Real-time grocery price comparison for **Coles** and **Woolworths** in Australia. Search by keyword or barcode, compare aligned product rows side-by-side, track price history, and use AI to optimise a shopping list across both stores.

## Features

- **Side-by-side compare** — matched Woolworths ↔ Coles rows with savings badges
- **Barcode scanning** — camera scan with Open Food Facts name lookup fallback
- **MongoDB cache** — faster repeat searches; price history buckets per product
- **AI shopping list** — paste a list and get a store split suggestion (OpenAI)
- **PWA** — installable on mobile with offline shell caching

## Folder structure

```
ShoppingSmart/
├── api/
│   └── index.js          # Express backend (RapidAPI, MongoDB, OpenAI, barcode)
├── public/
│   ├── index.html        # Main UI
│   ├── script.js         # Compare grid, watchlist, search history
│   ├── app.js            # Price charts, pageviews
│   ├── style.css
│   └── …                 # PWA assets (manifest, service worker, icons)
├── lib/
│   └── mongodb.js        # Shared MongoDB connection + indexes
├── scripts/
│   ├── verify-mongo-cache.js
│   └── debug-scrapers.js # Dev utility for RapidAPI smoke tests
├── tests/                # Manual / integration test scripts
├── fetcher.js            # Legacy Playwright scraper (optional)
├── index.js              # Legacy scraper server entry (npm run start:scraper)
├── .env.example          # Environment variable template
└── vercel.json           # Vercel deployment config
```

## Prerequisites

- **Node.js** 18+ (LTS recommended)
- **npm**
- API keys (see below)

## Installation

1. **Clone the repository**

   ```bash
   git clone <your-repo-url>
   cd SmartChoice
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Configure environment**

   ```bash
   cp .env.example .env
   ```

   Edit `.env` and set at minimum:

   | Variable                             | Purpose                                                    |
   | ------------------------------------ | ---------------------------------------------------------- |
   | `RAPIDAPI_KEY`                       | Coles + Woolworths search via RapidAPI                     |
   | `MONGODB_URI`                        | Cache, price history, pageviews (`shoppingsmart` database) |
   | `OPENAI_API_KEY`                     | AI shopping-list analysis                                  |
   | `COLES_API_KEY` / `COLES_API_SECRET` | Optional — direct Coles mobile API for barcode lookup      |

4. **Run locally**

   ```bash
   npm start
   ```

   Open [http://localhost:3000](http://localhost:3000).

## Scripts

| Command                     | Description                              |
| --------------------------- | ---------------------------------------- |
| `npm start` / `npm run dev` | Start main app (`api/index.js`)          |
| `npm test`                  | Run product-matching unit tests          |
| `npm run test:mongo`        | Smoke-test MongoDB read/write            |
| `npm run verify:mongo`      | Inspect cache documents in MongoDB       |
| `npm run format`            | Format JS/HTML/CSS with Prettier         |
| `npm run start:scraper`     | Legacy Playwright scraper (experimental) |

## Deployment

The project is configured for **Vercel**:

- API routes → `api/index.js`
- Static files → `public/`

Set the same environment variables in your Vercel project settings. Never commit `.env`.

## Security notes for collaborators

- **Never commit** `.env` or API keys.
- All secrets must go in environment variables (see `.env.example`).
- `user_data/` (browser profiles for scraper tests) and `*.log` files are gitignored.

## License

ISC
