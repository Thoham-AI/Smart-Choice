/**
 * SmartChoice – Backend trung gian RapidAPI
 * Chạy: node server.js  →  http://localhost:3000
 */

require('dotenv').config();

const express = require('express');
const axios   = require('axios');
const cors    = require('cors');
const OpenAI = require('openai');
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
const LIST_MATCH_THRESHOLD = 0.38; // Ngưỡng chọn sản phẩm khớp nhất cho từng dòng giỏ AI
const API_TIMEOUT_MS = 60000; // Một số request RapidAPI có thể chậm
const API_MAX_RETRIES = 2;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const openaiClient = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

// ============================================================
// 2. KHỞI TẠO EXPRESS
// ============================================================
const app = express();
app.use(cors());                       // Cho phép front-end trên origin khác gọi vào
app.use(express.json({ limit: '32kb' }));
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
// 3b. UNIT PRICING – BÓC TÁCH KHỐI LƯỢNG & TÍNH GIÁ / 100g|100ml
// ============================================================

/** Quy đổi kg/L về gram/ml */
function normalizeToBaseUnit(value, unit) {
  const u = String(unit).toLowerCase();
  if (u === 'kg') return value * 1000;
  if (u === 'g') return value;
  if (u === 'l') return value * 1000;
  if (u === 'ml') return value;
  return value;
}

/**
 * Bóc tách khối lượng từ chuỗi (tên sản phẩm, size, …).
 * Hỗ trợ: 250g, 1kg, 500ml, 1L, 2x125g, approx. 200g each
 */
