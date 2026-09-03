#!/usr/bin/env node
import * as fs from "fs";
import { parseArgs } from "util";
import { ConfigError, ConfigParser } from "./config-parser";
import { ConfigLoader } from "./config-loader";
import { FetchLike, FlowError } from "./flow-client";
import { PlaylistProxy, UpstreamFetcher } from "./playlist-proxy";
import { PlaylistRewriter, RewriteConfig } from "./playlist-rewriter";

export const USAGE = `Usage: timbra-rewrite (--flow <id> | --playlist <src> --subtitles <tracks>) [options]

Rewrites an HLS multivariant playlist to add CaptionHub subtitle tracks and
prints the result. Does the same job as the Lambda, once, without deploying.

Sources of configuration (an explicit flag always wins over a flow):
  --flow <id>               CaptionHub flow to read the source playlist URL and
                            caption tracks from. Repeat for redundant flows.
  --flows <file|json|->     JSON array of {"flow_id", "group_id", "variant_pattern"}
                            objects, for redundant flows that need distinct groups.
  --token <token>           CaptionHub API token. Defaults to $CAPTIONHUB_API_TOKEN.
  --api-url <url>           CaptionHub API base URL (default https://api.captionhub.com/api).
  --playlist <url|file|->   Source playlist. An http(s) URL is fetched; anything
                            else is read as a file. "-" reads stdin.
  --base-url <url>          URL the source playlist is served from, for resolving
                            relative URIs. Required for a file or stdin unless a
                            flow supplies it.
  --subtitles <file|json|-> Subtitle tracks: a JSON file, an inline JSON array,
                            or "-" for stdin. Same shape as SUBTITLE_PLAYLISTS.

Options:
  --mode <add|replace>      add keeps existing subtitle tracks (default);
                            replace strips them first.
  --output <file>           Write the playlist here instead of stdout.
  -h, --help                Show this help.

Examples:
  timbra-rewrite --flow bd62751212 --token "$CAPTIONHUB_API_TOKEN"

  timbra-rewrite --playlist https://hls.example.com/live/stream.m3u8 \\
    --subtitles tracks.json

  timbra-rewrite --playlist https://hls.example.com/live/stream.m3u8 \\
    --flows '[{"flow_id":"aaa","group_id":"primary","variant_pattern":"^https://primary\\\\."},
              {"flow_id":"bbb","group_id":"backup","variant_pattern":"^https://backup\\\\."}]'
`;

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  readStdin: () => string;
  env?: NodeJS.ProcessEnv;
  fetcher?: UpstreamFetcher;
  apiFetch?: FetchLike;
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

    const config = await loadConfig(args, io);
    const rewriter = new PlaylistRewriter(config);

    const source = args.playlist ?? config.sourceUrl;
    const playlist = HTTP_URL.test(source)
      ? await fetchPlaylist(source, rewriter, io.fetcher)
      : rewriter.rewrite(readLocalPlaylist(source, io));

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
    if (err instanceof FlowError) {
      io.stderr(`timbra-rewrite: ${message}\n`);
      return ExitCode.RewriteFailed;
    }
    io.stderr(`timbra-rewrite: ${message}\n`);
    return ExitCode.RewriteFailed;
  }
}

interface ParsedArguments {
  help: boolean;
  playlist: string | undefined;
  baseUrl: string | undefined;
  subtitles: string | undefined;
  flows: string[];
  flowsSpec: string | undefined;
  token: string | undefined;
  apiUrl: string | undefined;
  mode: string | undefined;
  output: string | undefined;
}

function parseArguments(argv: string[]): ParsedArguments {
  let values: Record<string, string | string[] | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        playlist: { type: "string" },
        "base-url": { type: "string" },
        subtitles: { type: "string" },
        flow: { type: "string", multiple: true },
        flows: { type: "string" },
        token: { type: "string" },
        "api-url": { type: "string" },
        mode: { type: "string" },
        output: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (err) {
    throw new CliUsageError(err instanceof Error ? err.message : String(err));
  }

  const args: ParsedArguments = {
    help: values.help === true,
    playlist: values.playlist as string | undefined,
    baseUrl: values["base-url"] as string | undefined,
    subtitles: values.subtitles as string | undefined,
    flows: (values.flow as string[] | undefined) ?? [],
    flowsSpec: values.flows as string | undefined,
    token: values.token as string | undefined,
    apiUrl: values["api-url"] as string | undefined,
    mode: values.mode as string | undefined,
    output: values.output as string | undefined,
  };
  if (args.help) return args;

  const hasFlows = args.flows.length > 0 || args.flowsSpec !== undefined;
  if (!args.playlist && !hasFlows) {
    throw new CliUsageError("--playlist is required unless --flow or --flows is given");
  }
  if (!args.subtitles && !hasFlows) {
    throw new CliUsageError("--subtitles is required unless --flow or --flows is given");
  }
  const stdinReaders = [args.playlist, args.subtitles, args.flowsSpec].filter((v) => v === "-");
  if (stdinReaders.length > 1) {
    throw new CliUsageError("only one of --playlist, --subtitles and --flows can read stdin");
  }
  if (args.playlist && !HTTP_URL.test(args.playlist) && !args.baseUrl && !hasFlows) {
    throw new CliUsageError(
      "--base-url is required when --playlist is a file or stdin (unless a flow supplies it)",
    );
  }
  return args;
}

async function loadConfig(args: ParsedArguments, io: CliIo): Promise<RewriteConfig> {
  const env: NodeJS.ProcessEnv = {
    PLAYLIST_URL:
      args.baseUrl ?? (args.playlist && HTTP_URL.test(args.playlist) ? args.playlist : undefined),
    SUBTITLE_PLAYLISTS: args.subtitles ? readSpec(args.subtitles, "--subtitles", io) : undefined,
    MODE: args.mode,
    CAPTIONHUB_API_TOKEN: args.token ?? io.env?.CAPTIONHUB_API_TOKEN,
    CAPTIONHUB_API_URL: args.apiUrl,
    CAPTIONHUB_FLOW_CACHE_SECONDS: "0",
  };
  if (args.flows.length === 1 && args.flowsSpec === undefined) {
    env.CAPTIONHUB_FLOW_ID = args.flows[0];
  } else if (args.flows.length > 0 || args.flowsSpec !== undefined) {
    const fromSpec = args.flowsSpec ? parseFlowsSpec(readSpec(args.flowsSpec, "--flows", io)) : [];
    const fromFlags = args.flows.map((flowId) => ({ flow_id: flowId }));
    env.CAPTIONHUB_FLOWS = JSON.stringify([...fromFlags, ...fromSpec]);
  }

  const parsed = ConfigParser.fromEnv(env);
  const config = await ConfigLoader.resolve(parsed, { fetchImpl: io.apiFetch, cache: new Map() });
  if (args.playlist && !HTTP_URL.test(args.playlist) && !config.sourceUrl) {
    throw new CliUsageError("--base-url is required when --playlist is a file or stdin");
  }
  return config;
}

function parseFlowsSpec(raw: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new CliUsageError(`--flows must be valid JSON: ${reason}`);
  }
  if (!Array.isArray(parsed)) throw new CliUsageError("--flows must be a JSON array");
  return parsed;
}

/** A value that is inline JSON (starts with "["), "-" for stdin, or a file path. */
function readSpec(spec: string, flag: string, io: CliIo): string {
  if (spec === "-") return io.readStdin();
  if (spec.trimStart().startsWith("[")) return spec;
  return readFile(spec, flag);
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
    env: process.env,
  }).then((code) => {
    process.exitCode = code;
  });
}
