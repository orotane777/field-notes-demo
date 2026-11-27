import {
  newRecord,
  newEntry,
  ensureEntry,
  defaultTitle,
  getRecord,
  listRecords,
  updateRecord,
  addFiles,
  replacePhoto,
  getBlob,
  syncPending,
} from "./store.js";
import { openCamera, prepareGallery } from "./capture.js";
import { chooseAlbum, chooseMediaHandles, currentAlbum, forgetAlbum, openRecentAlbum, supportsAlbums } from "./gallery.js";
import { apiPath, installOfflineShell, staticSample, storageKey, viewerPath } from "./runtime.js";
import {
  el,
  button,
  dayOf,
  shortTime,
  longDate,
  dailyItems,
  datePicker,
  emptyState,
  recordRow,
  dialog,
  mediaTiles,
  pairingForm,
  mediaLabel,
} from "./shared.js";

const desktop = matchMedia("(min-width: 860px) and (pointer: fine)").matches;
if (desktop && !new URLSearchParams(location.search).has("mobile"))
  location.replace(viewerPath);
else
  start().catch((err) => {
    document.querySelector("#app").textContent =
      "기록 화면을 열 수 없습니다. " + err.message;
  });

async function start() {
  if (!window.isSecureContext)
    throw Error(
      "휴대폰에서는 신뢰된 HTTPS 주소로 접속해 주세요. PC 시험은 localhost를 사용할 수 있습니다.",
    );
  const app = document.querySelector("#app"),
    banner = document.querySelector("#banner"),
    nav = document.querySelector("#mobileNav");
  const connectionLabel = document.querySelector("#connectionLabel");
  connectionLabel.textContent = staticSample ? "샘플 · 이 브라우저에만 저장" : "기기 저장 모드";
  const savedLabel = staticSample ? "이 브라우저에 저장됨" : "폰에 저장됨";
  const urls = new Map();
  let page = "write",
    editor = null,
    day = dayOf(Date.now()),
    generation = 0,
    queue = Promise.resolve(),
    syncTimer,
    hideTimer,
    pickerActive = false;
  function notice(message, hold = false) {
    clearTimeout(hideTimer);
    banner.textContent = message;
    banner.hidden = !message;
    if (!hold && message)
      hideTimer = setTimeout(() => {
        banner.hidden = true;
      }, 6000);
  }
  function problem(err) {
    notice(
      err?.message || "작업을 마치지 못했습니다. 다시 시도해 주세요.",
      true,
    );
  }
  function onSync(s) {
    connectionLabel.textContent = ["offline", "error"].includes(s.state)
      ? "서버 연결 대기"
      : "서버 연결됨";
    if (s.state === "uploading")
      notice(
        "기록 " +
          s.pending +
          "건을 올리는 중입니다. 완료될 때까지 앱을 열어 두세요.",
        true,
      );
    if (s.state === "complete") notice("모든 기록을 올렸습니다.");
    if (s.state === "error")
      notice(
        "폰에 보관 중 · " + (s.message || "연결되면 다시 올립니다."),
        true,
      );
    if (s.state === "offline" && s.pending)
      notice("폰에 보관 중 · 전송 대기 " + s.pending + "건");
    if (
      s.state === "idle" &&
      !s.pending &&
      banner.textContent.includes("올리는 중")
    )
      notice("");
  }
  const synchronize = () => syncPending(onSync).catch(problem);
  function scheduleSync() {
    if (staticSample) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(synchronize, 1000);
  }
  function queued(action) {
    const operation = queue.then(action);
    queue = operation.catch(problem);
    return operation;
  }
  function remember(record) {
    try {
      const last = pref("field.last");
      if (last && last !== record.id) localStorage.setItem(storageKey("field.previous"), last);
      localStorage.setItem(storageKey("field.last"), record.id);
    } catch {}
  }
  function pref(key, fallback = "") {
    try {
      return localStorage.getItem(storageKey(key)) || fallback;
    } catch {
      return fallback;
    }
  }
  async function previousRecord(currentId) {
    for (const id of [pref("field.last"), pref("field.previous")]) {
      if (!id || id === currentId) continue;
      const record = await getRecord(id);
      if (record && !record.deletedAt) return record;
    }
    // Older installations only remembered one ID. Use the most recent remaining entry.
    let previous = null, latest = "";
    for (const record of await listRecords()) {
      if (record.id === currentId || record.deletedAt) continue;
      const stamp = record.entries.reduce((at, entry) => entry.at > at ? entry.at : at, record.recordedAt);
      if (stamp > latest) { previous = record; latest = stamp; }
    }
    return previous;
  }
  function releaseURLs() {
    for (const url of urls.values()) URL.revokeObjectURL(url);
    urls.clear();
  }
  async function loadImage(node, item) {
    try {
      let url = urls.get(item.id);
      if (!url) {
        const blob = await getBlob(item.id);
        if (!node.isConnected || !blob) return;
        url = urls.get(item.id);
        if (!url) {
          url = URL.createObjectURL(blob);
          urls.set(item.id, url);
        }
      }
      node.src = url;
    } catch (err) {
      problem(err);
    }
  }
  async function go(name, options = {}) {
    const token = ++generation;
    await queue;
    if (token !== generation) return;
    if (editor?.titleFailed) {
      notice("제목을 저장하지 못했습니다. 제목을 다시 확인해 주세요.", true);
      app.querySelector("[data-note-title]")?.focus();
      return;
    }
    if (editor?.unsaved) {
      notice(
        "저장하지 못한 메모가 있습니다. 다시 저장하거나 메모를 복사해 두세요.",
        true,
      );
      editor.retryBox.hidden = false;
      return;
    }
    page = name;
    editor = null;
    releaseURLs();
    app.replaceChildren();
    window.scrollTo(0, 0);
    for (const b of nav.querySelectorAll("button"))
      b.setAttribute(
        "aria-current",
        b.dataset.page === name ? "page" : "false",
      );
    if (name === "write") {
      let rec = options.record && await getRecord(options.record.id);
      if (
        !rec &&
        !options.fresh &&
        pref("field.start") === "resume" &&
        pref("field.last")
      )
        rec = await getRecord(pref("field.last"));
      if (token !== generation) return;
      const active = rec && !rec.deletedAt ? rec : newRecord();
      compose(active, !!(rec && !rec.deletedAt), options.editId);
    } else if (name === "settings") await settings(token);
    else await listings(name === "trash", token);
  }
  function submitAction(action) {
    return () => Promise.resolve().then(action).catch(problem);
  }
  function titleRow(kicker, title) {
    const head = el("header", "page-title");
    head.append(el("p", "eyebrow", kicker), el("h1", "", title));
    return head;
  }
  function commit(ctx, change) {
    return queued(async () => {
      const saved = await updateRecord(ctx.record.id, change, ctx.record);
      ctx.record = saved;
      remember(saved);
      scheduleSync();
      return saved;
    });
  }
  function compose(record, existing, editId) {
    const entry = editId
      ? record.entries.find((e) => e.id === editId)
      : existing
        ? newEntry()
        : record.entries[0];
    const ctx = {
      record,
      entry,
      started: !!editId,
      customMetadata: false,
      unsaved: false,
      titleFailed: false,
    };
    editor = ctx;
    const head = el("header", "note-heading");
    const heading = el("h1");
    const titleField = el("input", "note-title");
    titleField.type = "text";
    titleField.dataset.noteTitle = "";
    titleField.setAttribute("aria-label", "기록 제목");
    titleField.enterKeyHint = "done";
    titleField.value = record.title;
    let titleTarget = record.title;
    const recordTime = button("", () => editRecordTime(ctx, refreshHeading), "record-time");
    recordTime.dataset.recordTime = "";
    recordTime.title = "기록 일시 수정";
    function refreshHeading() {
      titleTarget = ctx.record.title;
      titleField.value = titleTarget;
      heading.setAttribute("aria-label", titleTarget);
      recordTime.textContent = longDate(ctx.record.recordedAt) + " · " + shortTime(ctx.record.recordedAt);
      recordTime.setAttribute("aria-label", "기록 일시 수정, " + recordTime.textContent);
    }
    refreshHeading();
    heading.append(titleField);
    head.append(recordTime, heading);
    app.append(head);
    function markStarted() {
      if (ctx.started) return;
      ctx.started = true;
      const now = new Date().toISOString();
      if (!existing && !ctx.customMetadata) {
        ctx.record.recordedAt = now;
        ctx.record.title = defaultTitle(now);
        refreshHeading();
      }
      entry.at = existing ? now : ctx.record.recordedAt;
    }
    async function saveTitle() {
      const typed = titleField.value.trim();
      const next = typed || defaultTitle(ctx.record.recordedAt);
      titleField.value = next;
      if (next === titleTarget && !ctx.titleFailed) return;
      markStarted();
      titleTarget = next;
      titleField.value = next;
      ctx.titleFailed = false;
      try {
        await commit(ctx, r => { r.title = next; });
        heading.setAttribute("aria-label", ctx.record.title);
      } catch {
        if (titleTarget === next) ctx.titleFailed = true;
      }
    }
    titleField.onchange = titleField.onblur = saveTitle;
    titleField.onkeydown = event => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") {
        if (ctx.titleFailed) { titleTarget = ctx.record.title; ctx.titleFailed = false; }
        titleField.value = titleTarget;
      } else if (event.key !== "Enter") return;
      event.preventDefault();
      titleField.blur();
    };
    let history;
    if (existing) {
      history = el("section", "panel history");
      history.setAttribute("aria-label", "이전 입력 내용");
      for (const [index, e] of record.entries.entries()) {
        if (e.id === editId) continue;
        const block = el("section", "entry");
        const top = el("div", "section-head");
        top.append(
          el(
            "span",
            "entry-time",
            index
              ? longDate(e.at) + " " + shortTime(e.at) + " 추가"
              : "처음 기록",
          ),
          button(
            "수정",
            () => go("write", { record: ctx.record, editId: e.id }),
            "text-btn",
          ),
        );
        block.append(top);
        if (e.text) block.append(el("p", "entry-text", e.text));
        if (e.media.length)
          block.append(
            mediaTiles(e.media, loadImage, (m) =>
              removeAttachment(ctx, e.id, m),
            ),
          );
        history.append(block);
      }
    }
    const panel = el("section", "panel compose");
    const bar = el("div", "section-head memo-tools");
    const tools = el("div", "note-actions");
    function iconButton(name, paths, action) {
      const btn = button("", submitAction(action), "note-tool");
      btn.title = name;
      btn.setAttribute("aria-label", name);
      btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + "</svg>";
      return btn;
    }
    const fresh = iconButton("새 기록", '<path d="M13 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h8M13 3v5h5l-5-5Zm5 5v3M18 14v7m-3.5-3.5h7"/>', () => go("write", {fresh: true}));
    fresh.dataset.newNote = "";
    let previousId;
    const previous = iconButton("직전 기록 이어쓰기", '<path d="M3 11a9 9 0 1 1 2 7M3 6v5h5m4-4v5l3 2"/>', async () => {
      let last = previousId && await getRecord(previousId);
      if (!last || last.deletedAt) last = await previousRecord(record.id);
      if (last) await go("write", {record: last});
      else previous.disabled = true;
    });
    previous.dataset.previousNote = "";
    previous.disabled = true;
    previousRecord(record.id).then(last => {
      previousId = last?.id;
      previous.disabled = !last;
    }).catch(problem);
    tools.append(previous, fresh);
    const state = el(
      "span",
      "save-state",
      record.revision ? savedLabel : "",
    );
    state.setAttribute("role", "status");
    bar.append(tools, state);
    const area = el("textarea", "memo");
    area.id = "memo";
    area.setAttribute("aria-label", editId ? "메모 수정" : existing ? "내용 덧붙이기" : "현장 메모");
    area.value = entry.text;
    area.placeholder = existing && !editId ? "덧붙일 내용을 기록하세요." : "지금 보고 들은 내용을 기록하세요.";
    const retryBox = el("div", "save-retry");
    ctx.retryBox = retryBox;
    retryBox.hidden = true;
    retryBox.append(button("메모 다시 저장", () => saveText(), "btn"));
    function saveText() {
      const value = area.value;
      if (!ctx.started && !value && !entry.text) return;
      markStarted();
      ctx.unsaved = true;
      state.textContent = "저장 중…";
      commit(ctx, (r) => {
        ensureEntry(r, entry).text = value;
      }).then(
        () => {
          if (area.value === value) {
            ctx.unsaved = false;
            retryBox.hidden = true;
            state.textContent = savedLabel;
          }
        },
        () => {
          if (area.value === value) {
            ctx.unsaved = true;
            retryBox.hidden = false;
            state.textContent = "저장 실패";
          }
        },
      );
    }
    area.oninput = saveText;
    const mediaBox = el("div", "current-media");
    const refreshMedia = () => {
      const items =
        ctx.record.entries.find((e) => e.id === entry.id)?.media || [];
      mediaBox.replaceChildren(
        mediaTiles(items, loadImage, (m) => removeAttachment(ctx, entry.id, m)),
      );
    };
    const add = async (files, { showThumbnails = true } = {}) => {
      if (!files.length) return;
      markStarted();
      state.textContent = "자료 저장 중…";
      try {
        const added = await queued(async () => {
          ctx.record = await addFiles(ctx.record, entry.id, files, entry);
          remember(ctx.record);
          return ctx.record.entries.find(item => item.id === entry.id).media.slice(-files.length);
        });
        state.textContent = savedLabel;
        if (showThumbnails) refreshMedia();
        scheduleSync();
        return added;
      } catch (err) {
        state.textContent = "자료 저장 실패";
        throw err;
      }
    };
    const file = el("input");
    file.type = "file";
    file.accept = "image/*,video/*";
    file.multiple = true;
    file.hidden = true;
    file.onchange = async () => {
      try {
        await add(Array.from(file.files));
      } catch (err) {
        problem(err);
      } finally {
        file.value = "";
        pickerActive = false;
      }
    };
    file.oncancel = () => {
      pickerActive = false;
    };
    const actions = el("div", "capture-actions");
    const camera = button(
      "촬영하기",
      submitAction(async () => {
        pickerActive = true;
        const openingRevision = ctx.record.revision;
        try {
          await openCamera({
            onCapture: async file => (await add([file], { showThumbnails: false }))[0],
            onEditPhoto: (previous, image) => queued(async () => {
              ctx.record = await replacePhoto(ctx.record.id, entry.id, previous.id, image);
              const url = urls.get(previous.id);
              if (url) {
                URL.revokeObjectURL(url);
                urls.delete(previous.id);
              }
              scheduleSync();
              return ctx.record.entries.find(item => item.id === entry.id).media
                .find(item => item.kind === "photo" && item.number === previous.number);
            }),
            onClose: () => {
              pickerActive = false;
              if (ctx.record.revision !== openingRevision) refreshMedia();
            },
            onNotice: notice,
          });
        } catch (err) {
          pickerActive = false;
          throw err;
        }
      }),
      "btn primary camera-btn",
    );
    camera.prepend(el("i", "camera-icon"));
    let useFileInput = false;
    async function openSystemPicker() {
      pickerActive = true;
      if (!useFileInput && typeof window.showOpenFilePicker === "function") {
        let handles;
        try {
          handles = await chooseMediaHandles();
        } catch (error) {
          if (error.name === "AbortError") {
            pickerActive = false;
            return;
          }
          useFileInput = true;
          if (navigator.userActivation?.isActive === false) {
            pickerActive = false;
            notice("갤러리를 다시 눌러 사진과 영상을 선택하세요.");
            return;
          }
        }
        if (handles) {
          try {
            await add(await Promise.all(handles.map(handle => handle.getFile())));
          } catch (error) {
            problem(error);
          } finally {
            pickerActive = false;
          }
          return;
        }
      }
      try {
        if (file.showPicker) file.showPicker();
        else file.click();
      } catch (error) {
        pickerActive = false;
        problem(error);
      }
    }
    const gallery = button("갤러리", () => {
      if (!supportsAlbums() || pref("field.gallery.start") !== "album") return openSystemPicker();
      pickerActive = true;
      openRecentAlbum(add, openSystemPicker).then((result) => {
        if (result !== "system") pickerActive = false;
      }).catch((error) => {
        pickerActive = false;
        problem(error);
      });
    }, "btn gallery-btn");
    gallery.dataset.openGallery = "";
    gallery.dataset.galleryPicker = "";
    gallery.prepend(el("i", "gallery-icon"));
    actions.append(camera, gallery);
    panel.append(bar, area, retryBox, mediaBox, actions, file);
    app.append(panel);
    refreshMedia();
    if (history?.childElementCount) app.append(history);
    if (editId)
      app.append(
        button(
          "수정 마치기",
          submitAction(async () => {
            await queue;
            await go("write", { record: ctx.record });
          }),
          "btn",
        ),
      );
    if (existing) {
      const more = el("div", "record-tools");
      more.append(
        button("휴지통으로 이동", () => trashRecord(ctx), "text-btn danger"),
      );
      app.append(more);
    }
    if (!existing && !matchMedia("(pointer: coarse)").matches)
      area.focus({ preventScroll: true });
  }
  function trashRecord(ctx) {
    const { d, body } = dialog("기록을 휴지통으로 옮길까요?");
    body.append(
      el("p", "hint", "촬영 원본과 갤러리에서 가져온 파일은 그대로 보관됩니다."),
      button(
        "휴지통으로 이동",
        submitAction(async () => {
          await commit(ctx, (r) => {
            r.deletedAt = new Date().toISOString();
          });
          d.close();
          await go("list");
        }),
        "btn danger",
      ),
    );
  }
  function removeAttachment(ctx, entryId, m) {
    const { d, body } = dialog(mediaLabel(m) + "을 기록에서 뺄까요?");
    body.append(
      el("p", "hint", "촬영 원본과 갤러리에서 가져온 파일은 그대로 보관됩니다."),
      button(
        "기록에서 빼기",
        submitAction(async () => {
          await commit(ctx, (r) => {
            const e = r.entries.find((i) => i.id === entryId);
            e.media = e.media.filter((item) => item.id !== m.id);
          });
          d.close();
          await go("write", { record: ctx.record });
        }),
        "btn",
      ),
    );
  }
  function editRecordTime(ctx, refreshHeading) {
    const { d, body } = dialog("기록 일시 수정");
    const date = el("input", "field");
    date.type = "datetime-local";
    date.step = "1";
    date.required = true;
    const dt = new Date(ctx.record.recordedAt);
    date.value =
      dayOf(dt) +
      "T" +
      [dt.getHours(), dt.getMinutes(), dt.getSeconds()]
        .map((v) => String(v).padStart(2, "0"))
        .join(":");
    date.setAttribute("aria-label", "기록 일시");
    body.append(
      date,
      button(
        "적용",
        submitAction(async () => {
          if (!date.reportValidity()) return;
          const stamp = new Date(date.value).toISOString();
          const change = (r) => {
            if (r.title === defaultTitle(r.recordedAt)) r.title = defaultTitle(stamp);
            if (r.entries[0]?.at === r.recordedAt) r.entries[0].at = stamp;
            r.recordedAt = stamp;
          };
          ctx.customMetadata = true;
          if (ctx.record.revision || ctx.started) await commit(ctx, change);
          else change(ctx.record);
          refreshHeading();
          d.close();
        }),
        "btn primary",
      ),
    );
  }
  async function listings(trash, token) {
    const records = await listRecords();
    if (token !== generation) return;
    app.append(
      titleRow(
        trash ? "기록 관리" : "날짜별 보기",
        trash ? "휴지통" : "기록 목록",
      ),
    );
    if (!trash)
      app.append(
        datePicker(day, (value) => {
          day = value;
          go("list");
        }),
      );
    const rows = el("div", "panel records");
    app.append(rows);
    if (trash) {
      const deleted = records
        .filter((r) => r.deletedAt)
        .sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
      if (!deleted.length) rows.append(emptyState("휴지통이 비어 있습니다."));
      for (const r of deleted) {
        const line = el("div", "trash-row");
        const info = el("div");
        info.append(
          el("strong", "", r.title),
          el("p", "hint", longDate(r.deletedAt) + " 삭제"),
        );
        line.append(
          info,
          button(
            "복구",
            submitAction(async () => {
              await updateRecord(r.id, (x) => {
                x.deletedAt = null;
              });
              scheduleSync();
              await go("trash");
              notice("기록을 복구했습니다.");
            }),
            "btn",
          ),
        );
        rows.append(line);
      }
    } else {
      const items = dailyItems(records, day);
      if (!items.length)
        rows.append(emptyState("이 날짜에 남긴 기록이 없습니다."));
      for (const item of items)
        rows.append(
          recordRow(
            item,
            () => go("write", { record: item.record }),
            loadImage,
          ),
        );
    }
  }
  async function settings(token) {
    app.append(titleRow("기기 환경", "설정"));
    const panel = el("section", "panel settings");
    app.append(panel);
    panel.append(el("h2", "", "다시 열 때 첫 화면"));
    const modes = el("div", "mode-group");
    for (const [v, label] of [
      ["new", "빈 메모"],
      ["resume", "직전 기록"],
    ]) {
      const radio = el("input");
      radio.type = "radio";
      radio.name = "startMode";
      radio.value = v;
      radio.checked = pref("field.start", "new") === v;
      radio.onchange = () => localStorage.setItem(storageKey("field.start"), v);
      const line = el("label");
      line.append(radio, document.createTextNode(label));
      modes.append(line);
    }
    panel.append(
      modes,
      el("h2", "", "촬영 원본"),
      el(
        "p",
        "hint",
        "촬영물은 메모에 자동 저장됩니다. 휴대폰에 파일도 남기려면 카메라 화면 상단의 설정에서 ‘내 폰에도 함께 저장’을 켜세요.",
      ),
      button(
        "원본 폴더 연결",
        submitAction(async () => notice(await prepareGallery())),
      ),
    );
    if (supportsAlbums()) {
      const albumName = el("p", "hint");
      const preference = el("label");
      const preferAlbum = el("input");
      preferAlbum.type = "checkbox";
      preferAlbum.dataset.preferAlbum = "";
      preferAlbum.onchange = () => localStorage.setItem(storageKey("field.gallery.start"), preferAlbum.checked ? "album" : "files");
      preference.append(preferAlbum, document.createTextNode(" 연결한 앨범부터 열기"));
      const connect = button("카메라 앨범 연결", submitAction(async () => {
        const folder = await chooseAlbum();
        if (folder) {
          localStorage.setItem(storageKey("field.gallery.start"), "album");
          displayAlbum(folder);
        }
      }));
      connect.dataset.linkAlbum = "";
      const disconnect = button("연결 해제", submitAction(async () => {
        await forgetAlbum();
        localStorage.removeItem(storageKey("field.gallery.start"));
        displayAlbum(null);
      }), "text-btn");
      function displayAlbum(folder) {
        albumName.textContent = folder
          ? folder.name + " · 읽기 전용"
          : "갤러리를 누르면 휴대폰의 파일 선택 화면이 열립니다. 특정 폴더를 최신순으로 보려면 앨범을 연결하세요.";
        connect.textContent = folder ? "다른 앨범 연결" : "카메라 앨범 연결";
        disconnect.hidden = !folder;
        preference.hidden = !folder;
        preferAlbum.checked = !!folder && pref("field.gallery.start") === "album";
      }
      panel.append(el("h2", "", "갤러리에서 볼 최근 앨범"), albumName, connect, preference, disconnect);
      displayAlbum(null);
      try {
        displayAlbum(await currentAlbum());
      } catch (error) {
        problem(error);
      }
      if (token !== generation) return;
    }
    const server = el("section", "panel settings");
    server.append(el("h2", "", staticSample ? "샘플 기록 보관" : "서버 연결"));
    app.append(server);
    const view = el("a", "text-btn", staticSample ? "이 브라우저의 기록 대시보드 열기" : "PC 조회 화면 열기");
    view.href = viewerPath;
    if (staticSample) {
      server.append(el("p", "hint", "메모와 첨부는 지금 쓰는 브라우저에만 저장됩니다. 입력 결과는 아래 대시보드에서 확인하세요. 다른 기기와는 동기화되지 않습니다."), view);
      return;
    }
    try {
      const res = await fetch(apiPath("status"), {
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
      });
      const s = await res.json();
      if (token !== generation) return;
      server.append(
        el(
          "p",
          "hint",
          (s.mode === "supabase"
            ? "Supabase 시험 서버"
            : s.mode === "local"
              ? "PC 로컬 시험 서버"
              : "오프라인 저장 전용") +
            " · " +
            (s.ready ? "연결됨" : "전송 대기"),
        ),
      );
      if (s.requiresPairing && !s.authenticated)
        server.append(
          pairingForm(() => {
            scheduleSync();
            go("settings");
          }),
        );
    } catch {
      server.append(
        el("p", "hint", "서버 연결 대기 · 휴대폰에 기록할 수 있습니다."),
      );
    }
    server.append(view);
  }
  nav.onclick = (event) => {
    const tab = event.target.closest("button[data-page]");
    if (!tab) return;
    if (tab.dataset.page === "list") day = dayOf(Date.now());
    go(tab.dataset.page).catch(problem);
  };
  addEventListener("online", scheduleSync);
  let background = false;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      background =
        page === "write" &&
        !pickerActive &&
        !document.querySelector("dialog[open]");
      return;
    }
    scheduleSync();
    if (background && page === "write" && !pickerActive) {
      background = false;
      go("write").catch(problem);
    }
  });
  await go("write");
  scheduleSync();
  installOfflineShell().catch(() =>
    notice("오프라인 재실행 준비에 실패했습니다. 연결을 확인해 주세요."),
  );
}
