/**
 * Chạy: node scripts/debug-scrapers.js croissant
 * In cấu trúc JSON Woolworths (RapidAPI) + ALDI (api.aldi.com.au).
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const axios = require('axios');

const query = process.argv[2] || 'croissant';

async function debugAldi() {
  const response = await axios.get('https://api.aldi.com.au/v3/product-search', {
    params: { query, limit: 12, page: 1 },
    headers: {
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'en-AU,en;q=0.9',
      Origin: 'https://www.aldi.com.au',
      Referer: `https://www.aldi.com.au/results?q=${encodeURIComponent(query)}`,
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    },
    timeout: 20000,
    validateStatus: () => true,
  });

  const body = response.data;
  const payloadLen =
    typeof body === 'string'
      ? body.length
      : body == null
        ? 0
        : JSON.stringify(body).length;

  console.log('\n=== ALDI ===');
  console.log('HTTP', response.status);
  console.log('ALDI response payload length:', payloadLen);
  console.log('Content-Type', response.headers['content-type']);

  if (typeof body === 'string') {
    console.log('Body preview:', body.slice(0, 400));
    return;
  }

  const list = Array.isArray(body?.data)
    ? body.data
    : Array.isArray(body?.products)
      ? body.products
      : Array.isArray(body?.results)
        ? body.results
        : [];
  console.log('Product count:', list.length);
  if (list[0]) {
    console.log('First item keys:', Object.keys(list[0]));
    console.log(JSON.stringify(list[0], null, 2).slice(0, 1500));
  }
}

async function debugWoolworths() {
  const key = process.env.RAPIDAPI_KEY || process.env.RAPID_API_KEY || '';
  if (!key) {
    console.log('\n=== Woolworths: bỏ qua (không có RAPIDAPI_KEY trong .env) ===');
    return;
  }

  const host = 'woolworths-australia-product-category-api.p.rapidapi.com';
  const response = await axios.get(`https://${host}/woolworths/search`, {
    params: {
      query,
      page: 1,
      latitude: -33.8688,
      longitude: 151.2093,
      lat: -33.8688,
      lng: 151.2093,
    },
    headers: {
      'x-rapidapi-key': key,
      'x-rapidapi-host': host,
    },
    timeout: 20000,
    validateStatus: () => true,
  });

  console.log('\n=== Woolworths RapidAPI ===');
  console.log('HTTP', response.status);

  const payload = response.data;
  const arr =
    payload?.results ||
    payload?.data?.results ||
    payload?.items ||
    (Array.isArray(payload) ? payload : []);

  console.log('Results count:', arr.length);
  if (arr[0]) {
    console.log('First product keys:', Object.keys(arr[0]));
    console.log(JSON.stringify(arr[0], null, 2));
  }
}

(async () => {
  console.log('Query:', query);
  await debugAldi();
  await debugWoolworths();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
