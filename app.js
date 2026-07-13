// 7号Suit舍 布料試搭 — 核心合成邏輯
// 原理：底圖（西裝+襯衫合一的真實照片，天生對齊，不用拼接）先畫出來
//       -> 布料圖依模式處理（整張套用 or 小樣本重複貼）、裁進「外套專屬」遮罩形狀、疊皺褶陰影 -> 蓋在底圖的外套部分上面
//       襯衫部分因為遮罩本來就排除它，永遠不會被布料蓋到，也就不會有拼接縫或缺角問題

const CANVAS_W = 896;
const CANVAS_H = 1200;

const MODE_COVER = 'cover'; // 整張照片縮放鋪滿（適合布樣夠大的情況），無接縫
const MODE_TILE = 'tile';   // 小樣本重複貼（鏡射拼接，降低接縫感，適合小布樣）

const DEFAULT_COVER_ZOOM = 1;
const DEFAULT_TILE_SCALE = 0.22;

// 紅色 LOGO 在領口的位置（貼在襯衫胸前，領尖下方，像繡在襯衫上的小標）
// 圖檔已裁到緊貼內容邊界，這裡的座標直接對應視覺上的置中位置
const LOGO_CENTER = { x: 448, y: 235, w: 78 };

const resultCanvas = document.getElementById('resultCanvas');
const ctx = resultCanvas.getContext('2d');
const emptyHint = document.getElementById('emptyHint');
const cameraInput = document.getElementById('cameraInput');
const retakeBtn = document.getElementById('retakeBtn');
const downloadBtn = document.getElementById('downloadBtn');
const thumbsEl = document.getElementById('thumbs');
const toastEl = document.getElementById('toast');
const scaleSlider = document.getElementById('scaleSlider');
const scaleControl = document.getElementById('scaleControl');
const scaleLabel = document.getElementById('scaleLabel');
const scaleHint = document.getElementById('scaleHint');
const modeControl = document.getElementById('modeControl');
const modeCoverBtn = document.getElementById('modeCoverBtn');
const modeTileBtn = document.getElementById('modeTileBtn');

resultCanvas.width = CANVAS_W;
resultCanvas.height = CANVAS_H;

let suitCutoutImg, suitMaskImg, suitShadingImg, logoImg;
let assetsReady = false;

// 最多保留 4 筆比較紀錄： { fabricImg, mode, scale, dataUrl, img }
const history = [];
let activeIndex = -1;
let currentMode = MODE_COVER;
let currentScale = DEFAULT_COVER_ZOOM;

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

async function loadAssets() {
  [suitCutoutImg, suitMaskImg, suitShadingImg, logoImg] = await Promise.all([
    loadImage('assets/suit-cutout.png'),
    loadImage('assets/suit-mask.png'),
    loadImage('assets/suit-shading.png'),
    loadImage('assets/logo-red-transparent.png'),
  ]);
  assetsReady = true;
}

// 把黑白遮罩圖(白=外套/黑=其他)轉成「alpha遮罩」canvas：白->不透明, 黑->全透明
function maskToAlphaCanvas(maskImg) {
  const c = document.createElement('canvas');
  c.width = CANVAS_W;
  c.height = CANVAS_H;
  const mctx = c.getContext('2d');
  mctx.drawImage(maskImg, 0, 0, CANVAS_W, CANVAS_H);
  const imageData = mctx.getImageData(0, 0, CANVAS_W, CANVAS_H);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const luminance = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
    data[i + 3] = luminance;
  }
  mctx.putImageData(imageData, 0, 0);
  return c;
}

let alphaMaskCanvas = null;

// 模式 A：整張照片縮放置中鋪滿（像 CSS background-size: cover），zoom 可以再放大裁入
function drawCoverZoom(targetCtx, img, w, h, zoom) {
  const imgRatio = img.width / img.height;
  const targetRatio = w / h;
  let drawW, drawH;
  if (imgRatio > targetRatio) {
    drawH = h * zoom;
    drawW = drawH * imgRatio;
  } else {
    drawW = w * zoom;
    drawH = drawW / imgRatio;
  }
  const offX = (w - drawW) / 2;
  const offY = (h - drawH) / 2;
  targetCtx.drawImage(img, offX, offY, drawW, drawH);
}

