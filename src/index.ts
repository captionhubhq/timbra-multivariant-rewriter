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
import { ConfigLoader } from "./config-loader";
import { FlowClient, FlowError } from "./flow-client";

export { PlaylistRewriter, PlaylistProxy, ConfigParser, ConfigError, ConfigLoader, FlowClient, FlowError };
export type { Mode, RewriteConfig, SubtitlePlaylist };

export async function handler(
  event: APIGatewayProxyEventV2,
  _context?: Context,
): Promise<APIGatewayProxyResultV2> {
  let config: RewriteConfig;
  try {
    config = await ConfigLoader.load();
  } catch (err) {
    if (err instanceof ConfigError) {
      return plainText(500, `Lambda misconfigured: ${err.message}`);
    }
    if (err instanceof FlowError) {
      return plainText(502, `Could not load flow from CaptionHub: ${err.message}`);
    }
    throw err;
  }

  const rewriter = new PlaylistRewriter(config);
  const proxy = new PlaylistProxy(config.sourceUrl, rewriter);
  return await proxy.handle(event.requestContext?.http?.method);
}

function plainText(statusCode: number, body: string): APIGatewayProxyResultV2 {
  return { statusCode, headers: { "Content-Type": "text/plain" }, body };
}
