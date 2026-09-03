#!/usr/bin/env node
import * as fs from "fs";
import { parseArgs } from "util";
import { ConfigError, ConfigParser } from "./config-parser";
import { PlaylistProxy, UpstreamFetcher } from "./playlist-proxy";
import { PlaylistRewriter } from "./playlist-rewriter";

export const USAGE = `Usage: timbra-rewrite --playlist <url|file|-> --subtitles <file|json|-> [options]

Rewrites an HLS multivariant playlist to add CaptionHub subtitle tracks and
prints the result. Does the same job as the Lambda, once, without deploying.

Options:
  --playlist <url|file|->   Source playlist. An http(s) URL is fetched; anything
                            else is read as a file. "-" reads stdin.
  --base-url <url>          URL the source playlist is served from. Required when
                            --playlist is a file or stdin; relative URIs in the
                            playlist are resolved against it.
  --subtitles <file|json|-> Subtitle tracks: a JSON file, an inline JSON array,
                            or "-" for stdin. Same shape as SUBTITLE_PLAYLISTS
                            (paste playlist_tracks from the CaptionHub API).
  --mode <add|replace>      add keeps existing subtitle tracks (default);
                            replace strips them first.
  --output <file>           Write the playlist here instead of stdout.
  -h, --help                Show this help.

Examples:
  timbra-rewrite --playlist https://hls.example.com/live/stream.m3u8 \\
    --subtitles tracks.json

  curl -s -H "Authorization: $CAPTIONHUB_API_TOKEN" \\
      https://api.captionhub.com/v1/timbra/<flow_id> \\
    | jq -c '.output_details.hls_output.playlist_tracks' \\
    | timbra-rewrite --playlist https://hls.example.com/live/stream.m3u8 --subtitles -
`;

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  readStdin: () => string;
  fetcher?: UpstreamFetcher;
}

export enum ExitCode {
  Ok = 0,
  UsageError = 2,
  RewriteFailed = 1,
}

const HTTP_URL = /^https?:\/\//i;

class CliUsageError extends Error {}

export async function runCli(argv: string[], io: CliIo): Promise<ExitCode> {
  try {
    const args = parseArguments(argv);
    if (args.help) {
      io.stdout(USAGE);
      return ExitCode.Ok;
    }

    const config = ConfigParser.fromEnv({
      PLAYLIST_URL: args.sourceUrl,
      SUBTITLE_PLAYLISTS: readSubtitles(args.subtitles, io),
      MODE: args.mode,
    });
    const rewriter = new PlaylistRewriter(config);

    const playlist = HTTP_URL.test(args.playlist)
      ? await fetchPlaylist(args.playlist, rewriter, io.fetcher)
      : rewriter.rewrite(readLocalPlaylist(args.playlist, io));

    if (args.output) {
      fs.writeFileSync(args.output, playlist);
    } else {
      io.stdout(playlist);
    }
    return ExitCode.Ok;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof CliUsageError || err instanceof ConfigError) {
      io.stderr(`timbra-rewrite: ${message}\n\n${USAGE}`);
      return ExitCode.UsageError;
    }
    io.stderr(`timbra-rewrite: ${message}\n`);
    return ExitCode.RewriteFailed;
  }
}

interface ParsedArguments {
  help: boolean;
  playlist: string;
  sourceUrl: string;
  subtitles: string;
  mode: string | undefined;
  output: string | undefined;
}

function parseArguments(argv: string[]): ParsedArguments {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        playlist: { type: "string" },
        "base-url": { type: "string" },
        subtitles: { type: "string" },
        mode: { type: "string" },
        output: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (err) {
    throw new CliUsageError(err instanceof Error ? err.message : String(err));
  }

  if (values.help) {
    return { help: true, playlist: "", sourceUrl: "", subtitles: "", mode: undefined, output: undefined };
  }

  const playlist = values.playlist as string | undefined;
  const baseUrl = values["base-url"] as string | undefined;
  const subtitles = values.subtitles as string | undefined;
  if (!playlist) throw new CliUsageError("--playlist is required");
  if (!subtitles) throw new CliUsageError("--subtitles is required");
  if (playlist === "-" && subtitles === "-") {
    throw new CliUsageError("--playlist and --subtitles cannot both read stdin");
  }

  const sourceUrl = HTTP_URL.test(playlist) ? baseUrl ?? playlist : baseUrl;
  if (!sourceUrl) {
    throw new CliUsageError("--base-url is required when --playlist is a file or stdin");
  }

  return {
    help: false,
    playlist,
    sourceUrl,
    subtitles,
    mode: values.mode as string | undefined,
    output: values.output as string | undefined,
  };
}

function readSubtitles(spec: string, io: CliIo): string {
  if (spec === "-") return io.readStdin();
  if (spec.trimStart().startsWith("[")) return spec;
  return readFile(spec, "--subtitles");
}

function readLocalPlaylist(spec: string, io: CliIo): string {
  const body = spec === "-" ? io.readStdin() : readFile(spec, "--playlist");
  if (!PlaylistProxy.looksLikeHls(body)) {
    throw new Error("Input is not an HLS playlist (missing #EXTM3U header)");
  }
  return body;
}

function readFile(path: string, flag: string): string {
  try {
    return fs.readFileSync(path, "utf8");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new CliUsageError(`${flag}: cannot read ${path}: ${reason}`);
  }
}

async function fetchPlaylist(
  url: string,
  rewriter: PlaylistRewriter,
  fetcher: UpstreamFetcher | undefined,
): Promise<string> {
  const proxy = new PlaylistProxy(url, rewriter, fetcher);
  const response = await proxy.handle("GET");
  if (response.statusCode !== 200) {
    throw new Error(`${response.statusCode} from ${url}: ${response.body.trim()}`);
  }
  return response.body;
}

if (require.main === module) {
  runCli(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    readStdin: () => fs.readFileSync(0, "utf8"),
  }).then((code) => {
    process.exitCode = code;
  });
}
