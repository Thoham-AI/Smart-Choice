const express = require('express');
const { getPrices } = require('./fetcher'); // Your scraping logic
const app = express();

app.get('/', (req, res) => {
    res.send(`
        <h1>Grocery Compare</h1>
        <form action="/compare">
            <input name="item" placeholder="e.g. 1L Milk">
            <button type="submit">Compare</button>
        </form>
    `);
});

app.get('/compare', async (req, res) => {
    const item = req.query.item;
    const prices = await getPrices(item); // Runs the Playwright script
    res.json(prices);
});

app.listen(3000, () => console.log('App running on http://localhost:3000'));