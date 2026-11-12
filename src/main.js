import * as ort from 'onnxruntime-web';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import { DemucsProcessor, CONSTANTS } from './demucs-web/index.js';
import './style.css';

const MODEL_URL = CONSTANTS.DEFAULT_MODEL_URL;
const FFMPEG_VERSION = '0.12.10';
const FFMPEG_BASE = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${FFMPEG_VERSION}/dist/umd`;

const $ = (id) => document.getElementById(id);
const fileInput = $('fileInput');
const dropZone = $('dropZone');
const videoPreview = $('videoPreview');
const processButton = $('processButton');
const processLabel = $('buttonLabel');
const statusText = $('status');
const progressFill = $('progressFill');
const progressPercent = $('progressPercent');
const progressDetail = $('progressDetail');
const etaText = $('eta');
const ffmpeg = new FFmpeg();

let selectedFile = null;
let inputUrl = null;
let outputUrl = null;
let processor = null;
let audioContext = null;
let modelReady = false;
let busy = false;
let ffmpegReady = false;
let lastProgressTime = 0;
let separatedStems = null;
let sourceVideoName = null;
let outputStemUrls = [];
let mixPreviewUrl = null;
let audioSampleCount = 0;
const STEM_LABELS = { drums: '鼓組', bass: '低音', other: '其他樂器', vocals: '人聲' };

function setProgress(value, label, detail = '') {
  const percent = Math.max(0, Math.min(100, value));
  progressFill.style.width = `${percent}%`;
  progressPercent.textContent = percent > 0 ? `${Math.round(percent)}%` : '';
  if (label) statusText.textContent = label;
  if (detail) progressDetail.textContent = detail;
}

function setStep(step) {
  document.querySelectorAll('.step').forEach((node) => {
    const number = Number(node.dataset.step);
    node.classList.toggle('active', number === step);
    node.classList.toggle('done', number < step);
  });
}

function showError(error) {
  console.error(error);
  const message = error instanceof Error ? error.message : String(error);
  setProgress(0, '處理失敗', message);
  processLabel.textContent = '再試一次';
}

async function detectBackend() {
  const isolated = self.crossOriginIsolated === true;
  ort.env.wasm.numThreads = isolated ? Math.max(1, Math.min(navigator.hardwareConcurrency || 4, 8)) : 1;
  let backend = 'wasm';
  if ('gpu' in navigator) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) backend = 'webgpu';
    } catch { /* WASM remains available. */ }
  }
  if (backend === 'webgpu') {
    ort.env.webgpu = { ...(ort.env.webgpu || {}), powerPreference: 'high-performance' };
    $('backendBadge').textContent = 'WebGPU 加速';
    $('backendBadge').classList.add('gpu');
  } else {
    $('backendBadge').textContent = isolated
      ? `WASM · ${ort.env.wasm.numThreads} 執行緒`
      : 'WASM · 單執行緒相容模式';
  }
}

async function loadModel() {
  if (modelReady) return;
  processor ||= new DemucsProcessor({
    ort,
    onProgress: ({ progress, currentSegment, totalSegments }) => {
      const elapsed = (Date.now() - lastProgressTime) / 1000;
      const fraction = Math.round(progress * 100);
      setProgress(12 + progress * 75, 'AI 正在分離人聲', `音訊分段 ${currentSegment} / ${totalSegments}`);
      etaText.textContent = currentSegment > 0
        ? `剩餘約 ${formatDuration(elapsed / currentSegment * (totalSegments - currentSegment))}`
        : '';
      progressPercent.textContent = `${fraction}%`;
    },
    onDownloadProgress: (loaded, total) => {
      const progress = total ? loaded / total : 0;
      setProgress(progress * 10, '首次載入 Demucs 模型', `${(loaded / 1048576).toFixed(0)} / ${total ? (total / 1048576).toFixed(0) : '…'} MB`);
    },
    onLog: (phase, message) => console.info(`[Demucs/${phase}] ${message}`)
  });
  setProgress(1, '載入 AI 模型', '模型約 172 MB，首次使用需要下載');
  await processor.loadModel(MODEL_URL);
  modelReady = true;
}

async function loadFFmpeg() {
  if (ffmpegReady) return;
  setProgress(1, '準備瀏覽器影片工具', '首次載入 FFmpeg WASM');
  const coreURL = await toBlobURL(`${FFMPEG_BASE}/ffmpeg-core.js`, 'text/javascript');
  const wasmURL = await toBlobURL(`${FFMPEG_BASE}/ffmpeg-core.wasm`, 'application/wasm');
  await ffmpeg.load({ coreURL, wasmURL });
  ffmpegReady = true;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '計算中';
  const value = Math.ceil(seconds);
  return value >= 60 ? `${Math.floor(value / 60)} 分 ${value % 60} 秒` : `${value} 秒`;
}

function formatSize(bytes) {
  return bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function setMixerEnabled(enabled) {
  for (const id of ['keyShift', 'keyDown', 'keyUp', 'effectSelect', 'previewMixButton']) $(id).disabled = !enabled;
}

function chooseFile(file) {
  if (!file) return;
  if (!file.type.startsWith('video/') && !/\.(mp4|mov|webm|m4v)$/i.test(file.name)) {
    setProgress(0, '請選擇影片檔', '支援 MP4、MOV、WebM、M4V。');
    return;
  }
  if (file.size > 1024 * 1024 * 1024) {
    setProgress(0, '影片檔案較大', '目前建議選擇 1 GB 以下的影片，以免瀏覽器記憶體不足。');
    return;
  }
  selectedFile = file;
  if (inputUrl) URL.revokeObjectURL(inputUrl);
  inputUrl = URL.createObjectURL(file);
  videoPreview.src = inputUrl;
  videoPreview.hidden = false;
  $('emptyState').hidden = true;
  $('fileName').textContent = `${file.name} · ${formatSize(file.size)}`;
  $('changeButton').hidden = false;
  $('videoMeta').textContent = '影片已就緒';
  $('downloadButton').hidden = true;
  $('resultPreview').hidden = true;
  $('mixPreview').hidden = true;
  $('mixPreview').removeAttribute('src');
  $('stemList').replaceChildren();
  $('stemList').classList.add('mixer-placeholder');
  $('stemList').textContent = '分離完成後可獨立調整鼓組、低音、其他樂器與人聲。';
  $('stemCount').textContent = '分離後開啟';
  setMixerEnabled(false);
  if (mixPreviewUrl) URL.revokeObjectURL(mixPreviewUrl);
  mixPreviewUrl = null;
  for (const url of outputStemUrls) URL.revokeObjectURL(url);
  outputStemUrls = [];
  separatedStems = null;
  if (outputUrl) URL.revokeObjectURL(outputUrl);
  outputUrl = null;
  processButton.disabled = false;
  processLabel.textContent = '先分離音軌';
  setProgress(0, '影片已載入，可以開始', 'AI 模型會在開始時載入');
  setStep(1);
}

$('chooseButton').addEventListener('click', () => fileInput.click());
$('changeButton').addEventListener('click', () => fileInput.click());
dropZone.addEventListener('click', (event) => {
  if (event.target.closest('button') || selectedFile) return;
  fileInput.click();
});
fileInput.addEventListener('change', () => {
  chooseFile(fileInput.files?.[0]);
  fileInput.value = '';
});
dropZone.addEventListener('dragover', (event) => {
  event.preventDefault();
  dropZone.classList.add('dragging');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragging'));
dropZone.addEventListener('drop', (event) => {
  event.preventDefault();
  dropZone.classList.remove('dragging');
  chooseFile(event.dataTransfer?.files?.[0]);
});

function linearResample(source, targetLength) {
  const target = new Float32Array(targetLength);
  const ratio = source.length / targetLength;
  for (let i = 0; i < targetLength; i += 1) {
    const position = i * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, source.length - 1);
    const blend = position - left;
    target[i] = source[left] * (1 - blend) + source[right] * blend;
  }
  return target;
}

function toWav(left, right, sampleRate) {
  const frames = Math.min(left.length, right.length);
  const bytes = new ArrayBuffer(44 + frames * 4);
  const view = new DataView(bytes);
  const write = (offset, text) => [...text].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  write(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); write(8, 'WAVE');
  write(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 2, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 4, true); view.setUint16(32, 4, true);
  view.setUint16(34, 16, true); write(36, 'data'); view.setUint32(40, frames * 4, true);
  let offset = 44;
  for (let i = 0; i < frames; i += 1) {
    for (const channel of [left, right]) {
      const sample = Math.max(-1, Math.min(1, channel[i]));
      view.setInt16(offset, sample < 0 ? sample * 32768 : sample * 32767, true);
      offset += 2;
    }
  }
  return new Uint8Array(bytes);
}

async function separateVideo() {
  if (!selectedFile || busy) return;
  busy = true;
  processButton.disabled = true;
  $('downloadButton').hidden = true;
  $('resultPreview').hidden = true;
  etaText.textContent = '';
  setStep(2);
  try {
    await loadFFmpeg();
    await loadModel();
    setProgress(11, '從影片擷取音訊', '僅在瀏覽器記憶體中進行');
    sourceVideoName = `source${extensionFor(selectedFile.name)}`;
    await ffmpeg.writeFile(sourceVideoName, await fetchFile(selectedFile));
    await ffmpeg.exec(['-y', '-i', sourceVideoName, '-vn', '-ac', '2', '-ar', String(CONSTANTS.SAMPLE_RATE), '-f', 'wav', 'source.wav']);

    setProgress(12, '準備音訊資料', '轉換成 Demucs 所需的 44.1 kHz 立體聲');
    const wav = await ffmpeg.readFile('source.wav');
    audioContext ||= new AudioContext({ sampleRate: CONSTANTS.SAMPLE_RATE });
    if (audioContext.state === 'suspended') await audioContext.resume();
    const decoded = await audioContext.decodeAudioData(wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength));
    let left = decoded.getChannelData(0);
    let right = decoded.numberOfChannels > 1 ? decoded.getChannelData(1) : left;
    if (decoded.sampleRate !== CONSTANTS.SAMPLE_RATE) {
      const newLength = Math.round(decoded.length * CONSTANTS.SAMPLE_RATE / decoded.sampleRate);
      left = linearResample(left, newLength);
      right = linearResample(right, newLength);
    }
    audioSampleCount = left.length;
    lastProgressTime = Date.now();
    setProgress(12, 'AI 正在分離四組音軌', '長影片需要更多處理時間');
    separatedStems = await processor.separate(left, right);
    renderStemMixer();
    $('mixerPanel').hidden = false;
    processLabel.textContent = '製作伴奏 MV';
    setProgress(100, '音軌分離完成', '調整音量與效果，再製作伴奏 MV');
    $('progressDetail').textContent = '可單獨下載每一組音軌';
    setStep(2);
  } catch (error) {
    showError(error);
  } finally {
    busy = false;
    processButton.disabled = !selectedFile;
  }
}

function renderStemMixer() {
  const list = $('stemList');
  list.replaceChildren();
  list.classList.remove('mixer-placeholder');
  const activeCount = Object.keys(STEM_LABELS).filter((name) => separatedStems[name]).length;
  $('stemCount').textContent = `${activeCount} 組音軌`;
  setMixerEnabled(true);
  for (const [name, label] of Object.entries(STEM_LABELS)) {
    const stem = separatedStems[name];
    if (!stem) continue;
    const row = document.createElement('div');
    row.className = 'stem-row';
    const enabled = name !== 'vocals';
    row.innerHTML = `<label class="stem-toggle"><input type="checkbox" data-stem="${name}" ${enabled ? 'checked' : ''}><span class="checkmark"></span><span class="stem-name">${label}</span></label><input class="stem-volume" type="range" min="0" max="150" value="100" aria-label="${label}音量"><output class="stem-level">${enabled ? '100%' : '0%'}</output><button class="stem-download" type="button" data-download="${name}" aria-label="下載${label}">↓</button>`;
    list.append(row);
  }
  list.querySelectorAll('.stem-volume').forEach((slider) => slider.addEventListener('input', () => {
    const row = slider.closest('.stem-row');
    const checkbox = row.querySelector('[data-stem]');
    row.querySelector('.stem-level').value = checkbox.checked ? `${slider.value}%` : '0%';
  }));
  list.querySelectorAll('[data-stem]').forEach((checkbox) => checkbox.addEventListener('change', () => {
    const row = checkbox.closest('.stem-row');
    row.querySelector('.stem-level').value = checkbox.checked ? `${row.querySelector('.stem-volume').value}%` : '0%';
  }));
  list.querySelectorAll('[data-download]').forEach((button) => button.addEventListener('click', () => downloadStem(button.dataset.download)));
}

function getMix() {
  const left = new Float32Array(audioSampleCount);
  const right = new Float32Array(audioSampleCount);
  for (const row of $('stemList').querySelectorAll('.stem-row')) {
    const name = row.querySelector('[data-stem]').dataset.stem;
    if (!row.querySelector('[data-stem]').checked) continue;
    const gain = Number(row.querySelector('.stem-volume').value) / 100;
    const stem = separatedStems[name];
    const count = Math.min(audioSampleCount, stem.left.length);
    for (let i = 0; i < count; i += 1) {
      left[i] += stem.left[i] * gain;
      right[i] += stem.right[i] * gain;
    }
  }
  return { left, right };
}

function currentAudioFilters() {
  const semitones = Number($('keyShift').value);
  const filters = [];
  if (semitones !== 0) {
    const ratio = 2 ** (semitones / 12);
    filters.push(`asetrate=${Math.round(CONSTANTS.SAMPLE_RATE * ratio)}`, `aresample=${CONSTANTS.SAMPLE_RATE}`, `atempo=${(1 / ratio).toFixed(6)}`);
  }
  if ($('effectSelect').value === 'electronic') {
    filters.push('aphaser=in_gain=0.8:out_gain=0.85:delay=2:decay=0.35:speed=0.45:type=triangular', 'aecho=0.8:0.85:55|110|165:0.22|0.13|0.08');
  }
  return filters.join(',');
}

async function makeMixWav(outputName) {
  const mix = getMix();
  const filter = currentAudioFilters();
  if (filter) {
    await ffmpeg.writeFile('mix-source.wav', toWav(mix.left, mix.right, CONSTANTS.SAMPLE_RATE));
    const result = await ffmpeg.exec(['-y', '-i', 'mix-source.wav', '-af', filter, '-t', (audioSampleCount / CONSTANTS.SAMPLE_RATE).toFixed(3), outputName]);
    if (result !== 0) throw new Error('音訊效果處理失敗，請嘗試關閉電音效果或把 Key 設為 0。');
  } else {
    await ffmpeg.writeFile(outputName, toWav(mix.left, mix.right, CONSTANTS.SAMPLE_RATE));
  }
}

function downloadStem(name) {
  const stem = separatedStems[name];
  if (!stem) return;
  const blob = new Blob([toWav(stem.left, stem.right, CONSTANTS.SAMPLE_RATE)], { type: 'audio/wav' });
  const url = URL.createObjectURL(blob);
  outputStemUrls.push(url);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${selectedFile.name.replace(/\.[^.]+$/, '')}-${STEM_LABELS[name]}.wav`;
  link.click();
}