// 模式 B：小樣本重複貼，用「鏡射 2x2」拼接 —— 相鄰兩塊用鏡射對齊，邊緣像素會對得起來，
// 不會像單純重複貼那樣，深色邊緣對深色邊緣產生一條明顯接縫線
function drawMirrorTiledPattern(targetCtx, img, w, h, scale) {
  const tileW = Math.max(24, w * scale);
  const tileH = tileW * (img.height / img.width);

  const blockCanvas = document.createElement('canvas');
  blockCanvas.width = tileW * 2;
  blockCanvas.height = tileH * 2;
  const bctx = blockCanvas.getContext('2d');

  // 左上：原圖
  bctx.drawImage(img, 0, 0, tileW, tileH);
  // 右上：水平鏡射
  bctx.save();
  bctx.translate(tileW * 2, 0);
  bctx.scale(-1, 1);
  bctx.drawImage(img, 0, 0, tileW, tileH);
  bctx.restore();
  // 左下：垂直鏡射
  bctx.save();
  bctx.translate(0, tileH * 2);
  bctx.scale(1, -1);
  bctx.drawImage(img, 0, 0, tileW, tileH);
  bctx.restore();
  // 右下：水平+垂直都鏡射
  bctx.save();
  bctx.translate(tileW * 2, tileH * 2);
  bctx.scale(-1, -1);
  bctx.drawImage(img, 0, 0, tileW, tileH);
  bctx.restore();

  const pattern = targetCtx.createPattern(blockCanvas, 'repeat');
  targetCtx.save();
  targetCtx.fillStyle = pattern;
  targetCtx.fillRect(0, 0, w, h);
  targetCtx.restore();
}

// 核心合成：底圖（西裝+襯衫）-> 布料(依模式處理，只裁進外套遮罩) -> 疊皺褶陰影 -> 蓋在外套上
function renderComposite(fabricImg, mode, scale) {
  if (!alphaMaskCanvas) {
    alphaMaskCanvas = maskToAlphaCanvas(suitMaskImg);
  }

  const fabricCanvas = document.createElement('canvas');
  fabricCanvas.width = CANVAS_W;
  fabricCanvas.height = CANVAS_H;
  const fctx = fabricCanvas.getContext('2d');

  if (mode === MODE_TILE) {
    drawMirrorTiledPattern(fctx, fabricImg, CANVAS_W, CANVAS_H, scale);
  } else {
    drawCoverZoom(fctx, fabricImg, CANVAS_W, CANVAS_H, scale);
  }

  // 用 alpha 遮罩把布料裁進「外套專屬」形狀（destination-in），襯衫範圍不受影響
  fctx.globalCompositeOperation = 'destination-in';
  fctx.drawImage(alphaMaskCanvas, 0, 0);
  fctx.globalCompositeOperation = 'source-over';

  // 疊上灰階皺褶/打光層，讓布料貼合西裝立體感
  fctx.globalCompositeOperation = 'multiply';
  fctx.drawImage(suitShadingImg, 0, 0, CANVAS_W, CANVAS_H);
  fctx.globalCompositeOperation = 'destination-in';
  fctx.drawImage(alphaMaskCanvas, 0, 0);
  fctx.globalCompositeOperation = 'source-over';

  // 畫到主畫布 —— 先畫底圖（西裝+襯衫原圖，襯衫永遠正確），再蓋上新布料的外套
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
  ctx.drawImage(suitCutoutImg, 0, 0, CANVAS_W, CANVAS_H);
  ctx.drawImage(fabricCanvas, 0, 0);

  // 紅色 LOGO，貼在領口上方（已去背，不影響襯衫/外套範圍）
  if (logoImg) {
    const logoW = LOGO_CENTER.w;
    const logoH = logoW * (logoImg.height / logoImg.width);
    ctx.drawImage(logoImg, LOGO_CENTER.x - logoW / 2, LOGO_CENTER.y - logoH / 2, logoW, logoH);
  }

  emptyHint.style.display = 'none';
  retakeBtn.disabled = false;
  downloadBtn.disabled = false;
}

function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toastEl.classList.remove('show'), 1800);
}

function updateModeUI() {
  modeCoverBtn.classList.toggle('active', currentMode === MODE_COVER);
  modeTileBtn.classList.toggle('active', currentMode === MODE_TILE);
  if (currentMode === MODE_COVER) {
    scaleLabel.textContent = '縮放';
    scaleHint.textContent = '放大 / 縮小這張照片';
    scaleSlider.min = '0.5';
    scaleSlider.max = '2.5';
    scaleSlider.step = '0.01';
  } else {
    scaleLabel.textContent = '樣本大小';
    scaleHint.textContent = '調整重複貼的樣本大小';
    scaleSlider.min = '0.08';
    scaleSlider.max = '0.6';
    scaleSlider.step = '0.01';
  }
  scaleSlider.value = String(currentScale);
}

