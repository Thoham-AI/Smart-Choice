/**
 * ShoppingSmart – Biểu đồ watchlist, xuất PDF, bộ đếm pageviews.
 * Nút Feedback: href cố định trong HTML (api/index.js).
 */

(function initShoppingSmartApp() {
  /** Active Chart.js instances keyed by chart id (destroy before redraw). */
  const priceChartRegistry = new Map();

  /** Open accordion chart id (only one chart open at a time on small screens). */
  let openPriceChartId = null;

  function escapeChartIdForSelector(chartId) {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
      return CSS.escape(String(chartId));
    }
    return String(chartId).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  // --- Chart theme (light / dark) ---

  function isDarkTheme() {
    return document.documentElement.getAttribute('data-theme') === 'dark';
  }

  function getChartTheme() {
    const dark = isDarkTheme();
    return {
      text: dark ? '#94a3b8' : '#6b7280',
      grid: dark ? 'rgba(148, 163, 184, 0.15)' : 'rgba(107, 114, 128, 0.2)',
      coles: dark ? '#f87171' : '#e01a22',
      woolworths: dark ? '#4ade80' : '#008a00',
      tooltipBg: dark ? '#1e2736' : '#ffffff',
      tooltipBorder: dark ? '#3d4f6a' : '#e5e7eb',
    };
  }

  // --- Price history API ---

  /**
   * Fetch stored price history for a product (watchlist id, productId, or barcode).
   * @param {{ watchId?: string, productId?: string, barcode?: string }} lookup
   */
  async function fetchPriceHistory(lookup = {}) {
    const params = new URLSearchParams();
    if (lookup.watchId) params.set('id', lookup.watchId);
    if (lookup.productId) params.set('productId', lookup.productId);
    if (lookup.barcode) params.set('barcode', lookup.barcode);

    const query = params.toString();
    const path = `/api/price-history?${query}`;
    const url =
      typeof buildApiUrl === 'function' ? buildApiUrl(path) : `${API_BASE}${path}`;

    const response = await apiFetch(url);
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Could not load price history.');
    }
    return data;
  }

  /**
   * Build a watchlist-like entry from a search/browse product for chart fallbacks.
   * @param {object} item - product from search results
   * @param {object[]} [peerProducts] - matched Coles/Woolworths row peers
   */
  function buildProductChartFallbackEntry(item, peerProducts = []) {
    const peers = Array.isArray(peerProducts) ? peerProducts.filter(Boolean) : [];
    const colesProduct =
      item.supermarket === 'Coles'
        ? item
        : peers.find((p) => p.supermarket === 'Coles') || null;
    const woolProduct =
      item.supermarket === 'Woolworths'
        ? item
        : peers.find((p) => p.supermarket === 'Woolworths') || null;

    return {
      id:
        typeof getWatchlistProductId === 'function'
          ? getWatchlistProductId(item)
          : item.productId || item.name,
      productId: item.productId || null,
      barcode: item.barcode || null,
      name: item.name,
      supermarket: item.supermarket,
      watchedAtPrice: item.price,
      watchedAt: new Date().toISOString(),
      lastColesPrice: colesProduct?.price ?? null,
      lastWoolworthsPrice: woolProduct?.price ?? null,
    };
  }

  /**
   * Build minimal chart data when MongoDB has no points yet (e.g. first day watching).
   */
  function buildFallbackPriceSeries(entry) {
    const series = [];
    const watchedDate = entry.watchedAt
      ? String(entry.watchedAt).slice(0, 10)
      : new Date().toISOString().slice(0, 10);
    const watchedPrice = Number(entry.watchedAtPrice);

    if (Number.isFinite(watchedPrice) && watchedPrice > 0) {
      const store = entry.supermarket || 'Coles';
      series.push({
        supermarket: store,
        points: [{ date: watchedDate, price: watchedPrice }],
      });
    }

    const today = new Date().toISOString().slice(0, 10);
    const coles = Number(entry.lastColesPrice);
    const wool = Number(entry.lastWoolworthsPrice);

    if (Number.isFinite(coles) && coles > 0) {
      let colesSeries = series.find((s) => s.supermarket === 'Coles');
      if (!colesSeries) {
        colesSeries = { supermarket: 'Coles', points: [] };
        series.push(colesSeries);
      }
      const hasToday = colesSeries.points.some((p) => p.date === today);
      if (!hasToday) colesSeries.points.push({ date: today, price: coles });
    }

    if (Number.isFinite(wool) && wool > 0) {
      let woolSeries = series.find((s) => s.supermarket === 'Woolworths');
      if (!woolSeries) {
        woolSeries = { supermarket: 'Woolworths', points: [] };
        series.push(woolSeries);
      }
      const hasToday = woolSeries.points.some((p) => p.date === today);
      if (!hasToday) woolSeries.points.push({ date: today, price: wool });
    }

    return series;
  }

  function mergeHistoryWithFallback(apiSeries, entry) {
    const merged = Array.isArray(apiSeries) && apiSeries.length ? [...apiSeries] : [];
    if (merged.length) return merged;
    return buildFallbackPriceSeries(entry);
  }

  function formatPriceLabel(value) {
    return `$${Number(value).toFixed(2)}`;
  }

  function sortPoints(points) {
    return [...points].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  }

  // --- Chart.js lifecycle ---

  /**
   * Destroy a chart instance and release the canvas (prevents mobile memory leaks).
   * @param {string} chartId
   */
  function destroyPriceChart(chartId) {
    const existing = priceChartRegistry.get(chartId);
    if (existing) {
      existing.destroy();
      priceChartRegistry.delete(chartId);
    }
  }

  /** @deprecated alias */
  function destroyWatchlistChart(chartId) {
    destroyPriceChart(chartId);
  }

  /** Tear down every chart instance (e.g. before re-rendering a grid). */
  function destroyAllPriceCharts() {
    priceChartRegistry.forEach((chart) => chart.destroy());
    priceChartRegistry.clear();
    openPriceChartId = null;
  }

  /** @deprecated alias */
  function destroyAllWatchlistCharts() {
    destroyAllPriceCharts();
  }

  /**
   * Draw dual-line chart from unified chartData [{ date, colesPrice, wooliesPrice }].
   */
  function renderPriceChartFromChartData(canvas, chartData, chartId) {
    if (typeof Chart === 'undefined') {
      throw new Error('Chart.js is not loaded.');
    }

    destroyPriceChart(chartId);

    const theme = getChartTheme();
    const labels = chartData.map((row) => row.date);
    const colesData = chartData.map((row) => row.colesPrice ?? null);
    const woolData = chartData.map((row) => row.wooliesPrice ?? null);

    const chart = new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Coles',
            data: colesData,
            borderColor: theme.coles,
            backgroundColor: theme.coles + '33',
            tension: 0.35,
            fill: false,
            spanGaps: true,
            pointRadius: 3,
            pointHoverRadius: 5,
          },
          {
            label: 'Woolworths',
            data: woolData,
            borderColor: theme.woolworths,
            backgroundColor: theme.woolworths + '33',
            tension: 0.35,
            fill: false,
            spanGaps: true,
            pointRadius: 3,
            pointHoverRadius: 5,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 420 },
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            labels: { color: theme.text, boxWidth: 12 },
          },
          tooltip: {
            backgroundColor: theme.tooltipBg,
            borderColor: theme.tooltipBorder,
            borderWidth: 1,
            titleColor: theme.text,
            bodyColor: theme.text,
            callbacks: {
              label(ctx) {
                const v = ctx.parsed.y;
                if (v == null) return `${ctx.dataset.label}: —`;
                return `${ctx.dataset.label}: ${formatPriceLabel(v)}`;
              },
            },
          },
        },
        scales: {
          x: {
            ticks: { color: theme.text, maxRotation: 45, minRotation: 0 },
            grid: { color: theme.grid },
          },
          y: {
            ticks: {
              color: theme.text,
              callback: (value) => formatPriceLabel(value),
            },
            grid: { color: theme.grid },
          },
        },
      },
    });

    priceChartRegistry.set(chartId, chart);
    return chart;
  }

  /**
   * Draw or redraw the price history line chart on a card canvas.
   * @param {HTMLCanvasElement} canvas
   * @param {Array<{ supermarket: string, points: Array<{ date: string, price: number }> }>} series
   * @param {string} chartId
   * @param {{ chartData?: Array<{ date: string, dateIso: string, colesPrice: number|null, wooliesPrice: number|null }> }} [options]
   */
  function renderPriceChart(canvas, series, chartId, options = {}) {
    if (Array.isArray(options.chartData) && options.chartData.length) {
      return renderPriceChartFromChartData(canvas, options.chartData, chartId);
    }

    if (typeof Chart === 'undefined') {
      throw new Error('Chart.js is not loaded.');
    }

    destroyPriceChart(chartId);

    const theme = getChartTheme();
    const labelsSet = new Set();
    series.forEach((s) => {
      sortPoints(s.points || []).forEach((p) => labelsSet.add(p.date));
    });
    const labels = [...labelsSet].sort();

    const datasets = [];
    for (const row of series) {
      const store = row.supermarket;
      const sorted = sortPoints(row.points || []);
      const priceByDate = new Map(sorted.map((p) => [p.date, p.price]));
      const data = labels.map((d) => priceByDate.get(d) ?? null);
      const color = store === 'Coles' ? theme.coles : theme.woolworths;

      datasets.push({
        label: store,
        data,
        borderColor: color,
        backgroundColor: color + '33',
        tension: 0.35,
        fill: false,
        spanGaps: true,
        pointRadius: 3,
        pointHoverRadius: 5,
      });
    }

    const chart = new Chart(canvas, {
      type: 'line',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 420 },
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            labels: { color: theme.text, boxWidth: 12 },
          },
          tooltip: {
            backgroundColor: theme.tooltipBg,
            borderColor: theme.tooltipBorder,
            borderWidth: 1,
            titleColor: theme.text,
            bodyColor: theme.text,
            callbacks: {
              label(ctx) {
                const v = ctx.parsed.y;
                return v == null ? `${ctx.dataset.label}: —` : `${ctx.dataset.label}: ${formatPriceLabel(v)}`;
              },
            },
          },
        },
        scales: {
          x: {
            ticks: { color: theme.text, maxRotation: 45, minRotation: 0 },
            grid: { color: theme.grid },
          },
          y: {
            ticks: {
              color: theme.text,
              callback: (v) => formatPriceLabel(v),
            },
            grid: { color: theme.grid },
          },
        },
      },
    });

    priceChartRegistry.set(chartId, chart);
  }

  // --- Accordion toggle (shared by watchlist + product cards) ---

  function getChartHostSelector(chartId) {
    return `[data-chart-id="${escapeChartIdForSelector(chartId)}"]`;
  }

  function findChartHost(chartId) {
    return document.querySelector(getChartHostSelector(chartId));
  }

  function getChartCanvas(card) {
    return (
      card.querySelector('.price-history-canvas') ||
      card.querySelector('.watchlist-canvas')
    );
  }

  function setChartStatus(card, message, isError = false) {
    const status = card.querySelector('.price-chart-status');
    if (!status) return;
    status.textContent = message || '';
    status.classList.toggle('is-error', Boolean(isError));
    status.hidden = !message;
  }

  function slideCloseChart(card, chartId) {
    card.classList.remove('is-chart-open');
    card.querySelector('.watchlist-card-summary')?.setAttribute('aria-expanded', 'false');
    card.querySelector('.price-history-toggle')?.setAttribute('aria-expanded', 'false');
    const container = card.querySelector('.price-chart-container');
    if (container) container.hidden = true;
    destroyPriceChart(chartId);
    if (openPriceChartId === chartId) openPriceChartId = null;
  }

  /**
   * Expand/collapse chart panel and lazy-load history when opening.
   * @param {HTMLElement} card
   * @param {object} entry - watchlist entry or buildProductChartFallbackEntry()
   */
  async function togglePriceChart(card, entry) {
    const chartId = entry.id;
    const container = card.querySelector('.price-chart-container');
    if (!container) return;

    const isOpen = card.classList.contains('is-chart-open');

    if (isOpen) {
      slideCloseChart(card, chartId);
      return;
    }

    if (openPriceChartId && openPriceChartId !== chartId) {
      const other = findChartHost(openPriceChartId);
      if (other) slideCloseChart(other, openPriceChartId);
    }

    card.classList.add('is-chart-open');
    card.querySelector('.watchlist-card-summary')?.setAttribute('aria-expanded', 'true');
    card.querySelector('.price-history-toggle')?.setAttribute('aria-expanded', 'true');
    container.hidden = false;
    openPriceChartId = chartId;

    const canvas = getChartCanvas(card);
    if (!canvas) return;

    setChartStatus(card, 'Loading price history…');

    try {
      const data = await fetchPriceHistory({
        watchId: chartId,
        productId: entry.productId || null,
        barcode: entry.barcode || null,
      });

      if (Array.isArray(data.chartData) && data.chartData.length) {
        setChartStatus(
          card,
          data.days
            ? `${data.days} day${data.days === 1 ? '' : 's'} tracked (up to ${data.maxDays || 100})`
            : ''
        );
        renderPriceChart(canvas, data.series || [], chartId, { chartData: data.chartData });
        return;
      }

      const series = mergeHistoryWithFallback(data.series, entry);

      if (!series.length || !series.some((s) => s.points?.length)) {
        setChartStatus(
          card,
          'No price history yet. Watch this product or refresh your watchlist to build a chart.'
        );
        destroyPriceChart(chartId);
        return;
      }

      setChartStatus(card, '');
      renderPriceChart(canvas, series, chartId);
    } catch (err) {
      const fallback = buildFallbackPriceSeries(entry);
      if (fallback.some((s) => s.points?.length)) {
        setChartStatus(card, 'Showing today\'s price — history builds over time.');
        renderPriceChart(canvas, fallback, chartId);
      } else {
        setChartStatus(card, err.message || 'Could not load chart.', true);
        destroyPriceChart(chartId);
      }
    }
  }

  /** @deprecated alias */
  async function toggleWatchlistChart(card, entry) {
    return togglePriceChart(card, entry);
  }

  /**
   * Bind accordion + remove button on a watchlist card (called from script.js after render).
   */
  function attachWatchlistCard(card, entry) {
    card.dataset.chartId = entry.id;

    const summary = card.querySelector('.watchlist-card-summary');
    const removeBtn = card.querySelector('.watchlist-remove');

    if (summary) {
      summary.addEventListener('click', () => {
        togglePriceChart(card, entry);
      });
      summary.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          togglePriceChart(card, entry);
        }
      });
    }

    if (removeBtn) {
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        destroyPriceChart(entry.id);
        if (openPriceChartId === entry.id) openPriceChartId = null;
      });
    }

    card.querySelectorAll('a.product-link').forEach((link) => {
      link.addEventListener('click', (e) => e.stopPropagation());
    });
  }

  /**
   * Bind price-history toggle on a global product card (search / browse / aligned matrix).
   * @param {HTMLElement} card
   * @param {object} item - product object from API
   * @param {object[]} [peerProducts] - matched row peers for dual-store fallback
   */
  function attachProductCardChart(card, item, peerProducts = []) {
    if (!card || !item) return;

    const entry = buildProductChartFallbackEntry(item, peerProducts);
    card.dataset.chartId = entry.id;

    const toggle = card.querySelector('.price-history-toggle');
    if (!toggle || toggle.dataset.chartBound === 'true') return;
    toggle.dataset.chartBound = 'true';

    toggle.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      togglePriceChart(card, entry);
    });

    card.querySelectorAll('a.product-link').forEach((link) => {
      link.addEventListener('click', (e) => e.stopPropagation());
    });
  }

  /** Re-theme open charts after dark mode toggle. */
  function refreshOpenPriceCharts() {
    priceChartRegistry.forEach((chart, chartId) => {
      const card = findChartHost(chartId);
      if (!card || !card.classList.contains('is-chart-open')) {
        destroyPriceChart(chartId);
        return;
      }
      const canvas = getChartCanvas(card);
      const watchEntry =
        typeof loadWatchlist === 'function'
          ? loadWatchlist().find((w) => w.id === chartId)
          : null;
      const entry = watchEntry || { id: chartId };
      if (canvas && entry) {
        fetchPriceHistory({
          watchId: chartId,
          productId: entry.productId || null,
          barcode: entry.barcode || null,
        })
          .then((data) => {
            if (Array.isArray(data.chartData) && data.chartData.length) {
              renderPriceChart(canvas, data.series || [], chartId, { chartData: data.chartData });
              return;
            }
            const series = mergeHistoryWithFallback(data.series, entry);
            renderPriceChart(canvas, series, chartId);
          })
          .catch(() => {});
      }
    });
  }

  /** @deprecated alias */
  function refreshOpenWatchlistCharts() {
    refreshOpenPriceCharts();
  }

  document.getElementById('theme-toggle')?.addEventListener('click', () => {
    window.setTimeout(refreshOpenPriceCharts, 80);
  });

  // --- PDF export (free Beta — client-side jsPDF) ---

  function getJsPdfConstructor() {
    if (window.jspdf?.jsPDF) return window.jspdf.jsPDF;
    if (typeof window.jsPDF !== 'undefined') return window.jsPDF;
    return null;
  }

  /**
   * Footer on every PDF page: "Powered by **ShoppingSmart** - AI Grocery Analytic"
   */
  function addPdfPoweredByFooter(doc) {
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const y = pageHeight - 10;
    const prefix = 'Powered by ';
    const brand = 'ShoppingSmart';
    const suffix = ' - AI Grocery Analytic';

    doc.setFontSize(9);
    doc.setTextColor(100);

    const xStart = pageWidth / 2;
    const full = prefix + brand + suffix;
    const fullWidth = doc.getTextWidth(full);
    let x = xStart - fullWidth / 2;

    doc.setFont(undefined, 'normal');
    doc.text(prefix, x, y);
    x += doc.getTextWidth(prefix);

    doc.setFont(undefined, 'bold');
    doc.text(brand, x, y);
    x += doc.getTextWidth(brand);

    doc.setFont(undefined, 'normal');
    doc.text(suffix, x, y);
  }

  function ensurePdfPageSpace(doc, y, needed = 20) {
    const pageHeight = doc.internal.pageSize.getHeight();
    if (y + needed > pageHeight - 18) {
      addPdfPoweredByFooter(doc);
      doc.addPage();
      return 16;
    }
    return y;
  }

  /**
   * Export a tabular shopping list (cart or AI analysis) to PDF.
   */
  function exportShoppingListToPdf({ title, subtitle, rows, totals = [] }) {
    const JsPDF = getJsPdfConstructor();
    if (!JsPDF) {
      alert('PDF library did not load. Please refresh the page and try again.');
      return;
    }

    if (!rows?.length) {
      alert('Nothing to export — add items to your cart or run an AI list analysis first.');
      return;
    }

    const doc = new JsPDF({ unit: 'mm', format: 'a4' });
    const margin = 14;
    let y = 18;

    doc.setFontSize(16);
    doc.setFont(undefined, 'bold');
    doc.text(title || 'Shopping List', margin, y);
    y += 8;

    doc.setFontSize(10);
    doc.setFont(undefined, 'normal');
    doc.setTextColor(80);
    if (subtitle) {
      doc.text(subtitle, margin, y);
      y += 6;
    }
    doc.text(`Generated: ${new Date().toLocaleString('en-AU')}`, margin, y);
    y += 10;
    doc.setTextColor(0);

    const colX = [margin, margin + 78, margin + 118, margin + 158];
    doc.setFontSize(10);
    doc.setFont(undefined, 'bold');
    doc.text('Item', colX[0], y);
    doc.text('Woolworths', colX[1], y);
    doc.text('Coles', colX[2], y);
    doc.text('Note', colX[3], y);
    y += 6;
    doc.setFont(undefined, 'normal');

    for (const row of rows) {
      y = ensurePdfPageSpace(doc, y, 12);
      const nameLines = doc.splitTextToSize(String(row.name || '—'), 72);
      doc.text(nameLines, colX[0], y);
      doc.text(row.woolworths != null ? `$${Number(row.woolworths).toFixed(2)}` : '—', colX[1], y);
      doc.text(row.coles != null ? `$${Number(row.coles).toFixed(2)}` : '—', colX[2], y);
      const noteLines = doc.splitTextToSize(String(row.note || ''), 38);
      doc.text(noteLines, colX[3], y);
      y += Math.max(nameLines.length, noteLines.length, 1) * 5 + 2;
    }

    if (totals.length) {
      y = ensurePdfPageSpace(doc, y, 8 + totals.length * 6);
      doc.setFont(undefined, 'bold');
      doc.text('Totals', margin, y);
      y += 6;
      doc.setFont(undefined, 'normal');
      for (const line of totals) {
        doc.text(line, margin, y);
        y += 6;
      }
    }

    addPdfPoweredByFooter(doc);

    const safeName = (title || 'shopping-list')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .toLowerCase();
    doc.save(`${safeName || 'shopping-list'}.pdf`);
  }

  function exportCartToPdf() {
    const cart = typeof loadCart === 'function' ? loadCart() : [];
    const rows = cart.map((entry) => ({
      name: entry.name,
      woolworths: entry.woolworthsPrice,
      coles: entry.colesPrice,
      note: '',
    }));

    let colesTotal = 0;
    let woolTotal = 0;
    cart.forEach((e) => {
      if (e.colesPrice != null) colesTotal += e.colesPrice;
      if (e.woolworthsPrice != null) woolTotal += e.woolworthsPrice;
    });

    exportShoppingListToPdf({
      title: 'ShoppingSmart Shopping List',
      subtitle: 'Your cart — compare store totals before you shop',
      rows,
      totals: [
        `Woolworths subtotal: $${woolTotal.toFixed(2)}`,
        `Coles subtotal: $${colesTotal.toFixed(2)}`,
      ],
    });
  }

  function exportAiListToPdf() {
    const data = window.lastAiShoppingExportData;
    if (!data?.lineItems?.length) {
      alert('Run "Analyze List by AI" first, then export the breakdown.');
      return;
    }

    const opt = data.optimization || {};
    const rows = data.lineItems.map((line) => {
      const label = typeof formatRequestLabel === 'function'
        ? formatRequestLabel(line.request)
        : line.request?.keyword || 'Item';
      const wool = line.woolworthsLinePrice ?? line.woolworthsSingleStorePrice;
      const coles = line.colesLinePrice ?? line.colesSingleStorePrice;
      let note = '';
      if (line.chosenStore) note = `Buy at ${line.chosenStore}`;
      if (line.colesIncomplete || line.woolIncomplete) note += ' (est.)';
      return {
        name: label,
        woolworths: wool,
        coles: coles,
        note: note.trim(),
      };
    });

    exportShoppingListToPdf({
      title: 'ShoppingSmart AI Shopping List',
      subtitle: 'Optimized split between Coles and Woolworths (Beta)',
      rows,
      totals: [
        `Split cart total: $${(opt.splitTotal || 0).toFixed(2)}`,
        `All Woolworths: $${(opt.woolworthsOnlyTotal || 0).toFixed(2)}`,
        `All Coles: $${(opt.colesOnlyTotal || 0).toFixed(2)}`,
      ],
    });
  }

  document.getElementById('export-cart-pdf-btn')?.addEventListener('click', exportCartToPdf);
  document.getElementById('export-ai-pdf-btn')?.addEventListener('click', exportAiListToPdf);

  window.ShoppingSmartApp = {
    attachWatchlistCard,
    attachProductCardChart,
    buildProductChartFallbackEntry,
    destroyPriceChart,
    destroyWatchlistChart,
    destroyAllPriceCharts,
    destroyAllWatchlistCharts,
    renderPriceChart,
    togglePriceChart,
    toggleWatchlistChart,
    exportShoppingListToPdf,
    exportCartToPdf,
    exportAiListToPdf,
  };

  // ============================================================
  // Pageviews — UX: đã ẩn khỏi giao diện; giữ logic để bật lại sau nếu cần
  // ============================================================

  function formatPageViewCount(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return '—';
    return n.toLocaleString('en-AU');
  }

  function showPageViewsFooter(totalViews) {
    const display = document.getElementById('pageviews-display');
    const countEl = document.getElementById('pageviews-count');
    if (!display || !countEl) return;

    countEl.textContent = formatPageViewCount(totalViews);
    display.removeAttribute('hidden');
    display.classList.add('is-visible');
    display.style.display = 'block';
  }

  async function fetchAndShowPageViews() {
    const apiRoot =
      typeof API_BASE !== 'undefined' && API_BASE
        ? API_BASE
        : window.location?.origin || '';

    if (!apiRoot) return;

    try {
      const response = await fetch(`${apiRoot}/api/pageviews`, {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
      });

      let data = {};
      try {
        data = await response.json();
      } catch {
        data = {};
      }

      if (response.ok && data.total_views != null) {
        showPageViewsFooter(data.total_views);
      }
    } catch (err) {
      console.warn('[ShoppingSmart] Pageviews:', err.message || err);
    }
  }

  function schedulePageViewCounter() {
    const run = () => fetchAndShowPageViews();
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(run, { timeout: 4000 });
    } else {
      window.setTimeout(run, 300);
    }
  }

  function bootPageViewCounter() {
    const startPageViews = () => {
      if (window.__shoppingsmartPageViewsScheduled) return;
      window.__shoppingsmartPageViewsScheduled = true;
      schedulePageViewCounter();
    };

    if (document.readyState === 'complete') {
      startPageViews();
    } else {
      window.addEventListener('load', startPageViews, { once: true });
    }
  }

  // UX: không boot bộ đếm — người dùng không thấy "Pageviews: …"
  // bootPageViewCounter();
})();
