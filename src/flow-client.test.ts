import { FlowClient, FlowError } from "./flow-client";

const API = { url: "https://api.captionhub.com/api", token: "tok", cacheMs: 0 };

function flowBody(overrides: Record<string, unknown> = {}) {
  return {
    flow_id: "bd62751212",
    hls_details: { hls_url: "https://hls.example.com/live/stream.m3u8", hls_transcription_url: null },
    output_details: {
      hls_output: {
        modified_multivariant_url: "https://hls.captionhub.com/live/modified_multivariant/stream.m3u8",
        playlist_tracks: [
          { language_name: "English", default: true, language_code: "en", url: "https://cdn.captionhub.com/live/vtt/playlist/en/stream.m3u8" },
        ],
      },
    },
    ...overrides,
  };
}

function clientReturning(status: number, body: unknown, seen: { url?: string; init?: RequestInit } = {}) {
  return new FlowClient(API, async (url, init) => {
    seen.url = url;
    seen.init = init;
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  });
}

describe("FlowClient.fetchFlow", () => {
  test("requests the flow with the token and maps the response", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const client = clientReturning(200, flowBody(), seen);

    const summary = await client.fetchFlow("bd62751212");

    expect(seen.url).toBe("https://api.captionhub.com/api/v1/timbra/bd62751212");
    expect((seen.init?.headers as Record<string, string>).Authorization).toBe("tok");
    expect(summary).toEqual({
      flowId: "bd62751212",
      sourceUrl: "https://hls.example.com/live/stream.m3u8",
      tracks: [
        { label: "English", language: "en", default: true, url: "https://cdn.captionhub.com/live/vtt/playlist/en/stream.m3u8" },
      ],
    });
  });

  test("leaves sourceUrl unset for a flow without hls_details", async () => {
    const client = clientReturning(200, flowBody({ hls_details: undefined }));

    const summary = await client.fetchFlow("bd62751212");

    expect(summary.sourceUrl).toBeUndefined();
  });

  test("rejects a flow without HLS output", async () => {
    const client = clientReturning(200, flowBody({ output_details: { plugin_output: { plugin_captions_url: "https://x" } } }));

    await expect(client.fetchFlow("bd62751212")).rejects.toThrow(/has no HLS output/);
  });

  test("reports a rejected token", async () => {
    const client = clientReturning(401, { error: "Invalid API token" });

    await expect(client.fetchFlow("bd62751212")).rejects.toThrow(FlowError);
    await expect(client.fetchFlow("bd62751212")).rejects.toThrow(/rejected the token/);
  });

  test("reports an unknown flow", async () => {
    const client = clientReturning(404, { error: "Not found" });

    await expect(client.fetchFlow("nope")).rejects.toThrow(/Flow nope was not found/);
  });

  test("reports invalid JSON", async () => {
    const client = clientReturning(200, "<html>");

    await expect(client.fetchFlow("bd62751212")).rejects.toThrow(/invalid JSON/);
  });

  test("wraps network failures", async () => {
    const client = new FlowClient(API, async () => {
      throw new Error("ECONNREFUSED");
    });

    await expect(client.fetchFlow("bd62751212")).rejects.toThrow(/Could not fetch flow bd62751212 .*ECONNREFUSED/);
  });
});