function renderThumbs() {
  thumbsEl.innerHTML = '';
  history.forEach((item, i) => {
    const div = document.createElement('div');
    div.className = 'thumb' + (i === activeIndex ? ' active' : '');
    const img = document.createElement('img');
    img.src = item.dataUrl;
    div.appendChild(img);
    const rm = document.createElement('div');
    rm.className = 'remove';
    rm.textContent = '×';
    rm.addEventListener('click', (e) => {
      e.stopPropagation();
      history.splice(i, 1);
      if (activeIndex === i) {
        activeIndex = history.length ? Math.max(0, i - 1) : -1;
        if (activeIndex >= 0) selectHistory(activeIndex);
        else resetCanvas();
      } else if (activeIndex > i) {
        activeIndex--;
      }
      renderThumbs();
    });
    div.appendChild(rm);
    div.addEventListener('click', () => {
      activeIndex = i;
      selectHistory(i);
      renderThumbs();
    });
    thumbsEl.appendChild(div);
  });
}

// 切換到某筆歷史紀錄：套用該筆自己記錄的模式與比例，並同步 UI
function selectHistory(i) {
  const item = history[i];
  currentMode = item.mode;
  currentScale = item.scale;
  updateModeUI();
  renderComposite(item.fabricImg, item.mode, item.scale);
  emptyHint.style.display = 'none';
  retakeBtn.disabled = false;
  downloadBtn.disabled = false;
  scaleControl.style.display = 'flex';
  modeControl.style.display = 'flex';
}

// 把目前畫布結果序列化，更新回歷史紀錄與縮圖（拖曳滑桿放開時才做，避免拖曳中一直重算縮圖）
async function commitActiveToHistory() {
  if (activeIndex < 0) return;
  const item = history[activeIndex];
  item.mode = currentMode;
  item.scale = currentScale;
  item.dataUrl = resultCanvas.toDataURL('image/png');
  item.img = await loadImage(item.dataUrl);
  renderThumbs();
}

function resetCanvas() {
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
  emptyHint.style.display = 'flex';
  retakeBtn.disabled = true;
  downloadBtn.disabled = true;
  scaleControl.style.display = 'none';
  modeControl.style.display = 'none';
}

cameraInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (!assetsReady) {
    showToast('素材載入中，請稍等一下再試一次');
    return;
  }
  const url = URL.createObjectURL(file);
  try {
    const fabricImg = await loadImage(url);
    currentMode = MODE_COVER;
    currentScale = DEFAULT_COVER_ZOOM;
    updateModeUI();
    renderComposite(fabricImg, currentMode, currentScale);
    const dataUrl = resultCanvas.toDataURL('image/png');
    const resultImg = await loadImage(dataUrl);

    if (history.length >= 4) history.shift();
    history.push({ fabricImg, mode: currentMode, scale: currentScale, dataUrl, img: resultImg });
    activeIndex = history.length - 1;
    renderThumbs();
    scaleControl.style.display = 'flex';
    modeControl.style.display = 'flex';
    showToast('布料套用完成 ✅ 布樣較小可以切換「小樣本重複貼」');
  } catch (err) {
    console.error(err);
    showToast('這張照片讀取失敗，換一張試試');
  } finally {
    URL.revokeObjectURL(url);
    cameraInput.value = '';
  }
});

retakeBtn.addEventListener('click', () => {
  cameraInput.click();
});

downloadBtn.addEventListener('click', () => {
  if (activeIndex < 0) return;
  const a = document.createElement('a');
  a.href = history[activeIndex].dataUrl;
  a.download = `7号Suit舍_布料試搭_${Date.now()}.png`;
  a.click();
  showToast('已下載到您的裝置');
});

function switchMode(newMode) {
  if (currentMode === newMode || activeIndex < 0) return;
  currentMode = newMode;
  currentScale = newMode === MODE_COVER ? DEFAULT_COVER_ZOOM : DEFAULT_TILE_SCALE;
  updateModeUI();
  renderComposite(history[activeIndex].fabricImg, currentMode, currentScale);
  commitActiveToHistory();
}

modeCoverBtn.addEventListener('click', () => switchMode(MODE_COVER));
modeTileBtn.addEventListener('click', () => switchMode(MODE_TILE));

// 滑桿拖曳中：即時更新主畫布預覽（不重算縮圖，效能較好）
scaleSlider.addEventListener('input', (e) => {
  currentScale = parseFloat(e.target.value);
  if (activeIndex < 0) return;
  renderComposite(history[activeIndex].fabricImg, currentMode, currentScale);
});

// 滑桿放開時：把最終比例寫回歷史紀錄＋更新縮圖
scaleSlider.addEventListener('change', () => {
  commitActiveToHistory();
});

// PWA: 註冊 service worker，並在有新版本時自動重新整理（不用手動清快取/關分頁）
if ('serviceWorker' in navigator) {
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch((err) => {
      console.warn('Service worker 註冊失敗（本機直接開檔案時是正常的，用本機伺服器開就會成功）', err);
    });
  });
}

loadAssets().then(() => {
  console.log('西裝範本素材載入完成');
}).catch((err) => {
  console.error('西裝範本素材載入失敗', err);
  showToast('西裝範本圖片載入失敗，請確認 assets 資料夾');
});
