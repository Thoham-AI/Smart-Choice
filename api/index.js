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

/** ID ổn định từ stockcode (WW) hoặc slug (Coles) – dùng cho watchlist */
function extractProductId(raw, supermarket) {
  if (supermarket === 'Woolworths' && raw.stockcode != null) {
    return `ww-${raw.stockcode}`;
  }
  if (supermarket === 'Coles' && raw.slug) {
    return `coles-${String(raw.slug).replace(/^\//, '')}`;
  }
  if (raw.product_id != null) return `${supermarket}-${raw.product_id}`;
  if (raw.id != null) return `${supermarket}-${raw.id}`;
  return null;
}

// ============================================================
// 3d. BARCODE – TRÍCH & SO KHỚP MÃ VẠCH TỪ API
// ============================================================

/** Chuẩn hóa mã vạch: chỉ giữ chữ số */
function normalizeBarcode(value) {
  return String(value || '').replace(/\D/g, '');
}

/** Thu thập mọi mã vạch có thể có trên object thô RapidAPI */
function collectBarcodesFromRaw(raw, found = new Set()) {
  if (!raw || typeof raw !== 'object') return found;

  const fields = [
    'barcode',
    'barcodes',
    'ean',
    'ean13',
    'gtin',
    'upc',
    'product_barcode',
    'productBarcode',
  ];

  for (const key of fields) {
    const val = raw[key];
    if (val == null) continue;
    if (Array.isArray(val)) {
      val.forEach((entry) => {
        const digits = normalizeBarcode(entry);
        if (digits.length >= 8) found.add(digits);
      });
    } else {
      const digits = normalizeBarcode(val);
      if (digits.length >= 8) found.add(digits);
    }
  }

  if (raw.product && typeof raw.product === 'object') {
    collectBarcodesFromRaw(raw.product, found);
  }

  return found;
}

/** So khớp EAN-13 / UPC (có thể khác số 0 đầu) */
function barcodesMatch(codeA, codeB) {
  const a = normalizeBarcode(codeA);
  const b = normalizeBarcode(codeB);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length === 13 && a.startsWith('0') && a.slice(1) === b) return true;
  if (b.length === 13 && b.startsWith('0') && b.slice(1) === a) return true;
  return false;
}

/** Tìm sản phẩm có trường barcode khớp chính xác trong danh sách thô */
function findProductByBarcodeInRawList(rawList, barcode, supermarket) {
  const target = normalizeBarcode(barcode);
  if (target.length < 8) return null;

  for (const raw of rawList) {
    const codes = collectBarcodesFromRaw(raw);
    for (const code of codes) {
      if (barcodesMatch(code, target)) {
        return normalizeItem(raw, supermarket);
      }
    }
  }

  return null;
}

/** Ghép cặp so sánh khi quét barcode trúng cả 2 siêu thị */
function buildDirectComparePair(woolworthsItem, colesItem) {
  if (!woolworthsItem || !colesItem) return null;

  const saving = Math.abs(woolworthsItem.price - colesItem.price);
  const cheaper =
    woolworthsItem.price < colesItem.price
      ? 'Woolworths'
      : colesItem.price < woolworthsItem.price
        ? 'Coles'
        : 'tie';

  return {
    woolworths: woolworthsItem,
    coles: colesItem,
    cheaper,
    saving: Number(saving.toFixed(2)),
    similarity: 1,
    matchType: 'barcode',
  };
}

/** Từ khóa tìm kiếm ngắn khi làm mới giá watchlist */
function deriveSearchKeyword(productName) {
  const words = normalizeNameForMatch(productName)
    .split(' ')
    .filter((w) => w.length > 2);
  if (words.length >= 2) return words.slice(0, 5).join(' ');
  return String(productName).split(/\s+/).slice(0, 4).join(' ');
}

// ============================================================
// 3e. THỰC PHẨM TƯƠI – FALLBACK TÌM KIẾM, GIÁ / KG, GHÉP CẶP
// ============================================================

/** Cụm từ cốt lõi thịt/rau – dùng ghép cặp dù tên có đuôi Roast, Slices, Rind On */
const FRESH_CORE_PHRASES = [
  'pork belly',
  'belly pork',
  'pork mince',
  'pork loin',
  'pork chop',
  'pork shoulder',
  'pork leg',
  'beef mince',
  'beef rump',
  'beef steak',
  'beef brisket',
  'beef roast',
  'lamb leg',
  'lamb chop',
  'lamb mince',
  'chicken breast',
  'chicken thigh',
  'chicken drumstick',
  'chicken wing',
  'whole chicken',
  'salmon fillet',
  'barramundi',
  'prawn',
  'fish fillet',
].sort((a, b) => b.length - a.length);

/** Từ khóa nhận diện danh mục tươi sống */
const FRESH_FOOD_TOKENS = [
  'pork',
  'beef',
  'lamb',
  'veal',
  'chicken',
  'turkey',
  'duck',
  'mince',
  'steak',
  'fillet',
  'rump',
  'belly',
  'thigh',
  'breast',
  'drumstick',
  'salmon',
  'prawn',
  'fish',
  'tomato',
  'potato',
  'onion',
  'carrot',
  'broccoli',
  'lettuce',
  'cucumber',
  'mushroom',
  'cabbage',
  'cauliflower',
  'zucchini',
  'capsicum',
  'spinach',
  'celery',
  'pumpkin',
  'corn',
  'apple',
  'banana',
  'orange',
  'grape',
  'berry',
  'herb',
  'parsley',
  'coriander',
  'vegetable',
];

