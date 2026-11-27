import { storageKey } from "./runtime.js";
import { createCaptureReview } from "./capture-review.js";

let galleryDatabase;
let activeCamera;
let vp8EncoderReady = false;

export async function galleryRequest(storeName, mode, operation) {
  if (!galleryDatabase) {
    galleryDatabase = new Promise((resolve, reject) => {
      const request = indexedDB.open(storageKey("field-camera-originals"), 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("settings");
        request.result.createObjectStore("pending");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }).catch(error => {
      galleryDatabase = undefined;
      throw error;
    });
  }
  const db = await galleryDatabase;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const request = operation(tx.objectStore(storeName));
    tx.oncomplete = () => resolve(request.result);
    tx.onabort = tx.onerror = () => reject(tx.error || request.error);
  });
}

const folderAccess = {mode: "readwrite"};

async function chooseOriginalFolder() {
  const directory = await window.showDirectoryPicker({id: "field-originals", ...folderAccess, startIn: "pictures"});
  await galleryRequest("settings", "readwrite", store => {
    store.put(directory, "directory");
    return store.put("folder", "phoneCopyMode");
  });
  return directory;
}

async function readPhoneCopySettings() {
  const [preference, directory] = await Promise.all(["phoneCopyMode", "directory"].map(key =>
    galleryRequest("settings", "readonly", store => store.get(key))));
  // A folder selected in previous releases was already an explicit choice to save there.
  const mode = preference ?? (directory ? "folder" : "off");
  return {mode, directory, writable: mode === "folder" ? await writableFolder(directory) : null};
}

async function writableFolder(directory) {
  try { return await directory?.queryPermission(folderAccess) === "granted" ? directory : null; }
  catch { return null; }
}

export async function prepareGallery() {
  if (typeof window.showDirectoryPicker !== "function") {
    return "폴더 선택을 지원하지 않습니다. 카메라 설정에서 다운로드로 추가 저장할 수 있습니다.";
  }
  try {
    const directory = await chooseOriginalFolder();
    return `원본 폴더 ‘${directory.name}’ 연결됨`;
  } catch (error) {
    if (error.name === "AbortError") return "폴더 선택을 취소했습니다.";
    return "폴더를 연결하지 못했습니다. Pictures 또는 DCIM 안의 폴더를 선택하세요.";
  }
}

function requestDownload(file) {
  const link = document.createElement("a");
  const url = URL.createObjectURL(file);
  link.href = url;
  link.download = file.name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function writeOriginal(file, directory) {
  const handle = await directory.getFileHandle(file.name, {create: true});
  const writer = await handle.createWritable();
  try {
    await writer.write(file);
    await writer.close();
  } catch (error) {
    await writer.abort().catch(() => {});
    throw error;
  }
}

function captureName(blob, takenAt) {
  const mime = blob.type.split(";")[0];
  const suffix = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "video/mp4": "mp4", "video/webm": "webm"}[mime];
  if (!suffix) throw new Error("이 기기의 촬영 형식을 저장할 수 없습니다.");
  const stamp = new Date(takenAt).toISOString().replace(/[-:]/g, "");
  return new File([blob], `field-${stamp}-${crypto.randomUUID()}.${suffix}`, {type: mime, lastModified: takenAt});
}

const ratios = {"1:1": [1, 1], "3:4": [3, 4], "9:16": [9, 16]};

function centerCrop(width, height, aspect, zoom = 1) {
  const w = Math.min(width, height * aspect) / zoom;
  const h = w / aspect;
  return {x: (width - w) / 2, y: (height - h) / 2, w, h};
}

function framingCanvas(width, height, [x, y]) {
  if (!width || !height) throw new Error("카메라 미리보기를 기다려 주세요.");
  // Even dimensions are accepted by both the MP4 and WebM encoders.
  const unit = 2 * Math.floor(Math.min(width / x, height / y) / 2);
  if (!unit) throw new Error("카메라 영상의 크기가 너무 작습니다.");
  const canvas = document.createElement("canvas");
  canvas.width = x * unit;
  canvas.height = y * unit;
  return canvas;
}

function drawFrame(canvas, source, bounds, zoom) {
  const crop = centerCrop(bounds.w, bounds.h, canvas.width / canvas.height, zoom);
  canvas.getContext("2d", {alpha: false}).drawImage(source, bounds.x + crop.x, bounds.y + crop.y,
    crop.w, crop.h, 0, 0, canvas.width, canvas.height);
}

async function photoBlob(preview, frame, zoom, imageCapture, light) {
  const streamWidth = preview.videoWidth;
  const streamHeight = preview.videoHeight;
  if (!streamWidth || !streamHeight) throw new Error("카메라 미리보기를 기다려 주세요.");
  let bitmap;
  if (light === "flash" || light === "auto") {
    try {
      const blob = await imageCapture.takePhoto({fillLightMode: light});
      bitmap = await createImageBitmap(blob);
    } catch {
      throw new Error("플래시 촬영이 실패했습니다. 조명을 끄거나 다시 촬영하세요.");
    }
  }
  let canvas;
  try {
    // Still images can include additional sensor area outside the video preview.
    const bounds = bitmap ? centerCrop(bitmap.width, bitmap.height, streamWidth / streamHeight)
      : {x: 0, y: 0, w: streamWidth, h: streamHeight};
    canvas = framingCanvas(bounds.w, bounds.h, frame);
    drawFrame(canvas, bitmap || preview, bounds, zoom);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", .94));
    if (!blob) throw new Error("사진을 만들지 못했습니다. 다시 촬영하세요.");
    return blob;
  } finally {
    if (canvas) canvas.width = 0;
    bitmap?.close();
  }
}

