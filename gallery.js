import { galleryRequest } from "./capture.js";
import { button, dialog, el } from "./shared.js";
import { mediaType } from "./store.js";

const albumKey = "recent-read-only-album";
const pageSize = 18;
const fileNames = new Intl.Collator("ko", { numeric: true });

export const supportsAlbums = () => typeof window.showDirectoryPicker === "function";
const readAlbum = () =>
  galleryRequest("settings", "readonly", (store) => store.get(albumKey));
export const currentAlbum = async () => (await readAlbum())?.folder;
export const forgetAlbum = () =>
  galleryRequest("settings", "readwrite", (store) => store.delete(albumKey));

async function pickAlbum() {
  try {
    const folder = await window.showDirectoryPicker({
      id: "field-recent-album", mode: "read", startIn: "pictures",
    });
    const album = { id: crypto.randomUUID(), folder, recent: [] };
    await galleryRequest("settings", "readwrite", (store) => store.put(album, albumKey));
    return album;
  } catch (error) {
    if (error.name === "AbortError") return null;
    throw error;
  }
}

export const chooseAlbum = async () => (await pickAlbum())?.folder;

function rememberRecent(album, items) {
  return galleryRequest("settings", "readwrite", (store) => {
    const request = store.get(albumKey);
    request.onsuccess = () => {
      if (request.result?.id === album.id) {
        store.put({ ...album, recent: items.slice(0, pageSize).map((item) => item.handle) }, albumKey);
      }
    };
    return request;
  });
}

async function inspect(handle) {
  try {
    const file = await handle.getFile();
    const type = mediaType(file);
    return type ? { handle, file, video: type.startsWith("video/") } : null;
  } catch (error) {
    if (error.name !== "NotFoundError") throw error;
    return null;
  }
}

async function listMedia(folder, isOpen) {
  const items = [];
  let batch = [];
  async function flush() {
    items.push(...(await Promise.all(batch.map(inspect))).filter(Boolean));
    batch = [];
  }
  for await (const handle of folder.values()) {
    if (!isOpen()) return [];
    if (handle.kind !== "file" || handle.name.startsWith(".")) continue;
    batch.push(handle);
    if (batch.length === 12) await flush();
  }
  await flush();
  return items.sort((a, b) => b.file.lastModified - a.file.lastModified ||
    fileNames.compare(b.file.name, a.file.name));
}

