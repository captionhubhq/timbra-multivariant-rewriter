import * as http from "http";
import type { APIGatewayProxyEventV2, Context } from "aws-lambda";
import { handler } from "../src/index";

// Example defaults. Override any of these by exporting the env var before
// running the script. The source playlist is Mux's public Tears of Steel
// test stream (multivariant, no existing subtitle tracks). The subtitle
// tracks use the same shape as `output_details.hls_output.playlist_tracks`
// in the CaptionHub API's flow response; the URLs are placeholders, the
// rewriter doesn't fetch them.
//
// With CAPTIONHUB_FLOW_ID (or CAPTIONHUB_FLOWS) and CAPTIONHUB_API_TOKEN
// set, the defaults are skipped and the flow supplies both values.
const usingFlow = Boolean(process.env.CAPTIONHUB_FLOW_ID || process.env.CAPTIONHUB_FLOWS);

if (!usingFlow) process.env.PLAYLIST_URL ??=
  "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8";

if (!usingFlow) process.env.SUBTITLE_PLAYLISTS ??= JSON.stringify([
  {
    language_name: "English",
    default: true,
    language_code: "en",
    url: "https://cdn.captionhub.com/live/vtt/playlist/en/demo.m3u8",
  },
  {
    language_name: "Nederlands",
    default: false,
    language_code: "nl",
    url: "https://cdn.captionhub.com/live/vtt/playlist/nl/demo.m3u8",
  },
]);

process.env.MODE ??= "add";

const PORT = Number(process.env.PORT ?? 4444);

const server = http.createServer(async (req, res) => {
  const event = {
    requestContext: { http: { method: req.method ?? "GET" } },
    headers: req.headers as Record<string, string>,
  } as unknown as APIGatewayProxyEventV2;

  const result = await handler(event, {} as Context);
  const statusCode = typeof result === "object" && "statusCode" in result
    ? (result.statusCode ?? 200)
    : 200;
  const headers = typeof result === "object" && "headers" in result ? result.headers : undefined;
  const body = typeof result === "object" && "body" in result ? result.body : "";

  res.statusCode = statusCode;
  if (headers) {
    for (const [key, value] of Object.entries(headers)) {
      if (value !== undefined) res.setHeader(key, String(value));
    }
  }
  res.end(body ?? "");
});

server.listen(PORT, () => {
  console.log(`Lambda available at http://localhost:${PORT}/`);
  console.log(
    usingFlow
      ? `Flow: ${process.env.CAPTIONHUB_FLOW_ID ?? process.env.CAPTIONHUB_FLOWS}`
      : `Source playlist: ${process.env.PLAYLIST_URL}`,
  );
  console.log(`Mode: ${process.env.MODE}`);
});
