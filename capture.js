import { storageKey } from "./runtime.js";

let galleryDatabase;
let activeCamera;

async function galleryRequest(storeName, mode, operation) {
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

async function photoBlob(preview) {
  const track = preview.srcObject.getVideoTracks()[0];
  if (typeof ImageCapture === "function") {
    try {
      return await new ImageCapture(track).takePhoto();
    } catch {
      // Some cameras expose ImageCapture but have no still-photo mode.
    }
  }
  if (!preview.videoWidth || !preview.videoHeight) throw new Error("카메라 미리보기를 기다려 주세요.");
  const canvas = document.createElement("canvas");
  canvas.width = preview.videoWidth;
  canvas.height = preview.videoHeight;
  canvas.getContext("2d").drawImage(preview, 0, 0);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", .94));
  if (!blob) throw new Error("사진을 만들지 못했습니다. 다시 촬영하세요.");
  return blob;
}

function timerText(milliseconds) {
  const seconds = Math.floor(milliseconds / 1000);
  return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
}

export async function openCamera({onCapture, onClose, onNotice}) {
  if (activeCamera) return;
  const dialog = document.createElement("dialog");
  activeCamera = dialog;
  dialog.className = "capture-dialog";
  dialog.setAttribute("aria-label", "현장 촬영");
  dialog.innerHTML = `
    <div class="capture-stage">
      <video data-preview muted autoplay playsinline></video>
      <header><strong>현장 촬영</strong><span data-count>0개 저장</span></header>
      <output data-time hidden></output>
    </div>
    <div class="capture-panel">
      <div class="capture-modes" aria-label="촬영 모드">
        <button type="button" data-photo aria-pressed="true">사진</button>
        <button type="button" data-video aria-pressed="false">영상</button>
      </div>
      <div class="capture-controls">
        <button type="button" data-gallery>원본 폴더</button>
        <button type="button" data-shutter aria-label="사진 촬영"><i></i></button>
        <button type="button" data-done>촬영 완료</button>
      </div>
      <p data-status role="status">카메라를 여는 중입니다.</p>
      <p data-location></p>
      <div data-recovery></div>
    </div>`;
  document.body.append(dialog);
  dialog.showModal();
  const find = name => dialog.querySelector(`[data-${name}]`);
  const preview = find("preview");
  const status = text => { find("status").textContent = text; };
  let stream;
  let microphone;
  let recorder;
  let recordingTime;
  let pendingSave = null;
  let folder;
  let busy = true;
  let mode = "photo";
  let saved = 0;
  let closed = false;

  async function startPreview() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("카메라는 HTTPS 또는 localhost에서 열 수 있습니다.");
    const live = await navigator.mediaDevices.getUserMedia({video: {facingMode: {ideal: "environment"}, width: {ideal: 1920}, height: {ideal: 1080}}, audio: false});
    if (closed) {
      live.getTracks().forEach(track => track.stop());
      return;
    }
    stream = live;
    preview.srcObject = live;
    await preview.play();
  }

  function update() {
    const recording = recorder?.state === "recording";
    const available = !closed && !busy && stream?.getVideoTracks()[0]?.readyState === "live";
    find("shutter").disabled = !available || !!pendingSave;
    find("photo").disabled = !available || recording || !!pendingSave;
    find("video").disabled = find("photo").disabled || typeof MediaRecorder !== "function";
    find("photo").setAttribute("aria-pressed", String(mode === "photo"));
    find("video").setAttribute("aria-pressed", String(mode === "video"));
    find("gallery").disabled = busy || recording;
    find("done").disabled = busy && !!stream;
    find("shutter").dataset.mode = recording ? "recording" : mode;
    find("shutter").setAttribute("aria-label", recording ? "녹화 정지" : mode === "photo" ? "사진 촬영" : "영상 녹화");
    find("count").textContent = saved + "개 저장";
    find("time").hidden = !recording;
  }

  async function refreshRecovery() {
    const names = await galleryRequest("pending", "readonly", store => store.getAllKeys());
    if (closed) return;
    const slot = find("recovery");
    slot.replaceChildren();
    if (pendingSave) {
      const retry = document.createElement("button");
      retry.textContent = "기록 저장 재시도";
      retry.onclick = () => run(() => saveFile(pendingSave));
      slot.append(retry);
    }
    if (!names.length) return;
    const retry = document.createElement("button");
    retry.textContent = folder ? `원본 ${names.length}개 폴더 저장 재시도` : `원본 다시 다운로드 (${names.length})`;
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
      confirm.textContent = "첫 번째 대기 파일 저장 확인";
      confirm.title = names[0];
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
      status(pendingSave ? "기록 저장에 실패했습니다. 공간을 확인하고 재시도하세요." : (error.message || "작업을 마치지 못했습니다."));
      await refreshRecovery().catch(() => {});
      return false;
    } finally {
      busy = false;
      update();
    }
  }

  let recordingResult;
  async function startRecording() {
    try {
      microphone = await navigator.mediaDevices.getUserMedia({audio: true});
    } catch {
      status("마이크를 사용할 수 없어 소리 없이 녹화합니다.");
    }
    if (closed) { microphone?.getTracks().forEach(track => track.stop()); return; }
    const media = new MediaStream([...stream.getVideoTracks(), ...(microphone?.getAudioTracks() || [])]);
    const mimeType = ["video/mp4", "video/webm;codecs=vp8,opus", "video/webm"].find(type => MediaRecorder.isTypeSupported(type));
    const chunks = [];
    let resolveStop;
    let rejectStop;
    recordingResult = new Promise((resolve, reject) => { resolveStop = resolve; rejectStop = reject; });
    // A camera may end its stream before the user taps stop.
    recordingResult.catch(() => {});
    try {
      recorder = new MediaRecorder(media, {...(mimeType ? {mimeType} : {}), videoBitsPerSecond: 2000000});
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      let recordingError;
      recorder.onerror = () => { recordingError = new Error("녹화가 중단되었습니다. 새로 녹화하세요."); };
      recorder.onstop = () => {
        microphone?.getTracks().forEach(track => track.stop());
        microphone = undefined;
        clearInterval(recordingTime);
        const result = new Blob(chunks, {type: recorder.mimeType || chunks[0]?.type});
        if (recordingError || !result.size) rejectStop(recordingError || new Error("저장할 영상이 없습니다."));
        else resolveStop(result);
        if (!busy && !closed) void run(finishRecording);
      };
      recorder.start(1000);
    } catch (error) {
      microphone?.getTracks().forEach(track => track.stop());
      microphone = undefined;
      recorder = null;
      recordingResult = null;
      throw error;
    }
    const start = Date.now();
    find("time").textContent = "0:00";
    recordingTime = setInterval(() => { find("time").textContent = timerText(Date.now() - start); }, 250);
    status(microphone ? "녹화 중입니다." : "무음 녹화 중입니다.");
  }

  async function finishRecording() {
    if (recorder?.state === "recording") recorder.stop();
    let blob;
    try {
      blob = await recordingResult;
    } finally {
      recordingResult = null;
      recorder = null;
    }
    await saveFile(captureName(blob));
    if (!closed && stream?.getVideoTracks()[0]?.readyState !== "live") await startPreview();
  }

  const release = () => {
    if (recorder?.state === "recording") recorder.stop();
    stream?.getTracks().forEach(track => track.stop());
    microphone?.getTracks().forEach(track => track.stop());
    clearInterval(recordingTime);
  };
  const close = async () => {
    if (closed || (busy && stream)) return;
    if (recordingResult && !await run(finishRecording)) return;
    if (pendingSave && !window.confirm("기록에 저장되지 않은 촬영물이 있습니다. 재시도하지 않고 나갈까요?")) return;
    closed = true;
    release();
    window.removeEventListener("pagehide", release);
    dialog.close();
    dialog.remove();
    activeCamera = null;
    onClose?.();
  };
  find("photo").onclick = () => { mode = "photo"; update(); };
  find("video").onclick = () => { mode = "video"; update(); };
  find("shutter").onclick = () => run(async () => {
    if (mode === "photo") return saveFile(captureName(await photoBlob(preview)));
    if (recordingResult) return finishRecording();
    return startRecording();
  });
  find("gallery").onclick = () => run(async () => {
    const message = await prepareGallery();
    folder = await currentFolder();
    find("location").textContent = folder ? `원본 폴더 · ${folder.name}` : "Pictures 또는 DCIM 안의 폴더를 연결하세요.";
    status(message);
    await refreshRecovery();
  });
  find("done").onclick = close;
  dialog.oncancel = event => { event.preventDefault(); void close(); };
  window.addEventListener("pagehide", release);
  update();
  try {
    folder = await currentFolder();
    find("location").textContent = folder ? `원본 폴더 · ${folder.name}` : "원본 자동 보관은 Pictures 또는 DCIM 안의 폴더를 연결하세요.";
    await refreshRecovery();
    if (closed) return;
    await startPreview();
    status("촬영할 준비가 되었습니다.");
  } catch (error) {
    const message = ({NotAllowedError: "브라우저에서 카메라 사용을 허용한 후 다시 열어 주세요.", NotFoundError: "사용할 카메라를 찾지 못했습니다.", NotReadableError: "다른 앱의 카메라 사용을 마친 후 다시 열어 주세요."})[error.name] || error.message;
    status(message);
    onNotice?.(message);
  } finally {
    busy = false;
    update();
  }
}