function croppedRecording(preview, frame, currentZoom, sourceLost) {
  const source = preview.srcObject.getVideoTracks()[0];
  const canvas = framingCanvas(preview.videoWidth, preview.videoHeight, frame);
  const manual = typeof window.CanvasCaptureMediaStreamTrack?.prototype.requestFrame === "function";
  const stream = canvas.captureStream(manual ? 0 : 30);
  const [track] = stream.getVideoTracks();
  let timer;
  function draw() {
    if (source.readyState !== "live") {
      sourceLost();
      return;
    }
    const bounds = {x: 0, y: 0, w: preview.videoWidth, h: preview.videoHeight};
    if (!bounds.w || !bounds.h) return;
    drawFrame(canvas, preview, bounds, currentZoom());
    if (manual) track.requestFrame();
  }
  return {
    stream,
    async poster() {
      const thumb = document.createElement("canvas");
      const scale = Math.min(1, 256 / Math.max(canvas.width, canvas.height));
      thumb.width = Math.max(1, Math.round(canvas.width * scale));
      thumb.height = Math.max(1, Math.round(canvas.height * scale));
      thumb.getContext("2d").drawImage(canvas, 0, 0, thumb.width, thumb.height);
      return new Promise(resolve => thumb.toBlob(resolve, "image/jpeg", .8));
    },
    async start() {
      // Wait for an actual cropped video frame before the muxer can start with audio alone.
      const probe = document.createElement("video");
      probe.muted = true;
      probe.playsInline = true;
      probe.srcObject = stream;
      timer = setInterval(draw, 1000 / 30);
      draw();
      let timeout;
      try {
        await Promise.race([
          probe.play(),
          new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("카메라 영상이 준비되지 않았습니다. 다시 녹화하세요.")), 5000); }),
        ]);
      } finally {
        clearTimeout(timeout);
        probe.pause();
        probe.srcObject = null;
      }
    },
    stop() {
      clearInterval(timer);
      stream.getTracks().forEach(track => track.stop());
    }
  };
}

function timerText(milliseconds) {
  const seconds = Math.floor(milliseconds / 1000);
  return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
}

