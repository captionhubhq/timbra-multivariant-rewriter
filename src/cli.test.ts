import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ExitCode, runCli } from "./cli";
import { UpstreamResponse } from "./playlist-proxy";

const MANIFEST = path.join(__dirname, "..", "test_hls_manifests", "brightcove_normal.m3u8");

const API_TRACKS = JSON.stringify([
  {
    language_name: "English",
    default: true,
    language_code: "en",
    url: "https://cdn.captionhub.com/live/vtt/playlist/en/stream.m3u8",
  },
]);

interface Capture {
  stdout: string[];
  stderr: string[];
}

interface RunOptions {
  stdin?: string;
  upstream?: UpstreamResponse;
  flows?: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
}

function flowResponse(flowId: string, sourceUrl: string, languages: string[]) {
  return {
    flow_id: flowId,
    hls_details: { hls_url: sourceUrl, hls_transcription_url: null },
    output_details: {
      hls_output: {
        modified_multivariant_url: `https://hls.captionhub.com/live/modified_multivariant/${flowId}.m3u8`,
        playlist_tracks: languages.map((code, i) => ({
          language_name: code.toUpperCase(),
          default: i === 0,
          language_code: code,
          url: `https://cdn.captionhub.com/live/vtt/playlist/${code}/${flowId}.m3u8`,
        })),
      },
    },
  };
}

function run(argv: string[], options: RunOptions = {}) {
  const capture: Capture = { stdout: [], stderr: [] };
  const exit = runCli(argv, {
    stdout: (text) => capture.stdout.push(text),
    stderr: (text) => capture.stderr.push(text),
    readStdin: () => options.stdin ?? "",
    env: options.env ?? {},
    fetcher: async () =>
      options.upstream ?? { status: 200, body: fs.readFileSync(MANIFEST, "utf8"), headers: {} },
    apiFetch: async (url) => {
      const flowId = url.split("/").pop() ?? "";
      const flow = options.flows?.[flowId];
      return flow
        ? new Response(JSON.stringify(flow), { status: 200 })
        : new Response("Not found", { status: 404 });
    },
  });
  return exit.then((code) => ({ code, out: capture.stdout.join(""), err: capture.stderr.join("") }));
}

