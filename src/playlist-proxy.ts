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

const defaultUpstreamFetcher: UpstreamFetcher = async (url) => {
  const response = await fetch(url, { redirect: "follow" });
  return {
    status: response.status,
    body: await response.text(),
    headers: PlaylistProxy.filterResponseHeaders(response.headers),
  };
};

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

  constructor(
    private readonly sourceUrl: string,
    private readonly rewriter: PlaylistRewriter,
    private readonly fetcher: UpstreamFetcher = defaultUpstreamFetcher,
  ) {}

  async handle(method: string = "GET"): Promise<ProxyResponse> {
    if (method === "OPTIONS") {
      return { statusCode: 204, headers: PlaylistProxy.CORS_HEADERS, body: "" };
    }

    let upstream: UpstreamResponse;
    try {
      upstream = await this.fetcher(this.sourceUrl);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        statusCode: 502,
        headers: { "Content-Type": "text/plain", ...PlaylistProxy.CORS_HEADERS },
        body: `Upstream fetch failed: ${message}`,
      };
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

  static filterResponseHeaders(headers: Headers): Record<string, string> {
    const out: Record<string, string> = {};
    headers.forEach((value, key) => {
      if (!PlaylistProxy.STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) {
        out[key] = value;
      }
    });
    return out;
  }
}
