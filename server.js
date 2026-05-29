/**
 * SmartChoice – Backend trung gian RapidAPI
 * Chạy: node server.js  →  http://localhost:3000
 */

const express = require('express');
const axios   = require('axios');
const cors    = require('cors');
const stringSimilarity = require('string-similarity');

// ============================================================
// 1. CẤU HÌNH HẰNG SỐ
// ============================================================
const RAPIDAPI_KEY    = 'da720b7848msh99f571ba1848fcdp1388ddjsn3af3071dc5a4';
const COLES_HOST      = 'coles-australia-full-catalog-pricing-intelligence-api.p.rapidapi.com';
const WOOLWORTHS_HOST = 'woolworths-australia-product-category-api.p.rapidapi.com';

const PORT         = 3000;
const RESULT_LIMIT = 20;   // số sản phẩm tối đa mỗi siêu thị
const SIMILARITY_THRESHOLD = 0.58; // Ngưỡng sau khi đã tính điểm tổng hợp (tên + size + loại)
const API_TIMEOUT_MS = 60000; // Một số request RapidAPI có thể chậm
const API_MAX_RETRIES = 2;

// ============================================================
// 2. KHỞI TẠO EXPRESS
// ============================================================
const app = express();
app.use(cors());                       // Cho phép front-end trên origin khác gọi vào
// Tắt cache để tránh trình duyệt dùng JS/API cũ gây hiển thị dữ liệu "fake"
app.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});
app.use(express.static('public'));     // Phục vụ file tĩnh từ thư mục public/

// ============================================================
// 3. HÀM TIỆN ÍCH: CHUẨN HÓA GIÁ
// ============================================================
/**
 * Chuyển bất kỳ dạng giá nào (string "$4.50", number 4.5, ...) về number.
 * Trả null nếu không parse được hoặc giá <= 0.
 */
function parsePrice(value) {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Number(value.toFixed(2));
  }
  const num = parseFloat(String(value).replace(/[^0-9.]/g, ''));
  return Number.isFinite(num) && num > 0 ? Number(num.toFixed(2)) : null;
}

// ============================================================
// 4. HÀM CHUẨN HÓA 1 SẢN PHẨM → CẤU TRÚC THỐNG NHẤT
// ============================================================
/**
 * Nhận object sản phẩm thô từ RapidAPI,
 * trả về: { supermarket, name, price, image }
 *
 * Thứ tự ưu tiên khi mapping:
 *  - price      : item.price > item.discount_price
 *  - image      : item.image > item.image_url > ''
 */
