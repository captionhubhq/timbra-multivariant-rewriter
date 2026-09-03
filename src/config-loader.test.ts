import { ConfigLoader } from "./config-loader";
import { ConfigError } from "./config-parser";
import { FlowError } from "./flow-client";

function flowBody(flowId: string, sourceUrl: string | undefined, languages: string[]) {
  return {
    flow_id: flowId,
    hls_details: sourceUrl ? { hls_url: sourceUrl, hls_transcription_url: null } : undefined,
    output_details: {
      hls_output: {
        modified_multivariant_url: `https://hls.captionhub.com/${flowId}.m3u8`,
        playlist_tracks: languages.map((code) => ({
          language_name: code.toUpperCase(),
          default: false,
          language_code: code,
          url: `https://cdn.captionhub.com/live/vtt/playlist/${code}/${flowId}.m3u8`,
        })),
      },
    },
  };
}

function apiFetch(flows: Record<string, unknown>, calls: string[] = []) {
  return async (url: string) => {
    calls.push(url);
    const flowId = url.split("/").pop() ?? "";
    const body = flows[flowId];
    return body
      ? new Response(JSON.stringify(body), { status: 200 })
      : new Response("Not found", { status: 404 });
  };
}

describe("ConfigLoader.load", () => {
  test("returns env-only config untouched when no flow is set", async () => {
    const config = await ConfigLoader.load(
      { PLAYLIST_URL: "https://example.com/master.m3u8", SUBTITLE_PLAYLISTS: "[]" },
      { fetchImpl: apiFetch({}), cache: new Map() },
    );

    expect(config).toEqual({ sourceUrl: "https://example.com/master.m3u8", subtitles: [], mode: "add" });
  });

  test("fills sourceUrl and subtitles from the flow", async () => {
    const config = await ConfigLoader.load(
      { CAPTIONHUB_FLOW_ID: "aaa", CAPTIONHUB_API_TOKEN: "tok" },
      { fetchImpl: apiFetch({ aaa: flowBody("aaa", "https://hls.example.com/live/stream.m3u8", ["en", "nl"]) }), cache: new Map() },
    );

    expect(config.sourceUrl).toBe("https://hls.example.com/live/stream.m3u8");
    expect(config.subtitles.map((t) => t.language)).toEqual(["en", "nl"]);
    expect(config.mode).toBe("add");
  });

  test("explicit PLAYLIST_URL and SUBTITLE_PLAYLISTS win over the flow", async () => {
    const config = await ConfigLoader.load(
      {
        CAPTIONHUB_FLOW_ID: "aaa",
        CAPTIONHUB_API_TOKEN: "tok",
        PLAYLIST_URL: "https://mine.example.com/master.m3u8",
        SUBTITLE_PLAYLISTS: JSON.stringify([{ label: "Mine", language: "de", url: "https://mine.example.com/de.m3u8" }]),
      },
      { fetchImpl: apiFetch({ aaa: flowBody("aaa", "https://hls.example.com/live/stream.m3u8", ["en"]) }), cache: new Map() },
    );

    expect(config.sourceUrl).toBe("https://mine.example.com/master.m3u8");
    expect(config.subtitles.map((t) => t.language)).toEqual(["de"]);
  });

  test("tags each flow's tracks with its group and pattern", async () => {
    const config = await ConfigLoader.load(
      {
        CAPTIONHUB_API_TOKEN: "tok",
        CAPTIONHUB_FLOWS: JSON.stringify([
          { flow_id: "aaa", group_id: "primary-captions", variant_pattern: "^https://primary\\." },
          { flow_id: "bbb", group_id: "backup-captions", variant_pattern: "^https://backup\\." },
        ]),
      },
      {
        fetchImpl: apiFetch({
          aaa: flowBody("aaa", "https://hls.example.com/live/stream.m3u8", ["en"]),
          bbb: flowBody("bbb", "https://hls.example.com/live/stream.m3u8", ["en"]),
        }),
        cache: new Map(),
      },
    );

    expect(config.subtitles).toEqual([
      expect.objectContaining({ language: "en", groupId: "primary-captions", variantPattern: "^https://primary\\.", url: "https://cdn.captionhub.com/live/vtt/playlist/en/aaa.m3u8" }),
      expect.objectContaining({ language: "en", groupId: "backup-captions", variantPattern: "^https://backup\\.", url: "https://cdn.captionhub.com/live/vtt/playlist/en/bbb.m3u8" }),
    ]);
  });

  test("fails when no flow has an HLS source and PLAYLIST_URL is unset", async () => {
    const load = ConfigLoader.load(
      { CAPTIONHUB_FLOW_ID: "srt", CAPTIONHUB_API_TOKEN: "tok" },
      { fetchImpl: apiFetch({ srt: flowBody("srt", undefined, ["en"]) }), cache: new Map() },
    );

    await expect(load).rejects.toThrow(ConfigError);
    await expect(load).rejects.toThrow(/set PLAYLIST_URL/);
  });

  test("propagates flow lookup failures", async () => {
    const load = ConfigLoader.load(
      { CAPTIONHUB_FLOW_ID: "nope", CAPTIONHUB_API_TOKEN: "tok" },
      { fetchImpl: apiFetch({}), cache: new Map() },
    );

    await expect(load).rejects.toThrow(FlowError);
  });

  describe("caching", () => {
    const env = { CAPTIONHUB_FLOW_ID: "aaa", CAPTIONHUB_API_TOKEN: "tok", CAPTIONHUB_FLOW_CACHE_SECONDS: "60" };
    const flows = { aaa: flowBody("aaa", "https://hls.example.com/live/stream.m3u8", ["en"]) };

    test("reuses the flow within the TTL and refetches after it", async () => {
      const calls: string[] = [];
      const cache = new Map();
      let now = 1_000_000;
      const options = { fetchImpl: apiFetch(flows, calls), cache, now: () => now };

      await ConfigLoader.load(env, options);
      now += 30_000;
      await ConfigLoader.load(env, options);
      now += 31_000;
      await ConfigLoader.load(env, options);

      expect(calls).toHaveLength(2);
    });

    test("serves the stale flow when the API is unreachable", async () => {
      const cache = new Map();
      let now = 1_000_000;
      let online = true;
      const fetchImpl = async (url: string) => {
        if (!online) throw new Error("ECONNREFUSED");
        return apiFetch(flows)(url);
      };
      const options = { fetchImpl, cache, now: () => now };

      await ConfigLoader.load(env, options);
      now += 120_000;
      online = false;
      const config = await ConfigLoader.load(env, options);

      expect(config.sourceUrl).toBe("https://hls.example.com/live/stream.m3u8");
    });

    test("fails when the API is unreachable and nothing is cached", async () => {
      const load = ConfigLoader.load(env, {
        fetchImpl: async () => {
          throw new Error("ECONNREFUSED");
        },
        cache: new Map(),
      });

      await expect(load).rejects.toThrow(FlowError);
    });
  });
});
