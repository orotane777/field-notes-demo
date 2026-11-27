import { apiPath, staticSample, storageKey } from "./runtime.js";

const DATABASE = storageKey("hse-field-journal");
const RECORDS = "records";
const FILES = "files";
const UPLOADS = "uploads";
let database;
let destination;
let requestedPersistence = false;

function openDatabase() {
  if (database) return database;
  database = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(RECORDS, { keyPath: "id" });
      request.result.createObjectStore(FILES);
      request.result.createObjectStore(UPLOADS);
    };
    request.onerror = () => {
      database = undefined;
      reject(request.error);
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        database = undefined;
      };
      resolve(db);
    };
  });
  return database;
}

function valueOf(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transaction(names, mode, work) {
  const db = await openDatabase();
  const options = mode === "readwrite" ? { durability: "strict" } : {};
  const tx = db.transaction(names, mode, options);
  const finished = new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error ?? new Error("휴대폰 저장이 중단됐습니다."));
  });
  try {
    const [result] = await Promise.all([Promise.resolve().then(() => work(tx)), finished]);
    return result;
  } catch (error) {
    try { tx.abort(); } catch { /* The request may already have aborted the transaction. */ }
    if (error.name === "QuotaExceededError") {
      throw new Error("휴대폰 저장 공간이 부족합니다. 공간을 확보한 뒤 다시 저장해 주세요.", { cause: error });
    }
    throw error;
  }
}

const pad = (value) => String(value).padStart(2, "0");

export function localDay(instant = new Date()) {
  const date = new Date(instant);
  return [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join("-");
}

export function defaultTitle(instant = new Date()) {
  const date = new Date(instant);
  const time = [date.getHours(), date.getMinutes(), date.getSeconds()].map(pad).join(":");
  return "현장기록 " + localDay(date) + " " + time;
}

export function newEntry(at = new Date().toISOString()) {
  return { id: crypto.randomUUID(), at, text: "", media: [] };
}

export function newRecord() {
  const recordedAt = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    recordedAt,
    title: defaultTitle(recordedAt),
    entries: [newEntry(recordedAt)],
    deletedAt: null,
    revision: 0,
    syncedRevision: 0,
    lastNumber: { photo: 0, video: 0 },
  };
}

export function ensureEntry(record, entry) {
  const saved = record.entries.find((item) => item.id === entry.id);
  if (saved) return saved;
  const copy = structuredClone(entry);
  record.entries.push(copy);
  return copy;
}

function mediaIn(record) {
  return record.entries.flatMap((entry) => entry.media);
}

function forDisplay(record) {
  if (record && destination) {
    record.syncedRevision = record.receipts?.["store:" + destination] ?? 0;
  }
  return record;
}

export async function getRecord(id) {
  const record = await transaction(RECORDS, "readonly", (tx) =>
    valueOf(tx.objectStore(RECORDS).get(id)));
  return forDisplay(record);
}

export async function listRecords() {
  const records = await transaction(RECORDS, "readonly", (tx) =>
    valueOf(tx.objectStore(RECORDS).getAll()));
  return records.map(forDisplay);
}

export function getBlob(id) {
  return transaction(FILES, "readonly", (tx) => valueOf(tx.objectStore(FILES).get(id)));
}

async function change(id, seed, mutate) {
  if (!requestedPersistence && navigator.storage?.persist) {
    requestedPersistence = true;
    navigator.storage.persist().catch(() => {});
  }
  const saved = await transaction([RECORDS, FILES], "readwrite", async (tx) => {
    const records = tx.objectStore(RECORDS);
    const files = tx.objectStore(FILES);
    const record = await valueOf(records.get(id)) ?? structuredClone(seed);
    if (!record || record.id !== id) throw new Error("기록을 찾을 수 없습니다.");
    const previous = mediaIn(record);
    const result = mutate(record, files);
    if (result && typeof result.then === "function") {
      throw new Error("저장할 변경 사항은 한 번에 적용해야 합니다.");
    }
    const remaining = new Set(mediaIn(record).map((item) => item.id));
    for (const item of previous) {
      if (!remaining.has(item.id)) files.delete(item.id);
    }
    record.revision += 1;
    records.put(record);
    return record;
  });
  return forDisplay(saved);
}

export function updateRecord(id, mutator, seed) {
  return change(id, seed, (record) => mutator(record));
}

const fileTypes = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
  gif: "image/gif", heic: "image/heic", heif: "image/heif", avif: "image/avif",
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", "3gp": "video/3gpp",
  webm: "video/webm", mkv: "video/x-matroska",
};

export function mediaType(file) {
  const extension = file.name?.split(".").pop().toLowerCase();
  const declared = file.type?.split(";")[0].trim().toLowerCase();
  const type = declared && declared !== "application/octet-stream" ? declared : fileTypes[extension];
  if (!file.size || !type || type === "image/svg+xml" || !/^(image|video)\/[a-z0-9][a-z0-9.+-]*$/.test(type)) return null;
  return type;
}

export function addFiles(record, entryId, files, entrySeed) {
  const additions = Array.from(files, (file) => {
    const type = mediaType(file);
    if (!type) throw new Error("내용이 있는 사진이나 영상 파일을 선택해 주세요.");
    return { file, type, kind: type.startsWith("video/") ? "video" : "photo" };
  });
  if (!additions.length) return Promise.resolve(record);
  return change(record.id, record, (current, blobs) => {
    const entry = current.entries.find((item) => item.id === entryId)
      ?? (entrySeed?.id === entryId ? ensureEntry(current, entrySeed) : null);
    if (!entry) throw new Error("첨부할 메모를 찾을 수 없습니다.");
    for (const { file, type, kind } of additions) {
      const id = crypto.randomUUID();
      const number = ++current.lastNumber[kind];
      entry.media.push({ id, kind, number, name: file.name || id, type });
      blobs.add(file.type === type ? file : file.slice(0, file.size, type), id);
    }
  });
}

