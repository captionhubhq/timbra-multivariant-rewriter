# timbra-multivariant-rewriter

AWS Lambda that proxies an HLS multivariant (master) playlist and injects
subtitle tracks. Existing relative URIs in the upstream playlist are
absolutised so the response stands on its own from any origin.

## Configuration

Set these env vars on the Lambda:

| Var | Required | Default | Description |
| --- | --- | --- | --- |
| `PLAYLIST_URL` | yes | — | Upstream HLS master playlist URL. |
| `SUBTITLE_PLAYLISTS` | yes | `[]` | JSON array of subtitle tracks (see below). |
| `MODE` | no | `add` | `add` keeps existing subtitle tracks; `replace` strips them and substitutes the configured set. |

`SUBTITLE_PLAYLISTS` shape:

```json
[
  {
    "label": "English",
    "language": "en",
    "default": true,
    "url": "https://captions.example.com/streams/abc/en.m3u8"
  },
  {
    "label": "Nederlands",
    "language": "nl",
    "default": false,
    "url": "https://captions.example.com/streams/abc/nl.m3u8"
  }
]
```

## Deploy

```sh
npm install
npm run build
cd dist && zip -r ../function.zip . && cd ..
zip -ur function.zip node_modules
```

Upload `function.zip` to a Node.js 20+ Lambda with handler `index.handler`.
Front it with a Function URL or API Gateway HTTP API; the Lambda speaks the
API Gateway v2 event shape.

## Usage

```sh
curl https://<your-lambda-url>/   # returns rewritten master playlist
```

Players can point at the Function URL anywhere they'd point at the source
master playlist. The response:

- Sets `Content-Type: application/vnd.apple.mpegurl`.
- Forwards `Cache-Control`, `Age`, `Date`, `Expires` from the origin.
- Strips body-dependent origin headers (`ETag`, `Last-Modified`,
  `Content-Length`, `Content-Encoding`, `Vary`).
- Adds permissive CORS so browser-based players can fetch it cross-origin.
- Handles `HEAD` (empty body, same headers) and `OPTIONS` (204 preflight).
- Maps upstream fetch failures to `502` and passes through upstream `4xx`/
  `5xx` bodies unchanged.

Client request headers are **not** forwarded to the origin — the proxy
always issues a clean upstream request.

## Develop

```sh
npm test        # jest with snapshot coverage over test_hls_manifests/
npm run build   # tsc → dist/
```

To refresh snapshots after a logic change: `npx jest -u`.

### Try the Lambda locally

`scripts/local.ts` boots an HTTP server on `localhost:4444` that wraps the
Lambda handler — every request is turned into an API Gateway v2 event and
piped through `handler()`, so it exercises the real proxy + rewriter code.

```sh
npm run dev
curl -s http://localhost:4444/ | head -30
```

The script ships with example defaults pointing at Mux's public
[Tears of Steel test stream](https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8)
(a five-bitrate multivariant manifest with relative URIs and no existing
subtitle tracks) and two placeholder CaptionHub subtitle URLs, so it
works out of the box with no setup. Fetch the raw upstream playlist to
compare against the rewritten output:

```sh
curl -s https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8
```

Override any field by exporting the relevant env var before `npm run dev`:

```sh
PLAYLIST_URL=https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8 \
  SUBTITLE_PLAYLISTS='[{"label":"EN","language":"en","default":true,"url":"https://captions.example.com/en.m3u8"}]' \
  MODE=add \
  npm run dev
```
