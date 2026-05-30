/**
 * SmartChoice – Barcode scanner via camera (html5-qrcode CDN)
 * - 📷 opens modal, uses rear camera (environment) on mobile
 * - Reads EAN/UPC/CODE128 → calls searchByBarcode() → closes camera
 */

(function initBarcodeScanner() {
  const modal = document.getElementById('barcode-scanner-modal');
  const readerEl = document.getElementById('barcode-reader');
  const statusEl = document.getElementById('scanner-status');
  const openBtn = document.getElementById('scannerBtn');
  const closeBtn = document.getElementById('scanner-close-btn');
  const backdrop = document.getElementById('scanner-backdrop');

  if (!modal || !readerEl || typeof Html5Qrcode === 'undefined') {
    if (openBtn) {
      openBtn.addEventListener('click', () => {
        alert('Barcode scanner library failed to load. Check your internet connection.');
      });
    }
    return;
  }

  let html5QrCode = null;
  let isScanning = false;
  let scanLocked = false;

  /** Barcode formats common at Coles / Woolworths */
  const barcodeFormats = [
    Html5QrcodeSupportedFormats.EAN_13,
    Html5QrcodeSupportedFormats.EAN_8,
    Html5QrcodeSupportedFormats.UPC_A,
    Html5QrcodeSupportedFormats.UPC_E,
    Html5QrcodeSupportedFormats.CODE_128,
    Html5QrcodeSupportedFormats.CODE_39,
  ];

  function setStatus(message, isError = false) {
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.classList.toggle('error', isError);
  }

  function openModal() {
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    scanLocked = false;
    setStatus('Point your camera at the product barcode');
    startScanner();
  }

  function closeModal() {
    modal.classList.add('hidden');
    document.body.style.overflow = '';
    stopScanner();
  }

  /** Stop camera and release resources */
  async function stopScanner() {
    if (!html5QrCode || !isScanning) return;

    try {
      await html5QrCode.stop();
      await html5QrCode.clear();
    } catch {
      /* ignore – may already be stopped */
    }

    isScanning = false;
  }

  /** Start camera – prefer rear camera on phones */
  async function startScanner() {
    await stopScanner();
    readerEl.innerHTML = '';

    html5QrCode = new Html5Qrcode('barcode-reader', {
      formatsToSupport: barcodeFormats,
      verbose: false,
    });

    const config = {
      fps: 12,
      aspectRatio: 1.777778,
      disableFlip: false,
      experimentalFeatures: {
        useBarCodeDetectorIfSupported: true,
      },
      qrbox: (viewfinderWidth, viewfinderHeight) => {
        const width = Math.floor(Math.min(viewfinderWidth * 0.92, 320));
        const height = Math.floor(Math.min(viewfinderHeight * 0.38, 140));
        return { width, height };
      },
    };

    const cameraConfig = { facingMode: 'environment' };

    try {
      await html5QrCode.start(
        cameraConfig,
        config,
        onScanSuccess,
        () => {}
      );
      isScanning = true;
    } catch (err) {
      setStatus(
        'Could not open camera. Allow camera permission or use manual search.',
        true
      );
      console.error('Scanner start error:', err);
    }
  }

  /** On successful scan: debounce, stop camera, search by barcode */
  async function onScanSuccess(decodedText) {
    if (scanLocked) return;

    const barcode = String(decodedText).replace(/\D/g, '');
    if (barcode.length < 8) return;

    scanLocked = true;
    setStatus(`Barcode detected: ${barcode}`);

    await stopScanner();
    closeModal();

    if (typeof searchByBarcode === 'function') {
      await searchByBarcode(barcode);
    }
  }

  openBtn?.addEventListener('click', openModal);
  closeBtn?.addEventListener('click', closeModal);
  backdrop?.addEventListener('click', closeModal);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
      closeModal();
    }
  });
})();
