import * as fs from "fs";
import * as path from "path";
import { PlaylistRewriter, SubtitlePlaylist } from "./playlist-rewriter";

const MANIFEST_DIR = path.join(__dirname, "..", "test_hls_manifests");

const SUBTITLES: SubtitlePlaylist[] = [
  {
    label: "English",
    language: "en",
    default: true,
    url: "https://captions.example.com/streams/abc/en.m3u8",
  },
  {
    label: "Nederlands",
    language: "nl",
    default: false,
    url: "https://captions.example.com/streams/abc/nl.m3u8",
  },
];

const SOURCE_URL = "https://example.com/multivariant.m3u8";

const MANIFESTS = fs
  .readdirSync(MANIFEST_DIR)
  .filter((name) => name.endsWith(".m3u8"))
  .sort();

describe("PlaylistRewriter against test_hls_manifests", () => {
  describe.each(MANIFESTS)("%s", (manifest) => {
    const body = fs.readFileSync(path.join(MANIFEST_DIR, manifest), "utf8");

    test("mode=add", () => {
      const rewriter = new PlaylistRewriter({
        sourceUrl: SOURCE_URL,
        subtitles: SUBTITLES,
        mode: "add",
      });
      expect(rewriter.rewrite(body)).toMatchSnapshot();
    });

    test("mode=replace", () => {
      const rewriter = new PlaylistRewriter({
        sourceUrl: SOURCE_URL,
        subtitles: SUBTITLES,
        mode: "replace",
      });
      expect(rewriter.rewrite(body)).toMatchSnapshot();
    });
  });
});
