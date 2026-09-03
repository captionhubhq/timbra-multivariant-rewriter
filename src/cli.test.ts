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

function run(argv: string[], options: { stdin?: string; upstream?: UpstreamResponse } = {}) {
  const capture: Capture = { stdout: [], stderr: [] };
  const exit = runCli(argv, {
    stdout: (text) => capture.stdout.push(text),
    stderr: (text) => capture.stderr.push(text),
    readStdin: () => options.stdin ?? "",
    fetcher: async () =>
      options.upstream ?? { status: 200, body: fs.readFileSync(MANIFEST, "utf8"), headers: {} },
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
    expect(result.err).toContain("cannot both read stdin");
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
});
