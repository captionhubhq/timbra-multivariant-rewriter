import { ApiSettings, ConfigParser } from "./config-parser";
import { SubtitlePlaylist } from "./playlist-rewriter";

/** The parts of a CaptionHub flow the rewriter needs. */
export interface FlowSummary {
  flowId: string;
  /** hls_details.hls_url; absent for SRT and RTMP sources. */
  sourceUrl?: string;
  /** output_details.hls_output.playlist_tracks, validated. */
  tracks: SubtitlePlaylist[];
}

export class FlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlowError";
  }
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const DEFAULT_TIMEOUT_MS = 10_000;

export class FlowClient {
  constructor(
    private readonly api: ApiSettings,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  async fetchFlow(flowId: string): Promise<FlowSummary> {
    const url = `${this.api.url}/v1/timbra/${encodeURIComponent(flowId)}`;
    const body = await this.getJson(url, flowId);
    return FlowClient.summarise(flowId, body);
  }

  private async getJson(url: string, flowId: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: { Authorization: this.api.token, Accept: "application/json" },
        signal: controller.signal,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new FlowError(`Could not fetch flow ${flowId} from ${url}: ${reason}`);
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 401 || response.status === 403) {
      throw new FlowError(
        `CaptionHub API rejected the token for flow ${flowId} (HTTP ${response.status})`,
      );
    }
    if (response.status === 404) {
      throw new FlowError(`Flow ${flowId} was not found (HTTP 404)`);
    }
    if (!response.ok) {
      throw new FlowError(`CaptionHub API returned HTTP ${response.status} for flow ${flowId}`);
    }
    try {
      return await response.json();
    } catch {
      throw new FlowError(`CaptionHub API returned invalid JSON for flow ${flowId}`);
    }
  }

  static summarise(flowId: string, body: unknown): FlowSummary {
    if (typeof body !== "object" || body === null) {
      throw new FlowError(`Flow ${flowId} response is not an object`);
    }
    const flow = body as Record<string, unknown>;

    const hlsOutput = FlowClient.dig(flow, ["output_details", "hls_output"]);
    if (!hlsOutput) {
      throw new FlowError(
        `Flow ${flowId} has no HLS output; only flows with output_details.hls_output can be rewritten`,
      );
    }
    const tracks = ConfigParser.parseSubtitleList(
      (hlsOutput as Record<string, unknown>).playlist_tracks,
      `flow ${flowId} playlist_tracks`,
    );

    const hlsUrl = FlowClient.dig(flow, ["hls_details", "hls_url"]);
    const sourceUrl = typeof hlsUrl === "string" && hlsUrl.length > 0 ? hlsUrl : undefined;

    return { flowId, sourceUrl, tracks };
  }

  private static dig(obj: Record<string, unknown>, path: string[]): unknown {
    let current: unknown = obj;
    for (const key of path) {
      if (typeof current !== "object" || current === null) return undefined;
      current = (current as Record<string, unknown>)[key];
    }
    return current;
  }
}
