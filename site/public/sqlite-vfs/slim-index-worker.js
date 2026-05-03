// openroles slim-index loader worker. Does all CPU-heavy chunk work
// off the main thread so the tab stays interactive while ~30 MB of
// gzipped JSON streams in.
//
// Critical: the worker not only decompresses + JSON.parses, it also
// runs the fromWire mapping AND packs each chunk into a JSON STRING
// before postMessage'ing back. Returning the parsed object array
// turned out to be the biggest blocker on the main thread —
// structured-cloning ~50k objects with 16 fields each was a 3-second
// task per chunk in real Chrome (measured via PerformanceObserver
// longtask). Strings clone in O(1).
//
// Protocol from main → worker:
//   { type: "chunk",  url, id }
//   { type: "search", url, id }
//
// Protocol from worker → main:
//   { type: "chunk-done",  id, rowsJson, count }   ← rowsJson is a SlimRow[] JSON string
//   { type: "search-done", id, jsonText }          ← raw JSON string for parseSearchIndex()
//   { type: "error",       id, error }

function fromWire(r) {
  return {
    short_id: r.i,
    ats: r.a,
    tenant_slug: r.t,
    title: r.ti,
    company: r.c,
    level: r.l,
    workplace_type: r.w,
    is_recruiter_post: r.r === 1,
    is_stale: r.s === 1,
    location_text: r.loc,
    location_country: r.cc,
    posted_at: r.p,
    first_seen_at: r.f,
    compensation_min: r.cm,
    compensation_max: r.cmax,
    compensation_currency: r.cur,
  };
}

async function fetchText(url) {
  const res = await fetch(url, { cache: "force-cache" });
  if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
  const enc = res.headers.get("content-encoding");
  if (enc === null || enc === "identity") {
    // .json.gz served without auto-decompression — decompress here.
    const blob = await res.blob();
    const ds = new DecompressionStream("gzip");
    return await new Response(blob.stream().pipeThrough(ds)).text();
  }
  // Server already decompressed via Content-Encoding negotiation.
  return await res.text();
}

self.onmessage = async (ev) => {
  const data = ev.data ?? {};
  const id = data.id;
  const url = data.url;
  if (typeof url !== "string") {
    self.postMessage({ type: "error", id, error: "missing url" });
    return;
  }
  try {
    if (data.type === "chunk") {
      // biome-ignore lint/suspicious/noConsole: chunk-merge diagnostic
      console.log(`[worker] starting chunk id=${id} ${url.split("/").pop()}`);
      const text = await fetchText(url);
      // biome-ignore lint/suspicious/noConsole: chunk-merge diagnostic
      console.log(`[worker] fetched id=${id} bytes=${text.length}`);
      const onWire = JSON.parse(text);
      const rows = new Array(onWire.length);
      for (let i = 0; i < onWire.length; i++) rows[i] = fromWire(onWire[i]);
      const rowsJson = JSON.stringify(rows);
      // biome-ignore lint/suspicious/noConsole: chunk-merge diagnostic
      console.log(
        `[worker] posting chunk-done id=${id} count=${rows.length} jsonBytes=${rowsJson.length}`,
      );
      self.postMessage({ type: "chunk-done", id, rowsJson, count: rows.length });
      return;
    }
    if (data.type === "search") {
      const text = await fetchText(url);
      self.postMessage({ type: "search-done", id, jsonText: text });
      return;
    }
    self.postMessage({ type: "error", id, error: `unknown message type: ${data.type}` });
  } catch (err) {
    const msg = err?.message ?? String(err);
    console.error(`[worker] error id=${id}: ${msg}`);
    self.postMessage({ type: "error", id, error: msg });
  }
};
