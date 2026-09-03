# timbra-multivariant-rewriter

AWS Lambda that proxies an HLS multivariant (master) playlist and injects
subtitle tracks. Existing relative URIs in the upstream playlist are
absolutised so the response stands on its own from any origin.

## Typical use case

A CaptionHub Timbra flow with
[HLS output](https://support.captionhub.com/timbra/anHrwmAnQCHCsf4DjG5uGX/introduction-to-hls-output/3dXFPaRPW6sRmxQg2CPBBX)
publishes one WebVTT playlist per caption language. The knowledge base
describes two ways to get those into a player:
[edit your own multivariant playlist](https://support.captionhub.com/timbra/anHrwmAnQCHCsf4DjG5uGX/integrate-captions-into-your-hls-manifest/38A8ShVEARoBJqhfcLUBjf),
or point the player at the
[modified manifest CaptionHub hosts](https://support.captionhub.com/timbra/anHrwmAnQCHCsf4DjG5uGX/use-a-modified-hls-manifest-from-captionhub/38A8ShVEAPqYPACV97Gvq9)
(`modified_multivariant_url` in the API). This repository is a third
option for teams that want the rewrite done automatically but served
from infrastructure they control: their own domain and CDN, their own
access controls, or a player that must not be repointed at a third-party
host.

Two differences from the hosted manifest are worth knowing:

- The hosted manifest only lists subtitle tracks while a flow is
  actively captioning, which the knowledge base notes can make Safari and
  iOS drop captions and switch rendition. This rewriter always lists the
  configured tracks, so the player's view of the playlist is stable.
- The hosted manifest picks up language changes on its own. Here the
  tracks are configuration, so they must be refreshed by hand.

The Lambda's configuration is the flow's API representation, so setting
it up is a copy-and-paste job. (For a playlist that never changes, the
[command-line tool](#rewrite-once-from-the-command-line) does the same
rewrite without deploying anything.)

1. Fetch the flow from the CaptionHub API
   ([Get flow](https://api-docs.captionhub.com/docs/captionhub/659557c352a16-get-flow)).
   The token comes from the API tab in your team settings; see
   [Create an API key](https://support.captionhub.com/developers/4fuH3UnM2RNWB81Y6NEHgg/create-an-api-key/4fuH3UnM2TMshgmtLt4DNy).
   The same URLs are shown in the CaptionHub UI under **HLS
   integration** on the flow.

   ```sh
   curl -s -H "Authorization: $CAPTIONHUB_API_TOKEN" \
     https://api.captionhub.com/v1/timbra/<flow_id>
   ```

   The response includes the source stream and the caption tracks:

   ```json
   {
     "flow_id": "bd62751212",
     "name": "Live stream 24/7",
     "hls_details": {
       "hls_url": "https://hls.example.com/live/stream.m3u8",
       "hls_transcription_url": null
     },
     "output_details": {
       "hls_output": {
         "modified_multivariant_url": "https://hls.captionhub.com/live/modified_multivariant/stream.m3u8?token=abc123",
         "playlist_tracks": [
           {
             "language_name": "English",
             "default": true,
             "language_code": "en",
             "url": "https://cdn.captionhub.com/live/vtt/playlist/en/stream.m3u8"
           },
           {
             "language_name": "Nederlands",
             "default": false,
             "language_code": "nl",
             "url": "https://cdn.captionhub.com/live/vtt/playlist/nl/stream.m3u8"
           }
         ]
       }
     }
   }
   ```

2. Map two fields from the response onto the Lambda's env vars:

   | Env var | Value |
   | --- | --- |
   | `PLAYLIST_URL` | `hls_details.hls_url`, the multivariant playlist CaptionHub is pulling from. |
   | `SUBTITLE_PLAYLISTS` | `output_details.hls_output.playlist_tracks`, verbatim. |
   | `MODE` | `add`, or `replace` if the source playlist already carries subtitle tracks that should be dropped. |

   With `jq`, the second one is a one-liner:

   ```sh
   curl -s -H "Authorization: $CAPTIONHUB_API_TOKEN" \
     https://api.captionhub.com/v1/timbra/<flow_id> \
     | jq -c '.output_details.hls_output.playlist_tracks'
   ```

3. Deploy (see [Deploy](#deploy)) and point players at the Function URL
   instead of the source playlist. The Lambda fetches the source playlist
   on every request and appends one `EXT-X-MEDIA` subtitle entry per
   track, so the output tracks the live stream while the caption tracks
   stay fixed.

If the flow's languages change, fetch the flow again and update
`SUBTITLE_PLAYLISTS`. The Lambda does not call the CaptionHub API
itself.

## Rewrite once from the command line

The same rewriting is available as a CLI for cases where a Lambda is
overkill: a VOD asset whose playlist never changes, a one-off check of
what the output will look like, or a build step that writes the playlist
to a static host. Run it from a checkout with `npm run rewrite --`, or
install it globally with `npm install -g .` to get a `timbra-rewrite`
command.

```sh
# Fetch the source playlist and add tracks from a JSON file
npm run rewrite -- \
  --playlist https://hls.example.com/live/stream.m3u8 \
  --subtitles tracks.json

# Pipe the tracks straight from the CaptionHub API
curl -s -H "Authorization: $CAPTIONHUB_API_TOKEN" \
    https://api.captionhub.com/v1/timbra/<flow_id> \
  | jq -c '.output_details.hls_output.playlist_tracks' \
  | npm run rewrite -- --playlist https://hls.example.com/live/stream.m3u8 --subtitles -

# Rewrite a local file and write the result next to it
npm run rewrite -- \
  --playlist ./master.m3u8 \
  --base-url https://hls.example.com/vod/master.m3u8 \
  --subtitles tracks.json \
  --output ./master_with_captions.m3u8
```

| Flag | Meaning |
| --- | --- |
| `--playlist <url\|file\|->` | Source playlist. An http(s) URL is fetched with the same timeout and validation as the Lambda; anything else is read as a file, `-` reads stdin. |
| `--base-url <url>` | Where the source playlist is served from. Required for a file or stdin, since relative URIs are resolved against it. Optional for a URL, where it overrides the fetched URL. |
| `--subtitles <file\|json\|->` | Tracks as a JSON file, an inline JSON array, or `-` for stdin. Same shape and validation as `SUBTITLE_PLAYLISTS`. |
| `--mode <add\|replace>` | Same as the `MODE` env var. Defaults to `add`. |
| `--output <file>` | Write to a file instead of stdout. |

Exit status is 0 on success, 2 for a usage or configuration error, and 1
when the fetch fails or the input is not an HLS playlist. Unlike the
Lambda, the output is a snapshot: rerun the command when the source
playlist or the flow's tracks change.

## Configuration

Set these env vars on the Lambda:

| Var | Required | Default | Description |
| --- | --- | --- | --- |
| `PLAYLIST_URL` | yes | — | Upstream HLS master playlist URL. |
| `SUBTITLE_PLAYLISTS` | yes | `[]` | JSON array of subtitle tracks (see below). |
| `MODE` | no | `add` | `add` keeps existing subtitle tracks; `replace` strips them and substitutes the configured set. |

`SUBTITLE_PLAYLISTS` is a JSON array with one object per caption track. The
keys are the same ones the CaptionHub API uses for `playlist_tracks` in a
flow's `output_details.hls_output`, so that array can be pasted in
unchanged (see [Typical use case](#typical-use-case)):

```json
[
  {
    "language_name": "English",
    "default": true,
    "language_code": "en",
    "url": "https://cdn.captionhub.com/live/vtt/playlist/en/stream.m3u8"
  },
  {
    "language_name": "Nederlands",
    "default": false,
    "language_code": "nl",
    "url": "https://cdn.captionhub.com/live/vtt/playlist/nl/stream.m3u8"
  }
]
```

Each entry becomes one `EXT-X-MEDIA` tag, with the attributes the
knowledge base recommends in
[Integrate captions into your HLS manifest](https://support.captionhub.com/timbra/anHrwmAnQCHCsf4DjG5uGX/integrate-captions-into-your-hls-manifest/38A8ShVEARoBJqhfcLUBjf),
and every `EXT-X-STREAM-INF` line gains `SUBTITLES="subs"`.

| Key | Required | Used for |
| --- | --- | --- |
| `language_name` | yes | `NAME` attribute of the `EXT-X-MEDIA` tag. |
| `language_code` | yes | `LANGUAGE` attribute. |
| `url` | yes | `URI` attribute. Must be http(s). |
| `default` | no | `DEFAULT=YES` when true. Omitted or false gives `DEFAULT=NO`. |

`label` and `language` are accepted as alternative spellings of
`language_name` and `language_code`, and take precedence when both are
present.

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
- Passes through upstream `4xx`/`5xx` bodies unchanged.
- Aborts the upstream fetch after 10s and returns `504 Gateway Timeout`.
- Returns `502 Bad Gateway` when the upstream connection fails, the body
  is empty, exceeds 5 MB, or doesn't start with `#EXTM3U` (i.e. isn't an
  HLS playlist). Tolerates a leading UTF-8 BOM.

Client request headers are **not** forwarded to the origin — the proxy
always issues a clean upstream request.

### Limitations

- **One subtitle group for all variants.** Every track goes into
  `GROUP-ID="subs"` and every variant references that group. The
  knowledge base's
  [redundant stream setup](https://support.captionhub.com/timbra/anHrwmAnQCHCsf4DjG5uGX/recommendations-for-a-redundant-stream/5GDESEkCzbveVXsmdRATwm),
  where primary and backup renditions point at different caption
  projects via different group IDs, is not expressible with this
  configuration.
- **Redirects on `PLAYLIST_URL` are not fully handled.** The upstream
  fetch follows `3xx` hops, but relative URIs inside the playlist are
  resolved against the configured `PLAYLIST_URL`, not the post-redirect
  URL that `fetch` actually landed on. If the redirect target serves
  the playlist from a different host or path prefix (typical of CDN
  geo-routing or signed-URL handoffs), the rewritten segment URLs will
  point at the wrong origin. Workaround: configure `PLAYLIST_URL` with
  the final, non-redirecting URL.

## Further reading

- [Timbra knowledge base](https://support.captionhub.com/timbra/anHrwmAnQCHCsf4DjG5uGX),
  in particular the "Output: captions via HLS integration" collection.
- [Using a HLS feed as a source](https://support.captionhub.com/timbra/anHrwmAnQCHCsf4DjG5uGX/using-a-hls-feed-as-a-source/389b3dFua53GBBnXcWWxf7):
  requirements the source stream behind `PLAYLIST_URL` has to meet.
- [Introduction to HLS output](https://support.captionhub.com/timbra/anHrwmAnQCHCsf4DjG5uGX/introduction-to-hls-output/3dXFPaRPW6sRmxQg2CPBBX):
  players known to work with WebVTT subtitle tracks.
- [CaptionHub API reference](https://api-docs.captionhub.com/docs/captionhub/b0fb6beb9cd7e-caption-hub-api).

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
  SUBTITLE_PLAYLISTS='[{"language_name":"English","default":true,"language_code":"en","url":"https://cdn.captionhub.com/live/vtt/playlist/en/demo.m3u8"}]' \
  MODE=add \
  npm run dev
```