async function videoFrameStatus(blob) {
  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  const url = URL.createObjectURL(blob);
  let timeout;
  try {
    return await new Promise(resolve => {
      video.onloadeddata = () => resolve(video.videoWidth && video.videoHeight ? "ready" : "missing");
      video.onerror = () => resolve("unknown");
      timeout = setTimeout(() => resolve("unknown"), 3500);
      video.src = url;
    });
  } finally {
    clearTimeout(timeout);
    video.onloadeddata = video.onerror = null;
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}

async function prepareVp8Encoder(stream) {
  if (vp8EncoderReady) return;
  // The first encoder in a fresh Chrome process can accept input before it can emit a frame.
  // Prime with video alone so startup never adds microphone audio to the actual clip.
  const mimeType = "video/webm;codecs=vp8";
  if (!MediaRecorder.isTypeSupported(mimeType)) return;
  const probe = new MediaRecorder(stream, {mimeType, videoBitsPerSecond: 2000000});
  const chunks = [];
  let inspecting = false;
  let timeout;
  const stop = () => { if (probe.state === "recording") probe.stop(); };
  try {
    await new Promise(resolve => {
      probe.onstop = resolve;
      probe.ondataavailable = async event => {
        if (!event.data.size || probe.state !== "recording") return;
        chunks.push(event.data);
        if (inspecting) return;
        inspecting = true;
        const frames = await videoFrameStatus(new Blob(chunks, {type: mimeType}));
        inspecting = false;
        if (frames === "ready") {
          vp8EncoderReady = true;
          stop();
        }
      };
      probe.start(150);
      timeout = setTimeout(stop, 5000);
    });
  } finally {
    clearTimeout(timeout);
    probe.ondataavailable = probe.onstop = null;
  }
}

const cameraIcons = {
  flash: '<path d="m14 2-10 12h7l-1 8 10-13h-7z"/><path class="flash-slash" d="m3 3 18 18"/>',
  settings: '<path d="m10.2 2-.6 2.3-1.6.9-2.3-.6-1.8 3 1.7 1.7v2l-1.7 1.7 1.8 3 2.3-.6 1.6.9.6 2.3h3.6l.6-2.3 1.6-.9 2.3.6 1.8-3-1.7-1.7v-2l1.7-1.7-1.8-3-2.3.6-1.6-.9-.6-2.3z" transform="translate(0 1.5)"/><circle cx="12" cy="12" r="3"/>',
  done: '<path d="m4 12 5.4 5.4L20 6.8"/>',
  close: '<path d="m6 6 12 12m0-12L6 18"/>',
};
function cameraIcon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${cameraIcons[name]}</svg>`;
}

export async function openCamera({onCapture, onClose, onNotice}) {
  if (activeCamera) return;
  const dialog = document.createElement("dialog");
  activeCamera = dialog;
  dialog.className = "capture-dialog";
  dialog.setAttribute("aria-label", "카메라");
  dialog.innerHTML = `
    <div class="capture-stage">
      <div class="capture-frame" data-frame>
        <video data-preview muted autoplay playsinline></video>
        <div class="capture-zoom-dock">
          <div class="camera-popup zoom-popup" data-pane="zoom" id="camera-zoom" hidden>
            <label><span data-zoom-label>확대</span>
              <input type="range" data-zoom aria-label="확대 배율" min="1" max="4" step=".1" value="1">
            </label>
            <div data-presets class="zoom-presets" role="group" aria-label="확대 배율 선택"></div>
          </div>
          <button type="button" class="camera-tool zoom-tool" data-toggle="zoom" aria-label="확대 배율 1배" aria-expanded="false" aria-controls="camera-zoom"><span data-zoom-value>1×</span></button>
        </div>
      </div>
      <div class="capture-tools" role="group" aria-label="카메라 도구">
        <label class="camera-tool light-tool" data-light-icon="off">
          ${cameraIcon("flash")}<span data-light-mark aria-hidden="true"></span>
          <select data-light aria-label="촬영 조명"><option value="off">조명 미지원</option></select>
        </label>
        <button type="button" class="camera-tool ratio-tool" data-toggle="ratio" aria-controls="camera-ratios" aria-expanded="false" aria-label="촬영 비율 1:1" title="촬영 비율"><span data-ratio-value>1:1</span></button>
        <button type="button" class="camera-tool" data-toggle="originals" data-camera-settings aria-controls="camera-originals" aria-expanded="false" aria-label="카메라 설정" title="카메라 설정">
          ${cameraIcon("settings")}<span class="capture-badge" data-pending hidden></span>
        </button>
      </div>
      <div class="camera-popup ratio-popup" role="group" data-pane="ratio" id="camera-ratios" aria-label="촬영 비율 선택" hidden>
          <button type="button" data-ratio="1:1">1:1</button>
          <button type="button" data-ratio="3:4">3:4</button>
          <button type="button" data-ratio="9:16">9:16</button>
      </div>
      <section class="camera-popup originals-popup" data-pane="originals" data-phone-mode="off" id="camera-originals" aria-labelledby="camera-originals-title" hidden>
        <div class="originals-head"><h2 id="camera-originals-title">카메라 설정</h2>
          <button type="button" data-dismiss aria-label="카메라 설정 닫기">${cameraIcon("close")}</button>
        </div>
        <h3 id="camera-phone-save-title">내 폰에도 함께 저장</h3>
        <div class="phone-save-options" role="group" aria-labelledby="camera-phone-save-title">
          <button type="button" data-phone-off aria-pressed="true">앱에만 저장</button>
          <button type="button" data-gallery aria-pressed="false">폴더에도 저장</button>
          <button type="button" data-phone-download aria-pressed="false">다운로드로 추가 저장</button>
        </div>
        <p data-location role="status"></p>
        <button type="button" data-phone-reconnect hidden>폴더 권한 다시 허용</button>
        <p class="download-hint">갤러리용 폴더는 Pictures 또는 DCIM 안에서 선택하세요. 다운로드는 알림이 뜨거나 여러 파일의 저장 허용을 물을 수 있습니다.</p>
        <p data-phone-notice role="status" hidden></p>
        <h3>앱에 보관한 원본</h3>
        <p data-status></p>
        <div data-recovery></div>
      </section>
      <output data-time hidden aria-live="off"></output>
      <div class="camera-toast" data-toast role="status">카메라를 여는 중…</div>
    </div>
    <div class="capture-panel">
      <div class="capture-modes" aria-label="촬영 모드">
        <button type="button" data-photo aria-pressed="true">사진</button>
        <button type="button" data-video aria-pressed="false">영상</button>
      </div>
      <div class="capture-controls">
        <button type="button" class="camera-tool side-tool" data-review aria-label="이번 촬영 보기" aria-haspopup="dialog" disabled></button>
        <button type="button" data-shutter aria-label="사진 촬영"><i aria-hidden="true"></i></button>
        <button type="button" class="camera-tool side-tool" data-done aria-label="촬영 완료" title="촬영 완료">${cameraIcon("done")}<span class="capture-badge" data-count hidden></span></button>
      </div>
    </div>`;
  document.body.append(dialog);
  dialog.showModal();
  const find = name => dialog.querySelector(`[data-${name}]`);
  const preview = find("preview");
  const review = createCaptureReview(dialog);
  const orientation = matchMedia("(orientation: landscape)");
  const ratioButtons = Array.from(dialog.querySelectorAll("[data-ratio]"));
  const zoomControl = find("zoom");
  const lightControl = find("light");
  const toggles = Array.from(dialog.querySelectorAll("[data-toggle]"));
  const panes = Array.from(dialog.querySelectorAll("[data-pane]"));
  const toggleFor = name => toggles.find(button => button.dataset.toggle === name);
  let openPane = null;
  function showPane(name, focus = true) {
    const previous = openPane;
    openPane = name;
    for (const toggle of toggles) toggle.setAttribute("aria-expanded", String(toggle.dataset.toggle === name));
    for (const pane of panes) pane.hidden = pane.dataset.pane !== name;
    if (!focus) return;
    const pane = panes.find(item => item.dataset.pane === name);
    const next = pane?.querySelector('[aria-pressed="true"], input, [data-dismiss]') || toggleFor(previous);
    next?.focus({preventScroll: true});
  }
  for (const button of toggles) {
    button.onclick = () => {
      showPane(openPane === button.dataset.toggle ? null : button.dataset.toggle);
      if (openPane === "originals") void refreshRecovery().catch(() => status("보관한 원본을 읽지 못했습니다.", true));
    };
  }
  find("dismiss").onclick = () => showPane(null);
  dialog.addEventListener("pointerdown", event => {
    if (openPane && !event.target.closest("[data-pane], [data-toggle]")) showPane(null, false);
  });
  dialog.addEventListener("keydown", event => {
    if (event.key === "Escape" && openPane) {
      event.preventDefault();
      showPane(null);
    }
  });
  function status(text, announce = false) {
    find("status").textContent = text;
    find("toast").textContent = announce ? text : "";
  }
  let stream;
  let microphone;
  let recorder;
  let recordingTime;
  let recordingFrames;
  let recordingPoster;
  let savingFinishedVideo = false;
  let recordingFrame;
  let ratio = "1:1";
  let capabilities = {};
  let supportsTorch = false;
  let imageCapture;
  let photoLights = [];
  let light = "off";
  let hardwareZoom;
  let digitalZoom = 1;
  const captures = [];
  let draining = null;
  let saveError = "";
  let failedExposures = 0;
  let copyMode = "off";
  let storedFolder;
  let folder;
  let phoneCopyIssue = "";
  let busy = true;
  let mode = "photo";
  let saved = 0;
  let closed = false;
  let closing = false;

  function currentFrame() {
    if (recordingFrame) return recordingFrame;
    const [short, long] = ratios[ratio];
    return orientation.matches ? [long, short] : [short, long];
  }

  function updateFrame() {
    const [w, h] = currentFrame();
    find("frame").style.setProperty("--frame-ratio", String(w / h));
    find("frame").style.setProperty("--digital-zoom", digitalZoom);
    const value = Number(zoomControl.value);
    const display = Number(value.toFixed(2));
    find("zoom-value").textContent = display + "×";
    zoomControl.setAttribute("aria-valuetext", display + "배");
    toggleFor("zoom").setAttribute("aria-label", "확대 배율 " + display + "배");
    for (const preset of find("presets").children) {
      preset.setAttribute("aria-pressed", String(Number(preset.value) === display));
    }
    find("ratio-value").textContent = ratio;
    toggleFor("ratio").setAttribute("aria-label", "촬영 비율 " + ratio);
  }

  async function setCameraControls(changes) {
    const track = stream.getVideoTracks()[0];
    const settings = track.getSettings();
    const controls = {...changes};
    if (capabilities.focusMode?.includes("continuous")) controls.focusMode = "continuous";
    if (hardwareZoom && controls.zoom === undefined) controls.zoom = settings.zoom;
    if (supportsTorch && controls.torch === undefined) controls.torch = light === "torch";
    // Chromium applies image controls separately from stream size and facing mode.
    await track.applyConstraints({advanced: [controls]});
    return track.getSettings();
  }

  function setLightOptions() {
    const choices = [["off", "조명 끔"]];
    if (mode === "photo" && photoLights.includes("auto")) choices.push(["auto", "자동 플래시"]);
    if (mode === "photo" && photoLights.includes("flash")) choices.push(["flash", "촬영 플래시"]);
    if (supportsTorch) choices.push(["torch", "연속 조명"]);
    if (choices.length === 1) choices[0][1] = "조명 미지원";
    if (!choices.some(([value]) => value === light)) light = "off";
    lightControl.replaceChildren(...choices.map(([value, label]) => new Option(label, value)));
    lightControl.value = light;
    renderLight();
  }

  function renderLight() {
    lightControl.parentElement.dataset.lightIcon = light;
    lightControl.parentElement.title = lightControl.selectedOptions[0]?.textContent || "촬영 조명";
    find("light-mark").textContent = light === "auto" ? "A" : "";
  }

  async function configureCamera(track) {
    capabilities = track.getCapabilities?.() || {};
    supportsTorch = capabilities.torch === true || (Array.isArray(capabilities.torch) && capabilities.torch.includes(true));
    const settings = track.getSettings();
    hardwareZoom = capabilities.zoom?.max > capabilities.zoom?.min && Number.isFinite(settings.zoom);
    digitalZoom = 1;
    zoomControl.min = hardwareZoom ? capabilities.zoom.min : 1;
    zoomControl.max = hardwareZoom ? capabilities.zoom.max : 4;
    zoomControl.step = hardwareZoom ? (capabilities.zoom.step || .1) : .1;
    zoomControl.value = hardwareZoom ? settings.zoom : 1;
    find("zoom-label").textContent = hardwareZoom ? "확대" : "디지털 확대";
    const min = Number(zoomControl.min), max = Number(zoomControl.max);
    const presets = [min, 1, 2, 3, 10].filter((value, index, all) =>
      value >= min && value <= max && all.indexOf(value) === index);
    find("presets").replaceChildren(...presets.map(value => {
      const button = document.createElement("button");
      button.type = "button";
      button.value = value;
      button.textContent = Number(value.toFixed(2)) + "×";
      button.onclick = () => {
        zoomControl.value = value;
        zoomControl.oninput();
        zoomControl.onchange();
        showPane(null);
      };
      return button;
    }));
    light = settings.torch ? "torch" : "off";
    imageCapture = undefined;
    photoLights = [];
    if (typeof ImageCapture === "function") {
      try {
        imageCapture = new ImageCapture(track);
        photoLights = (await imageCapture.getPhotoCapabilities()).fillLightMode || [];
      } catch { /* Preview frames also work on cameras without still-photo controls. */ }
    }
    if (capabilities.focusMode?.includes("continuous") && settings.focusMode !== "continuous") {
      await setCameraControls({}).catch(() => {});
    }
    setLightOptions();
    updateFrame();
  }

  async function startPreview() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("카메라는 HTTPS 또는 localhost에서 열 수 있습니다.");
    const video = {facingMode: {ideal: "environment"}, width: {ideal: 1920}, height: {ideal: 1080}};
    const requestZoom = navigator.mediaDevices.getSupportedConstraints().zoom;
    let live;
    try {
      live = await navigator.mediaDevices.getUserMedia({video: requestZoom ? {...video, zoom: true} : video, audio: false});
    } catch (error) {
      if (closed || !requestZoom || !["NotAllowedError", "OverconstrainedError", "NotSupportedError"].includes(error.name)) throw error;
      live = await navigator.mediaDevices.getUserMedia({video, audio: false});
    }
    if (closed) {
      live.getTracks().forEach(track => track.stop());
      return;
    }
    stream = live;
    preview.srcObject = live;
    await preview.play();
    const track = live.getVideoTracks()[0];
    track.onended = () => {
      if (stream?.getVideoTracks()[0] !== track) return;
      if (recorder?.state === "recording") recorder.stop();
      else if (busy && mode === "video" && !closed) status("카메라 연결을 복구하고 있습니다.", true);
      else if (!closed) { status("카메라 연결이 끊겼습니다. 촬영 화면을 다시 열어 주세요.", true); update(); }
    };
    await configureCamera(track);
  }

  function update() {
    const recording = recorder?.state === "recording";
    const canAct = !closed && !closing && !busy;
    const available = canAct && stream?.getVideoTracks()[0]?.readyState === "live";
    // A running recorder can always be stopped. An interrupted video preview can be reopened on the next tap.
    const canRecord = canAct && mode === "video" && !!stream;
    find("shutter").disabled = recording ? !canAct : (!available && !canRecord) || !!saveError;
    find("photo").disabled = !available || recording || !!saveError;
    find("video").disabled = find("photo").disabled || typeof MediaRecorder !== "function" ||
      typeof HTMLCanvasElement.prototype.captureStream !== "function";
    for (const button of ratioButtons) {
      button.disabled = find("photo").disabled;
      button.setAttribute("aria-pressed", String(button.dataset.ratio === ratio));
    }
    zoomControl.disabled = !available || !!saveError;
    toggleFor("zoom").disabled = zoomControl.disabled;
    for (const preset of find("presets").children) preset.disabled = zoomControl.disabled;
    toggleFor("ratio").disabled = find("photo").disabled;
    lightControl.disabled = !available || !!saveError || lightControl.options.length <= 1;
    find("photo").setAttribute("aria-pressed", String(mode === "photo"));
    find("video").setAttribute("aria-pressed", String(mode === "video"));
    const changingDestination = closing || busy || recording;
    find("gallery").disabled = changingDestination || typeof window.showDirectoryPicker !== "function";
    find("phone-off").disabled = find("phone-download").disabled = find("phone-reconnect").disabled = changingDestination;
    review.setAvailable(!closing && !closed && !recording && (!busy || savingFinishedVideo));
    find("done").disabled = closing || (busy && !!stream);
    find("shutter").dataset.mode = recording ? "recording" : mode;
    find("shutter").setAttribute("aria-label", recording ? "녹화 정지" : mode === "photo" ? "사진 촬영" : "영상 녹화");
    const count = saved + captures.length;
    find("count").textContent = count;
    find("count").hidden = !count;
    const doneLabel = count ? `촬영 완료 · ${count}개 촬영` : "촬영 완료";
    find("done").setAttribute("title", doneLabel);
    find("done").setAttribute("aria-label", doneLabel);
    find("time").hidden = !recording;
  }

  async function refreshRecovery() {
    let count = 0;
    let firstName;
    try {
      const [total, first] = await Promise.all([
        galleryRequest("pending", "readonly", store => store.count()),
        galleryRequest("pending", "readonly", store => store.getAllKeys(null, 1)),
      ]);
      count = total;
      firstName = first[0];
    } catch (error) {
      if (!saveError) throw error;
    }
    if (closed) return;
    const slot = find("recovery");
    slot.replaceChildren();
    renderStorageSettings();
    if (saveError) {
      const retry = document.createElement("button");
      retry.textContent = captures[0]?.recorded || captures[0]?.originalOnly ? "원본 보관 재시도" : "기록 저장 재시도";
      retry.onclick = () => run(async () => {
        saveError = "";
        await drainCaptures();
        await refreshRecovery();
      });
      slot.append(retry);
    }
    if (!firstName) return;
    const retry = document.createElement("button");
    const details = document.createElement("p");
    details.textContent = `보관된 원본 ${count}개`;
    slot.append(details);
    retry.textContent = "원본 다운로드";
    retry.onclick = () => run(async () => {
      const file = await galleryRequest("pending", "readonly", store => store.get(firstName));
      if (file) requestDownload(file);
      status("다운로드 후 파일을 확인하고 아래 버튼을 누르세요.");
    });
    slot.append(retry);
    if (folder) {
      const copyArchive = document.createElement("button");
      copyArchive.textContent = `보관된 원본 ${count}개를 폴더로 복사`;
      copyArchive.onclick = () => run(async () => {
        const names = await galleryRequest("pending", "readonly", store => store.getAllKeys());
        for (const name of names) {
          const file = await galleryRequest("pending", "readonly", store => store.get(name));
          if (file) await writeOriginal(file, folder);
        }
        phoneCopyIssue = "";
        renderStorageSettings();
        status("보관된 원본을 폴더에 복사했습니다.");
      });
      slot.append(copyArchive);
    }
    {
      const confirm = document.createElement("button");
      confirm.textContent = "다운로드 확인 후 보관함에서 제거";
      confirm.title = firstName;
      const filename = document.createElement("small");
      filename.textContent = firstName;
      slot.append(filename);
      confirm.onclick = () => run(async () => {
        if (!window.confirm(`휴대폰에서 다음 원본 파일을 확인했나요?\n${firstName}`)) return;
        await galleryRequest("pending", "readwrite", store => store.delete(firstName));
        await refreshRecovery();
      });
      slot.append(confirm);
    }
  }

  function renderStorageSettings() {
    const hasPicker = typeof window.showDirectoryPicker === "function";
    find("phone-mode").dataset.phoneMode = copyMode;
    for (const [control, value] of [["phone-off", "off"], ["gallery", "folder"], ["phone-download", "download"]]) {
      find(control).setAttribute("aria-pressed", String(copyMode === value));
    }
    let location = "새 사진과 영상은 이 기기의 앱에 보관합니다.";
    if (copyMode === "download") location = "새 사진과 영상을 앱에 보관하고 다운로드도 요청합니다.";
    if (copyMode === "folder") location = folder ? `앱과 휴대폰 폴더 ‘${folder.name}’에 저장합니다.` :
      "폴더 권한이 필요합니다. 다시 연결할 때까지 새 파일은 앱에 보관합니다.";
    if (!hasPicker) location += " 이 브라우저에서는 폴더를 선택할 수 없습니다.";
    find("location").textContent = location;
    find("gallery").textContent = folder ? "저장 폴더 변경" : "폴더에도 저장";
    find("phone-reconnect").hidden = !(copyMode === "folder" && !folder && storedFolder?.requestPermission);
    find("phone-notice").textContent = phoneCopyIssue;
    find("phone-notice").hidden = !phoneCopyIssue;
    const attention = saveError || phoneCopyIssue || (copyMode === "folder" && !folder);
    find("pending").hidden = !attention;
    find("pending").textContent = "!";
    const label = attention ? "카메라 설정 · 저장 상태 확인" : "카메라 설정";
    toggleFor("originals").setAttribute("aria-label", label);
    toggleFor("originals").title = label;
  }

  async function archive(shot) {
    const {file, directory} = shot;
    let storageError;
    try {
      await galleryRequest("pending", "readwrite", store => store.put(file, file.name));
    } catch (error) {
      storageError = error;
    }
    if (!shot.extraAttempted && shot.copyMode !== "off") {
      shot.extraAttempted = true;
      try {
        if (shot.copyMode === "download") {
          requestDownload(file);
          shot.extraMessage = "다운로드를 요청했습니다.";
        } else if (directory) {
          await writeOriginal(file, directory);
          shot.extraMessage = "선택한 폴더에도 저장했습니다.";
        }
      } catch (error) {
        if (directory && folder === directory && ["NotAllowedError", "NotFoundError", "SecurityError"].includes(error.name)) folder = null;
        phoneCopyIssue = shot.copyMode === "folder" ? "폴더에 사본을 저장하지 못했습니다. 폴더를 다시 선택하거나 다운로드를 이용하세요." :
          "다운로드를 요청하지 못했습니다. 보관된 원본에서 다시 내려받을 수 있습니다.";
        renderStorageSettings();
      }
    }
    if (storageError) throw storageError;
    return shot.extraMessage || "원본은 앱에 보관했습니다.";
  }

  function keepOriginal(shot) {
    // A later shot can finish encoding while an earlier one is still saving.
    return archive(shot).then(message => ({message}), error => ({error}));
  }

  function enqueueCapture(blob, takenAt, poster, originalOnly = false) {
    const shot = {directory: folder, copyMode, recorded: false, originalOnly};
    const file = Promise.resolve(blob).then(result => captureName(result, takenAt));
    if (!originalOnly) review.add(file, poster);
    shot.ready = file.then(result => {
      shot.file = result;
      shot.backup = keepOriginal(shot);
    }).catch(error => { shot.error = error; });
    captures.push(shot);
    update();
    void drainCaptures();
  }

  function drainCaptures() {
    if (!draining && !saveError && captures.length) {
      draining = writeCaptures().finally(() => {
        draining = null;
        update();
        if (captures.length && !saveError) return drainCaptures();
      });
    }
    return draining;
  }

  async function writeCaptures() {
    let captureError = "";
    while (captures.length) {
      const shot = captures[0];
      await shot.ready;
      if (shot.error) {
        failedExposures++;
        captureError = shot.error.message || "사진을 만들지 못했습니다. 다시 촬영하세요.";
        status(captureError, true);
        captures.shift();
        continue;
      }
      try {
        if (!shot.recorded && !shot.originalOnly) {
          await onCapture(shot.file);
          shot.recorded = true;
        }
        shot.backup ??= keepOriginal(shot);
        const original = await shot.backup;
        if (original.error) {
          shot.backup = null;
          throw original.error;
        }
        captures.shift();
        if (shot.originalOnly) {
          failedExposures++;
          captureError = "영상 프레임이 없습니다. " + original.message + " 다시 촬영하세요.";
          status(captureError, true);
        } else {
          saved++;
          if (!captureError) status("기록 저장됨. " + original.message);
        }
      } catch {
        saveError = shot.recorded || shot.originalOnly ? "원본을 별도로 보관하지 못했습니다. 공간을 확인하고 재시도하세요." :
          "기록 저장에 실패했습니다. 공간을 확인하고 재시도하세요.";
        status(saveError, true);
        update();
        showPane("originals");
        break;
      }
    }
    if (openPane === "originals" || saveError) {
      await refreshRecovery().catch(() => status("원본 보관함을 읽지 못했습니다.", true));
    }
  }

  async function run(action) {
    if (busy || closed) return;
    busy = true;
    update();
    try {
      await action();
      return true;
    } catch (error) {
      status(error.message || "작업을 마치지 못했습니다.", true);
      await refreshRecovery().catch(() => {});
      return false;
    } finally {
      busy = false;
      update();
      if (recordingResult && recorder?.state === "inactive" && !closed) void run(finishRecording);
    }
  }

  let recordingResult;
  function releaseRecordingTracks() {
    recordingFrames?.stop();
    recordingFrames = undefined;
    microphone?.getTracks().forEach(track => track.stop());
    microphone = undefined;
    clearInterval(recordingTime);
  }

  async function reopenVideoPreview() {
    status("카메라 연결을 복구하고 있습니다.", true);
    const previousZoom = zoomControl.value;
    const previousTorch = light === "torch";
    try { await startPreview(); }
    catch { throw new Error("카메라를 다시 열지 못했습니다. 영상 녹화를 다시 눌러 주세요."); }
    if (!closed) {
      zoomControl.value = previousZoom;
      const changes = {};
      if (hardwareZoom) changes.zoom = Number(zoomControl.value);
      else digitalZoom = Number(zoomControl.value);
      if (previousTorch && supportsTorch) changes.torch = true;
      if (Object.keys(changes).length) {
        const settings = await setCameraControls(changes).catch(() => stream.getVideoTracks()[0].getSettings());
        if (hardwareZoom) zoomControl.value = settings.zoom;
        light = settings.torch ? "torch" : "off";
        setLightOptions();
      }
      updateFrame();
    }
  }

  async function prepareRecordingSource(mimeType) {
    // Acquiring the microphone or opening Downloads can end an older physical camera track.
    for (let attempt = 0; attempt < 2 && !closed; attempt++) {
      if (stream?.getVideoTracks()[0]?.readyState !== "live") await reopenVideoPreview();
      if (closed) break;
      const source = stream.getVideoTracks()[0];
      let signalLoss;
      const lost = new Promise(resolve => { signalLoss = () => resolve(false); });
      const frames = croppedRecording(preview, recordingFrame, () => digitalZoom, () => {
        signalLoss();
        if (recordingFrames === frames && recorder?.state === "recording") recorder.stop();
      });
      recordingFrames = frames;
      const warm = async () => {
        await frames.start();
        if (source.readyState !== "live") return false;
        if (mimeType?.includes("vp8") && !vp8EncoderReady) {
          status("녹화를 준비하고 있습니다.", true);
          await prepareVp8Encoder(frames.stream).catch(() => {});
        }
        return source.readyState === "live";
      };
      try {
        if (await Promise.race([warm(), lost]) && source.readyState === "live") return;
      } catch (error) {
        if (source.readyState === "live") throw error;
      }
      frames.stop();
      recordingFrames = undefined;
    }
    throw new Error("카메라 연결이 끊겼습니다. 영상 녹화를 다시 눌러 주세요.");
  }

  async function startRecording() {
    try {
      microphone = await navigator.mediaDevices.getUserMedia({audio: true});
    } catch {
      status("마이크를 사용할 수 없어 소리 없이 녹화합니다.");
    }
    if (closed) { microphone?.getTracks().forEach(track => track.stop()); return; }
    // Short MP4s on Chromium can flush before the first encoded video frame.
    const mimeType = (microphone
      ? ["video/webm;codecs=vp8,opus", "video/mp4;codecs=avc1,mp4a.40.2", "video/mp4;codecs=avc1,opus"]
      : ["video/webm;codecs=vp8", "video/mp4;codecs=avc1"])
      .concat("video/webm", "video/mp4").find(type => MediaRecorder.isTypeSupported(type));
    const chunks = [];
    let resolveStop;
    let rejectStop;
    recordingResult = new Promise((resolve, reject) => { resolveStop = resolve; rejectStop = reject; });
    // A camera may end its stream before the user taps stop.
    recordingResult.catch(() => {});
    try {
      recordingFrame = currentFrame();
      await prepareRecordingSource(mimeType);
      recordingPoster = recordingFrames.poster().catch(() => null);
      const media = new MediaStream([...recordingFrames.stream.getVideoTracks(), ...(microphone?.getAudioTracks() || [])]);
      recorder = new MediaRecorder(media, {...(mimeType ? {mimeType} : {}), videoBitsPerSecond: 2000000});
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      let recordingError;
      recorder.onerror = () => { recordingError = new Error("녹화가 중단되었습니다. 새로 녹화하세요."); };
      recorder.onstop = () => {
        releaseRecordingTracks();
        const result = new Blob(chunks, {type: recorder.mimeType || chunks[0]?.type});
        if (recordingError || !result.size) rejectStop(recordingError || new Error("저장할 영상이 없습니다. 다시 촬영하세요."));
        else resolveStop(result);
        if (!busy && !closed) void run(finishRecording);
      };
      recorder.start(250);
    } catch (error) {
      releaseRecordingTracks();
      recordingPoster = null;
      recordingFrame = null;
      updateFrame();
      recorder = null;
      recordingResult = null;
      throw error;
    }
    const start = Date.now();
    find("time").textContent = "0:00";
    recordingTime = setInterval(() => { find("time").textContent = timerText(Date.now() - start); }, 250);
    status(microphone ? "" : "마이크를 사용할 수 없어 소리 없이 녹화합니다.", !microphone);
  }

  async function finishRecording() {
    if (recorder?.state === "recording") recorder.stop();
    const poster = recordingPoster;
    let blob;
    try {
      blob = await recordingResult;
    } finally {
      recordingResult = null;
      recorder = null;
      recordingPoster = null;
      recordingFrame = null;
      updateFrame();
    }
    savingFinishedVideo = true;
    try {
      const frames = await videoFrameStatus(blob);
      enqueueCapture(blob, Date.now(), poster, frames === "missing");
      await drainCaptures();
      if (frames === "unknown" && !saveError) {
        status("기기에 저장했지만 재생을 확인하지 못했습니다. 촬영 목록에서 확인하세요.", true);
      }
    } finally {
      savingFinishedVideo = false;
    }
    if (!closed && stream?.getVideoTracks()[0]?.readyState !== "live") await startPreview();
  }

  const release = () => {
    if (recorder?.state === "recording") recorder.stop();
    stream?.getTracks().forEach(track => track.stop());
    releaseRecordingTracks();
  };
  const close = async () => {
    if (closed || closing || (busy && stream)) return;
    const discard = !!saveError;
    if (discard && !window.confirm("저장을 마치지 못한 촬영물이 있습니다. 재시도하지 않고 나갈까요?")) return;
    const failuresBeforeClosing = failedExposures;
    closing = true;
    update();
    try {
      if (recordingResult && !await run(finishRecording)) return;
      if (discard) {
        // Already accepted shots may still be encoding or writing their independent originals.
        await Promise.all(captures.map(async shot => { await shot.ready; await shot.backup; }));
      } else {
        if (captures.length) status("촬영한 자료를 저장 중입니다.", true);
        await drainCaptures();
        if (saveError || failedExposures !== failuresBeforeClosing) return;
      }
    } finally {
      closing = false;
      update();
    }
    closed = true;
    review.dispose();
    release();
    window.removeEventListener("pagehide", release);
    orientation.removeEventListener("change", updateFrame);
    dialog.close();
    dialog.remove();
    activeCamera = null;
    onClose?.();
  };
  function setMode(value) {
    mode = value;
    setLightOptions();
    update();
  }
  find("photo").onclick = () => setMode("photo");
  find("video").onclick = () => setMode("video");
  for (const button of ratioButtons) {
    button.onclick = () => { ratio = button.dataset.ratio; updateFrame(); update(); showPane(null); };
  }
  zoomControl.oninput = () => {
    if (!hardwareZoom) digitalZoom = Number(zoomControl.value);
    updateFrame();
  };
  zoomControl.onchange = () => {
    if (!hardwareZoom) { zoomControl.oninput(); return; }
    void run(async () => {
      try {
        const settings = await setCameraControls({zoom: Number(zoomControl.value)});
        zoomControl.value = settings.zoom;
      } catch {
        zoomControl.value = stream.getVideoTracks()[0].getSettings().zoom;
        throw new Error("이 카메라에서 배율을 변경하지 못했습니다.");
      } finally {
        updateFrame();
      }
    });
  };
  lightControl.onchange = () => {
    const next = lightControl.value;
    void run(async () => {
      try {
        if (light === "torch" || next === "torch") {
          const settings = await setCameraControls({torch: next === "torch"});
          if (typeof settings.torch === "boolean" && settings.torch !== (next === "torch")) throw new Error();
        }
        light = next;
        renderLight();
      } catch {
        lightControl.value = light;
        throw new Error("이 카메라에서 조명을 변경하지 못했습니다.");
      }
    });
  };
  function takePhoto() {
    const takenAt = Date.now();
    // Without a flash, photoBlob draws this moment's preview before its first await.
    const exposure = photoBlob(preview, currentFrame(), digitalZoom, imageCapture, light);
    enqueueCapture(exposure, takenAt);
    return exposure;
  }
  find("shutter").onclick = () => {
    if (mode === "video") return run(recordingResult ? finishRecording : startRecording);
    if (light === "flash" || light === "auto") {
      // The camera can deliver only one hardware flash exposure at a time.
      return run(() => takePhoto().catch(() => {}));
    }
    takePhoto();
  };
  async function changeCopyMode(next, writable = null) {
    await galleryRequest("settings", "readwrite", store => store.put(next, "phoneCopyMode"));
    copyMode = next;
    folder = writable;
    phoneCopyIssue = "";
    await refreshRecovery();
  }
  find("phone-off").onclick = () => run(() => changeCopyMode("off"));
  find("phone-download").onclick = () => run(() => changeCopyMode("download"));
  find("phone-reconnect").onclick = () => run(async () => {
    try {
      // Request while the button activation is still live; the handle was loaded at camera startup.
      if (await storedFolder.requestPermission(folderAccess) === "granted") {
        await changeCopyMode("folder", storedFolder);
        return;
      }
    } catch { /* The stored directory may have been moved or removed. */ }
    phoneCopyIssue = "폴더 권한을 얻지 못했습니다. 다른 폴더를 선택하거나 다운로드를 이용하세요.";
    renderStorageSettings();
  });
  find("gallery").onclick = () => run(async () => {
    try {
      const directory = await chooseOriginalFolder();
      storedFolder = directory;
      copyMode = "folder";
      folder = await writableFolder(directory);
      phoneCopyIssue = "";
      await refreshRecovery();
    } catch (error) {
      if (error.name !== "AbortError") {
        phoneCopyIssue = "폴더를 연결하지 못했습니다. 다른 폴더를 선택하거나 다운로드로 추가 저장할 수 있습니다.";
        renderStorageSettings();
      }
    }
  });
  find("done").onclick = close;
  dialog.oncancel = event => { event.preventDefault(); if (openPane) showPane(null); else void close(); };
  window.addEventListener("pagehide", release);
  orientation.addEventListener("change", updateFrame);
  updateFrame();
  update();
  try {
    const phoneSettings = await readPhoneCopySettings();
    copyMode = phoneSettings.mode;
    storedFolder = phoneSettings.directory;
    folder = phoneSettings.writable;
    await refreshRecovery();
    if (closed) return;
    await startPreview();
    status("");
  } catch (error) {
    const message = ({NotAllowedError: "브라우저에서 카메라 사용을 허용한 후 다시 열어 주세요.", NotFoundError: "사용할 카메라를 찾지 못했습니다.", NotReadableError: "다른 앱의 카메라 사용을 마친 후 다시 열어 주세요."})[error.name] || error.message;
    status(message, true);
    onNotice?.(message);
  } finally {
    busy = false;
    update();
  }
}
