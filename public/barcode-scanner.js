/**
 * ShoppingSmart – Barcode scanner (html5-qrcode bundled in public/html5-qrcode.min.js)
 * - Prefer rear camera on phones (facingMode: environment)
 * - Step through fallbacks when { exact: "environment" } is unsupported
 * - Surface clear errors when camera permission is denied
 */

(function initBarcodeScanner() {
  const modal = document.getElementById('barcode-scanner-modal');
  const readerEl = document.getElementById('barcode-reader');
  const statusEl = document.getElementById('scanner-status');
  const openBtn = document.getElementById('scannerBtn');
  const closeBtn = document.getElementById('scanner-close-btn');
  const backdrop = document.getElementById('scanner-backdrop');

  const PERMISSION_ALERT =
    'Camera access is required to scan barcodes. Please allow camera permission in your browser settings and try again.';

  if (!modal || !readerEl || typeof Html5Qrcode === 'undefined') {
    if (openBtn) {
      openBtn.addEventListener('click', () => {
        alert(
          'The barcode scanner library did not load. Ensure public/html5-qrcode.min.js exists and refresh the page.'
        );
      });
    }
    return;
  }

  let html5QrCode = null;
  let isScanning = false;
  let scanLocked = false;
  let startInProgress = false;

  const isMobile =
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.maxTouchPoints > 1 && window.matchMedia('(max-width: 768px)').matches);

  /** Định dạng mã vạch phổ biến tại Coles / Woolworths */
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

  /** Đợi modal hiển thị xong (quan trọng trên iOS Safari / Chrome Android) */
  function waitForModalLayout() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setTimeout(resolve, isMobile ? 120 : 50);
        });
      });
    });
  }

  function openModal() {
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    scanLocked = false;
    setStatus('Đang mở camera…');
    startScanner();
  }

  function closeModal() {
    modal.classList.add('hidden');
    document.body.style.overflow = '';
    stopScanner();
  }

  /**
   * Dừng camera và giải phóng tài nguyên.
   * @param {boolean} resetInstance – tạo lại instance Html5Qrcode cho lần mở sau
   */
  async function stopScanner(resetInstance = false) {
    if (html5QrCode && isScanning) {
      try {
        await html5QrCode.stop();
      } catch {
        /* có thể đã dừng */
      }
    }

    if (html5QrCode) {
      try {
        await html5QrCode.clear();
      } catch {
        /* ignore */
      }
    }

    isScanning = false;

    if (resetInstance) {
      html5QrCode = null;
    }
  }

  /** Tạo (hoặc tạo lại) đối tượng Html5Qrcode sau khi clear vùng đọc */
  function createReaderInstance() {
    readerEl.innerHTML = '';
    html5QrCode = new Html5Qrcode('barcode-reader', {
      formatsToSupport: barcodeFormats,
      verbose: false,
    });
  }

  /**
   * Cấu hình khung quét – mobile không ép aspectRatio (tránh màn hình đen trên một số máy).
   */
  function buildScanConfig() {
    const config = {
      fps: isMobile ? 10 : 12,
      disableFlip: false,
      experimentalFeatures: {
        useBarCodeDetectorIfSupported: true,
      },
      qrbox: (viewfinderWidth, viewfinderHeight) => {
        const width = Math.floor(Math.min(viewfinderWidth * 0.92, 340));
        const height = Math.floor(Math.min(viewfinderHeight * 0.42, isMobile ? 160 : 140));
        return { width: Math.max(width, 200), height: Math.max(height, 80) };
      },
    };

    if (!isMobile) {
      config.aspectRatio = 1.777778;
    }

    return config;
  }

  /**
   * Danh sách cấu hình camera theo thứ tự ưu tiên:
   * 1) Ép camera sau (exact environment)
   * 2) environment thường
   * 3) ideal environment
   * 4) deviceId camera sau (từ getCameras)
   * 5) camera đầu tiên trong danh sách
   */
  async function buildCameraStartAttempts() {
    const attempts = [];

    attempts.push({
      id: 'exact-environment',
      getConfig: () => ({ facingMode: { exact: 'environment' } }),
    });

    attempts.push({
      id: 'environment',
      getConfig: () => ({ facingMode: 'environment' }),
    });

    attempts.push({
      id: 'ideal-environment',
      getConfig: () => ({ facingMode: { ideal: 'environment' } }),
    });

    attempts.push({
      id: 'device-back',
      getConfig: async () => {
        const deviceId = await pickBackCameraDeviceId();
        if (!deviceId) throw new Error('Không tìm thấy camera sau trong danh sách thiết bị.');
        return deviceId;
      },
    });

    attempts.push({
      id: 'device-first',
      getConfig: async () => {
        const cameras = await Html5Qrcode.getCameras();
        if (!cameras?.length) {
          throw new Error('Không có camera trên thiết bị.');
        }
        return cameras[0].id;
      },
    });

    return attempts;
  }

  /**
   * Chọn deviceId camera sau khi đã có quyền (nhãn Back/Rear hoặc camera cuối danh sách trên Android).
   */
  async function pickBackCameraDeviceId() {
    const cameras = await Html5Qrcode.getCameras();
    if (!cameras?.length) return null;

    const backByLabel = cameras.find((cam) => {
      const label = String(cam.label || '').toLowerCase();
      return (
        /back|rear|environment|sau|wide/.test(label) &&
        !/front|user|selfie|trước/.test(label)
      );
    });
    if (backByLabel) return backByLabel.id;

    if (cameras.length > 1) {
      return cameras[cameras.length - 1].id;
    }

    return cameras[0].id;
  }

  /** Lỗi do người dùng từ chối quyền camera */
  function isCameraPermissionDenied(error) {
    const name = error?.name || '';
    const message = String(error?.message || error || '').toLowerCase();

    return (
      name === 'NotAllowedError' ||
      name === 'PermissionDeniedError' ||
      name === 'SecurityError' ||
      message.includes('permission denied') ||
      message.includes('permission dismissed') ||
      message.includes('not allowed') ||
      message.includes('access denied') ||
      message.includes('notallowed')
    );
  }

  /** Hiển thị thông báo lỗi camera phù hợp */
  function handleCameraStartError(error) {
    console.error('Scanner start error:', error);

    if (isCameraPermissionDenied(error)) {
      alert(PERMISSION_ALERT);
      setStatus('Cần quyền Camera để quét mã vạch.', true);
      return;
    }

    const message = String(error?.message || error || '');
    if (/not found|no camera|devices/i.test(message)) {
      setStatus('Không tìm thấy camera trên thiết bị này.', true);
      return;
    }

    setStatus(
      'Không mở được camera. Thử tải lại trang hoặc tìm sản phẩm bằng tên.',
      true
    );
  }

  /**
   * Gọi html5QrCode.start với một cấu hình camera (object facingMode hoặc deviceId).
   */
  async function startWithCameraConfig(cameraIdOrConfig, scanConfig) {
    await html5QrCode.start(cameraIdOrConfig, scanConfig, onScanSuccess, () => {});
    isScanning = true;
  }

  /**
   * Khởi động camera: thử lần lượt các fallback cho đến khi thành công.
   */
  async function startScanner() {
    if (startInProgress) return;
    startInProgress = true;

    try {
      await stopScanner(true);
      await waitForModalLayout();

      createReaderInstance();
      const scanConfig = buildScanConfig();
      const attempts = await buildCameraStartAttempts();

      let lastError = null;

      for (const attempt of attempts) {
        try {
          const cameraConfig =
            typeof attempt.getConfig === 'function'
              ? await attempt.getConfig()
              : attempt.getConfig;

          await startWithCameraConfig(cameraConfig, scanConfig);
          setStatus('Đưa camera vào mã vạch trên bao bì sản phẩm');
          return;
        } catch (err) {
          lastError = err;
          console.warn(`Camera attempt "${attempt.id}" failed:`, err?.message || err);
          await stopScanner(false);
          createReaderInstance();
        }
      }

      handleCameraStartError(lastError);
    } finally {
      startInProgress = false;
    }
  }

  /** Khi quét thành công: khóa trùng, tắt camera, rồi dịch barcode sang tên sản phẩm trước khi so giá */
  async function onScanSuccess(decodedText) {
    if (scanLocked) return;

    const barcode = String(decodedText).replace(/\D/g, '');
    if (barcode.length < 8) return;

    scanLocked = true;
    setStatus('Scanning...');

    await stopScanner(true);
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
