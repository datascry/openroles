// Phase 14 slim-index loader worker. Lives off the main thread so
// chunk decompress + JSON.parse (typically 100–700 ms per chunk on
// mobile CPUs) doesn't block the FilterTable's interaction loop.
//
// Pattern: fetch → DecompressionStream('gzip') → text → JSON.parse →
// postMessage to the main thread. Same shape as the reference impl
// at github.com/Feashliaa/job-board-aggregator/blob/main/js/chunk_worker.js.
//
// The main-thread loader (site/src/lib/slim-index.ts) sends one
// `{ url }` message per chunk and expects one `{ rows }` (or
// `{ error }`) reply per chunk. Order is not guaranteed — chunks
// arrive in network-completion order, not request order. The main
// thread is responsible for de-duplication via short_id.

self.onmessage = async (ev) => {
  const url = ev.data?.url;
  if (typeof url !== "string") {
    self.postMessage({ rows: [], error: "missing url" });
    return;
  }
  try {
    const res = await fetch(url, { cache: "force-cache" });
    if (!res.ok) {
      self.postMessage({ rows: [], error: `${url} returned HTTP ${res.status}` });
      return;
    }
    const enc = res.headers.get("content-encoding");
    let text;
    if (enc === null || enc === "identity") {
      // .json.gz served without auto-decompression — decompress here.
      const blob = await res.blob();
      const ds = new DecompressionStream("gzip");
      const decompressed = blob.stream().pipeThrough(ds);
      text = await new Response(decompressed).text();
    } else {
      // Server already decompressed via Content-Encoding negotiation.
      text = await res.text();
    }
    const rows = JSON.parse(text);
    self.postMessage({ rows });
  } catch (err) {
    const msg = err?.message ?? String(err);
    self.postMessage({ rows: [], error: msg });
  }
};
