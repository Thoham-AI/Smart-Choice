/**
 * Chạy: node scripts/debug-scrapers.js croissant
 * In cấu trúc JSON Woolworths (RapidAPI).
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const axios = require('axios');

const query = process.argv[2] || 'croissant';

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
  await debugWoolworths();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
