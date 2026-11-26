import { staticSample } from "./deployment.js";

export { staticSample };

const directory = new URL("./", import.meta.url).pathname;

export function appPath(path) {
  return directory + path;
}

export function apiPath(path) {
  if (staticSample) throw new Error("샘플 체험판은 이 브라우저에만 저장합니다.");
  return appPath("api/" + path);
}

export const viewerPath = appPath(staticSample ? "viewer.html" : "viewer");

export function storageKey(name) {
  if (!staticSample && directory === "/") return name;
  return name + ":" + (staticSample ? "sample:" : "server:") + directory;
}

export function installOfflineShell() {
  return navigator.serviceWorker?.register(appPath("sw.js")) ?? Promise.resolve();
}