export function openRecentAlbum(add, openSystemPicker) {
  const { d, body } = dialog("최근 사진·영상");
  d.classList.add("album-sheet");
  const info = el("p", "hint");
  const status = el("p", "album-status");
  status.setAttribute("role", "status");
  const link = button("카메라 앨범 연결", () => connect().catch(showError), "btn");
  link.dataset.linkAlbum = "";
  const grid = el("div", "album-grid");
  const paging = el("div", "album-paging");
  const previous = button("이전", () => renderPage(page - 1), "text-btn");
  const next = button("다음", () => renderPage(page + 1), "text-btn");
  const count = el("span", "hint");
  paging.append(previous, count, next);
  const footer = el("div", "album-footer");
  const system = button("다른 사진·영상 선택", () => {
    result = "system";
    d.close();
    openSystemPicker();
  }, "text-btn");
  system.dataset.systemPicker = "";
  const attach = button("선택 항목 추가", () => save().catch(showError), "btn primary");
  attach.dataset.albumAttach = "";
  footer.append(system, attach);
  body.append(info, link, status, grid, paging, footer);
  grid.hidden = paging.hidden = link.hidden = attach.hidden = true;
  const selected = new Map();
  const previews = [];
  let album, items = [], refreshed = null, page = 0, saving = false, result = "closed";
  function clearPreviews() {
    grid.replaceChildren();
    for (const url of previews) URL.revokeObjectURL(url);
    previews.length = 0;
  }
  function showError(error) {
    if (!d.open) return;
    status.textContent = error.name === "NotAllowedError"
      ? "앨범 읽기 권한이 필요합니다. 다시 연결하거나 다른 사진·영상을 선택하세요."
      : "앨범 작업을 마치지 못했습니다. " + error.message;
  }
  function updateSelection() {
    attach.disabled = !selected.size || saving;
    system.disabled = !!selected.size;
    attach.textContent = selected.size ? selected.size + "개 추가" : "선택 항목 추가";
    const order = new Map([...selected.keys()].map((name, index) => [name, index + 1]));
    for (const tile of grid.children) {
      const number = order.get(tile.dataset.albumItem);
      tile.setAttribute("aria-pressed", String(!!number));
      tile.querySelector(".album-order").textContent = number || "";
    }
  }
  function updatePaging() {
    const offset = page * pageSize;
    paging.hidden = items.length <= pageSize;
    previous.disabled = page === 0;
    next.disabled = offset + pageSize >= items.length;
    count.textContent = (offset + 1) + "–" + Math.min(offset + pageSize, items.length) + " / " + items.length;
  }
  function renderPage(index) {
    page = index;
    clearPreviews();
    const offset = page * pageSize;
    for (const { handle, file, video } of items.slice(offset, offset + pageSize)) {
      const tile = button("", () => {
        if (selected.has(file.name)) selected.delete(file.name);
        else selected.set(file.name, handle);
        if (!selected.size && refreshed) {
          items = refreshed;
          refreshed = null;
          renderPage(0);
        } else updateSelection();
      }, "album-tile");
      tile.dataset.albumItem = file.name;
      tile.setAttribute("aria-label", (video ? "영상 " : "사진 ") + file.name);
      const thumb = el(video ? "video" : "img");
      if (video) {
        thumb.muted = true;
        thumb.playsInline = true;
        thumb.preload = "metadata";
      } else {
        thumb.loading = "lazy";
        thumb.decoding = "async";
        thumb.alt = "";
      }
      const url = URL.createObjectURL(file);
      previews.push(url);
      thumb.src = url;
      thumb.onerror = () => { thumb.hidden = true; };
      tile.append(thumb, el("span", "album-order"), el("span", "album-name", file.name));
      if (video) tile.append(el("span", "album-video", "영상"));
      grid.append(tile);
    }
    grid.hidden = attach.hidden = !items.length;
    updatePaging();
    updateSelection();
    if (page > 0 || items.length > pageSize) body.scrollTop = 0;
  }
  async function display(granted = false) {
    if (!d.open) return;
    if (!album) {
      info.textContent = "DCIM 안의 Camera처럼 사진이 들어 있는 폴더를 한 번 연결하면, 다음부터 최신 파일이 먼저 보입니다.";
      link.hidden = false;
      return;
    }
    const { folder } = album;
    info.textContent = folder.name + " · 파일 수정일 최신순";
    if (!granted && await folder.queryPermission({ mode: "read" }) !== "granted") {
      link.textContent = "앨범 읽기 허용";
      link.hidden = false;
      return;
    }
    link.hidden = true;
    status.textContent = "사진과 영상을 찾는 중…";
    if (album.recent.length) {
      items = (await Promise.all(album.recent.map((handle) => inspect(handle).catch(() => null)))).filter(Boolean);
      if (!d.open) return;
      renderPage(0);
      status.textContent = "최근 변경 사항을 확인하는 중…";
    }
    const fresh = await listMedia(folder, () => d.open);
    if (!d.open) return;
    // A concurrent folder change must never attach this index to another album.
    await rememberRecent(album, fresh).catch(() => {});
    if (!d.open) return;
    status.textContent = fresh.length ? "" : "이 폴더에 사진이나 영상이 없습니다. 사진이 들어 있는 폴더를 연결하세요.";
    link.hidden = !!fresh.length;
    link.textContent = "다른 앨범 연결";
    const sameFirstPage = items.length && items.every((item, i) =>
      item.file.name === fresh[i]?.file.name && item.file.lastModified === fresh[i].file.lastModified);
    if (selected.size) {
      refreshed = fresh;
      const visible = new Set(items.map((item) => item.file.name));
      const fillPage = items.length < pageSize;
      items = items.concat(fresh.filter((item) => !visible.has(item.file.name)));
      if (fillPage) renderPage(0);
      else updatePaging();
    } else if (sameFirstPage) {
      items = fresh;
      updatePaging();
    } else {
      items = fresh;
      renderPage(0);
    }
  }
  async function connect() {
    link.disabled = true;
    try {
      if (album && link.textContent === "앨범 읽기 허용") {
        if (await album.folder.requestPermission({ mode: "read" }) === "granted") return await display(true);
        link.textContent = "다른 앨범 연결";
        status.textContent = "이 앨범의 읽기 권한을 받지 못했습니다.";
        return;
      }
      const chosen = await pickAlbum();
      if (chosen) {
        album = chosen;
        await display(true);
      }
    } finally {
      link.disabled = false;
    }
  }
  async function save() {
    if (saving || !selected.size) return;
    saving = true;
    const controls = [...d.querySelectorAll("button")].filter((control) => !control.disabled);
    controls.forEach((control) => { control.disabled = true; });
    status.textContent = "선택한 자료를 기록에 추가하는 중…";
    try {
      const files = await Promise.all([...selected.values()].map((handle) => handle.getFile()));
      await add(files);
      d.close();
    } finally {
      saving = false;
      controls.forEach((control) => { control.disabled = false; });
    }
  }
  d.addEventListener("cancel", (event) => { if (saving) event.preventDefault(); });
  const closed = new Promise((resolve) => d.addEventListener("close", () => {
    clearPreviews();
    resolve(result);
  }, { once: true }));
  readAlbum().then((stored) => {
    album = stored;
    return display();
  }).catch((error) => {
    link.hidden = false;
    link.textContent = "카메라 앨범 다시 연결";
    showError(error);
  });
  return closed;
}
