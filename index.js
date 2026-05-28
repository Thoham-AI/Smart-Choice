require('dotenv').config();

const express = require('express');
const { searchBoth, closeBrowser } = require('./fetcher');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));

app.get('/search', async (req, res) => {
  const query = (req.query.q || '').trim();
  if (!query) {
    return res.status(400).json({ error: 'Missing search query (q).' });
  }

  console.log(`\n🔎 Searching: "${query}"`);

  try {
    const result = await searchBoth(query);
    console.log(
      `✅ Woolworths: ${result.woolworths.length}, Coles: ${result.coles.length}`
    );
    res.json(result);
  } catch (error) {
    console.error('❌ Search failed:', error.message);
    res.status(500).json({
      error:
        'Search failed. If Coles shows a bot check, open the app once with HEADLESS=false and complete verification.',
    });
  }
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

process.on('SIGINT', async () => {
  await closeBrowser();
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`\n🚀 SmartChoice running at http://localhost:${PORT}`);
});
