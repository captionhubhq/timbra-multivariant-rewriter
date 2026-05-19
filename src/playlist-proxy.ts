import { PlaylistRewriter } from "./playlist-rewriter";

export interface UpstreamResponse {
  status: number;
  body: string;
  headers: Record<string, string>;
}

export type UpstreamFetcher = (url: string) => Promise<UpstreamResponse>;

export interface ProxyResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_PLAYLIST_BYTES = 5 * 1024 * 1024;

function buildDefaultFetcher(timeoutMs: number): UpstreamFetcher {
  return async (url) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        redirect: "follow",
        signal: controller.signal,
      });
      const body = await response.text();
      return {
        status: response.status,
        body,
        headers: PlaylistProxy.filterResponseHeaders(response.headers),
      };
    } finally {
      clearTimeout(timer);
    }
  };
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

export class PlaylistProxy {
  private static readonly STRIPPED_RESPONSE_HEADERS = new Set([
    "content-length",
    "content-encoding",
    "content-type",
    "transfer-encoding",
    "connection",
    "keep-alive",
    "etag",
    "last-modified",
    "vary",
  ]);

  private static readonly CORS_HEADERS: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Expose-Headers": "Cache-Control, Age, Date, Expires",
  };

  private readonly timeoutMs: number;
  private readonly fetcher: UpstreamFetcher;

  constructor(
    private readonly sourceUrl: string,
    private readonly rewriter: PlaylistRewriter,
    fetcher?: UpstreamFetcher,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {
    this.timeoutMs = timeoutMs;
    this.fetcher = fetcher ?? buildDefaultFetcher(timeoutMs);
  }

  async handle(method: string = "GET"): Promise<ProxyResponse> {
    if (method === "OPTIONS") {
      return { statusCode: 204, headers: PlaylistProxy.CORS_HEADERS, body: "" };
    }

    let upstream: UpstreamResponse;
    try {
      upstream = await this.fetcher(this.sourceUrl);
    } catch (err) {
      if (isAbortError(err)) {
        return this.errorResponse(
          504,
          `Upstream fetch timed out after ${this.timeoutMs}ms`,
        );
      }
      const message = err instanceof Error ? err.message : String(err);
      return this.errorResponse(502, `Upstream fetch failed: ${message}`);
    }

    if (upstream.status >= 400) {
      return {
        statusCode: upstream.status,
        headers: {
          ...upstream.headers,
          "Content-Type": "text/plain",
          ...PlaylistProxy.CORS_HEADERS,
        },
        body: upstream.body,
      };
    }

    if (upstream.body.length === 0) {
      return this.errorResponse(502, "Upstream returned an empty body");
    }

    if (upstream.body.length > MAX_PLAYLIST_BYTES) {
      return this.errorResponse(
        502,
        `Upstream playlist is too large (${upstream.body.length} bytes, max ${MAX_PLAYLIST_BYTES})`,
      );
    }

    if (!PlaylistProxy.looksLikeHls(upstream.body)) {
      return this.errorResponse(
        502,
        "Upstream did not return an HLS playlist (missing #EXTM3U header)",
      );
    }

    const body = method === "HEAD" ? "" : this.rewriter.rewrite(upstream.body);

    return {
      statusCode: 200,
      headers: {
        ...upstream.headers,
        "Content-Type": "application/vnd.apple.mpegurl",
        ...PlaylistProxy.CORS_HEADERS,
      },
      body,
    };
  }

  private errorResponse(statusCode: number, message: string): ProxyResponse {
    return {
      statusCode,
      headers: { "Content-Type": "text/plain", ...PlaylistProxy.CORS_HEADERS },
      body: message,
    };
  }

  static filterResponseHeaders(headers: Headers): Record<string, string> {
    const out: Record<string, string> = {};
    headers.forEach((value, key) => {
      if (!PlaylistProxy.STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) {
        out[key] = value;
      }
    });
    return out;
  }

  static looksLikeHls(body: string): boolean {
    return body.replace(/^﻿/, "").trimStart().startsWith("#EXTM3U");
  }
}
