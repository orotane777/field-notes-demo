const emptyIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="4"/><path d="m4 17 5-5 4 4 3-3 4 4"/><circle cx="15.8" cy="9" r="1.5"/></svg>';
const backIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m14 5-7 7 7 7"/></svg>';
const editIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 16-.8 4.8L8 20l12-12a2.8 2.8 0 0 0-4-4L4 16ZM14 6l4 4"/></svg>';

async function squareThumbnail(source, width, height) {
  const side = Math.min(width, height);
  if (!side) return null;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = Math.min(288, side);
  canvas.getContext("2d").drawImage(source, (width - side) / 2, (height - side) / 2, side, side,
    0, 0, canvas.width, canvas.height);
  try {
    return await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", .83));
  } finally {
    canvas.width = 0;
  }
}

async function photoThumbnail(file) {
  const bitmap = await createImageBitmap(file, {resizeWidth: 360, resizeQuality: "medium"});
  try {
    return await squareThumbnail(bitmap, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}

async function videoThumbnail(url) {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  let timeout;
  try {
    await new Promise((resolve, reject) => {
      video.onloadeddata = resolve;
      video.onerror = reject;
      timeout = setTimeout(reject, 4000);
      video.src = url;
    });
    return await squareThumbnail(video, video.videoWidth, video.videoHeight);
  } finally {
    clearTimeout(timeout);
    video.onerror = video.onloadeddata = null;
    video.removeAttribute("src");
    video.load();
  }
}

export function createCaptureReview(camera) {
  const trigger = camera.querySelector("[data-review]");
  trigger.innerHTML = emptyIcon;
  trigger.setAttribute("aria-haspopup", "dialog");
  const panel = document.createElement("dialog");
  panel.className = "capture-review";
  panel.setAttribute("aria-labelledby", "capture-review-title");
  panel.innerHTML = `
    <header class="review-header">
      <button type="button" data-review-back aria-label="카메라로 돌아가기">${backIcon}</button>
      <h2 id="capture-review-title">이번 촬영</h2>
      <span data-review-count></span>
      <button type="button" data-review-edit aria-label="사진에 표시" title="사진에 표시" hidden>${editIcon}</button>
    </header>
    <p class="review-notice" role="status" hidden></p>
    <div class="review-grid" data-review-grid></div>
    <div class="review-detail" data-review-detail hidden></div>`;
  camera.append(panel);
  const back = panel.querySelector("[data-review-back]");
  const edit = panel.querySelector("[data-review-edit]");
  const notice = panel.querySelector(".review-notice");
  const title = panel.querySelector("h2");
  const count = panel.querySelector("[data-review-count]");
  const grid = panel.querySelector("[data-review-grid]");
  const detail = panel.querySelector("[data-review-detail]");
  const items = [];
  const previewQueue = [];
  let sequence = 0, available = true, disposed = false, rendering = false, selected = null;

  function updateLabels() {
    edit.hidden = !selected?.saveEdit;
    trigger.disabled = !available || !items.length;
    trigger.setAttribute("aria-label", items.length ? `이번 촬영 ${items.length}개 보기` : "이번 촬영 없음");
    count.textContent = selected ? `${items.indexOf(selected) + 1} / ${items.length}` : `${items.length}개`;
  }
  function releaseDetail() {
    const video = detail.querySelector("video");
    if (video) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
    detail.replaceChildren();
  }
  function openDetail(item) {
    notice.hidden = true;
    selected = item;
    title.textContent = item.video ? "영상" : "사진";
    back.setAttribute("aria-label", "이번 촬영 목록으로");
    const media = document.createElement(item.video ? "video" : "img");
    if (item.video) {
      media.controls = true;
      media.playsInline = true;
    } else {
      media.alt = item.tile.getAttribute("aria-label");
    }
    media.src = item.url;
    detail.replaceChildren(media);
    grid.hidden = true;
    detail.hidden = false;
    updateLabels();
    back.focus({preventScroll: true});
  }
  function goBack() {
    notice.hidden = true;
    if (selected) {
      releaseDetail();
      grid.hidden = false;
      detail.hidden = true;
      title.textContent = "이번 촬영";
      back.setAttribute("aria-label", "카메라로 돌아가기");
      selected.tile.focus({preventScroll: true});
      selected = null;
      updateLabels();
    } else {
      panel.close();
      trigger.focus({preventScroll: true});
    }
  }
  back.onclick = goBack;
  edit.onclick = async () => {
    const item = selected;
    if (!item?.saveEdit || edit.disabled) return;
    edit.disabled = true;
    notice.hidden = true;
    try {
      const {openPhotoMarkup} = await import("./photo-markup.js");
      if (disposed || selected !== item) return;
      await openPhotoMarkup({
        parent: panel, source: item.source, marks: structuredClone(item.marks),
        onSave: async ({blob, marks}) => {
          const file = marks.length ? blob : item.source;
          const url = URL.createObjectURL(file);
          try {
            await item.saveEdit(file);
          } catch (error) {
            URL.revokeObjectURL(url);
            throw error;
          }
          if (disposed) { URL.revokeObjectURL(url); return; }
          const previousUrl = item.url;
          const previousThumbnail = item.thumbnail;
          item.url = url;
          item.thumbnail = null;
          item.content = file;
          item.marks = marks;
          if (selected === item) detail.querySelector("img").src = url;
          showImage(item.tile, url, false);
          if (item === items.at(-1)) showImage(trigger, url, false);
          URL.revokeObjectURL(previousUrl);
          if (previousThumbnail) URL.revokeObjectURL(previousThumbnail);
          previewQueue.push({item, file});
          void renderPreviews();
        }
      });
    } catch (error) {
      notice.textContent = error.message || "사진 표시 도구를 열 수 없습니다.";
      notice.hidden = false;
    } finally {
      edit.disabled = false;
      if (!disposed && selected === item) edit.focus({preventScroll: true});
    }
  };
  panel.oncancel = event => {
    if (event.target !== panel) return;
    event.preventDefault();
    event.stopPropagation();
    goBack();
  };
  panel.onkeydown = event => {
    if (event.key !== "Escape" || event.target.closest("dialog") !== panel || document.fullscreenElement) return;
    event.preventDefault();
    event.stopPropagation();
    goBack();
  };
  trigger.onclick = () => { if (!trigger.disabled && !panel.open) panel.showModal(); };

  function showImage(container, url, video) {
    const img = new Image();
    img.alt = "";
    img.decoding = "async";
    img.src = url;
    container.replaceChildren(img);
    if (video) {
      const play = document.createElement("span");
      play.className = "review-play";
      play.setAttribute("aria-hidden", "true");
      container.append(play);
    }
  }

  async function renderPreviews() {
    if (rendering) return;
    rendering = true;
    try {
      // Prefer the newest shot for the shutter-side thumbnail; decode just one image at a time.
      while (!disposed && previewQueue.length) {
        const {item, file, poster} = previewQueue.pop();
        if (file !== item.content) continue;
        let thumbnail;
        try {
          thumbnail = await poster || await (item.video ? videoThumbnail(item.url) : photoThumbnail(file));
        } catch { /* A failed thumbnail must leave the full capture available. */ }
        if (disposed) return;
        if (file !== item.content) continue;
        if (item.thumbnail) URL.revokeObjectURL(item.thumbnail);
        if (thumbnail) item.thumbnail = URL.createObjectURL(thumbnail);
        const url = item.thumbnail || (!item.video && item.url);
        if (url) {
          showImage(item.tile, url, item.video);
          if (item === items[items.length - 1]) showImage(trigger, url, item.video);
        }
      }
    } finally {
      rendering = false;
    }
  }

  function append(file, order, poster, saveEdit) {
    if (disposed || !file?.size) return;
    const tile = document.createElement("button");
    const video = file.type.startsWith("video/");
    const item = {order, tile, url: URL.createObjectURL(file), video, content: file,
      source: video ? null : file, marks: [], saveEdit: video ? null : saveEdit};
    tile.type = "button";
    tile.dataset.reviewItem = String(order);
    tile.value = String(order);
    tile.setAttribute("aria-label", `${order}번째 촬영, ${item.video ? "영상" : "사진"}`);
    tile.onclick = () => openDetail(item);
    if (item.video) tile.innerHTML = '<span class="review-play" aria-hidden="true"></span>';
    let index = items.length;
    while (index && items[index - 1].order > order) index--;
    const older = items[index - 1];
    items.splice(index, 0, item);
    grid.insertBefore(tile, older?.tile || null);
    if (index === items.length - 1 && item.video) trigger.replaceChildren(tile.firstChild.cloneNode(true));
    updateLabels();
    previewQueue.push({item, file, poster});
    void renderPreviews();
  }
  updateLabels();
  return {
    add(filePromise, poster, saveEdit) {
      const order = ++sequence;
      // Handle both promises immediately, including captures that fail before encoding finishes.
      const safePoster = Promise.resolve(poster).catch(() => null);
      Promise.resolve(filePromise).then(file => append(file, order, safePoster, saveEdit), () => {});
    },
    setAvailable(value) {
      if (available !== value) { available = value; updateLabels(); }
    },
    dispose() {
      disposed = true;
      if (panel.open) panel.close();
      releaseDetail();
      panel.remove();
      trigger.replaceChildren();
      for (const item of items) {
        URL.revokeObjectURL(item.url);
        if (item.thumbnail) URL.revokeObjectURL(item.thumbnail);
      }
      items.length = previewQueue.length = 0;
    },
  };
}
