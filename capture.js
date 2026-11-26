import { storageKey } from "./runtime.js";

let galleryDatabase;
let activeCamera;

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

async function currentFolder() {
  const directory = await galleryRequest("settings", "readonly", store => store.get("directory"));
  if (directory && await directory.queryPermission({mode: "readwrite"}) === "granted") return directory;
  return null;
}

export async function prepareGallery() {
  if (typeof window.showDirectoryPicker !== "function") {
    return "폴더 연결을 지원하지 않습니다. 촬영 후 원본 다운로드를 확인하세요.";
  }
  try {
    const directory = await window.showDirectoryPicker({id: "field-originals", mode: "readwrite", startIn: "pictures"});
    await galleryRequest("settings", "readwrite", store => store.put(directory, "directory"));
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

function captureName(blob) {
  const mime = blob.type.split(";")[0];
  const suffix = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "video/mp4": "mp4", "video/webm": "webm"}[mime];
  if (!suffix) throw new Error("이 기기의 촬영 형식을 저장할 수 없습니다.");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return new File([blob], `field-${stamp}-${crypto.randomUUID()}.${suffix}`, {type: mime});
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

async function photoBlob(preview, frame, zoom, imageCapture, light, photoLights) {
  const streamWidth = preview.videoWidth;
  const streamHeight = preview.videoHeight;
  if (!streamWidth || !streamHeight) throw new Error("카메라 미리보기를 기다려 주세요.");
  let bitmap;
  if (imageCapture && typeof createImageBitmap === "function") {
    const fill = light === "torch" ? "off" : light;
    try {
      const blob = await imageCapture.takePhoto(photoLights.includes(fill) ? {fillLightMode: fill} : {});
      bitmap = await createImageBitmap(blob);
    } catch {
      if (light === "flash" || light === "auto") throw new Error("플래시 촬영이 실패했습니다. 조명을 끄거나 다시 촬영하세요.");
    }
  }
  try {
    // Still images can include additional sensor area outside the video preview.
    const bounds = bitmap ? centerCrop(bitmap.width, bitmap.height, streamWidth / streamHeight)
      : {x: 0, y: 0, w: streamWidth, h: streamHeight};
    const canvas = framingCanvas(bounds.w, bounds.h, frame);
    drawFrame(canvas, bitmap || preview, bounds, zoom);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", .94));
    if (!blob) throw new Error("사진을 만들지 못했습니다. 다시 촬영하세요.");
    return blob;
  } finally {
    bitmap?.close();
  }
}

function croppedRecording(preview, frame, currentZoom) {
  const canvas = framingCanvas(preview.videoWidth, preview.videoHeight, frame);
  const manual = typeof window.CanvasCaptureMediaStreamTrack?.prototype.requestFrame === "function";
  const stream = canvas.captureStream(manual ? 0 : 30);
  const [track] = stream.getVideoTracks();
  let timer;
  function draw() {
    const bounds = {x: 0, y: 0, w: preview.videoWidth, h: preview.videoHeight};
    if (!bounds.w || !bounds.h) return;
    drawFrame(canvas, preview, bounds, currentZoom());
    if (manual) track.requestFrame();
  }
  return {
    stream,
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

const cameraIcons = {
  flash: '<path d="m14 2-10 12h7l-1 8 10-13h-7z"/><path class="flash-slash" d="m3 3 18 18"/>',
  archive: '<path d="M8 5H5l-2 9v5h18v-5l-2-9h-3"/><path d="M3 14h5l1.5 2h5l1.5-2h5M12 2v9m-3-3 3 3 3-3"/>',
  folder: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/><path d="M3.5 10h17"/>',
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
        <button type="button" class="camera-tool ratio-tool" data-toggle="ratio" aria-controls="camera-ratios" aria-expanded="false" aria-label="촬영 비율 3:4" title="촬영 비율"><span data-ratio-value>3:4</span></button>
        <button type="button" class="camera-tool" data-toggle="originals" aria-controls="camera-originals" aria-expanded="false" aria-label="원본 보관" title="원본 보관">
          ${cameraIcon("archive")}<span class="capture-badge" data-pending hidden></span>
        </button>
      </div>
      <div class="camera-popup ratio-popup" role="group" data-pane="ratio" id="camera-ratios" aria-label="촬영 비율 선택" hidden>
          <button type="button" data-ratio="1:1">1:1</button>
          <button type="button" data-ratio="3:4">3:4</button>
          <button type="button" data-ratio="9:16">9:16</button>
      </div>
      <section class="camera-popup originals-popup" data-pane="originals" id="camera-originals" aria-labelledby="camera-originals-title" hidden>
        <div class="originals-head"><h2 id="camera-originals-title">원본 보관</h2>
          <button type="button" data-dismiss aria-label="원본 보관 닫기">${cameraIcon("close")}</button>
        </div>
        <p data-location></p><p data-status></p>
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
        <button type="button" class="camera-tool side-tool" data-gallery aria-label="원본 폴더 연결" title="원본 폴더 연결">${cameraIcon("folder")}</button>
        <button type="button" data-shutter aria-label="사진 촬영"><i aria-hidden="true"></i></button>
        <button type="button" class="camera-tool side-tool" data-done aria-label="촬영 완료" title="촬영 완료">${cameraIcon("done")}<span class="capture-badge" data-count hidden></span></button>
      </div>
    </div>`;
  document.body.append(dialog);
  dialog.showModal();
  const find = name => dialog.querySelector(`[data-${name}]`);
  const preview = find("preview");
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
    button.onclick = () => showPane(openPane === button.dataset.toggle ? null : button.dataset.toggle);
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
  let recordingFrame;
  let ratio = "3:4";
  let capabilities = {};
  let supportsTorch = false;
  let imageCapture;
  let photoLights = [];
  let light = "off";
  let hardwareZoom;
  let digitalZoom = 1;
  let pendingSave = null;
  let folder;
  let busy = true;
  let mode = "photo";
  let saved = 0;
  let closed = false;

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
      if (recorder?.state === "recording") recorder.stop();
      else if (!closed) { status("카메라 연결이 끊겼습니다. 촬영 화면을 다시 열어 주세요.", true); update(); }
    };
    await configureCamera(track);
  }

  function update() {
    const recording = recorder?.state === "recording";
    const available = !closed && !busy && stream?.getVideoTracks()[0]?.readyState === "live";
    find("shutter").disabled = !available || !!pendingSave;
    find("photo").disabled = !available || recording || !!pendingSave;
    find("video").disabled = find("photo").disabled || typeof MediaRecorder !== "function" ||
      typeof HTMLCanvasElement.prototype.captureStream !== "function";
    for (const button of ratioButtons) {
      button.disabled = find("photo").disabled;
      button.setAttribute("aria-pressed", String(button.dataset.ratio === ratio));
    }
    zoomControl.disabled = !available || !!pendingSave;
    toggleFor("zoom").disabled = zoomControl.disabled;
    for (const preset of find("presets").children) preset.disabled = zoomControl.disabled;
    toggleFor("ratio").disabled = find("photo").disabled;
    lightControl.disabled = !available || !!pendingSave || lightControl.options.length <= 1;
    find("photo").setAttribute("aria-pressed", String(mode === "photo"));
    find("video").setAttribute("aria-pressed", String(mode === "video"));
    find("gallery").disabled = busy || recording;
    find("done").disabled = busy && !!stream;
    find("shutter").dataset.mode = recording ? "recording" : mode;
    find("shutter").setAttribute("aria-label", recording ? "녹화 정지" : mode === "photo" ? "사진 촬영" : "영상 녹화");
    find("count").textContent = saved;
    find("count").hidden = !saved;
    find("done").setAttribute("title", saved ? `촬영 완료 · ${saved}개 저장` : "촬영 완료");
    find("done").setAttribute("aria-label", saved ? `촬영 완료 · ${saved}개 저장` : "촬영 완료");
    find("time").hidden = !recording;
  }

  async function refreshRecovery() {
    const names = await galleryRequest("pending", "readonly", store => store.getAllKeys());
    if (closed) return;
    const slot = find("recovery");
    slot.replaceChildren();
    const badge = find("pending");
    badge.hidden = !pendingSave && !names.length;
    badge.textContent = pendingSave ? "!" : names.length;
    const notice = pendingSave ? " · 기록 저장 재시도 필요" : names.length ? ` · 원본 ${names.length}개 확인 필요` : "";
    toggleFor("originals").setAttribute("aria-label", "원본 보관" + notice);
    toggleFor("originals").title = "원본 보관" + notice;
    if (pendingSave) {
      const retry = document.createElement("button");
      retry.textContent = "기록 저장 재시도";
      retry.onclick = () => run(() => saveFile(pendingSave));
      slot.append(retry);
    }
    if (!names.length) return;
    const retry = document.createElement("button");
    const details = document.createElement("p");
    details.textContent = folder ? `폴더에 옮길 원본 ${names.length}개` : `휴대폰에 원본이 저장됐는지 확인하세요. 대기 ${names.length}개`;
    slot.append(details);
    retry.textContent = folder ? `원본 ${names.length}개 폴더 저장 재시도` : "다음 원본 다시 다운로드";
    retry.onclick = () => run(async () => {
      if (!folder) {
        const file = await galleryRequest("pending", "readonly", store => store.get(names[0]));
        if (file) requestDownload(file);
        status("다운로드 후 파일을 확인하고 아래 버튼을 누르세요.");
        return;
      }
      for (const name of names) {
        const file = await galleryRequest("pending", "readonly", store => store.get(name));
        if (!file) continue;
        await writeOriginal(file, folder);
        await galleryRequest("pending", "readwrite", store => store.delete(name));
      }
      status("대기 중인 원본을 폴더에 저장했습니다.");
      await refreshRecovery();
    });
    slot.append(retry);
    if (!folder) {
      const confirm = document.createElement("button");
      confirm.textContent = "이 파일 저장 확인";
      confirm.title = names[0];
      const filename = document.createElement("small");
      filename.textContent = names[0];
      slot.append(filename);
      confirm.onclick = () => run(async () => {
        if (!window.confirm(`휴대폰에서 다음 원본 파일을 확인했나요?\n${names[0]}`)) return;
        await galleryRequest("pending", "readwrite", store => store.delete(names[0]));
        await refreshRecovery();
      });
      slot.append(confirm);
    }
  }

  async function archive(file) {
    let queued = false;
    try {
      await galleryRequest("pending", "readwrite", store => store.put(file, file.name));
      queued = true;
    } catch { /* The shared folder may still have space when browser storage is full. */ }
    if (folder) {
      try {
        await writeOriginal(file, folder);
        if (queued) await galleryRequest("pending", "readwrite", store => store.delete(file.name));
        return "원본 폴더에 저장했습니다.";
      } catch {
        if (queued) return "원본 폴더 저장을 재시도하세요.";
      }
    }
    requestDownload(file);
    return "원본 다운로드를 요청했습니다. 갤러리에서 확인하세요.";
  }

  async function saveFile(file) {
    const retrying = pendingSave === file;
    pendingSave = file;
    status("기록을 폰에 저장 중입니다.");
    const [recordResult, originalResult] = await Promise.allSettled([
      onCapture(file),
      retrying ? Promise.resolve("") : archive(file)
    ]);
    if (recordResult.status === "rejected") throw recordResult.reason;
    pendingSave = null;
    saved++;
    status("기록 저장됨. " + (originalResult.status === "fulfilled" ? originalResult.value : "원본 다운로드를 확인하세요."));
    await refreshRecovery();
  }

  async function run(action) {
    if (busy || closed) return;
    busy = true;
    update();
    try {
      await action();
      return true;
    } catch (error) {
      status(pendingSave ? "기록 저장에 실패했습니다. 공간을 확인하고 재시도하세요." : (error.message || "작업을 마치지 못했습니다."), !pendingSave);
      await refreshRecovery().catch(() => {});
      if (pendingSave) showPane("originals");
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
  async function startRecording() {
    try {
      microphone = await navigator.mediaDevices.getUserMedia({audio: true});
    } catch {
      status("마이크를 사용할 수 없어 소리 없이 녹화합니다.");
    }
    if (closed) { microphone?.getTracks().forEach(track => track.stop()); return; }
    const mimeType = ["video/mp4", "video/webm;codecs=vp8,opus", "video/webm"].find(type => MediaRecorder.isTypeSupported(type));
    const chunks = [];
    let resolveStop;
    let rejectStop;
    recordingResult = new Promise((resolve, reject) => { resolveStop = resolve; rejectStop = reject; });
    // A camera may end its stream before the user taps stop.
    recordingResult.catch(() => {});
    try {
      recordingFrame = currentFrame();
      recordingFrames = croppedRecording(preview, recordingFrame, () => digitalZoom);
      await recordingFrames.start();
      const media = new MediaStream([...recordingFrames.stream.getVideoTracks(), ...(microphone?.getAudioTracks() || [])]);
      recorder = new MediaRecorder(media, {...(mimeType ? {mimeType} : {}), videoBitsPerSecond: 2000000});
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      let recordingError;
      recorder.onerror = () => { recordingError = new Error("녹화가 중단되었습니다. 새로 녹화하세요."); };
      recorder.onstop = () => {
        releaseRecordingTracks();
        const result = new Blob(chunks, {type: recorder.mimeType || chunks[0]?.type});
        if (recordingError || !result.size) rejectStop(recordingError || new Error("저장할 영상이 없습니다."));
        else resolveStop(result);
        if (!busy && !closed) void run(finishRecording);
      };
      recorder.start(1000);
    } catch (error) {
      releaseRecordingTracks();
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
    let blob;
    try {
      blob = await recordingResult;
    } finally {
      recordingResult = null;
      recorder = null;
      recordingFrame = null;
      updateFrame();
    }
    await saveFile(captureName(blob));
    if (!closed && stream?.getVideoTracks()[0]?.readyState !== "live") await startPreview();
  }

  const release = () => {
    if (recorder?.state === "recording") recorder.stop();
    stream?.getTracks().forEach(track => track.stop());
    releaseRecordingTracks();
  };
  const close = async () => {
    if (closed || (busy && stream)) return;
    if (recordingResult && !await run(finishRecording)) return;
    if (pendingSave && !window.confirm("기록에 저장되지 않은 촬영물이 있습니다. 재시도하지 않고 나갈까요?")) return;
    closed = true;
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
  find("shutter").onclick = () => run(async () => {
    if (mode === "photo") return saveFile(captureName(await photoBlob(preview, currentFrame(), digitalZoom, imageCapture, light, photoLights)));
    if (recordingResult) return finishRecording();
    return startRecording();
  });
  find("gallery").onclick = () => run(async () => {
    const message = await prepareGallery();
    folder = await currentFolder();
    find("location").textContent = folder ? `원본 폴더 · ${folder.name}` : "Pictures 또는 DCIM 안의 폴더를 연결하세요.";
    status(message);
    await refreshRecovery();
    if (!folder && !message.includes("취소")) showPane("originals");
  });
  find("done").onclick = close;
  dialog.oncancel = event => { event.preventDefault(); if (openPane) showPane(null); else void close(); };
  window.addEventListener("pagehide", release);
  orientation.addEventListener("change", updateFrame);
  updateFrame();
  update();
  try {
    folder = await currentFolder();
    find("location").textContent = folder ? `원본 폴더 · ${folder.name}` : "원본 자동 보관은 Pictures 또는 DCIM 안의 폴더를 연결하세요.";
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