export function replacePhoto(recordId, entryId, previousId, image) {
  const type = mediaType(image);
  if (!type?.startsWith("image/")) throw new Error("표시한 사진을 저장할 수 없습니다.");
  return change(recordId, undefined, (record, blobs) => {
    const entry = record.entries.find(item => item.id === entryId);
    const index = entry?.media.findIndex(item => item.id === previousId && item.kind === "photo") ?? -1;
    if (record.deletedAt || index < 0) throw new Error("사진이 삭제되었거나 다른 곳에서 변경되었습니다.");
    // Upload receipts refer to immutable file IDs. Keep the photo's position and number when its bytes change.
    const id = crypto.randomUUID();
    entry.media[index] = {...entry.media[index], id, type};
    blobs.add(image.type === type ? image : image.slice(0, image.size, type), id);
  });
}

async function send(url, options = {}) {
  const { timeout = 30000, ...request } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...request, cache: "no-store", credentials: "same-origin",
      redirect: "error", signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function hasReceipt(storeId, fileId) {
  return transaction(UPLOADS, "readonly", (tx) =>
    valueOf(tx.objectStore(UPLOADS).get([storeId, fileId])));
}

async function acceptSnapshot(record, storeId) {
  await transaction(RECORDS, "readwrite", async (tx) => {
    const records = tx.objectStore(RECORDS);
    const latest = await valueOf(records.get(record.id));
    if (!latest) return;
    const key = "store:" + storeId;
    latest.receipts ??= {};
    latest.syncedRevision = Math.max(latest.receipts[key] ?? 0, record.revision);
    latest.receipts[key] = latest.syncedRevision;
    records.put(latest);
  });
}

async function uploadRecord(record, storeId) {
  for (const media of mediaIn(record)) {
    if (await hasReceipt(storeId, media.id)) continue;
    const blob = await getBlob(media.id);
    if (!blob) {
      if ((await getRecord(record.id))?.revision !== record.revision) return;
      throw new Error("휴대폰에서 첨부 원본을 찾을 수 없습니다.");
    }
    const response = await send(apiPath("media/" + media.id), {
      method: "POST", headers: { "Content-Type": media.type, "X-Field-Store": storeId },
      body: blob, timeout: 600000,
    });
    if (!response.ok) throw new Error("첨부 전송을 완료하지 못했습니다 (" + response.status + ").");
    await transaction(UPLOADS, "readwrite", (tx) =>
      valueOf(tx.objectStore(UPLOADS).put(true, [storeId, media.id])));
  }
  if ((await getRecord(record.id))?.revision !== record.revision) return;
  const { id, revision, recordedAt, title, entries, deletedAt } = record;
  const response = await send(apiPath("records/" + id), {
    method: "PUT", headers: { "Content-Type": "application/json", "X-Field-Store": storeId },
    body: JSON.stringify({ id, revision, recordedAt, title, entries, deletedAt }),
  });
  if (response.status === 409) {
    if ((await getRecord(id))?.revision !== revision) return;
    throw new Error("서버 기록과 변경 내역이 다릅니다. 휴대폰 기록은 보관했습니다.");
  }
  if (!response.ok) throw new Error("기록 전송을 완료하지 못했습니다 (" + response.status + ").");
  const receipt = await response.json();
  if (receipt.id !== id || receipt.revision !== revision) {
    throw new Error("서버에서 해당 기록의 저장을 확인하지 못했습니다.");
  }
  await acceptSnapshot(record, storeId);
}

async function synchronize(notify) {
  let records = await listRecords();
  let pending = records.filter((item) => item.revision > item.syncedRevision).length;
  let status;
  try {
    const probe = await send(apiPath("status"), { timeout: 6000 });
    if (probe.ok) status = await probe.json();
  } catch {
    // Until the same-origin gateway confirms this network, no record leaves the phone.
  }
  if (!status?.ready || typeof status.storeId !== "string" || !status.storeId) {
    return { state: "offline", pending, message: status?.message };
  }
  destination = status.storeId;
  const failures = new Map();
  let sent = 0;
  for (;;) {
    records = await listRecords();
    const dirty = records.filter((record) => record.revision > record.syncedRevision);
    pending = dirty.length;
    const candidates = dirty.filter((record) => !failures.has(record.id));
    if (!candidates.length) break;
    notify({ state: "uploading", pending });
    for (const record of candidates) {
      try {
        await uploadRecord(record, status.storeId);
        sent += 1;
      } catch (error) {
        failures.set(record.id, error.message);
      }
    }
  }
  if (failures.size && pending) {
    return { state: "error", pending, message: failures.values().next().value };
  }
  return { state: sent ? "complete" : "idle", pending };
}

let syncInProgress;
let checkAgain = false;
const listeners = new Set();

function report(status) {
  for (const fn of listeners) fn(status);
  return status;
}

export async function syncPending(onStatus) {
  if (staticSample) {
    const status = { state: "local", pending: 0 };
    onStatus?.(status);
    return status;
  }
  if (onStatus) listeners.add(onStatus);
  if (syncInProgress) {
    checkAgain = true;
    return syncInProgress;
  }
  const run = async () => {
    let status;
    do {
      checkAgain = false;
      status = await synchronize(report);
    } while (checkAgain && status.state !== "offline" && status.state !== "error");
    return report(status);
  };
  const locks = navigator.locks;
  syncInProgress = (locks ? locks.request(storageKey("hse-field-journal-sync"), run) : run())
    .finally(() => {
      syncInProgress = undefined;
      listeners.clear();
    });
  return syncInProgress;
}