describe("timbra-rewrite CLI", () => {
  test("rewrites a fetched playlist with tracks from a JSON file", async () => {
    const tracksFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cli-")), "tracks.json");
    fs.writeFileSync(tracksFile, API_TRACKS);

    const result = await run([
      "--playlist", "https://example.com/live/master.m3u8",
      "--subtitles", tracksFile,
    ]);

    expect(result.code).toBe(ExitCode.Ok);
    expect(result.out).toContain('#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English"');
    expect(result.out).toContain("https://example.com/live/profile_0/chunklist.m3u8");
    expect(result.err).toBe("");
  });

  test("rewrites a local file against --base-url with inline JSON tracks", async () => {
    const result = await run([
      "--playlist", MANIFEST,
      "--base-url", "https://origin.example.com/vod/master.m3u8",
      "--subtitles", API_TRACKS,
      "--mode", "replace",
    ]);

    expect(result.code).toBe(ExitCode.Ok);
    expect(result.out).toContain('LANGUAGE="en"');
    expect(result.out).toContain("https://origin.example.com/vod/profile_0/chunklist.m3u8");
  });

  test("reads the playlist from stdin", async () => {
    const result = await run(
      ["--playlist", "-", "--base-url", "https://origin.example.com/m.m3u8", "--subtitles", API_TRACKS],
      { stdin: fs.readFileSync(MANIFEST, "utf8") },
    );

    expect(result.code).toBe(ExitCode.Ok);
    expect(result.out).toContain("#EXT-X-MEDIA:TYPE=SUBTITLES");
  });

  test("reads the tracks from stdin, as piped from the CaptionHub API", async () => {
    const result = await run(
      ["--playlist", "https://example.com/master.m3u8", "--subtitles", "-"],
      { stdin: API_TRACKS },
    );

    expect(result.code).toBe(ExitCode.Ok);
    expect(result.out).toContain('NAME="English"');
  });

  test("writes to --output instead of stdout", async () => {
    const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cli-")), "out.m3u8");

    const result = await run([
      "--playlist", "https://example.com/master.m3u8",
      "--subtitles", API_TRACKS,
      "--output", outFile,
    ]);

    expect(result.code).toBe(ExitCode.Ok);
    expect(result.out).toBe("");
    expect(fs.readFileSync(outFile, "utf8")).toContain("#EXT-X-MEDIA:TYPE=SUBTITLES");
  });

  test("prints usage for --help", async () => {
    const result = await run(["--help"]);

    expect(result.code).toBe(ExitCode.Ok);
    expect(result.out).toMatch(/^Usage: timbra-rewrite/);
  });

  test("requires --base-url for a local playlist", async () => {
    const result = await run(["--playlist", MANIFEST, "--subtitles", API_TRACKS]);

    expect(result.code).toBe(ExitCode.UsageError);
    expect(result.err).toContain("--base-url is required");
  });

  test("rejects both inputs on stdin", async () => {
    const result = await run(["--playlist", "-", "--base-url", "https://x.example.com/m.m3u8", "--subtitles", "-"]);

    expect(result.code).toBe(ExitCode.UsageError);
    expect(result.err).toContain("can read stdin");
  });

  test("reports invalid tracks as a usage error", async () => {
    const result = await run([
      "--playlist", "https://example.com/master.m3u8",
      "--subtitles", '[{"language_name":"English"}]',
    ]);

    expect(result.code).toBe(ExitCode.UsageError);
    expect(result.err).toContain("SUBTITLE_PLAYLISTS[0].language (or language_code)");
  });

  test("rejects unknown flags", async () => {
    const result = await run(["--playlist", "https://example.com/m.m3u8", "--subtitles", API_TRACKS, "--verbose"]);

    expect(result.code).toBe(ExitCode.UsageError);
    expect(result.err).toContain("--verbose");
  });

  test("fails when the upstream returns an error status", async () => {
    const result = await run(
      ["--playlist", "https://example.com/missing.m3u8", "--subtitles", API_TRACKS],
      { upstream: { status: 404, body: "Not Found", headers: {} } },
    );

    expect(result.code).toBe(ExitCode.RewriteFailed);
    expect(result.err).toContain("404 from https://example.com/missing.m3u8: Not Found");
    expect(result.out).toBe("");
  });

  test("fails when a local file is not an HLS playlist", async () => {
    const notHls = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cli-")), "page.html");
    fs.writeFileSync(notHls, "<html></html>");

    const result = await run(["--playlist", notHls, "--base-url", "https://x.example.com/m.m3u8", "--subtitles", API_TRACKS]);

    expect(result.code).toBe(ExitCode.RewriteFailed);
    expect(result.err).toContain("not an HLS playlist");
  });

  describe("with CaptionHub flows", () => {
    test("--flow supplies both the source playlist and the tracks", async () => {
      const result = await run(["--flow", "aaa", "--token", "tok"], {
        flows: { aaa: flowResponse("aaa", "https://origin.example.com/live/master.m3u8", ["en", "nl"]) },
      });

      expect(result.code).toBe(ExitCode.Ok);
      expect(result.out).toContain("https://origin.example.com/live/profile_0/chunklist.m3u8");
      expect(result.out).toContain('LANGUAGE="en",URI="https://cdn.captionhub.com/live/vtt/playlist/en/aaa.m3u8"');
      expect(result.out).toContain('LANGUAGE="nl"');
    });

    test("takes the token from the environment", async () => {
      const result = await run(["--flow", "aaa"], {
        env: { CAPTIONHUB_API_TOKEN: "tok" },
        flows: { aaa: flowResponse("aaa", "https://origin.example.com/m.m3u8", ["en"]) },
      });

      expect(result.code).toBe(ExitCode.Ok);
    });

    test("a local playlist borrows the base URL from the flow", async () => {
      const result = await run(["--flow", "aaa", "--token", "tok", "--playlist", MANIFEST], {
        flows: { aaa: flowResponse("aaa", "https://origin.example.com/vod/master.m3u8", ["en"]) },
      });

      expect(result.code).toBe(ExitCode.Ok);
      expect(result.out).toContain("https://origin.example.com/vod/profile_0/chunklist.m3u8");
    });

    test("--subtitles overrides the flow's tracks", async () => {
      const result = await run(["--flow", "aaa", "--token", "tok", "--subtitles", API_TRACKS], {
        flows: { aaa: flowResponse("aaa", "https://origin.example.com/m.m3u8", ["fr"]) },
      });

      expect(result.code).toBe(ExitCode.Ok);
      expect(result.out).toContain('LANGUAGE="en"');
      expect(result.out).not.toContain('LANGUAGE="fr"');
    });

    test("--flows assigns groups and variant patterns per flow", async () => {
      const redundant = [
        "#EXTM3U",
        "#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720",
        "https://primary.example.com/medium.m3u8",
        "#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720",
        "https://backup.example.com/medium.m3u8",
        "",
      ].join("\n");

      const result = await run(
        [
          "--playlist", "https://origin.example.com/master.m3u8",
          "--token", "tok",
          "--flows", JSON.stringify([
            { flow_id: "aaa", group_id: "primary-captions", variant_pattern: "^https://primary\\." },
            { flow_id: "bbb", group_id: "backup-captions", variant_pattern: "^https://backup\\." },
          ]),
        ],
        {
          upstream: { status: 200, body: redundant, headers: {} },
          flows: {
            aaa: flowResponse("aaa", "https://origin.example.com/master.m3u8", ["en"]),
            bbb: flowResponse("bbb", "https://origin.example.com/master.m3u8", ["en"]),
          },
        },
      );

      expect(result.code).toBe(ExitCode.Ok);
      expect(result.out).toContain('RESOLUTION=1280x720,SUBTITLES="primary-captions"\nhttps://primary.example.com/medium.m3u8');
      expect(result.out).toContain('RESOLUTION=1280x720,SUBTITLES="backup-captions"\nhttps://backup.example.com/medium.m3u8');
      expect(result.out).toContain('GROUP-ID="primary-captions",NAME="EN",DEFAULT=YES,AUTOSELECT=YES,FORCED=NO,LANGUAGE="en",URI="https://cdn.captionhub.com/live/vtt/playlist/en/aaa.m3u8"');
      expect(result.out).toContain('GROUP-ID="backup-captions",NAME="EN",DEFAULT=YES,AUTOSELECT=YES,FORCED=NO,LANGUAGE="en",URI="https://cdn.captionhub.com/live/vtt/playlist/en/bbb.m3u8"');
    });

    test("requires a token", async () => {
      const result = await run(["--flow", "aaa"]);

      expect(result.code).toBe(ExitCode.UsageError);
      expect(result.err).toContain("CAPTIONHUB_API_TOKEN");
    });

    test("reports an unknown flow", async () => {
      const result = await run(["--flow", "nope", "--token", "tok"]);

      expect(result.code).toBe(ExitCode.RewriteFailed);
      expect(result.err).toContain("Flow nope was not found");
    });
  });
});