/** Lấy mảng results từ nhiều dạng JSON RapidAPI có thể trả về */
function extractResultsArray(payload) {
  if (!payload) return [];
  if (Array.isArray(payload.results)) return payload.results;
  if (Array.isArray(payload.data?.results)) return payload.data.results;
  if (Array.isArray(payload.items)) return payload.items;
  if (Array.isArray(payload)) return payload;
  return [];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableApiError(error) {
  const status = error?.response?.status;
  const code = error?.code;
  return (
    code === 'ETIMEDOUT' ||
    code === 'ECONNABORTED' ||
    code === 'ECONNRESET' ||
    status === 429 ||
    (status != null && status >= 500)
  );
}

function formatStoreError(storeName, error) {
  const status = error?.response?.status;
  const apiMessage = error?.response?.data?.message;
  if (status === 429) {
    return `${storeName} API rate limit reached. Please wait a moment and try again.`;
  }
  if (error?.code === 'ETIMEDOUT' || error?.code === 'ECONNABORTED') {
    return `${storeName} API timed out. Please try again in a few seconds.`;
  }
  if (apiMessage) return `${storeName} API error: ${apiMessage}`;
  return error?.message || `${storeName} API is temporarily unavailable.`;
}

function normalizeItem(raw, supermarket) {
  if (!raw || typeof raw !== 'object') return null;

  // Tên sản phẩm
  const name =
    raw.name ||
    raw.productName ||
    raw.product_name ||
    raw.title ||
    raw.product_title ||
    null;

  // Giá: thử nhiều field phổ biến từ Dromb / RapidAPI
  const price =
    parsePrice(raw.price) ??
    parsePrice(raw.discount_price) ??
    parsePrice(raw.current_price) ??
    parsePrice(raw.sale_price) ??
    parsePrice(raw.selling_price) ??
    parsePrice(raw.final_price) ??
    parsePrice(raw.unit_price);

  // Ảnh: thử nhiều tên field
  const image =
    raw.image ||
    raw.image_url ||
    raw.imageUrl ||
    raw.thumbnail ||
    raw.img ||
    '';

  // Bỏ qua sản phẩm không có tên hoặc không parse được giá
  if (!name || price == null) return null;

  return {
    supermarket,
    name:  String(name).trim(),
    price,
    image: String(image),
  };
}

/** Chuẩn hóa tên trước khi so khớp (bỏ tiền tố siêu thị, ký tự thừa) */
function normalizeNameForMatch(name) {
  return String(name)
    .toLowerCase()
    .replace(/\b(woolworths|coles|essentials|macro|sunrice|riviana|bens original)\b/gi, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Các nhãn loại sản phẩm – dùng để tránh ghép Jasmine với Basmati, v.v. */
const VARIETY_KEYWORDS = [
  'jasmine',
  'basmati',
  'long grain',
  'brown',
  'white',
  'full cream',
  'skim',
  'lite',
  'light',
  'organic',
  'microwave',
  'greek',
  'coconut',
  'sparkling',
  'spring water',
];

const VARIETY_CONFLICTS = [
  ['jasmine', 'basmati'],
  ['brown', 'white'],
  ['full cream', 'skim'],
  ['full cream', 'lite'],
  ['full cream', 'light'],
];

function extractVarieties(name) {
  const lower = String(name).toLowerCase();
  return VARIETY_KEYWORDS.filter((keyword) => lower.includes(keyword));
}

/** Hai tên có cùng “dòng” sản phẩm (không Jasmine vs Basmati) */
function varietiesCompatible(nameA, nameB) {
  const vA = extractVarieties(nameA);
  const vB = extractVarieties(nameB);
  if (!vA.length || !vB.length) return true;

  for (const [left, right] of VARIETY_CONFLICTS) {
    const aHasLeft = vA.includes(left);
    const aHasRight = vA.includes(right);
    const bHasLeft = vB.includes(left);
    const bHasRight = vB.includes(right);
    if ((aHasLeft && bHasRight) || (aHasRight && bHasLeft)) return false;
  }

  return vA.some((v) => vB.includes(v));
}

/** Trích khối lượng / dung tích / số pack từ tên sản phẩm */
function extractSizeInfo(name) {
  const text = String(name).toLowerCase();
  let grams = null;
  let packCount = 1;

  const kgMatch = text.match(/(\d+(?:\.\d+)?)\s*kg\b/);
  const gMatch = text.match(/(\d+(?:\.\d+)?)\s*g\b/);
  const lMatch = text.match(/(\d+(?:\.\d+)?)\s*l\b/);
  const mlMatch = text.match(/(\d+(?:\.\d+)?)\s*ml\b/);
  const packMatch = text.match(/(?:x\s*)?(\d+)\s*(?:pack|pk)\b/);

  if (kgMatch) grams = parseFloat(kgMatch[1]) * 1000;
  else if (gMatch && !kgMatch) grams = parseFloat(gMatch[1]);
  else if (lMatch) grams = parseFloat(lMatch[1]) * 1000;
  else if (mlMatch) grams = parseFloat(mlMatch[1]);

  if (packMatch) packCount = parseInt(packMatch[1], 10);

  return { grams, packCount };
}

/**
 * Kiểm tra size/pack có tương thích không.
 * - conflict: 2kg vs 1kg, 6-pack vs đơn lẻ → không ghép
 * - mismatch_one_sided: một bên có size, bên kia không → phạt điểm
 */
function checkSizeCompatibility(nameA, nameB) {
  const a = extractSizeInfo(nameA);
  const b = extractSizeInfo(nameB);

  if (a.packCount !== b.packCount && (a.packCount > 1 || b.packCount > 1)) {
    return 'conflict';
  }

  if (a.grams != null && b.grams != null) {
    const ratio = Math.min(a.grams, b.grams) / Math.max(a.grams, b.grams);
    if (ratio < 0.85) return 'conflict';
    return 'ok';
  }

  if (
    (a.grams != null && b.grams == null) ||
    (a.grams == null && b.grams != null)
  ) {
    return 'mismatch_one_sided';
  }

  return 'ok';
}

/** Điểm ghép cặp tổng hợp: tên + loại + khối lượng */
function scoreProductPair(woolName, colesName) {
  const woolNorm = normalizeNameForMatch(woolName);
  const colesNorm = normalizeNameForMatch(colesName);
  if (!woolNorm || !colesNorm) return 0;

  if (!varietiesCompatible(woolName, colesName)) return 0;

  const sizeStatus = checkSizeCompatibility(woolName, colesName);
  if (sizeStatus === 'conflict') return 0;

  let score = stringSimilarity.compareTwoStrings(woolNorm, colesNorm);

  // Một bên có 2kg, bên kia chỉ ghi "Jasmine Rice" → hạ điểm để tránh ghép lệch
  if (sizeStatus === 'mismatch_one_sided') score *= 0.72;

  return score;
}

/**
 * Ghép cặp Similar products:
 * - Duyệt từng sản phẩm Woolworths
 * - Tìm Coles có điểm ghép cao nhất (tên + loại + size)
 * - Chỉ giữ cặp vượt ngưỡng SIMILARITY_THRESHOLD
 */
function buildSimilarPairs(woolworthsItems, colesItems) {
  const pairs = [];
  const usedColesIndexes = new Set();

  if (!woolworthsItems.length || !colesItems.length) return pairs;

  for (const woolItem of woolworthsItems) {
    let bestIndex = -1;
    let bestScore = 0;

    colesItems.forEach((colesItem, idx) => {
      if (usedColesIndexes.has(idx)) return;
      const score = scoreProductPair(woolItem.name, colesItem.name);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = idx;
      }
    });

    if (bestIndex < 0 || bestScore <= SIMILARITY_THRESHOLD) continue;

    usedColesIndexes.add(bestIndex);
    const colesItem = colesItems[bestIndex];
    const saving = Math.abs(woolItem.price - colesItem.price);
    const cheaper =
      woolItem.price < colesItem.price
        ? 'Woolworths'
        : colesItem.price < woolItem.price
          ? 'Coles'
          : 'tie';

    pairs.push({
      woolworths: woolItem,
      coles: colesItem,
      cheaper,
      saving: Number(saving.toFixed(2)),
      similarity: Number(bestScore.toFixed(2)),
    });
  }

  return pairs;
}

// ============================================================
// 5. HÀM GỌI COLES RAPIDAPI
// ============================================================
async function fetchColes(keyword) {
  const url = `https://${COLES_HOST}/coles/search`;
  let lastError = null;

  // Coles hay timeout → retry + tăng timeout
  for (let attempt = 1; attempt <= API_MAX_RETRIES; attempt++) {
    try {
      const response = await axios.get(url, {
        params: {
          query: keyword,
          page: 1,
        },
        headers: {
          'x-rapidapi-key': RAPIDAPI_KEY,
          'x-rapidapi-host': COLES_HOST,
        },
        timeout: API_TIMEOUT_MS,
      });

      const rawList = extractResultsArray(response.data);
      const items = rawList
        .map((item) => normalizeItem(item, 'Coles'))
        .filter(Boolean)
        .slice(0, RESULT_LIMIT);

      if (!items.length && rawList.length) {
        console.warn('  ⚠️ Coles returned items but none could be normalized.');
      }

      return items;
    } catch (error) {
      lastError = error;
      const retryable = isRetryableApiError(error);
      console.error(
        `  ❌ Coles attempt ${attempt}/${API_MAX_RETRIES} failed:`,
        error?.response?.data || error?.message || error?.code
      );
      if (retryable && attempt < API_MAX_RETRIES) {
        await sleep(1500 * attempt);
        continue;
      }
      throw lastError;
    }
  }

  throw lastError || new Error('Coles API failed.');
}

// ============================================================
// 6. HÀM GỌI WOOLWORTHS RAPIDAPI
// ============================================================
async function fetchWoolworths(keyword) {
  const url = `https://${WOOLWORTHS_HOST}/woolworths/search`;
  let lastError = null;

  for (let attempt = 1; attempt <= API_MAX_RETRIES; attempt++) {
    try {
      const { data } = await axios.get(url, {
        params: {
          query: keyword,
          page: 1,
        },
        headers: {
          'x-rapidapi-key': RAPIDAPI_KEY,
          'x-rapidapi-host': WOOLWORTHS_HOST,
        },
        timeout: API_TIMEOUT_MS,
      });

      const rawList = extractResultsArray(data);
      const items = rawList
        .map((item) => normalizeItem(item, 'Woolworths'))
        .filter(Boolean)
        .slice(0, RESULT_LIMIT);

      if (!items.length && rawList.length) {
        console.warn('  ⚠️ Woolworths returned items but none could be normalized.');
      }

      return items;
    } catch (error) {
      lastError = error;
      const retryable = isRetryableApiError(error);
      console.error(
        `  ❌ Woolworths attempt ${attempt}/${API_MAX_RETRIES} failed:`,
        error?.response?.data || error?.message || error?.code
      );
      if (retryable && attempt < API_MAX_RETRIES) {
        await sleep(1500 * attempt);
        continue;
      }
      throw lastError;
    }
  }

  throw lastError || new Error('Woolworths API failed.');
}

// ============================================================
// 7. ENDPOINT CHÍNH: GET /api/compare?keyword=...
// ============================================================
/**
 * Gọi song song cả 2 API qua Promise.allSettled:
 *   - Nếu 1 bên lỗi (rate-limit, network, ...) → bên còn lại vẫn trả dữ liệu.
 *   - Gộp kết quả và sắp xếp giá tăng dần.
 *
 * Response: mảng JSON thống nhất
 * [
 *   { supermarket: 'Coles',      name: '...', price: 3.50, image: '...' },
 *   { supermarket: 'Woolworths', name: '...', price: 3.80, image: '...' },
 *   ...
 * ]
 */
app.get('/api/compare', async (req, res) => {
  const keyword = (req.query.keyword || '').trim();

  if (!keyword) {
    return res.status(400).json({ error: 'Missing keyword parameter.' });
  }

  console.log(`\n🔎 Searching: "${keyword}"`);

  // Bọc try/catch riêng cho Coles: lỗi vẫn trả Woolworths bình thường
  const safeFetchColes = async () => {
    try {
      const items = await fetchColes(keyword);
      return { items, error: null };
    } catch (error) {
      const message = formatStoreError('Coles', error);
      console.error('  ❌ Coles error:', message);
      return { items: [], error: message };
    }
  };

  const safeFetchWoolworths = async () => {
    try {
      const items = await fetchWoolworths(keyword);
      return { items, error: null };
    } catch (error) {
      const message = formatStoreError('Woolworths', error);
      console.error('  ❌ Woolworths error:', message);
      return { items: [], error: message };
    }
  };

  // Gọi song song – allSettled đảm bảo cả 2 đều được xử lý dù có lỗi
  const [colesSettled, woolSettled] = await Promise.allSettled([
    safeFetchColes(),
    safeFetchWoolworths(),
  ]);

  let colesItems      = [];
  let woolworthsItems = [];
  let colesError      = null;
  let woolworthsError = null;

  // Lấy kết quả Coles (nếu thành công)
  if (colesSettled.status === 'fulfilled') {
    colesItems = colesSettled.value.items;
    colesError = colesSettled.value.error;
    console.log(`  Coles: ${colesItems.length} products`);
  } else {
    colesError = formatStoreError('Coles', colesSettled.reason);
    console.error('  ❌ Coles promise error:', colesError);
  }

  // Lấy kết quả Woolworths (nếu thành công)
  if (woolSettled.status === 'fulfilled') {
    woolworthsItems = woolSettled.value.items;
    woolworthsError = woolSettled.value.error;
    console.log(`  Woolworths: ${woolworthsItems.length} products`);
  } else {
    woolworthsError = formatStoreError('Woolworths', woolSettled.reason);
    console.error('  ❌ Woolworths promise error:', woolworthsError);
  }

  // Cả 2 đều lỗi → trả về 502
  if (!colesItems.length && !woolworthsItems.length) {
    return res.status(502).json({
      error: 'Both APIs failed or returned no results. Check your RapidAPI key and plan limits.',
    });
  }

  // Gộp 2 danh sách → sắp xếp theo giá tăng dần
  const combined = [...colesItems, ...woolworthsItems].sort(
    (a, b) => a.price - b.price
  );
  const similarPairs = buildSimilarPairs(woolworthsItems, colesItems);

  console.log(
    `  ✅ Total returned: ${combined.length} products | Similar pairs: ${similarPairs.length}\n`
  );

  res.json({
    items: combined,
    similarPairs,
    storeErrors: {
      coles: colesError,
      woolworths: woolworthsError,
    },
  });
});

// Health check endpoint
app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// ============================================================
// 8. KHỞI ĐỘNG SERVER
// ============================================================
app.listen(PORT, () => {
  console.log(`\n🚀 SmartChoice running at http://localhost:${PORT}`);
  console.log(`   Test: http://localhost:${PORT}/api/compare?keyword=milk\n`);
});
