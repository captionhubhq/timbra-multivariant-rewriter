import * as http from "http";
import type { APIGatewayProxyEventV2, Context } from "aws-lambda";
import { handler } from "../src/index";

// Example defaults — override any of these by exporting the env var before
// running the script. The source playlist is Mux's public Tears of Steel
// test stream (multivariant, no existing subtitle tracks). The subtitle URLs
// are placeholders — the rewriter doesn't fetch them.
process.env.PLAYLIST_URL ??=
  "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8";

process.env.SUBTITLE_PLAYLISTS ??= JSON.stringify([
  {
    label: "English (CaptionHub)",
    language: "en",
    default: true,
    url: "https://captions.example.com/streams/demo/en.m3u8",
  },
  {
    label: "Nederlands (CaptionHub)",
    language: "nl",
    default: false,
    url: "https://captions.example.com/streams/demo/nl.m3u8",
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
  console.log(`Source playlist: ${process.env.PLAYLIST_URL}`);
  console.log(`Mode: ${process.env.MODE}`);
});
