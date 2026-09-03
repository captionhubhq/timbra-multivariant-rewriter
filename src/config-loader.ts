import { ConfigError, ConfigParser, EnvConfig, FlowSettings } from "./config-parser";
import { FetchLike, FlowClient, FlowSummary } from "./flow-client";
import { RewriteConfig, SubtitlePlaylist } from "./playlist-rewriter";

interface CacheEntry {
  fetchedAt: number;
  summary: FlowSummary;
}

export interface LoaderOptions {
  fetchImpl?: FetchLike;
  now?: () => number;
  cache?: Map<string, CacheEntry>;
}

/** Shared across Lambda invocations in a warm container. */
const processCache = new Map<string, CacheEntry>();

/**
 * Turns env vars into a RewriteConfig, pulling the source URL and tracks
 * from the CaptionHub API when flows are configured. Flow lookups are
 * cached for CAPTIONHUB_FLOW_CACHE_SECONDS; if the API is unreachable and
 * a stale copy exists, the stale copy is used so playback keeps working.
 */
export class ConfigLoader {
  static async load(
    env: NodeJS.ProcessEnv = process.env,
    options: LoaderOptions = {},
  ): Promise<RewriteConfig> {
    return ConfigLoader.resolve(ConfigParser.fromEnv(env), options);
  }

  static async resolve(parsed: EnvConfig, options: LoaderOptions = {}): Promise<RewriteConfig> {
    if (parsed.flows.length === 0 || !parsed.api) {
      return {
        sourceUrl: parsed.sourceUrl as string,
        subtitles: parsed.subtitles ?? [],
        mode: parsed.mode,
      };
    }

    const client = new FlowClient(parsed.api, options.fetchImpl);
    const cache = options.cache ?? processCache;
    const now = options.now ?? Date.now;

    const summaries: FlowSummary[] = [];
    for (const flow of parsed.flows) {
      summaries.push(
        await ConfigLoader.cachedFetch(client, flow.flowId, parsed.api.url, parsed.api.cacheMs, cache, now),
      );
    }

    const sourceUrl = parsed.sourceUrl ?? summaries.find((s) => s.sourceUrl)?.sourceUrl;
    if (!sourceUrl) {
      throw new ConfigError(
        "No source playlist: none of the flows has hls_details.hls_url, so set PLAYLIST_URL",
      );
    }

    const subtitles =
      parsed.subtitles ??
      parsed.flows.flatMap((flow, i) => ConfigLoader.tagTracks(summaries[i].tracks, flow));
    ConfigParser.checkGroupPatterns(subtitles, "flow tracks");

    return { sourceUrl, subtitles, mode: parsed.mode };
  }

  private static tagTracks(tracks: SubtitlePlaylist[], flow: FlowSettings): SubtitlePlaylist[] {
    return tracks.map((track) => {
      const tagged: SubtitlePlaylist = { ...track };
      if (flow.groupId !== undefined) tagged.groupId = flow.groupId;
      if (flow.variantPattern !== undefined) tagged.variantPattern = flow.variantPattern;
      return tagged;
    });
  }

  private static async cachedFetch(
    client: FlowClient,
    flowId: string,
    apiUrl: string,
    cacheMs: number,
    cache: Map<string, CacheEntry>,
    now: () => number,
  ): Promise<FlowSummary> {
    const key = `${apiUrl} ${flowId}`;
    const cached = cache.get(key);
    if (cached && now() - cached.fetchedAt < cacheMs) return cached.summary;

    try {
      const summary = await client.fetchFlow(flowId);
      cache.set(key, { fetchedAt: now(), summary });
      return summary;
    } catch (err) {
      if (cached) return cached.summary;
      throw err;
    }
  }
}
