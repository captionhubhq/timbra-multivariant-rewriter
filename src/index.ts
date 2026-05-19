import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  Context,
} from "aws-lambda";
import {
  Mode,
  PlaylistRewriter,
  RewriteConfig,
  SubtitlePlaylist,
} from "./playlist-rewriter";
import { PlaylistProxy } from "./playlist-proxy";

export { PlaylistRewriter, PlaylistProxy };
export type { Mode, RewriteConfig, SubtitlePlaylist };

export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RewriteConfig {
  const sourceUrl = env.PLAYLIST_URL;
  if (!sourceUrl) {
    throw new Error("PLAYLIST_URL env var is required");
  }

  const subtitles = JSON.parse(env.SUBTITLE_PLAYLISTS ?? "[]") as SubtitlePlaylist[];

  const mode = (env.MODE ?? "add") as Mode;
  if (mode !== "add" && mode !== "replace") {
    throw new Error(`MODE must be "add" or "replace", got "${mode}"`);
  }

  return { sourceUrl, subtitles, mode };
}

export async function handler(
  event: APIGatewayProxyEventV2,
  _context?: Context,
): Promise<APIGatewayProxyResultV2> {
  const config = loadConfigFromEnv();
  const rewriter = new PlaylistRewriter(config);
  const proxy = new PlaylistProxy(config.sourceUrl, rewriter);
  return await proxy.handle(event.requestContext?.http?.method);
}
