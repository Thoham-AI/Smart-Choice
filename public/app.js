/**
 * SmartChoice – Watchlist charts, PDF export, pageview counter, shared UI helpers.
 * Loaded before script.js on the home page; terms page loads this with defer for pageviews only.
 */

(function initSmartChoiceApp() {
  /** Replace with your live Tally (or other) feedback form URL. */
  const FEEDBACK_FORM_URL = 'https://tally.so/r/your-form-id';

  // --- Public page view counter (non-blocking, does not affect AI progress UI) ---

  function formatPageViewCount(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return '—';
    return n.toLocaleString('en-AU');
  }

  /**
   * Fetch /api/pageviews after load using idle time so first paint stays fast.
   */
  function initPageViewCounter() {
    const display = document.getElementById('pageviews-display');
    const countEl = document.getElementById('pageviews-count');
    if (!display || !countEl) return;

    const run = () => {
      const base =
        typeof API_BASE !== 'undefined' && API_BASE
          ? API_BASE
          : window.location?.origin || '';

      fetch(`${base}/api/pageviews`, { method: 'GET', credentials: 'same-origin' })
        .then((response) => response.json().then((data) => ({ ok: response.ok, data })))
        .then(({ ok, data }) => {
          if (!ok || data.total_views == null) return;
          countEl.textContent = formatPageViewCount(data.total_views);
          display.hidden = false;
        })
        .catch(() => {
          /* Silent fail — footer counter is optional polish */
        });
    };

    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(run, { timeout: 4000 });
    } else {
      window.setTimeout(run, 250);
    }
  }

  function applyFeedbackFormUrl() {
    document.querySelectorAll('#feedback-fab, [data-feedback-link]').forEach((el) => {
      if (el instanceof HTMLAnchorElement) {
        el.href = FEEDBACK_FORM_URL;
      }
    });
  }

  if (document.readyState === 'complete') {
    applyFeedbackFormUrl();
    initPageViewCounter();
  } else {
    window.addEventListener('load', () => {
      applyFeedbackFormUrl();
      initPageViewCounter();
    });
  }

  /** Active Chart.js instances keyed by watchlist entry id (destroy before redraw). */
  const watchlistChartRegistry = new Map();

  /** Open accordion card id (only one chart open at a time on small screens). */
  let openWatchlistChartId = null;

  function escapeWatchIdForSelector(watchId) {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
      return CSS.escape(String(watchId));
    }
    return String(watchId).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
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
   * Fetch stored price history for a watchlist product.
   * @param {string} watchId
   * @returns {Promise<{ series: Array<{ supermarket: string, points: Array<{ date: string, price: number }> }> }>}
   */
  async function fetchPriceHistory(watchId) {
    const url =
      typeof buildApiUrl === 'function'
        ? buildApiUrl(`/api/watchlist/price-history?watchId=${encodeURIComponent(watchId)}`)
        : `${API_BASE}/api/watchlist/price-history?watchId=${encodeURIComponent(watchId)}`;

    const response = await apiFetch(url);
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Could not load price history.');
    }
    return data;
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
   * @param {string} watchId
   */
  function destroyWatchlistChart(watchId) {
    const existing = watchlistChartRegistry.get(watchId);
    if (existing) {
      existing.destroy();
      watchlistChartRegistry.delete(watchId);
    }
  }

  /** Tear down every chart instance (e.g. before re-rendering the watchlist grid). */
  function destroyAllWatchlistCharts() {
    watchlistChartRegistry.forEach((chart) => chart.destroy());
    watchlistChartRegistry.clear();
    openWatchlistChartId = null;
  }

  /**
   * Draw or redraw the price history line chart on a watchlist card canvas.
   * @param {HTMLCanvasElement} canvas
   * @param {Array<{ supermarket: string, points: Array<{ date: string, price: number }> }>} series
   * @param {string} watchId
   */
  function renderPriceChart(canvas, series, watchId) {
    if (typeof Chart === 'undefined') {
      throw new Error('Chart.js is not loaded.');
    }

    destroyWatchlistChart(watchId);

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

    watchlistChartRegistry.set(watchId, chart);
  }

  // --- Accordion toggle ---

  function setChartStatus(card, message, isError = false) {
    const status = card.querySelector('.price-chart-status');
    if (!status) return;
    status.textContent = message || '';
    status.classList.toggle('is-error', Boolean(isError));
    status.hidden = !message;
  }

  function slideCloseChart(card, watchId) {
    card.classList.remove('is-chart-open');
    card.querySelector('.watchlist-card-summary')?.setAttribute('aria-expanded', 'false');
    const container = card.querySelector('.price-chart-container');
    if (container) container.hidden = true;
    destroyWatchlistChart(watchId);
    if (openWatchlistChartId === watchId) openWatchlistChartId = null;
  }

  /**
   * Expand/collapse chart panel and load history when opening.
   * @param {HTMLElement} card
   * @param {object} entry - watchlist localStorage entry
   */
  async function toggleWatchlistChart(card, entry) {
    const watchId = entry.id;
    const container = card.querySelector('.price-chart-container');
    const summary = card.querySelector('.watchlist-card-summary');
    if (!container) return;

    const isOpen = card.classList.contains('is-chart-open');

    if (isOpen) {
      slideCloseChart(card, watchId);
      return;
    }

    // Close any other open chart first (keeps mobile layout tidy).
    if (openWatchlistChartId && openWatchlistChartId !== watchId) {
      const other = document.querySelector(
        `.watchlist-card[data-watch-id="${escapeWatchIdForSelector(openWatchlistChartId)}"]`
      );
      if (other) slideCloseChart(other, openWatchlistChartId);
    }

    card.classList.add('is-chart-open');
    summary?.setAttribute('aria-expanded', 'true');
    container.hidden = false;
    openWatchlistChartId = watchId;

    const canvas = card.querySelector('.watchlist-canvas');
    if (!canvas) return;

    setChartStatus(card, 'Loading price history…');

    try {
      const data = await fetchPriceHistory(watchId);
      const series = mergeHistoryWithFallback(data.series, entry);

      if (!series.length || !series.some((s) => s.points?.length)) {
        setChartStatus(card, 'No price history yet. Refresh prices a few times to build a chart.');
        destroyWatchlistChart(watchId);
        return;
      }

      setChartStatus(card, '');
      renderPriceChart(canvas, series, watchId);
    } catch (err) {
      const fallback = buildFallbackPriceSeries(entry);
      if (fallback.some((s) => s.points?.length)) {
        setChartStatus(card, '');
        renderPriceChart(canvas, fallback, watchId);
      } else {
        setChartStatus(card, err.message || 'Could not load chart.', true);
        destroyWatchlistChart(watchId);
      }
    }
  }

  /**
   * Bind accordion + remove button on a watchlist card (called from script.js after render).
   */
  function attachWatchlistCard(card, entry) {
    const summary = card.querySelector('.watchlist-card-summary');
    const removeBtn = card.querySelector('.watchlist-remove');

    if (summary) {
      summary.addEventListener('click', () => {
        toggleWatchlistChart(card, entry);
      });
      summary.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggleWatchlistChart(card, entry);
        }
      });
    }

    if (removeBtn) {
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        destroyWatchlistChart(entry.id);
        if (openWatchlistChartId === entry.id) openWatchlistChartId = null;
      });
    }

    card.querySelectorAll('a.product-link').forEach((link) => {
      link.addEventListener('click', (e) => e.stopPropagation());
    });
  }

  /** Re-theme open charts after dark mode toggle. */
  function refreshOpenWatchlistCharts() {
    watchlistChartRegistry.forEach((chart, watchId) => {
      const card = document.querySelector(
        `.watchlist-card[data-watch-id="${escapeWatchIdForSelector(watchId)}"]`
      );
      if (!card || !card.classList.contains('is-chart-open')) {
        destroyWatchlistChart(watchId);
        return;
      }
      const canvas = card.querySelector('.watchlist-canvas');
      const entry = typeof loadWatchlist === 'function'
        ? loadWatchlist().find((w) => w.id === watchId)
        : null;
      if (canvas && entry) {
        fetchPriceHistory(watchId)
          .then((data) => {
            const series = mergeHistoryWithFallback(data.series, entry);
            renderPriceChart(canvas, series, watchId);
          })
          .catch(() => {});
      }
    });
  }

  document.getElementById('theme-toggle')?.addEventListener('click', () => {
    window.setTimeout(refreshOpenWatchlistCharts, 80);
  });

  // --- PDF export (free Beta — client-side jsPDF) ---

  function getJsPdfConstructor() {
    if (window.jspdf?.jsPDF) return window.jspdf.jsPDF;
    if (typeof window.jsPDF !== 'undefined') return window.jsPDF;
    return null;
  }

  /**
   * Footer on every PDF page: "Powered by **SmartChoice** - AI Grocery Analytic"
   */
  function addPdfPoweredByFooter(doc) {
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const y = pageHeight - 10;
    const prefix = 'Powered by ';
    const brand = 'SmartChoice';
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
      title: 'SmartChoice Shopping List',
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
      title: 'SmartChoice AI Shopping List',
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

  window.SmartChoiceApp = {
    attachWatchlistCard,
    destroyWatchlistChart,
    destroyAllWatchlistCharts,
    renderPriceChart,
    toggleWatchlistChart,
    exportShoppingListToPdf,
    exportCartToPdf,
    exportAiListToPdf,
  };
})();
