import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  Context,
} from "aws-lambda";

export interface SubtitlePlaylist {
  label: string;
  language: string;
  default?: boolean;
  url: string;
}

export type Mode = "add" | "replace";

export interface RewriteConfig {
  sourceUrl: string;
  subtitles: SubtitlePlaylist[];
  mode: Mode;
}

const SUBTITLES_GROUP_ID = "subs";

export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RewriteConfig {
  const sourceUrl = env.PLAYLIST_URL;
  if (!sourceUrl) {
    throw new Error("PLAYLIST_URL env var is required");
  }

  const rawSubtitles = env.SUBTITLE_PLAYLISTS ?? "[]";
  const subtitles = JSON.parse(rawSubtitles) as SubtitlePlaylist[];

  const mode = (env.MODE ?? "add") as Mode;
  if (mode !== "add" && mode !== "replace") {
    throw new Error(`MODE must be "add" or "replace", got "${mode}"`);
  }

  return { sourceUrl, subtitles, mode };
}

function buildSubtitleMediaTags(subtitles: SubtitlePlaylist[]): string[] {
  return subtitles.map((p) => {
    const defaultFlag = p.default ? "YES" : "NO";
    const language = (p.language ?? "").toLowerCase();
    const name = p.label || language || "Subtitles";
    return (
      `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="${SUBTITLES_GROUP_ID}",` +
      `NAME="${name}",DEFAULT=${defaultFlag},AUTOSELECT=YES,FORCED=NO,` +
      `LANGUAGE="${language}",URI="${p.url}",CHARACTERISTICS="public.machine-generated"`
    );
  });
}

function baseUrlOf(sourceUrl: string): string {
  const idx = sourceUrl.lastIndexOf("/");
  return idx >= 0 ? sourceUrl.slice(0, idx + 1) : sourceUrl + "/";
}

function absolutize(line: string, base: string): string {
  if (/^https?:\/\//i.test(line)) return line;
  return base + line;
}

function rewriteUriAttributes(line: string, base: string): string {
  return line.replace(/URI="([^"]+)"/g, (_match, uri: string) => {
    const absolute = /^https?:\/\//i.test(uri) ? uri : base + uri;
    return `URI="${absolute}"`;
  });
}

function absolutizePlaylist(playlist: string, sourceUrl: string): string[] {
  const base = baseUrlOf(sourceUrl);
  return playlist.split(/(?<=\n)/).map((rawLine) => {
    const stripped = rawLine.trim();
    let line = rawLine;
    if (stripped && !stripped.startsWith("#") && !/^https?:\/\//i.test(stripped)) {
      const newline = rawLine.endsWith("\n") ? "\n" : "";
      line = absolutize(stripped, base) + newline;
    }
    return rewriteUriAttributes(line, base);
  });
}

export function rewriteMaster(
  playlist: string,
  sourceUrl: string,
  subtitles: SubtitlePlaylist[],
  mode: Mode,
): string {
  const replace = mode === "replace";
  let lines = absolutizePlaylist(playlist, sourceUrl);

  if (replace) {
    lines = lines.map((line) =>
      line.includes("EXT-X-MEDIA:TYPE=SUBTITLES")
        ? "# NOTE: Existing subtitles removed by CaptionHub\n"
        : line,
    );
  }

  const rewritten = lines.map((line) => {
    if (!line.startsWith("#EXT-X-STREAM-INF")) return line;

    if (line.includes("SUBTITLES=")) {
      if (replace) {
        return line.replace(/SUBTITLES="[^"]+"/, `SUBTITLES="${SUBTITLES_GROUP_ID}"`);
      }
      return line;
    }

    const trailingNewline = line.endsWith("\n") ? "\n" : "";
    return line.replace(/\n$/, "") + `,SUBTITLES="${SUBTITLES_GROUP_ID}"` + trailingNewline;
  });

  const mediaTags = buildSubtitleMediaTags(subtitles).join("\n");
  return (
    rewritten.join("") +
    "\n\n# NOTE: the following captions are added by CaptionHub:\n\n" +
    mediaTags +
    "\n"
  );
}

export function wrapMediaPlaylist(sourceUrl: string, subtitles: SubtitlePlaylist[]): string {
  const mediaTags = buildSubtitleMediaTags(subtitles).join("\n");
  return (
    "#EXTM3U\n" +
    "#EXT-X-VERSION:3\n" +
    `#EXT-X-STREAM-INF:BANDWIDTH=1655093,AVERAGE-BANDWIDTH=1332156,SUBTITLES="${SUBTITLES_GROUP_ID}"\n` +
    `${sourceUrl}\n` +
    `${mediaTags}\n`
  );
}

export function rewritePlaylist(playlist: string, config: RewriteConfig): string {
  if (playlist.includes("#EXT-X-STREAM-INF")) {
    return rewriteMaster(playlist, config.sourceUrl, config.subtitles, config.mode);
  }
  return wrapMediaPlaylist(config.sourceUrl, config.subtitles);
}

export type Fetcher = (url: string) => Promise<string>;

const defaultFetcher: Fetcher = async (url) => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch playlist: ${response.status} ${response.statusText}`);
  }
  return await response.text();
};

export async function buildResponseBody(
  config: RewriteConfig,
  fetcher: Fetcher = defaultFetcher,
): Promise<string> {
  const playlist = await fetcher(config.sourceUrl);
  return rewritePlaylist(playlist, config);
}

export async function handler(
  _event: APIGatewayProxyEventV2,
  _context?: Context,
): Promise<APIGatewayProxyResultV2> {
  const config = loadConfigFromEnv();
  const body = await buildResponseBody(config);
  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/vnd.apple.mpegurl",
      "Cache-Control": "no-cache",
    },
    body,
  };
}
