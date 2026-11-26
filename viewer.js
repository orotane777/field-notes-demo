import {
  el,
  dayOf,
  shortTime,
  longDate,
  dailyItems,
  datePicker,
  emptyState,
  recordRow,
  mediaTiles,
  pairingForm,
} from "./shared.js";
import { apiPath, appPath, installOfflineShell, staticSample } from "./runtime.js";
import { getBlob, listRecords } from "./store.js";
let records = [],
  selected = null,
  day = dayOf(Date.now()),
  reading = false,
  lastSignature = null;
const byId = (id) => document.getElementById(id);
const mediaURLs = new Map();
function releaseMediaURLs() {
  for (const url of mediaURLs.values()) URL.revokeObjectURL(url);
  mediaURLs.clear();
}
async function mediaSource(node, media) {
  if (!staticSample) {
    node.src = apiPath("media/" + encodeURIComponent(media.id));
    return;
  }
  try {
    if (!mediaURLs.has(media.id)) {
      const file = await getBlob(media.id);
      if (!node.isConnected || !file) return;
      if (!mediaURLs.has(media.id)) mediaURLs.set(media.id, URL.createObjectURL(file));
    }
    node.src = mediaURLs.get(media.id);
  } catch {
    byId("connection").textContent = "이 브라우저에서 첨부를 열지 못했습니다.";
  }
}
function render() {
  if (staticSample && !document.querySelector("dialog[open]")) releaseMediaURLs();
  byId("dayLabel").textContent = longDate(day + "T12:00:00");
  byId("picker").replaceChildren(
    datePicker(day, (value) => {
      day = value;
      selected = null;
      render();
    }),
  );
  const items = dailyItems(records, day);
  if (!items.some((x) => x.record.id === selected))
    selected = items[0]?.record.id || null;
  byId("count").textContent = items.length + "건";
  const rows = byId("rows"),
    detail = byId("detail");
  rows.replaceChildren();
  detail.replaceChildren();
  if (!items.length) {
    rows.append(emptyState(staticSample ? "이 날짜에 저장한 기록이 없습니다." : "이 날짜에 올라온 기록이 없습니다."));
    detail.append(
      emptyState(
        "기록 상세",
        "선택한 기록의 메모와 촬영 자료가 여기에 표시됩니다.",
      ),
    );
    return;
  }
  for (const item of items) {
    const r = recordRow(
      item,
      () => {
        selected = item.record.id;
        render();
        if (innerWidth < 820) detail.scrollIntoView({ behavior: "smooth" });
      },
      mediaSource,
    );
    r.setAttribute("aria-pressed", String(item.record.id === selected));
    rows.append(r);
  }
  const record = records.find((x) => x.id === selected);
  const info = el("header", "detail-heading");
  info.append(
    el("p", "eyebrow", "기록 상세"),
    el("h2", "detail-title", record.title),
    el(
      "p",
      "hint",
      longDate(record.recordedAt) + " " + shortTime(record.recordedAt),
    ),
  );
  detail.append(info);
  for (const [index, entry] of record.entries.entries()) {
    const block = el("article", "entry");
    block.append(
      el(
        "span",
        "entry-time",
        index
          ? longDate(entry.at) + " " + shortTime(entry.at) + " 추가"
          : "처음 기록",
      ),
    );
    if (entry.text) block.append(el("p", "entry-text", entry.text));
    if (entry.media.length) block.append(mediaTiles(entry.media, mediaSource));
    detail.append(block);
  }
}
function showRecords(fresh) {
  const signature = JSON.stringify(fresh.map((r) => [r.id, r.revision]).sort());
  if (signature !== lastSignature) {
    records = fresh;
    lastSignature = signature;
    render();
  }
}
async function refresh() {
  if (reading) return;
  reading = true;
  try {
    if (staticSample) {
      showRecords(await listRecords());
      byId("connection").textContent = "샘플 체험판 · 기록은 이 브라우저에만 저장됩니다. 휴대폰과 PC 간에는 동기화되지 않습니다.";
      return;
    }
    const s = await fetch(apiPath("status"), {
      cache: "no-store",
      signal: AbortSignal.timeout(6000),
    }).then((r) => r.json());
    const connection = byId("connection"),
      pair = byId("pair");
    if (!s.ready) {
      records = [];
      lastSignature = null;
      render();
      connection.textContent =
        s.requiresPairing && !s.authenticated
          ? "서버를 조회하려면 이 기기를 연결하세요."
          : "서버 연결 대기 중";
      if (s.requiresPairing && !s.authenticated && !pair.firstChild)
        pair.append(pairingForm(refresh));
      return;
    }
    pair.replaceChildren();
    connection.textContent =
      s.mode === "local"
        ? "PC 로컬 시험 서버 연결됨"
        : "Supabase 시험 서버 연결됨";
    const response = await fetch(apiPath("records"), {
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw Error();
    showRecords(await response.json());
  } catch {
    byId("connection").textContent = staticSample
      ? "이 브라우저에 저장된 샘플을 열지 못했습니다. 브라우저의 사이트 데이터 저장 설정을 확인하세요."
      : "서버에 연결할 수 없습니다. 연결되면 다시 조회합니다.";
  } finally {
    reading = false;
  }
}
if (staticSample) {
  const compose = el("a", "btn primary", "현장 기록 입력하기");
  compose.href = appPath("?mobile");
  byId("picker").before(compose);
  installOfflineShell().catch(() =>
    byId("pair").replaceChildren(el("p", "hint", "오프라인 실행을 준비하지 못했습니다. 인터넷 연결 후 다시 열어 주세요.")),
  );
}
render();
refresh();
setInterval(() => {
  if (!document.hidden) refresh();
}, 8000);
addEventListener("focus", refresh);
