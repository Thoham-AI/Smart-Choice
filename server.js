/**
 * SmartChoice – Backend trung gian RapidAPI
 * Chạy: node server.js  →  http://localhost:3000
 */

const express = require('express');
const axios   = require('axios');
const cors    = require('cors');

// ============================================================
// 1. CẤU HÌNH HẰNG SỐ
// ============================================================
const RAPIDAPI_KEY    = 'da720b7848msh99f571ba1848fcdp1388ddjsn3af3071dc5a4';
const COLES_HOST      = 'coles-australia-full-catalog-pricing-intelligence-api.p.rapidapi.com';
const WOOLWORTHS_HOST = 'woolworths-australia-product-category-api.p.rapidapi.com';

const PORT         = 3000;
const RESULT_LIMIT = 20;   // số sản phẩm tối đa mỗi siêu thị

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
function normalizeItem(raw, supermarket) {
  if (!raw || typeof raw !== 'object') return null;

  // Tên sản phẩm
  const name = raw.name || raw.productName || raw.title || null;

  // Giá: thử price trước, fallback sang discount_price
  const price = parsePrice(raw.price) ?? parsePrice(raw.discount_price);

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

// ============================================================
// 5. HÀM GỌI COLES RAPIDAPI
// ============================================================
async function fetchColes(keyword) {
  const url = `https://${COLES_HOST}/coles/search`;

  // Coles endpoint hiện tại dùng GET + query params
  const response = await axios.get(url, {
    params: {
      query: keyword,
      page: 1,
    },
    headers: {
      'x-rapidapi-key': RAPIDAPI_KEY,
      'x-rapidapi-host': COLES_HOST,
    },
    timeout: 25000,
  });

  // Kết quả Coles nằm trong mảng response.data.results
  const rawList = Array.isArray(response?.data?.results)
    ? response.data.results
    : [];

  return rawList
    .map((item) => normalizeItem(item, 'Coles'))
    .filter(Boolean)           // loại bỏ item null (thiếu tên / giá)
    .slice(0, RESULT_LIMIT);
}

// ============================================================
// 6. HÀM GỌI WOOLWORTHS RAPIDAPI
// ============================================================
async function fetchWoolworths(keyword) {
  const url = `https://${WOOLWORTHS_HOST}/woolworths/search`;

  const { data } = await axios.get(url, {
    params: {
      query: keyword,
      page:  1,
    },
    headers: {
      'x-rapidapi-key':  RAPIDAPI_KEY,
      'x-rapidapi-host': WOOLWORTHS_HOST,
    },
    timeout: 25000,
  });

  // Kết quả nằm trong mảng `results` theo tài liệu Dromb
  const rawList = Array.isArray(data?.results) ? data.results : [];

  return rawList
    .map((item) => normalizeItem(item, 'Woolworths'))
    .filter(Boolean)
    .slice(0, RESULT_LIMIT);
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

  // Bọc try/catch riêng cho Coles để nếu lỗi thì trả [] (không làm sập luồng chung)
  const safeFetchColes = async () => {
    try {
      return await fetchColes(keyword);
    } catch (error) {
      console.error(
        '  ❌ Coles error:',
        error?.response?.data || error?.message || error
      );
      return [];
    }
  };

  // Gọi song song – allSettled đảm bảo cả 2 đều được xử lý dù có lỗi
  const [colesSettled, woolSettled] = await Promise.allSettled([
    safeFetchColes(),
    fetchWoolworths(keyword),
  ]);

  let colesItems      = [];
  let woolworthsItems = [];

  // Lấy kết quả Coles (nếu thành công)
  if (colesSettled.status === 'fulfilled') {
    colesItems = colesSettled.value;
    console.log(`  Coles: ${colesItems.length} products`);
  } else {
    console.error(
      '  ❌ Coles promise error:',
      colesSettled.reason?.response?.data || colesSettled.reason?.message
    );
  }

  // Lấy kết quả Woolworths (nếu thành công)
  if (woolSettled.status === 'fulfilled') {
    woolworthsItems = woolSettled.value;
    console.log(`  Woolworths: ${woolworthsItems.length} products`);
  } else {
    console.error('  ❌ Woolworths error:', woolSettled.reason?.response?.data || woolSettled.reason?.message);
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

  console.log(`  ✅ Total returned: ${combined.length} products\n`);

  res.json(combined);
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
