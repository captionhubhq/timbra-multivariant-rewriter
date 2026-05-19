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
import { ConfigError, ConfigParser } from "./config-parser";

export { PlaylistRewriter, PlaylistProxy, ConfigParser, ConfigError };
export type { Mode, RewriteConfig, SubtitlePlaylist };

export async function handler(
  event: APIGatewayProxyEventV2,
  _context?: Context,
): Promise<APIGatewayProxyResultV2> {
  let config: RewriteConfig;
  try {
    config = ConfigParser.fromEnv();
  } catch (err) {
    if (err instanceof ConfigError) {
      return {
        statusCode: 500,
        headers: { "Content-Type": "text/plain" },
        body: `Lambda misconfigured: ${err.message}`,
      };
    }
    throw err;
  }

  const rewriter = new PlaylistRewriter(config);
  const proxy = new PlaylistProxy(config.sourceUrl, rewriter);
  return await proxy.handle(event.requestContext?.http?.method);
}
