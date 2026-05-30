process.env.NODE_ENV = 'production';
require('dotenv').config();
const axios = require('axios');
const path = require('path');

delete require.cache[require.resolve('./api/index.js')];

async function main() {
  const K = process.env.RAPIDAPI_KEY;
  const host = 'coles-australia-full-catalog-pricing-intelligence-api.p.rapidapi.com';
  const r = await axios.get(`https://${host}/coles/search`, {
    params: { query: 'watermelon', page: 1 },
    headers: { 'x-rapidapi-key': K, 'x-rapidapi-host': host },
    timeout: 60000,
  });
  const raw = (r.data?.results || [])[0];
  console.log('keys', Object.keys(raw).filter((k) => /categ|depart|bread|aisle/i.test(k)));
  console.log(JSON.stringify(raw, null, 2).slice(0, 2500));
}

main().catch(console.error);
