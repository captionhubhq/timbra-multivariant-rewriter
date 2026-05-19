import * as fs from "fs";
import * as path from "path";
import { buildResponseBody, RewriteConfig, SubtitlePlaylist } from "./index";

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

function configFor(mode: "add" | "replace"): RewriteConfig {
  return { sourceUrl: SOURCE_URL, subtitles: SUBTITLES, mode };
}

function fetcherFor(manifestName: string) {
  const body = fs.readFileSync(path.join(MANIFEST_DIR, manifestName), "utf8");
  return async () => body;
}

describe("rewriter against test_hls_manifests", () => {
  describe.each(MANIFESTS)("%s", (manifest) => {
    test("mode=add", async () => {
      const config = configFor("add");
      const result = await buildResponseBody(config, fetcherFor(manifest));
      expect(result).toMatchSnapshot();
    });

    test("mode=replace", async () => {
      const config = configFor("replace");
      const result = await buildResponseBody(config, fetcherFor(manifest));
      expect(result).toMatchSnapshot();
    });
  });
});
