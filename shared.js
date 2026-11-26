import { apiPath } from "./runtime.js";

export function el(tag, className, value) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (value != null) element.textContent = value;
  return element;
}

export function button(label, action, className = "btn") {
  const item = el("button", className, label);
  item.type = "button";
  item.addEventListener("click", action);
  return item;
}

export const dayOf = (value) => {
  const date = new Date(value);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
};
export const shortTime = (value) =>
  new Date(value).toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
export const longDate = (value) =>
  new Date(value).toLocaleDateString("ko-KR", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
  });
export function dailyItems(records, day) {
  const items = [];
  for (const record of records) {
    if (record.deletedAt) continue;
    const original = dayOf(record.recordedAt) === day;
    const additions = record.entries
      .slice(1)
      .filter((e) => dayOf(e.at) === day);
    if (!original && !additions.length) continue;
    const at = additions.length
      ? additions
          .map((e) => e.at)
          .sort()
          .at(-1)
      : record.recordedAt;
    const entries = original ? [record.entries[0], ...additions] : additions;
    items.push({ record, original, at, entries });
  }
  return items.sort((a, b) => new Date(b.at) - new Date(a.at));
}

export function datePicker(day, change) {
  const row = el("div", "date-picker");
  const field = el("input");
  field.type = "date";
  field.value = day;
  field.setAttribute("aria-label", "조회 날짜");
  field.onchange = () => {
    if (field.value) change(field.value);
  };
  const offset = (step) => {
    const d = new Date(day + "T12:00:00");
    d.setDate(d.getDate() + step);
    change(dayOf(d));
  };
  const prev = button("‹", () => offset(-1), "step");
  prev.setAttribute("aria-label", "전날");
  const next = button("›", () => offset(1), "step");
  next.setAttribute("aria-label", "다음 날");
  row.append(
    prev,
    field,
    next,
    button("오늘", () => change(dayOf(Date.now())), "today-btn"),
  );
  return row;
}

export function emptyState(title, subtitle) {
  const box = el("div", "empty");
  const mark = el("span", "empty-icon");
  mark.setAttribute("aria-hidden", "true");
  box.append(mark, el("strong", "", title));
  if (subtitle) box.append(el("p", "", subtitle));
  return box;
}

export function mediaLabel(item) {
  return (item.kind === "video" ? "영상 " : "사진 ") + item.number;
}

export function recordRow(
  { record, original, at, entries },
  action,
  loadThumb,
) {
  const row = button("", action, "record-row");
  const body = el("span", "row-body");
  const meta = el("span", "row-meta");
  meta.append(
    el(
      "span",
      "chip" + (original ? "" : " added"),
      original
        ? "새 기록"
        : dayOf(at) === dayOf(Date.now())
          ? "오늘 추가"
          : "이날 추가",
    ),
    el("time", "time", shortTime(at)),
  );
  const preview = [...entries].reverse().find((e) => e.text.trim())?.text;
  body.append(meta, el("strong", "row-title", record.title));
  if (preview) body.append(el("span", "row-copy", preview));
  row.append(body);
  const photo = entries.flatMap((e) => e.media).find((m) => m.kind === "photo");
  if (photo && loadThumb) {
    const img = el("img", "thumb");
    img.alt = "";
    img.loading = "lazy";
    row.append(img);
    loadThumb(img, photo);
  }
  return row;
}

export function dialog(title) {
  const d = el("dialog", "sheet");
  const head = el("div", "section-head");
  head.append(
    el("h2", "", title),
    button("닫기", () => d.close(), "text-btn"),
  );
  const body = el("div", "sheet-body");
  d.append(head, body);
  document.body.append(d);
  d.addEventListener("close", () => d.remove(), { once: true });
  d.showModal();
  return { d, body };
}

export function mediaTiles(items, load, onRemove) {
  const grid = el("div", "media-grid");
  for (const media of items) {
    const tile = el("div", "media-tile");
    const launch = button(
      "",
      () => {
        const { d, body } = dialog(mediaLabel(media));
        const asset = el(
          media.kind === "video" ? "video" : "img",
          "full-media",
        );
        if (media.kind === "video") {
          asset.controls = true;
          asset.playsInline = true;
        } else asset.alt = mediaLabel(media);
        body.append(asset);
        load(asset, media);
        d.addEventListener("close", () => {
          if (asset.tagName === "VIDEO") asset.pause();
        });
      },
      "asset-button",
    );
    if (media.kind === "photo") {
      const img = el("img");
      img.alt = "";
      img.loading = "lazy";
      launch.append(img);
      load(img, media);
    } else launch.append(el("span", "play-icon", "▶"));
    launch.append(el("span", "asset-label", mediaLabel(media)));
    tile.append(launch);
    if (onRemove) {
      const remove = button("×", () => onRemove(media), "remove-asset");
      remove.setAttribute("aria-label", mediaLabel(media) + " 기록에서 빼기");
      tile.append(remove);
    }
    grid.append(tile);
  }
  return grid;
}

export async function pairDevice(code) {
  const result = await fetch(apiPath("pair"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!result.ok) throw Error("연결하지 못했습니다. 코드를 확인해 주세요.");
}

export function pairingForm(after) {
  const form = el("form", "pair-form");
  const label = el("label", "", "기기 연결 코드");
  const input = el("input", "field");
  input.type = "password";
  input.required = true;
  input.autocomplete = "off";
  label.append(input);
  const submit = el("button", "btn", "기기 연결");
  submit.type = "submit";
  const message = el("p", "hint");
  message.role = "status";
  form.append(label, submit, message);
  form.onsubmit = async (event) => {
    event.preventDefault();
    try {
      await pairDevice(input.value);
      input.value = "";
      await after();
    } catch (err) {
      message.textContent = err.message;
    }
  };
  return form;
}