async function previewMix() {
  if (!separatedStems || busy) return;
  busy = true;
  $('previewMixButton').disabled = true;
  setProgress(0, '製作混音預覽', '套用目前音量、升降 Key 與效果');
  try {
    await makeMixWav('mix-preview.wav');
    const data = await ffmpeg.readFile('mix-preview.wav');
    if (mixPreviewUrl) URL.revokeObjectURL(mixPreviewUrl);
    mixPreviewUrl = URL.createObjectURL(new Blob([data], { type: 'audio/wav' }));
    $('mixPreview').src = mixPreviewUrl;
    $('mixPreview').hidden = false;
    $('mixPreview').load();
    setProgress(100, '混音預覽已就緒', '按下播放，試聽你的設定');
  } catch (error) {
    showError(error);
  } finally {
    busy = false;
    $('previewMixButton').disabled = false;
  }
}

async function exportVideo() {
  if (!selectedFile || !separatedStems || busy) return;
  busy = true;
  processButton.disabled = true;
  $('downloadButton').hidden = true;
  $('resultPreview').hidden = true;
  try {
    setProgress(89, '製作混音音軌', '套用音量、升降 Key 與效果');
    await makeMixWav('instrumental.wav');
    setProgress(93, '重新封裝伴奏 MV', '保留原始影片畫質');
    const args = ['-y', '-i', sourceVideoName, '-i', 'instrumental.wav', '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', 'instrumental-mv.mp4'];
    let result = await ffmpeg.exec(args);
    if (result !== 0) {
      setProgress(94, '轉換影片格式後重新封裝', '正在轉成 H.264');
      result = await ffmpeg.exec(['-y', '-i', sourceVideoName, '-i', 'instrumental.wav', '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '22', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', 'instrumental-mv.mp4']);
    }
    if (result !== 0) throw new Error('影片封裝失敗，請改用 MP4 影片或移除部分音效後重試。');
    const output = await ffmpeg.readFile('instrumental-mv.mp4');
    const blob = new Blob([output], { type: 'video/mp4' });
    if (outputUrl) URL.revokeObjectURL(outputUrl);
    outputUrl = URL.createObjectURL(blob);
    $('downloadButton').href = outputUrl;
    $('downloadButton').download = `${selectedFile.name.replace(/\.[^.]+$/, '')}-混音MV.mp4`;
    $('downloadButton').hidden = false;
    $('resultVideo').src = outputUrl;
    $('resultPreview').hidden = false;
    setProgress(100, '混音 MV 製作完成', `輸出檔案 ${formatSize(blob.size)}`);
    $('progressDetail').textContent = '已套用所選音軌與音效';
    setStep(3);
  } catch (error) {
    showError(error);
  } finally {
    busy = false;
    processButton.disabled = !separatedStems;
  }
}

function handleProcessClick() {
  if (separatedStems) exportVideo();
  else separateVideo();
}

function extensionFor(name) {
  const match = name.match(/\.(mp4|mov|webm|m4v)$/i);
  return match ? `.${match[1].toLowerCase()}` : '.mp4';
}

$('keyShift').addEventListener('input', () => {
  const value = Number($('keyShift').value);
  $('keyValue').textContent = value === 0 ? '0 半音' : `${value > 0 ? '+' : ''}${value} 半音`;
});
$('keyDown').addEventListener('click', () => {
  $('keyShift').value = Math.max(-12, Number($('keyShift').value) - 1);
  $('keyShift').dispatchEvent(new Event('input'));
});
$('keyUp').addEventListener('click', () => {
  $('keyShift').value = Math.min(12, Number($('keyShift').value) + 1);
  $('keyShift').dispatchEvent(new Event('input'));
});
$('previewMixButton').addEventListener('click', previewMix);
processButton.addEventListener('click', handleProcessClick);
window.addEventListener('beforeunload', () => {
  if (inputUrl) URL.revokeObjectURL(inputUrl);
  if (outputUrl) URL.revokeObjectURL(outputUrl);
  audioContext?.close();
});

detectBackend();
