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

describe("PlaylistRewriter subtitle groups", () => {
  const REDUNDANT = [
    "#EXTM3U",
    "",
    "#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720",
    "https://primary.example.com/medium.m3u8",
    "",
    "#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720",
    "https://backup.example.com/medium.m3u8",
    " ",
    "#EXT-X-STREAM-INF: BANDWIDTH=5000000,RESOLUTION=1920x1080",
    "https://primary.example.com/high.m3u8",
    "",
    "#EXT-X-STREAM-INF: BANDWIDTH=5000000,RESOLUTION=1920x1080",
    "https://backup.example.com/high.m3u8",
    "",
  ].join("\n");

  function track(groupId: string, variantPattern: string | undefined, project: string): SubtitlePlaylist {
    return {
      label: "English",
      language: "en",
      default: true,
      url: `https://cdn.captionhub.com/live/${project}/en.m3u8`,
      groupId,
      variantPattern,
    };
  }

  test("routes each variant to the group whose pattern matches its URI", () => {
    const rewriter = new PlaylistRewriter({
      sourceUrl: "https://origin.example.com/master.m3u8",
      mode: "add",
      subtitles: [
        track("primary-captions", "^https://primary\\.", "primary_project"),
        track("backup-captions", "^https://backup\\.", "secondary_project"),
      ],
    });

    const output = rewriter.rewrite(REDUNDANT);

    expect(output).toContain('RESOLUTION=1280x720,SUBTITLES="primary-captions"\nhttps://primary.example.com/medium.m3u8');
    expect(output).toContain('RESOLUTION=1280x720,SUBTITLES="backup-captions"\nhttps://backup.example.com/medium.m3u8');
    expect(output).toContain('RESOLUTION=1920x1080,SUBTITLES="primary-captions"\nhttps://primary.example.com/high.m3u8');
    expect(output).toContain('RESOLUTION=1920x1080,SUBTITLES="backup-captions"\nhttps://backup.example.com/high.m3u8');
    expect(output).toContain('GROUP-ID="primary-captions",NAME="English",DEFAULT=YES,AUTOSELECT=YES,FORCED=NO,LANGUAGE="en",URI="https://cdn.captionhub.com/live/primary_project/en.m3u8"');
    expect(output).toContain('GROUP-ID="backup-captions",NAME="English",DEFAULT=YES,AUTOSELECT=YES,FORCED=NO,LANGUAGE="en",URI="https://cdn.captionhub.com/live/secondary_project/en.m3u8"');
  });

  test("variants matching no pattern fall back to a group without one", () => {
    const rewriter = new PlaylistRewriter({
      sourceUrl: "https://origin.example.com/master.m3u8",
      mode: "add",
      subtitles: [
        track("primary-captions", "^https://primary\\.", "primary_project"),
        track("everything-else", undefined, "fallback_project"),
      ],
    });

    const output = rewriter.rewrite(REDUNDANT);

    expect(output).toContain('SUBTITLES="primary-captions"\nhttps://primary.example.com/medium.m3u8');
    expect(output).toContain('SUBTITLES="everything-else"\nhttps://backup.example.com/medium.m3u8');
  });

  test("replace mode rewrites existing SUBTITLES attributes to the matched group", () => {
    const playlist = [
      "#EXTM3U",
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="old",NAME="Old",LANGUAGE="en",URI="https://old.example.com/en.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=2000000,SUBTITLES="old"',
      "https://backup.example.com/medium.m3u8",
      "",
    ].join("\n");
    const rewriter = new PlaylistRewriter({
      sourceUrl: "https://origin.example.com/master.m3u8",
      mode: "replace",
      subtitles: [track("backup-captions", "^https://backup\\.", "secondary_project")],
    });

    const output = rewriter.rewrite(playlist);

    expect(output).toContain('BANDWIDTH=2000000,SUBTITLES="backup-captions"\nhttps://backup.example.com/medium.m3u8');
    expect(output).not.toContain('GROUP-ID="old"');
  });

  test("uses the default group when no track sets one", () => {
    const rewriter = new PlaylistRewriter({
      sourceUrl: "https://origin.example.com/master.m3u8",
      mode: "add",
      subtitles: [{ label: "English", language: "en", url: "https://cdn.captionhub.com/en.m3u8" }],
    });

    const output = rewriter.rewrite(REDUNDANT);

    expect(output.match(/SUBTITLES="subs"/g)).toHaveLength(4);
    expect(output).toContain('GROUP-ID="subs"');
  });
});
