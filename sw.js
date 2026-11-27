const base = new URL("./", self.location.href);
const prefix = "fieldnotes-shell:" + encodeURIComponent(base.pathname) + ":";
const CACHE = prefix + "3a97da1817c0a818";
const files = [
  "index.html", "app.js", "shared.js", "store.js", "runtime.js", "deployment.js",
  "style.css", "capture.js", "capture-review.js", "gallery.js", "capture.css", "viewer.html", "viewer.js",
  "manifest.webmanifest", "icon-192.png", "icon-512.png",
];
const shell = new Set(files.map((file) => new URL(file, base).pathname));
const pages = new Map([
  [base.pathname, "index.html"],
  [base.pathname + "index.html", "index.html"],
  [base.pathname + "viewer", "viewer.html"],
  [base.pathname + "viewer.html", "viewer.html"],
]);
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) =>
        cache.addAll([...shell].map((url) => new Request(url, { cache: "reload" }))),
      ),
  );
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys())
        if ((name.startsWith(prefix) && name !== CACHE) ||
            (base.pathname === "/" && name === "fieldnotes-shell-v1"))
          await caches.delete(name);
      await self.clients.claim();
    })(),
  );
});
self.addEventListener("fetch", (event) => {
  const req = event.request,
    url = new URL(req.url);
  if (
    req.method !== "GET" ||
    url.origin !== base.origin
  )
    return;
  const page = req.mode === "navigate" && pages.get(url.pathname);
  const resource = page ? base.pathname + page : url.pathname;
  if (!shell.has(resource)) return;
  event.respondWith(
    caches.open(CACHE)
      .then((cache) => cache.match(resource))
      .then((cached) => cached || fetch(req)),
  );
});