const FRESH_PAIR_SCORE_FLOOR = 0.62;
const FRESH_LIST_MATCH_THRESHOLD = 0.32;

/** Bỏ phần cân nặng khỏi chuỗi tìm kiếm (1kg, 500g, 2 L, …) */
function stripWeightFromText(text) {
  return String(text || '')
    .replace(/\b\d+(?:\.\d+)?\s*(?:kg|g|ml|l)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Trích số lượng kg/g từ câu tìm kiếm (vd: "pork belly 1kg") */
function parseWeightFromSearchText(text) {
  const source = String(text || '');
  const kgMatch = source.match(/(\d+(?:\.\d+)?)\s*kg\b/i);
  if (kgMatch) {
    return { quantity: parseFloat(kgMatch[1]), unit: 'kg' };
  }
  const gMatch = source.match(/(\d+(?:\.\d+)?)\s*g\b/i);
  if (gMatch && !kgMatch) {
    return { quantity: parseFloat(gMatch[1]), unit: 'g' };
  }
  return null;
}

/** Tạo listItem giả từ ô search để tính giá theo kg */
function buildListItemFromSearchText(searchText, coreKeyword) {
  const weight = parseWeightFromSearchText(searchText);
  if (weight) {
    return { keyword: coreKeyword, quantity: weight.quantity, unit: weight.unit };
  }
  return { keyword: coreKeyword, quantity: 1, unit: 'each' };
}

function normalizeSearchQuery(q) {
  return String(q || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Có thuộc nhóm thực phẩm tươi không */
function isFreshFoodCategory(name) {
  const norm = normalizeNameForMatch(name);
  if (detectFreshCorePhrase(name)) return true;
  return FRESH_FOOD_TOKENS.some((token) => {
    const re = new RegExp(`\\b${token}\\b`, 'i');
    return re.test(norm);
  });
}

/** Lấy cụm cốt lõi (vd: "pork belly") từ tên sản phẩm */
function detectFreshCorePhrase(name) {
  const norm = normalizeNameForMatch(name);
  for (const phrase of FRESH_CORE_PHRASES) {
    if (norm.includes(phrase)) return phrase;
  }
  return null;
}

/** Hai tên cùng cụm cốt lõi → chấp nhận ghép dù khác Roast / Slices / Rind On */
function freshFoodCorePhraseMatch(nameA, nameB) {
  const phraseA = detectFreshCorePhrase(nameA);
  const phraseB = detectFreshCorePhrase(nameB);
  if (phraseA && phraseB && phraseA === phraseB) return true;

  const normA = normalizeNameForMatch(nameA);
  const normB = normalizeNameForMatch(nameB);
  if (phraseA && normB.includes(phraseA)) return true;
  if (phraseB && normA.includes(phraseB)) return true;

  return false;
}

// ============================================================
// 3f. TOÁN HỌC GIÁ GIỎ HÀNG – / KG, QUY ĐỔI KHỐI LƯỢNG, ĐƠN VỊ LẺ
// ============================================================

/**
 * Trích khối lượng gói/khay (kg) từ tên hoặc field size API.
 * VD: khay 1.3kg giá $26 → dùng suy ra $20/kg.
 */
function getPackWeightKgFromProduct(displayName, raw = {}) {
  const sizeInfo = extractSizeInfo(displayName);
  if (sizeInfo.grams != null && sizeInfo.grams > 0) {
    return Number((sizeInfo.grams / 1000).toFixed(4));
  }

  const fromSizeField = parseQuantityFromText(
    raw.size || raw.package_size || raw.pack_size || ''
  );
  if (fromSizeField.amountInBaseUnit && fromSizeField.baseUnit === 'g') {
    return Number((fromSizeField.amountInBaseUnit / 1000).toFixed(4));
  }

  return null;
}

/** Công thức: Price_Per_KG = Giá_khay / Khối_lượng_khay (kg) */
function derivePricePerKgFromPack(shelfPrice, packWeightKg) {
  if (shelfPrice == null || packWeightKg == null || packWeightKg <= 0) return null;
  return Number((shelfPrice / packWeightKg).toFixed(4));
}

/**
 * Đọc giá/kg từ unit_price, price_info, price_per_unit… trên payload API.
 */
function extractPricePerKgFromApiFields(raw, displayName) {
  const direct =
    parsePrice(raw.price_per_kg) ??
    parsePrice(raw.pricePerKg) ??
    parsePrice(raw.per_kg_price) ??
    parsePrice(raw.price_per_kilo) ??
    parsePrice(raw.pricePerKilo);

  if (direct != null) return direct;

  const priceInfo = raw.price_info || raw.priceInfo;
  if (priceInfo && typeof priceInfo === 'object') {
    const fromInfo =
      parsePrice(priceInfo.price_per_kg) ??
      parsePrice(priceInfo.per_kg) ??
      parsePrice(priceInfo.unit_price_per_kg);
    if (fromInfo != null) return fromInfo;
  }

  const unitField = String(
    raw.price_per_unit_unit || raw.unit_of_measure || raw.selling_unit || ''
  ).toLowerCase();

  if (unitField === 'kg' && raw.price_per_unit_price != null) {
    const ppu = parsePrice(raw.price_per_unit_price);
    if (ppu != null) return ppu;
  }

  const unitPriceRaw = raw.unit_price || raw.unitPrice || raw.UnitPrice;
  if (typeof unitPriceRaw === 'string') {
    const perKgInUnit = unitPriceRaw.match(/\$?\s*([\d.]+)\s*\/\s*1?\s*kg\b/i);
    if (perKgInUnit) return parsePrice(perKgInUnit[1]);

    const per100g = unitPriceRaw.match(/\$?\s*([\d.]+)\s*\/\s*100\s*g\b/i);
    if (per100g) {
      const per100 = parsePrice(per100g[1]);
      if (per100 != null) return Number((per100 * 10).toFixed(4));
    }
  }

  const metaText = [
    displayName,
    raw.size,
    raw.package_size,
    raw.unit,
    unitPriceRaw,
    raw.cupString,
    raw.CupString,
  ]
    .filter(Boolean)
    .join(' ');

  const perKgLabel = /\b(per\s*kg|\/\s*kg|kg\s*each)\b/i.test(metaText);
  if (perKgLabel) {
    const fromCup =
      parsePrice(raw.cupPrice) ??
      parsePrice(raw.CupPrice) ??
      parsePrice(raw.price_per_unit_price);
    if (fromCup != null) return fromCup;
  }

  const dollarMatch = String(metaText).match(
    /\$\s*([\d]+(?:\.\d+)?)\s*(?:\/|per)\s*kg/i
  );
  if (dollarMatch) return parsePrice(dollarMatch[1]);

  return null;
}

/**
 * Xác định Price_Per_KG: ưu tiên API, không có thì suy từ giá khay ÷ cân nặng khay.
 */
function resolvePricePerKg(raw, displayName, shelfPrice) {
  const packWeightKg = getPackWeightKgFromProduct(displayName, raw);
  let pricePerKg = extractPricePerKgFromApiFields(raw, displayName);
  let source = pricePerKg != null ? 'api' : null;

  if (pricePerKg == null && shelfPrice != null && packWeightKg != null) {
    pricePerKg = derivePricePerKgFromPack(shelfPrice, packWeightKg);
    if (pricePerKg != null) source = 'derived_pack';
  }

  return { pricePerKg, packWeightKg, source };
}

/** Target_Weight (kg) từ prompt khách: 1 kg → 1, 500g → 0.5 */
function getTargetWeightKg(listItem) {
  if (!listItem) return null;
  const unit = String(listItem.unit || '').toLowerCase();
  const qty = Number(listItem.quantity) > 0 ? Number(listItem.quantity) : 1;
  if (unit === 'kg') return qty;
  if (unit === 'g') return qty / 1000;
  return null;
}

/**
 * Nhận diện đơn vị lẻ: Half, Quarter, Slices…
 * multiplier: hệ số quy đổi về 1 đơn vị nguyên (half → ×2).
 */
function detectFractionalUnit(productName) {
  const name = String(productName || '');
  const lower = name.toLowerCase();

  if (/\bwhole\b/i.test(lower)) {
    return { isWhole: true, isFractional: false, multiplier: 1, type: 'whole' };
  }

  if (/\bhalf\b/i.test(lower) || /\b1\/2\b/.test(lower)) {
    return { isWhole: false, isFractional: true, multiplier: 2, type: 'half', penalizeMatch: true };
  }

  if (/\bquarter\b/i.test(lower) || /\b1\/4\b/.test(lower)) {
    return { isWhole: false, isFractional: true, multiplier: 4, type: 'quarter', penalizeMatch: true };
  }

  if (/\bthird\b/i.test(lower) || /\b1\/3\b/.test(lower)) {
    return { isWhole: false, isFractional: true, multiplier: 3, type: 'third', penalizeMatch: true };
  }

  if (/\bslices?\b/i.test(lower)) {
    return { isWhole: false, isFractional: true, multiplier: 1, type: 'slices', penalizeMatch: true };
  }

  return { isWhole: false, isFractional: false, multiplier: 1, type: null, penalizeMatch: false };
}

/** Khách yêu cầu 1 quả/cây nguyên (each × 1) */
function wantsWholeUnitEach(listItem) {
  if (!listItem) return false;
  const unit = String(listItem.unit || '').toLowerCase();
  const qty = Number(listItem.quantity) > 0 ? Number(listItem.quantity) : 1;
  return ['each', 'ea', 'bunch'].includes(unit) && qty === 1;
}

/**
 * Quy đổi giá hiển thị theo đúng số lượng/khối lượng trong prompt.
 * - Weight: Final_Displayed_Price = Price_Per_KG × Target_Weight
 * - Each + fractional: giá_khay × multiplier (half ×2, quarter ×4)
 */
function applyListItemPricing(product, listItem) {
  if (!product || !listItem) return product;

  const unit = String(listItem.unit || 'each').toLowerCase();
  const qty = Number(listItem.quantity) > 0 ? Number(listItem.quantity) : 1;
  const targetWeightKg = getTargetWeightKg(listItem);

  const packShelfPrice =
    product.packShelfPrice != null ? product.packShelfPrice : product.price;

  let pricePerKg = product.pricePerKg;
  if (pricePerKg == null && targetWeightKg != null) {
    const packKg = product.packWeightKg ?? getPackWeightKgFromProduct(product.name, {});
    pricePerKg = derivePricePerKgFromPack(packShelfPrice, packKg);
  }

  let finalPrice = packShelfPrice;
  let pricingNote = null;
  let isAdjustedPrice = false;

  if (pricePerKg != null && targetWeightKg != null) {
    finalPrice = Number((pricePerKg * targetWeightKg).toFixed(2));
    isAdjustedPrice = true;

    const weightLabel =
      unit === 'g' ? `${qty}g` : unit === 'kg' ? `${qty}kg` : `${targetWeightKg}kg`;

    pricingNote = `($${pricePerKg.toFixed(2)}/kg, converted for ${weightLabel})`;
  } else if (['each', 'ea', 'bunch', 'pack', 'pk'].includes(unit)) {
    const frac = detectFractionalUnit(product.name);

    if (frac.isFractional && frac.multiplier > 1) {
      finalPrice = Number((packShelfPrice * frac.multiplier * qty).toFixed(2));
      isAdjustedPrice = true;
      pricingNote = `($${packShelfPrice.toFixed(2)} per ${frac.type}, ×${frac.multiplier} → est. 1 whole unit)`;
    } else {
      finalPrice = Number((packShelfPrice * qty).toFixed(2));
      if (qty > 1) {
        isAdjustedPrice = true;
        pricingNote = `($${packShelfPrice.toFixed(2)} each × ${qty})`;
      }
    }
  } else {
    const countable = ['pack', 'pk', 'dozen', 'loaf', 'bottle', 'can'];
    const multiplier = countable.includes(unit) ? qty : 1;
    finalPrice = Number((packShelfPrice * multiplier).toFixed(2));
    if (multiplier > 1) isAdjustedPrice = true;
  }

  return {
    ...product,
    price: finalPrice,
    packShelfPrice,
    pricePerKg: pricePerKg ?? product.pricePerKg,
    isPerKgPricing: pricePerKg != null,
    isAdjustedPrice,
    pricingNote,
    targetQuantity: qty,
    targetUnit: unit,
    targetWeightKg,
    unit_price_text: pricingNote || product.unit_price_text,
  };
}

/** Giữ tên cũ – gọi module quy đổi mới */
function applyWeightContextToProduct(product, listItem) {
  return applyListItemPricing(product, listItem);
}

/**
 * Tìm kiếm có fallback: lượt 1 kèm cân nặng, lượt 2 chỉ từ khóa cốt lõi.
 */
async function fetchStoreProducts(supermarket, searchText, listItem = null) {
  const coreKeyword = stripWeightFromText(listItem?.keyword || searchText);
  const primaryQuery = listItem
    ? buildSearchQueryFromListItem(listItem)
    : searchText;
  const weightListItem =
    listItem || buildListItemFromSearchText(searchText, coreKeyword);

  const runSearch = async (query) => {
    const rawList = await fetchStoreRawList(supermarket, query);
    return normalizeRawList(rawList, supermarket).map((product) =>
      applyWeightContextToProduct(product, weightListItem)
    );
  };

  let items = await runSearch(primaryQuery);
  let usedFallback = false;

  const needsFallback = () => {
    if (!items.length) return true;
    if (listItem) {
      const { product } = pickBestProductMatch(items, coreKeyword, listItem);
      return !product;
    }
    return false;
  };

  const primaryNorm = normalizeSearchQuery(primaryQuery);
  const coreNorm = normalizeSearchQuery(coreKeyword);

  if (needsFallback() && coreNorm && coreNorm !== primaryNorm) {
    console.log(`  ↩ ${supermarket} fallback search: "${coreKeyword}"`);
    items = await runSearch(coreKeyword);
    usedFallback = true;
  }

  return { items, usedFallback, coreKeyword, primaryQuery };
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

  const packShelfPrice = price;
  const { pricePerKg, packWeightKg, source: pricePerKgSource } = resolvePricePerKg(
    raw,
    name,
    packShelfPrice
  );
  const isPerKgPricing = pricePerKg != null;

  if (!name || (packShelfPrice == null && pricePerKg == null)) return null;

  let unit_price_text = buildUnitPriceText(packShelfPrice, name, raw);
  if (isPerKgPricing) {
    unit_price_text = `$${pricePerKg.toFixed(2)} / kg`;
    if (pricePerKgSource === 'derived_pack' && packWeightKg) {
      unit_price_text += ` (from ${packWeightKg}kg pack $${packShelfPrice.toFixed(2)})`;
    }
  }

  const productId = extractProductId(raw, supermarket);
  const searchKeyword = deriveSearchKeyword(name);
  const barcodeSet = collectBarcodesFromRaw(raw);
  const barcodes = [...barcodeSet];
  const barcode = barcodes[0] || null;

  return {
    productId,
    searchKeyword,
    barcode,
    barcodes,
    supermarket,
    name,
    brand: String(raw.brand || raw.brand_name || '').trim(),
    size: String(raw.size || raw.package_size || '').trim(),
    price: packShelfPrice ?? pricePerKg,
    packShelfPrice,
    packWeightKg,
    pricePerKg,
    pricePerKgSource,
    isPerKgPricing,
    pricingNote: null,
    isAdjustedPrice: false,
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
  // Thịt/rau tươi: cân nặng khay thay đổi → không loại vì lệch 500g vs 1kg
  if (
    freshFoodCorePhraseMatch(nameA, nameB) ||
    (isFreshFoodCategory(nameA) && isFreshFoodCategory(nameB))
  ) {
    return 'ok';
  }

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

  // Cùng cụm "pork belly" → ghép dù khác Roast / Slices / Rind On
  if (freshFoodCorePhraseMatch(woolName, colesName)) {
    const base = stringSimilarity.compareTwoStrings(woolNorm, colesNorm);
    return Math.min(Math.max(base, FRESH_PAIR_SCORE_FLOOR), 1);
  }

  if (!varietiesCompatible(woolName, colesName)) return 0;

  const sizeStatus = checkSizeCompatibility(woolName, colesName);
  if (sizeStatus === 'conflict') return 0;

  let score = stringSimilarity.compareTwoStrings(woolNorm, colesNorm);

  if (sizeStatus === 'mismatch_one_sided') {
    const freshLoose =
      isFreshFoodCategory(woolName) || isFreshFoodCategory(colesName);
    score *= freshLoose ? 0.9 : 0.72;
  }

  return score;
}

/**
 * Chấm điểm 1 sản phẩm so với từ khóa người dùng (AI shopping list).
 * Dùng cùng logic loại/size như ghép cặp similar.
 */
function scoreProductForKeyword(productName, keyword, hintText = '', listItem = {}) {
  const coreKeyword = stripWeightFromText(keyword);
  const query = `${coreKeyword} ${hintText}`.trim();
  const productNorm = normalizeNameForMatch(productName);
  const queryNorm = normalizeNameForMatch(query);
  if (!productNorm || !queryNorm) return 0;

  if (freshFoodCorePhraseMatch(productName, coreKeyword)) {
    const base = stringSimilarity.compareTwoStrings(productNorm, queryNorm);
    return Math.min(Math.max(base, FRESH_PAIR_SCORE_FLOOR - 0.05), 1);
  }

  if (!varietiesCompatible(productName, query)) return 0;

  const sizeStatus = checkSizeCompatibility(productName, query);
  if (sizeStatus === 'conflict') return 0;

  let score = stringSimilarity.compareTwoStrings(productNorm, queryNorm);

  const words = queryNorm.split(' ').filter((w) => w.length > 2);
  for (const word of words) {
    if (productNorm.includes(word)) score += 0.04;
  }

  if (isFreshFoodCategory(productName) && isFreshFoodCategory(coreKeyword)) {
    const coreWords = stripWeightFromText(coreKeyword).split(' ').filter((w) => w.length > 2);
    const allInProduct = coreWords.length > 0 && coreWords.every((w) => productNorm.includes(w));
    if (allInProduct) score = Math.max(score, 0.52);
  }

  // Rau/quả each: ưu tiên "Whole", hạ điểm Half / Quarter / Slices
  if (wantsWholeUnitEach(listItem)) {
    const frac = detectFractionalUnit(productName);
    if (frac.isWhole) {
      score = Math.min(score + 0.14, 1);
    } else if (frac.penalizeMatch) {
      score *= frac.type === 'slices' ? 0.42 : 0.36;
    }
  }

  if (sizeStatus === 'mismatch_one_sided') {
    score *= isFreshFoodCategory(productName) ? 0.92 : 0.85;
  }

  return Math.min(score, 1);
}

/** Chọn sản phẩm khớp nhất trong danh sách kết quả tìm kiếm */
function pickBestProductMatch(products, keyword, listItem = {}) {
  if (!products?.length) return { product: null, score: 0 };

  const hint = buildQuantityHint(listItem);
  let best = null;
  let bestScore = 0;

  for (const product of products) {
    const score = scoreProductForKeyword(product.name, keyword, hint, listItem);
    if (score > bestScore) {
      bestScore = score;
      best = product;
    }
  }

  const threshold =
    isFreshFoodCategory(keyword) || isFreshFoodCategory(best?.name)
      ? FRESH_LIST_MATCH_THRESHOLD
      : LIST_MATCH_THRESHOLD;

  if (!best || bestScore < threshold) {
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
 * Tính tiền 1 dòng giỏ (dùng chung công thức với applyListItemPricing).
 */
function computeLinePrice(product, listItem) {
  if (!product) return 0;
  return applyListItemPricing(product, listItem).price;
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
        const result = await fetchStoreProducts('Coles', searchQuery, listItem);
        return { items: result.items, error: null, usedFallback: result.usedFallback };
      } catch (error) {
        return { items: [], error: formatStoreError('Coles', error) };
      }
    })(),
    (async () => {
      try {
        const result = await fetchStoreProducts('Woolworths', searchQuery, listItem);
        return { items: result.items, error: null, usedFallback: result.usedFallback };
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

  const colesPriced = colesMatch.product
    ? applyListItemPricing(colesMatch.product, listItem)
    : null;
  const woolPriced = woolMatch.product
    ? applyListItemPricing(woolMatch.product, listItem)
    : null;

  const colesPrice = colesPriced?.price ?? 0;
  const woolPrice = woolPriced?.price ?? 0;

  let chosenStore = null;
  let chosenProduct = null;
  let lineTotal = 0;

  if (colesPriced && woolPriced) {
    if (colesPrice <= woolPrice) {
      chosenStore = 'Coles';
      chosenProduct = colesPriced;
      lineTotal = colesPrice;
    } else {
      chosenStore = 'Woolworths';
      chosenProduct = woolPriced;
      lineTotal = woolPrice;
    }
  } else if (colesPriced) {
    chosenStore = 'Coles';
    chosenProduct = colesPriced;
    lineTotal = colesPrice;
  } else if (woolPriced) {
    chosenStore = 'Woolworths';
    chosenProduct = woolPriced;
    lineTotal = woolPrice;
  }

  return {
    request: listItem,
    searchQuery,
    coles: colesPriced,
    woolworths: woolPriced,
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

  const bestPick = pickBestCartStrategy(
    colesOnlyTotal,
    woolworthsOnlyTotal,
    splitTotal
  );
  const recommendation = buildCartRecommendationMessage(
    bestPick,
    colesOnlyTotal,
    woolworthsOnlyTotal,
    splitTotal
  );

  return {
    colesOnlyTotal,
    woolworthsOnlyTotal,
    splitTotal,
    splitCart,
    bestStrategy: bestPick.strategy,
    recommendedStore: bestPick.store,
    bestTotal: bestPick.total,
    isSplitWorthIt: bestPick.strategy === 'split',
    recommendation,
    savings: recommendation,
    savingsVsColes: recommendation.savingsVsColes,
    savingsVsWoolworths: recommendation.savingsVsWoolworths,
    unresolved,
  };
}

const PRICE_COMPARE_EPS = 0.01;

/**
 * Chọn phương án rẻ nhất. Nếu giá bằng nhau → ưu tiên mua hết 1 siêu thị (không gọi là split).
 */
function pickBestCartStrategy(colesOnlyTotal, woolworthsOnlyTotal, splitTotal) {
  const candidates = [];

  if (colesOnlyTotal > 0) {
    candidates.push({
      strategy: 'coles_only',
      store: 'Coles',
      total: colesOnlyTotal,
    });
  }
  if (woolworthsOnlyTotal > 0) {
    candidates.push({
      strategy: 'woolworths_only',
      store: 'Woolworths',
      total: woolworthsOnlyTotal,
    });
  }
  if (splitTotal > 0) {
    candidates.push({ strategy: 'split', store: 'Split', total: splitTotal });
  }

  if (!candidates.length) {
    return { strategy: 'none', store: null, total: 0 };
  }

  candidates.sort((a, b) => {
    const diff = a.total - b.total;
    if (Math.abs(diff) > PRICE_COMPARE_EPS) return diff;
    const rank = (strategy) => (strategy === 'split' ? 1 : 0);
    return rank(a.strategy) - rank(b.strategy);
  });

  return candidates[0];
}

/** Thông báo tiết kiệm theo phương án thực sự tốt nhất */
function buildCartRecommendationMessage(
  bestPick,
  colesOnlyTotal,
  woolworthsOnlyTotal,
  splitTotal
) {
  const empty = {
    message: '',
    amount: 0,
    percent: 0,
    comparedTo: null,
    savingsVsColes: { amount: 0, percent: 0 },
    savingsVsWoolworths: { amount: 0, percent: 0 },
  };

  if (!bestPick?.strategy || bestPick.strategy === 'none') return empty;

  if (bestPick.strategy === 'woolworths_only' && colesOnlyTotal > woolworthsOnlyTotal) {
    const amount = Number((colesOnlyTotal - woolworthsOnlyTotal).toFixed(2));
    const percent = Number(((amount / colesOnlyTotal) * 100).toFixed(1));
    return {
      message: `🎉 Head to Woolworths! You'll save $${amount.toFixed(2)} (${percent}%) compared to buying everything at Coles.`,
      amount,
      percent,
      comparedTo: 'Coles',
      savingsVsColes: { amount, percent },
      savingsVsWoolworths: { amount: 0, percent: 0 },
    };
  }

  if (bestPick.strategy === 'coles_only' && woolworthsOnlyTotal > colesOnlyTotal) {
    const amount = Number((woolworthsOnlyTotal - colesOnlyTotal).toFixed(2));
    const percent = Number(((amount / woolworthsOnlyTotal) * 100).toFixed(1));
    return {
      message: `🎉 Coles wins this round! You'll save $${amount.toFixed(2)} (${percent}%) vs buying everything at Woolworths.`,
      amount,
      percent,
      comparedTo: 'Woolworths',
      savingsVsColes: { amount: 0, percent: 0 },
      savingsVsWoolworths: { amount, percent },
    };
  }

  if (bestPick.strategy === 'split') {
    const baseline = Math.max(colesOnlyTotal, woolworthsOnlyTotal);
    const baselineStore =
      colesOnlyTotal >= woolworthsOnlyTotal ? 'Coles' : 'Woolworths';
    const amount = Number(Math.max(0, baseline - splitTotal).toFixed(2));
    const percent =
      baseline > 0 ? Number(((amount / baseline) * 100).toFixed(1)) : 0;

    return {
      message:
        amount > 0
          ? `💡 Best for your wallet: split your cart between stores and save $${amount.toFixed(2)} (${percent}%) vs buying everything at ${baselineStore}.`
          : '✨ Split cart matches the cheapest single-store total — either works!',
      amount,
      percent,
      comparedTo: baselineStore,
      savingsVsColes:
        colesOnlyTotal > splitTotal
          ? {
              amount: Number((colesOnlyTotal - splitTotal).toFixed(2)),
              percent: Number(
                (((colesOnlyTotal - splitTotal) / colesOnlyTotal) * 100).toFixed(1)
              ),
            }
          : { amount: 0, percent: 0 },
      savingsVsWoolworths:
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
          : { amount: 0, percent: 0 },
    };
  }

  if (bestPick.strategy === 'woolworths_only') {
    return {
      message: '🛒 Woolworths has the best total for your whole list — one stop and you\'re done!',
      amount: 0,
      percent: 0,
      comparedTo: null,
      savingsVsColes: { amount: 0, percent: 0 },
      savingsVsWoolworths: { amount: 0, percent: 0 },
    };
  }

  if (bestPick.strategy === 'coles_only') {
    return {
      message: '🛒 Coles has the best total for your whole list — one stop and you\'re done!',
      amount: 0,
      percent: 0,
      comparedTo: null,
      savingsVsColes: { amount: 0, percent: 0 },
      savingsVsWoolworths: { amount: 0, percent: 0 },
    };
  }

  return empty;
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

    const pairThreshold =
      bestIndex >= 0 &&
      freshFoodCorePhraseMatch(woolItem.name, colesItems[bestIndex].name)
        ? FRESH_PAIR_SCORE_FLOOR - 0.02
        : SIMILARITY_THRESHOLD;

    if (bestIndex < 0 || bestScore <= pairThreshold) continue;

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
// 5. HÀM GỌI COLES / WOOLWORTHS RAPIDAPI
// ============================================================

/** Gọi search API và trả về mảng sản phẩm thô (dùng cho khớp barcode) */
async function fetchStoreRawList(supermarket, keyword) {
  const isColes = supermarket === 'Coles';
  const host = isColes ? COLES_HOST : WOOLWORTHS_HOST;
  const path = isColes ? '/coles/search' : '/woolworths/search';
  const url = `https://${host}${path}`;
  let lastError = null;

  for (let attempt = 1; attempt <= API_MAX_RETRIES; attempt++) {
    try {
      const response = await axios.get(url, {
        params: { query: keyword, page: 1 },
        headers: {
          'x-rapidapi-key': RAPIDAPI_KEY,
          'x-rapidapi-host': host,
        },
        timeout: API_TIMEOUT_MS,
      });

      return extractResultsArray(response.data);
    } catch (error) {
      lastError = error;
      const retryable = isRetryableApiError(error);
      console.error(
        `  ❌ ${supermarket} attempt ${attempt}/${API_MAX_RETRIES} failed:`,
        error?.response?.data || error?.message || error?.code
      );
      if (retryable && attempt < API_MAX_RETRIES) {
        await sleep(1500 * attempt);
        continue;
      }
      throw lastError;
    }
  }

  throw lastError || new Error(`${supermarket} API failed.`);
}

function normalizeRawList(rawList, supermarket) {
  const items = rawList
    .map((item) => normalizeItem(item, supermarket))
    .filter(Boolean)
    .slice(0, RESULT_LIMIT);

  if (!items.length && rawList.length) {
    console.warn(`  ⚠️ ${supermarket} returned items but none could be normalized.`);
  }

  return items;
}

async function fetchColes(keyword, listItem = null) {
  const { items } = await fetchStoreProducts('Coles', keyword, listItem);
  return items;
}

async function fetchWoolworths(keyword, listItem = null) {
  const { items } = await fetchStoreProducts('Woolworths', keyword, listItem);
  return items;
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
      const result = await fetchStoreProducts('Coles', keyword);
      return { items: result.items, error: null, usedFallback: result.usedFallback };
    } catch (error) {
      const message = formatStoreError('Coles', error);
      console.error('  ❌ Coles error:', message);
      return { items: [], error: message };
    }
  };

  const safeFetchWoolworths = async () => {
    try {
      const result = await fetchStoreProducts('Woolworths', keyword);
      return { items: result.items, error: null, usedFallback: result.usedFallback };
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
// 7a. QUÉT BARCODE: GET /api/compare/barcode?barcode=...
// ============================================================
/**
 * Tìm sản phẩm theo mã vạch (không theo tên):
 * - Gọi search API với chuỗi barcode (WW/Coles hỗ trợ tìm theo barcode)
 * - Lọc kết quả có field barcode khớp chính xác
 */
app.get('/api/compare/barcode', async (req, res) => {
  const barcode = normalizeBarcode(req.query.barcode);

  if (!barcode || barcode.length < 8) {
    return res.status(400).json({
      error: 'Invalid barcode. Provide at least 8 digits.',
    });
  }

  console.log(`\n📷 Barcode lookup: ${barcode}`);

  const safeFetchRaw = async (supermarket) => {
    try {
      const rawList = await fetchStoreRawList(supermarket, barcode);
      const product = findProductByBarcodeInRawList(rawList, barcode, supermarket);
      return { product, error: null };
    } catch (error) {
      const message = formatStoreError(supermarket, error);
      console.error(`  ❌ ${supermarket} barcode error:`, message);
      return { product: null, error: message };
    }
  };

  const [colesSettled, woolSettled] = await Promise.allSettled([
    safeFetchRaw('Coles'),
    safeFetchRaw('Woolworths'),
  ]);

  const colesResult =
    colesSettled.status === 'fulfilled'
      ? colesSettled.value
      : { product: null, error: formatStoreError('Coles', colesSettled.reason) };
  const woolResult =
    woolSettled.status === 'fulfilled'
      ? woolSettled.value
      : { product: null, error: formatStoreError('Woolworths', woolSettled.reason) };

  const colesItem = colesResult.product;
  const woolItem = woolResult.product;

  if (!colesItem && !woolItem) {
    return res.status(404).json({
      error: 'No product found with this barcode at Coles or Woolworths.',
      scannedBarcode: barcode,
      storeErrors: {
        coles: colesResult.error,
        woolworths: woolResult.error,
      },
    });
  }

  const colesItems = colesItem ? [colesItem] : [];
  const woolworthsItems = woolItem ? [woolItem] : [];
  const combined = [...colesItems, ...woolworthsItems];

  const directPair = buildDirectComparePair(woolItem, colesItem);
  const similarPairs = directPair
    ? [directPair]
    : buildSimilarPairs(woolworthsItems, colesItems);

  console.log(
    `  ✅ Barcode hit | Coles: ${colesItem ? 'yes' : 'no'} | WW: ${woolItem ? 'yes' : 'no'}\n`
  );

  res.json({
    items: combined,
    similarPairs,
    scannedBarcode: barcode,
    searchMode: 'barcode',
    storeErrors: {
      coles: colesResult.error,
      woolworths: woolResult.error,
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

// ============================================================
// 7c. WATCHLIST: POST /api/watchlist/refresh
// ============================================================

/** Tìm đúng sản phẩm trong kết quả search theo tên / URL đã lưu */
function findWatchlistProduct(products, watchEntry) {
  if (!products?.length) return null;

  const targetNorm = normalizeNameForMatch(watchEntry.name);
  const savedUrl = String(watchEntry.url || '').trim();

  if (savedUrl) {
    const byUrl = products.find((p) => p.url === savedUrl);
    if (byUrl) return byUrl;
  }

  const exact = products.find(
    (p) => normalizeNameForMatch(p.name) === targetNorm
  );
  if (exact) return exact;

  const keyword = watchEntry.searchKeyword || deriveSearchKeyword(watchEntry.name);
  const { product } = pickBestProductMatch(products, keyword);
  return product;
}

/** Làm mới giá cho 1 mục watchlist */
async function refreshSingleWatchItem(entry) {
  const supermarket = entry.supermarket;
  const keyword = String(entry.searchKeyword || deriveSearchKeyword(entry.name)).trim();

  try {
    const products =
      supermarket === 'Coles'
        ? await fetchColes(keyword)
        : await fetchWoolworths(keyword);

    const matched = findWatchlistProduct(products, entry);

    if (!matched) {
      return {
        id: entry.id,
        found: false,
        error: 'Product not found in latest search results.',
      };
    }

    const watchedPrice = Number(entry.watchedAtPrice);
    const currentPrice = matched.price;
    const priceDrop =
      Number.isFinite(watchedPrice) && currentPrice < watchedPrice
        ? Number((watchedPrice - currentPrice).toFixed(2))
        : 0;

    return {
      id: entry.id,
      found: true,
      currentPrice,
      watchedAtPrice: watchedPrice,
      priceDrop,
      isPriceDown: priceDrop > 0,
      product: matched,
    };
  } catch (error) {
    return {
      id: entry.id,
      found: false,
      error: formatStoreError(supermarket, error),
    };
  }
}

/**
 * Nhận danh sách sản phẩm đang theo dõi → gọi API song song → trả giá mới.
 * Body: { items: [{ id, name, supermarket, watchedAtPrice, url?, searchKeyword? }] }
 */
app.post('/api/watchlist/refresh', async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];

  if (!items.length) {
    return res.status(400).json({ error: 'Missing items array.' });
  }

  if (items.length > 30) {
    return res.status(400).json({ error: 'Maximum 30 watchlist items per request.' });
  }

  console.log(`\n🔔 Refresh watchlist: ${items.length} items`);

  const results = await Promise.all(
    items.map((entry) =>
      refreshSingleWatchItem({
        id: entry.id,
        name: entry.name,
        supermarket: entry.supermarket,
        watchedAtPrice: entry.watchedAtPrice,
        url: entry.url,
        searchKeyword: entry.searchKeyword,
      })
    )
  );

  console.log(`  ✅ Refreshed ${results.filter((r) => r.found).length}/${items.length}\n`);

  res.json({ results });
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
module.exports = app;
