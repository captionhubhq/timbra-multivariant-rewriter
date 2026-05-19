import { PlaylistRewriter } from "./playlist-rewriter";
import { PlaylistProxy, UpstreamFetcher, UpstreamResponse } from "./playlist-proxy";

const SOURCE_URL = "https://example.com/multivariant.m3u8";

const MINIMAL_MASTER =
  "#EXTM3U\n" +
  "#EXT-X-VERSION:3\n" +
  "#EXT-X-STREAM-INF:BANDWIDTH=1000000\n" +
  "video.m3u8\n";

function makeProxy(fetcher: UpstreamFetcher): PlaylistProxy {
  const rewriter = new PlaylistRewriter({
    sourceUrl: SOURCE_URL,
    subtitles: [
      {
        label: "English",
        language: "en",
        default: true,
        url: "https://captions.example.com/en.m3u8",
      },
    ],
    mode: "add",
  });
  return new PlaylistProxy(SOURCE_URL, rewriter, fetcher);
}

describe("PlaylistProxy.handle", () => {
  test("returns rewritten body with mpegurl content-type on 200", async () => {
    const fetcher: UpstreamFetcher = async () => ({
      status: 200,
      body: MINIMAL_MASTER,
      headers: { "cache-control": "max-age=2" },
    });
    const result = await makeProxy(fetcher).handle("GET");
    expect(result.statusCode).toBe(200);
    expect(result.headers["Content-Type"]).toBe("application/vnd.apple.mpegurl");
    expect(result.headers["cache-control"]).toBe("max-age=2");
    expect(result.headers["Access-Control-Allow-Origin"]).toBe("*");
    expect(result.body).toContain('SUBTITLES="subs"');
    expect(result.body).toContain("https://captions.example.com/en.m3u8");
  });

  test("returns empty body for HEAD but keeps headers", async () => {
    const fetcher: UpstreamFetcher = async () => ({
      status: 200,
      body: MINIMAL_MASTER,
      headers: {},
    });
    const result = await makeProxy(fetcher).handle("HEAD");
    expect(result.statusCode).toBe(200);
    expect(result.body).toBe("");
    expect(result.headers["Content-Type"]).toBe("application/vnd.apple.mpegurl");
  });

  test("returns 204 with CORS headers on OPTIONS", async () => {
    const fetcher = jest.fn<Promise<UpstreamResponse>, [string]>();
    const result = await makeProxy(fetcher).handle("OPTIONS");
    expect(result.statusCode).toBe(204);
    expect(result.body).toBe("");
    expect(result.headers["Access-Control-Allow-Origin"]).toBe("*");
    expect(fetcher).not.toHaveBeenCalled();
  });

  test("returns 502 when upstream fetch throws", async () => {
    const fetcher: UpstreamFetcher = async () => {
      throw new Error("connection refused");
    };
    const result = await makeProxy(fetcher).handle("GET");
    expect(result.statusCode).toBe(502);
    expect(result.body).toContain("connection refused");
    expect(result.headers["Access-Control-Allow-Origin"]).toBe("*");
  });

  test("passes through 4xx status from upstream without rewriting", async () => {
    const fetcher: UpstreamFetcher = async () => ({
      status: 404,
      body: "not found",
      headers: {},
    });
    const result = await makeProxy(fetcher).handle("GET");
    expect(result.statusCode).toBe(404);
    expect(result.body).toBe("not found");
    expect(result.headers["Content-Type"]).toBe("text/plain");
  });

  test("does not forward request headers to the upstream fetcher", async () => {
    const fetcher = jest.fn<Promise<UpstreamResponse>, [string]>(async () => ({
      status: 200,
      body: MINIMAL_MASTER,
      headers: {},
    }));
    await makeProxy(fetcher).handle("GET");
    expect(fetcher).toHaveBeenCalledWith(SOURCE_URL);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test("returns 504 when the fetcher signals an AbortError (timeout)", async () => {
    const fetcher: UpstreamFetcher = async () => {
      const err = new Error("The user aborted a request.");
      err.name = "AbortError";
      throw err;
    };
    const result = await makeProxy(fetcher).handle("GET");
    expect(result.statusCode).toBe(504);
    expect(result.body).toMatch(/timed out/);
    expect(result.headers["Access-Control-Allow-Origin"]).toBe("*");
  });

  test("returns 502 when upstream body is empty", async () => {
    const fetcher: UpstreamFetcher = async () => ({
      status: 200,
      body: "",
      headers: {},
    });
    const result = await makeProxy(fetcher).handle("GET");
    expect(result.statusCode).toBe(502);
    expect(result.body).toMatch(/empty body/);
  });

  test("returns 502 when upstream body is not an HLS playlist", async () => {
    const fetcher: UpstreamFetcher = async () => ({
      status: 200,
      body: "<html><body>Not Found</body></html>",
      headers: {},
    });
    const result = await makeProxy(fetcher).handle("GET");
    expect(result.statusCode).toBe(502);
    expect(result.body).toMatch(/not return an HLS playlist/);
  });

  test("tolerates a BOM and leading whitespace before #EXTM3U", async () => {
    const fetcher: UpstreamFetcher = async () => ({
      status: 200,
      body: "﻿\n" + MINIMAL_MASTER,
      headers: {},
    });
    const result = await makeProxy(fetcher).handle("GET");
    expect(result.statusCode).toBe(200);
    expect(result.body).toContain('SUBTITLES="subs"');
  });
});

describe("PlaylistProxy.looksLikeHls", () => {
  test("accepts a minimal HLS playlist", () => {
    expect(PlaylistProxy.looksLikeHls("#EXTM3U\n")).toBe(true);
  });

  test("accepts a playlist with a UTF-8 BOM", () => {
    expect(PlaylistProxy.looksLikeHls("﻿#EXTM3U\n")).toBe(true);
  });

  test("rejects HTML", () => {
    expect(PlaylistProxy.looksLikeHls("<html>")).toBe(false);
  });

  test("rejects empty string", () => {
    expect(PlaylistProxy.looksLikeHls("")).toBe(false);
  });

  test("rejects JSON", () => {
    expect(PlaylistProxy.looksLikeHls('{"error":"forbidden"}')).toBe(false);
  });
});

describe("PlaylistProxy.filterResponseHeaders", () => {
  test("forwards cache-related headers", () => {
    const headers = new Headers({
      "Cache-Control": "max-age=2",
      Age: "1",
      Date: "Tue, 19 May 2026 12:00:00 GMT",
      Expires: "Tue, 19 May 2026 12:00:05 GMT",
    });
    const result = PlaylistProxy.filterResponseHeaders(headers);
    expect(result["cache-control"]).toBe("max-age=2");
    expect(result.age).toBe("1");
    expect(result.date).toBe("Tue, 19 May 2026 12:00:00 GMT");
    expect(result.expires).toBe("Tue, 19 May 2026 12:00:05 GMT");
  });

  test("strips body-dependent and hop-by-hop headers", () => {
    const headers = new Headers({
      "Content-Length": "1234",
      "Content-Encoding": "gzip",
      "Content-Type": "application/vnd.apple.mpegurl",
      ETag: '"abc"',
      "Last-Modified": "Tue, 19 May 2026 12:00:00 GMT",
      Vary: "Accept-Encoding",
      "Cache-Control": "max-age=2",
    });
    const result = PlaylistProxy.filterResponseHeaders(headers);
    expect(result).toEqual({ "cache-control": "max-age=2" });
  });
});