function parseQuantityFromText(text) {
  const source = String(text || '').toLowerCase();

  if (!source.trim()) {
    return { unknown: true };
  }

  // Sản phẩm bán theo cái / each
  if (/\bwhole\s+each\b/i.test(source)) {
    return { isEach: true };
  }

  // Gói nhiều: 2x125g, 6 x 330ml
  const multiMatch = source.match(
    /(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*(kg|g|ml|l)\b/i
  );
  if (multiMatch) {
    const count = parseInt(multiMatch[1], 10);
    const value = parseFloat(multiMatch[2]);
    const unit = multiMatch[3].toLowerCase();
    const baseUnit = unit === 'ml' || unit === 'l' ? 'ml' : 'g';
    return {
      amountInBaseUnit: normalizeToBaseUnit(value, unit) * count,
      baseUnit,
    };
  }

  // Đơn lẻ: 1kg, 450g, 1.5l, 500ml
  const singleMatch = source.match(/(\d+(?:\.\d+)?)\s*(kg|g|ml|l)\b/i);
  if (singleMatch) {
    const value = parseFloat(singleMatch[1]);
    const unit = singleMatch[2].toLowerCase();
    const baseUnit = unit === 'ml' || unit === 'l' ? 'ml' : 'g';
    return {
      amountInBaseUnit: normalizeToBaseUnit(value, unit),
      baseUnit,
    };
  }

  if (/\beach\b/i.test(source) && !/\d+\s*(?:g|kg|ml|l)\b/i.test(source)) {
    return { isEach: true };
  }

  return { unknown: true };
}

/** Gộp nguồn: tên hiển thị → field size → unit API */
function resolveProductQuantity(displayName, raw = {}) {
  const fromName = parseQuantityFromText(displayName);
  if (fromName.amountInBaseUnit) return fromName;
  if (fromName.isEach) return fromName;

  const sizeText = raw.size || raw.package_size || raw.pack_size || '';
  const fromSize = parseQuantityFromText(sizeText);
  if (fromSize.amountInBaseUnit) return fromSize;
  if (fromSize.isEach) return fromSize;

  const unitField = String(raw.unit || '').toLowerCase();
  if (unitField === 'each' || unitField === 'ea') {
    return { isEach: true };
  }

  return fromName.unknown ? { unknown: true } : fromName;
}

/** Chuẩn hóa chuỗi unit price từ API Woolworths (vd: "$0.88 / 100G") */
function normalizeApiUnitPriceText(apiText) {
  const cleaned = String(apiText).trim().replace(/\s+/g, ' ');
  const match = cleaned.match(/\$?\s*([\d.]+)\s*\/\s*100\s*(g|ml)/i);
  if (match) {
    const amount = parseFloat(match[1]);
    const unit = match[2].toLowerCase();
    if (Number.isFinite(amount)) {
      return `$${amount.toFixed(2)} / 100${unit}`;
    }
  }
  return cleaned;
}

/**
 * Tạo chuỗi unit_price_text cho front-end.
 * - Có khối lượng: "$X.XX / 100g" hoặc "/ 100ml"
 * - Each / không parse được: "$X.XX / each"
 */
function buildUnitPriceText(price, displayName, raw = {}) {
  const apiUnit = raw.unit_price || raw.unitPrice;
  if (apiUnit && typeof apiUnit === 'string' && /\//.test(apiUnit)) {
    return normalizeApiUnitPriceText(apiUnit);
  }

  // Coles: price_per_unit trên 100g
  if (
    raw.price_per_unit_price != null &&
    raw.price_per_unit_quantity === 100 &&
    raw.price_per_unit_unit
  ) {
    const u = String(raw.price_per_unit_unit).toLowerCase();
    if (u === 'g' || u === 'ml') {
      return `$${Number(raw.price_per_unit_price).toFixed(2)} / 100${u}`;
    }
  }

  const quantity = resolveProductQuantity(displayName, raw);

  if (quantity.isEach || quantity.unknown) {
    return `$${price.toFixed(2)} / each`;
  }

  const per100 = (price / quantity.amountInBaseUnit) * 100;
  const label = quantity.baseUnit === 'ml' ? '100ml' : '100g';
  return `$${per100.toFixed(2)} / ${label}`;
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

/**
 * Lấy link trang sản phẩm gốc.
 * Coles (Dromb) thường dùng source_url + slug, không phải field url.
 */
function extractProductUrl(raw, supermarket) {
  const direct =
    raw.source_url ||
    raw.url ||
    raw.product_url ||
    raw.productUrl ||
    raw.link ||
    raw.product_link ||
    raw.canonical_url ||
    raw.href;

  if (direct) {
    const trimmed = String(direct).trim();
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
  }

  if (supermarket === 'Coles' && raw.slug) {
    const slug = String(raw.slug).replace(/^\//, '');
    return `https://www.coles.com.au/product/${slug}`;
  }

  if (supermarket === 'Woolworths' && raw.stockcode) {
    return `https://www.woolworths.com.au/shop/productdetails?stockcode=${raw.stockcode}`;
  }

  return '';
}

/**
 * Ghép tên hiển thị đầy đủ (Coles thường tách brand + name + size).
 * Ví dụ: brand=Sunrice, name="Microwave Jasmine Rice Pouch", size="450g"
 *   → "Sunrice Microwave Jasmine Rice Pouch 450g"
 */
function buildDisplayName(raw) {
  let baseName = String(
    raw.name || raw.productName || raw.product_name || raw.title || raw.product_title || ''
  ).trim();

  const brand = String(raw.brand || raw.brand_name || '').trim();
  let size = String(
    raw.size || raw.package_size || raw.pack_size || raw.unit_size || ''
  ).trim();

  if (!size) {
    size = extractSizeFromSlug(raw.slug);
  }

  if (brand) {
    const brandLower = brand.toLowerCase();
    const nameLower = baseName.toLowerCase();

    // Thêm thương hiệu nếu chưa có trong tên (Sunrice, …)
    if (!nameLower.includes(brandLower)) {
      baseName = `${brand} ${baseName}`;
    }
  }

  if (size) {
    const compactSize = size.replace(/^approx\.?\s*/i, '').trim();
    if (compactSize && !baseName.toLowerCase().includes(compactSize.toLowerCase())) {
      baseName = `${baseName} ${compactSize}`;
    }
  }

  return baseName.trim();
}

/** Lấy khối lượng từ slug Coles/Woolworths khi API không có field size */
function extractSizeFromSlug(slug) {
  if (!slug) return '';
  const match = String(slug).match(/(\d+(?:\.\d+)?\s*(?:kg|g|l|ml))/i);
  if (!match) return '';
  return match[1].replace(/\s+/g, '');
}

function normalizeItem(raw, supermarket) {
  if (!raw || typeof raw !== 'object') return null;

  const name = buildDisplayName(raw);

  const listedPrice = parsePrice(raw.price) ?? parsePrice(raw.current_price);
  const discountPrice = parsePrice(raw.discount_price) ?? parsePrice(raw.sale_price);
  const wasPrice =
    parsePrice(raw.was_price) ??
    parsePrice(raw.original_price) ??
    parsePrice(raw.list_price) ??
    parsePrice(raw.regular_price);

  // Giá hiển thị: ưu tiên giá khuyến mãi nếu thấp hơn giá gốc
  let price = listedPrice ?? discountPrice ?? parsePrice(raw.selling_price) ?? parsePrice(raw.final_price);
  let originalPrice = null;
  let isOnSpecial =
    raw.is_on_special === true ||
    raw.on_special === true ||
    raw.isSpecial === true ||
    raw.special === true;

  if (discountPrice != null && listedPrice != null && discountPrice < listedPrice) {
    price = discountPrice;
    originalPrice = listedPrice;
    isOnSpecial = true;
  } else if (wasPrice != null && price != null && wasPrice > price) {
    originalPrice = wasPrice;
    isOnSpecial = true;
  } else if (isOnSpecial && wasPrice != null && price != null && wasPrice > price) {
    originalPrice = wasPrice;
  }

  const saveAmount =
    originalPrice != null && price != null && originalPrice > price
      ? Number((originalPrice - price).toFixed(2))
      : null;

  const url = extractProductUrl(raw, supermarket);

  const image =
    raw.image ||
    (Array.isArray(raw.images) ? raw.images[0] : null) ||
    raw.image_url ||
    raw.imageUrl ||
    raw.thumbnail ||
    raw.img ||
    '';

  if (!name || price == null) return null;

  const unit_price_text = buildUnitPriceText(price, name, raw);

  return {
    supermarket,
    name,
    brand: String(raw.brand || raw.brand_name || '').trim(),
    size: String(raw.size || raw.package_size || '').trim(),
    price,
    originalPrice,
    isOnSpecial: Boolean(isOnSpecial || saveAmount),
    saveAmount,
    unit_price_text,
    url: String(url).trim(),
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
 * Chấm điểm 1 sản phẩm so với từ khóa người dùng (AI shopping list).
 * Dùng cùng logic loại/size như ghép cặp similar.
 */
function scoreProductForKeyword(productName, keyword, hintText = '') {
  const query = `${keyword} ${hintText}`.trim();
  const productNorm = normalizeNameForMatch(productName);
  const queryNorm = normalizeNameForMatch(query);
  if (!productNorm || !queryNorm) return 0;

  if (!varietiesCompatible(productName, query)) return 0;

  const sizeStatus = checkSizeCompatibility(productName, query);
  if (sizeStatus === 'conflict') return 0;

  let score = stringSimilarity.compareTwoStrings(productNorm, queryNorm);

  const words = queryNorm.split(' ').filter((w) => w.length > 2);
  for (const word of words) {
    if (productNorm.includes(word)) score += 0.04;
  }

  if (sizeStatus === 'mismatch_one_sided') score *= 0.85;

  return Math.min(score, 1);
}

/** Chọn sản phẩm khớp nhất trong danh sách kết quả tìm kiếm */
function pickBestProductMatch(products, keyword, listItem = {}) {
  if (!products?.length) return { product: null, score: 0 };

  const hint = buildQuantityHint(listItem);
  let best = null;
  let bestScore = 0;

  for (const product of products) {
    const score = scoreProductForKeyword(product.name, keyword, hint);
    if (score > bestScore) {
      bestScore = score;
      best = product;
    }
  }

  if (!best || bestScore < LIST_MATCH_THRESHOLD) {
    return { product: null, score: bestScore };
  }

  return { product: best, score: Number(bestScore.toFixed(2)) };
}

/** Gợi ý khối lượng cho câu truy vấn (vd: rice + 2kg → "2 kg") */
function buildQuantityHint(listItem) {
  const qty = listItem.quantity;
  const unit = String(listItem.unit || '').toLowerCase();
  if (qty != null && unit && ['kg', 'g', 'l', 'ml'].includes(unit)) {
    return `${qty}${unit}`;
  }
  return '';
}

/** Chuỗi tìm kiếm RapidAPI từ 1 dòng giỏ đã parse */
function buildSearchQueryFromListItem(listItem) {
  const keyword = String(listItem.keyword || '').trim();
  const hint = buildQuantityHint(listItem);
  return hint ? `${keyword} ${hint}` : keyword;
}

/**
 * Tính tiền 1 dòng: nhân quantity khi unit là each/pack/bunch.
 * Với kg/g/L chỉ tính 1 gói khớp (API trả về giá theo pack).
 */
function computeLinePrice(product, listItem) {
  if (!product) return 0;
  const unit = String(listItem.unit || 'each').toLowerCase();
  const qty = Number(listItem.quantity) > 0 ? Number(listItem.quantity) : 1;
  const countable = ['each', 'ea', 'pack', 'pk', 'bunch', 'dozen', 'loaf', 'bottle', 'can'];
  const multiplier = countable.includes(unit) ? qty : 1;
  return Number((product.price * multiplier).toFixed(2));
}

// ============================================================
// 3c. AI SHOPPING LIST – PARSE PROMPT & TỐI ƯU GIỎ
// ============================================================

const SHOPPING_LIST_SYSTEM_PROMPT = `You extract grocery shopping list items from natural language.
Return ONLY valid JSON: an array of objects with exactly these fields:
- "keyword": English search term for Australian supermarkets (e.g. "rice", "belly pork", "milk")
- "quantity": number (default 1)
- "unit": one of kg, g, L, ml, each, pack, bunch

Rules:
- Use simple product keywords suitable for Coles/Woolworths search.
- Convert volumes: 2L → quantity 2, unit "L". 500ml → quantity 500, unit "ml".
- "2 kg rice" → keyword "rice", quantity 2, unit "kg".
- No markdown, no explanation, only the JSON array.`;

/** Gọi OpenAI để bóc tách danh sách món */
async function parseShoppingListWithAI(promptText) {
  if (!openaiClient) {
    throw new Error(
      'OPENAI_API_KEY is not configured. Add it to .env to use AI list analysis.'
    );
  }

  const completion = await openaiClient.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.2,
    messages: [
      { role: 'system', content: SHOPPING_LIST_SYSTEM_PROMPT },
      { role: 'user', content: promptText },
    ],
  });

  const raw = completion.choices?.[0]?.message?.content?.trim() || '';
  const jsonText = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '');
  const parsed = JSON.parse(jsonText);

  if (!Array.isArray(parsed)) {
    throw new Error('AI did not return a JSON array.');
  }

  return parsed
    .map((row) => ({
      keyword: String(row.keyword || row.item || row.name || '').trim(),
      quantity: Number(row.quantity) > 0 ? Number(row.quantity) : 1,
      unit: String(row.unit || 'each').trim().toLowerCase(),
    }))
    .filter((row) => row.keyword);
}

/** Dự phòng khi không có OpenAI: regex tách từng dòng */
function parseShoppingListFallback(promptText) {
  const segments = String(promptText)
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  return segments.map((part) => {
    const match = part.match(
      /^(\d+(?:\.\d+)?)\s*(kg|g|l|ml|each|pack|bunch)?\s+(.+)$/i
    );
    if (match) {
      return {
        keyword: match[3].trim(),
        quantity: parseFloat(match[1]),
        unit: (match[2] || 'each').toLowerCase(),
      };
    }
    return { keyword: part, quantity: 1, unit: 'each' };
  });
}

/** Tìm sản phẩm tốt nhất ở cả 2 siêu thị cho 1 dòng giỏ */
async function resolveListItem(listItem) {
  const searchQuery = buildSearchQueryFromListItem(listItem);

  const [colesSettled, woolSettled] = await Promise.allSettled([
    (async () => {
      try {
        return { items: await fetchColes(searchQuery), error: null };
      } catch (error) {
        return { items: [], error: formatStoreError('Coles', error) };
      }
    })(),
    (async () => {
      try {
        return { items: await fetchWoolworths(searchQuery), error: null };
      } catch (error) {
        return { items: [], error: formatStoreError('Woolworths', error) };
      }
    })(),
  ]);

  const colesPayload =
    colesSettled.status === 'fulfilled'
      ? colesSettled.value
      : { items: [], error: formatStoreError('Coles', colesSettled.reason) };
  const woolPayload =
    woolSettled.status === 'fulfilled'
      ? woolSettled.value
      : { items: [], error: formatStoreError('Woolworths', woolSettled.reason) };

  const colesMatch = pickBestProductMatch(
    colesPayload.items,
    listItem.keyword,
    listItem
  );
  const woolMatch = pickBestProductMatch(
    woolPayload.items,
    listItem.keyword,
    listItem
  );

  const colesPrice = computeLinePrice(colesMatch.product, listItem);
  const woolPrice = computeLinePrice(woolMatch.product, listItem);

  let chosenStore = null;
  let chosenProduct = null;
  let lineTotal = 0;

  if (colesMatch.product && woolMatch.product) {
    if (colesPrice <= woolPrice) {
      chosenStore = 'Coles';
      chosenProduct = colesMatch.product;
      lineTotal = colesPrice;
    } else {
      chosenStore = 'Woolworths';
      chosenProduct = woolMatch.product;
      lineTotal = woolPrice;
    }
  } else if (colesMatch.product) {
    chosenStore = 'Coles';
    chosenProduct = colesMatch.product;
    lineTotal = colesPrice;
  } else if (woolMatch.product) {
    chosenStore = 'Woolworths';
    chosenProduct = woolMatch.product;
    lineTotal = woolPrice;
  }

  return {
    request: listItem,
    searchQuery,
    coles: colesMatch.product,
    woolworths: woolMatch.product,
    colesLinePrice: colesPrice,
    woolworthsLinePrice: woolPrice,
    colesMatchScore: colesMatch.score,
    woolworthsMatchScore: woolMatch.score,
    storeErrors: {
      coles: colesPayload.error,
      woolworths: woolPayload.error,
    },
    chosenStore,
    chosenProduct,
    lineTotal,
  };
}

/**
 * Tổng hợp 3 phương án: chỉ Coles, chỉ Woolworths, split rẻ nhất.
 */
function buildCartOptimization(lineItems) {
  let colesOnlyTotal = 0;
  let woolworthsOnlyTotal = 0;
  let splitTotal = 0;
  const splitCart = { coles: [], woolworths: [] };
  const unresolved = [];

  for (const line of lineItems) {
    const hasColes = Boolean(line.coles);
    const hasWool = Boolean(line.woolworths);

    if (hasColes) colesOnlyTotal += line.colesLinePrice;
    else if (line.request?.keyword) unresolved.push(line.request.keyword);

    if (hasWool) woolworthsOnlyTotal += line.woolworthsLinePrice;

    if (!hasColes && !hasWool) continue;

    splitTotal += line.lineTotal;

    const entry = {
      request: line.request,
      product: line.chosenProduct,
      lineTotal: line.lineTotal,
      coles: line.coles,
      woolworths: line.woolworths,
      colesLinePrice: line.colesLinePrice,
      woolworthsLinePrice: line.woolworthsLinePrice,
    };

    if (line.chosenStore === 'Coles') {
      splitCart.coles.push(entry);
    } else if (line.chosenStore === 'Woolworths') {
      splitCart.woolworths.push(entry);
    }
  }

  colesOnlyTotal = Number(colesOnlyTotal.toFixed(2));
  woolworthsOnlyTotal = Number(woolworthsOnlyTotal.toFixed(2));
  splitTotal = Number(splitTotal.toFixed(2));

  const singleStoreOptions = [
    { store: 'Coles', total: colesOnlyTotal },
    { store: 'Woolworths', total: woolworthsOnlyTotal },
  ].filter((o) => o.total > 0);

  const baseline =
    singleStoreOptions.length > 0
      ? Math.max(...singleStoreOptions.map((o) => o.total))
      : 0;
  const baselineStore =
    colesOnlyTotal >= woolworthsOnlyTotal ? 'Coles' : 'Woolworths';

  const savingsAmount = Number(Math.max(0, baseline - splitTotal).toFixed(2));
  const savingsPercent =
    baseline > 0 ? Number(((savingsAmount / baseline) * 100).toFixed(1)) : 0;

  const savingsVsColes =
    colesOnlyTotal > splitTotal
      ? {
          amount: Number((colesOnlyTotal - splitTotal).toFixed(2)),
          percent: Number(
            (((colesOnlyTotal - splitTotal) / colesOnlyTotal) * 100).toFixed(1)
          ),
        }
      : { amount: 0, percent: 0 };

  const savingsVsWoolworths =
    woolworthsOnlyTotal > splitTotal
      ? {
          amount: Number((woolworthsOnlyTotal - splitTotal).toFixed(2)),
          percent: Number(
            (
              ((woolworthsOnlyTotal - splitTotal) / woolworthsOnlyTotal) *
              100
            ).toFixed(1)
          ),
        }
      : { amount: 0, percent: 0 };

  return {
    colesOnlyTotal,
    woolworthsOnlyTotal,
    splitTotal,
    splitCart,
    savings: {
      amount: savingsAmount,
      percent: savingsPercent,
      comparedTo: baselineStore,
    },
    savingsVsColes,
    savingsVsWoolworths,
    unresolved,
  };
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

// ============================================================
// 7b. AI SHOPPING LIST: POST /api/analyze-prompt
// ============================================================
/**
 * Nhận văn bản tự nhiên → OpenAI parse → tìm từng món song song
 * → trả tổng Coles / Woolworths / split tối ưu.
 */
app.post('/api/analyze-prompt', async (req, res) => {
  const prompt = String(req.body?.prompt || req.body?.text || '').trim();

  if (!prompt) {
    return res.status(400).json({ error: 'Missing prompt. Send { "prompt": "..." }.' });
  }

  console.log(`\n🤖 AI shopping list (${prompt.length} chars)`);

  let parsedItems;
  let parseSource = 'openai';

  try {
    if (openaiClient) {
      parsedItems = await parseShoppingListWithAI(prompt);
    } else {
      parseSource = 'fallback';
      parsedItems = parseShoppingListFallback(prompt);
    }
  } catch (error) {
    console.error('  ❌ Parse error:', error.message);
    return res.status(502).json({
      error: error.message || 'Could not parse shopping list.',
    });
  }

  if (!parsedItems.length) {
    return res.status(400).json({
      error: 'No items found in your list. Try clearer lines like "2 kg rice, 1 L milk".',
    });
  }

  console.log(`  📋 ${parsedItems.length} items (${parseSource})`);

  // Gọi song song tất cả món – mỗi món lại gọi song song Coles + Woolworths
  const lineResults = await Promise.all(
    parsedItems.map((item) => resolveListItem(item))
  );

  const optimization = buildCartOptimization(lineResults);

  console.log(
    `  ✅ Split $${optimization.splitTotal} | Coles $${optimization.colesOnlyTotal} | WW $${optimization.woolworthsOnlyTotal}\n`
  );

  res.json({
    parseSource,
    parsedItems,
    lineItems: lineResults,
    optimization,
  });
});

// Health check endpoint
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    openaiConfigured: Boolean(openaiClient),
  });
});

// ============================================================
// 8. KHỞI ĐỘNG SERVER
// ============================================================
app.listen(PORT, () => {
  console.log(`\n🚀 SmartChoice running at http://localhost:${PORT}`);
  console.log(`   Test: http://localhost:${PORT}/api/compare?keyword=milk\n`);
});
