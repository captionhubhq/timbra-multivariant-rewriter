export interface SubtitlePlaylist {
  label: string;
  language: string;
  default?: boolean;
  url: string;
}

export type Mode = "add" | "replace";

export interface RewriteConfig {
  sourceUrl: string;
  subtitles: SubtitlePlaylist[];
  mode: Mode;
}

export class PlaylistRewriter {
  private static readonly GROUP_ID = "subs";
  private static readonly ABSOLUTE_URL = /^https?:\/\//i;

  constructor(private readonly config: RewriteConfig) {}

  rewrite(playlist: string): string {
    if (playlist.includes("#EXT-X-STREAM-INF")) {
      return this.rewriteMaster(playlist);
    }
    return this.wrapMediaPlaylist();
  }

  private rewriteMaster(playlist: string): string {
    const replace = this.config.mode === "replace";
    let lines = this.absolutisePlaylist(playlist);

    if (replace) {
      lines = lines.map((line) =>
        line.includes("EXT-X-MEDIA:TYPE=SUBTITLES")
          ? "# NOTE: Existing subtitles removed by CaptionHub\n"
          : line,
      );
    }

    const rewritten = lines.map((line) => {
      if (!line.startsWith("#EXT-X-STREAM-INF")) return line;

      if (line.includes("SUBTITLES=")) {
        if (replace) {
          return line.replace(
            /SUBTITLES="[^"]+"/,
            `SUBTITLES="${PlaylistRewriter.GROUP_ID}"`,
          );
        }
        return line;
      }

      const trailingNewline = line.endsWith("\n") ? "\n" : "";
      return (
        line.replace(/\n$/, "") +
        `,SUBTITLES="${PlaylistRewriter.GROUP_ID}"` +
        trailingNewline
      );
    });

    return (
      rewritten.join("") +
      "\n\n# NOTE: the following captions are added by CaptionHub:\n\n" +
      this.subtitleMediaTags().join("\n") +
      "\n"
    );
  }

  private wrapMediaPlaylist(): string {
    return (
      "#EXTM3U\n" +
      "#EXT-X-VERSION:3\n" +
      `#EXT-X-STREAM-INF:BANDWIDTH=1655093,AVERAGE-BANDWIDTH=1332156,SUBTITLES="${PlaylistRewriter.GROUP_ID}"\n` +
      `${this.config.sourceUrl}\n` +
      `${this.subtitleMediaTags().join("\n")}\n`
    );
  }

  private subtitleMediaTags(): string[] {
    return this.config.subtitles.map((p) => {
      const defaultFlag = p.default ? "YES" : "NO";
      const language = (p.language ?? "").toLowerCase();
      const name = p.label || language || "Subtitles";
      return (
        `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="${PlaylistRewriter.GROUP_ID}",` +
        `NAME="${name}",DEFAULT=${defaultFlag},AUTOSELECT=YES,FORCED=NO,` +
        `LANGUAGE="${language}",URI="${p.url}",CHARACTERISTICS="public.machine-generated"`
      );
    });
  }

  private absolutisePlaylist(playlist: string): string[] {
    const base = this.baseUrl();
    return playlist.split(/(?<=\n)/).map((rawLine) => {
      const stripped = rawLine.trim();
      let line = rawLine;
      if (
        stripped &&
        !stripped.startsWith("#") &&
        !PlaylistRewriter.ABSOLUTE_URL.test(stripped)
      ) {
        const newline = rawLine.endsWith("\n") ? "\n" : "";
        line = base + stripped + newline;
      }
      return line.replace(/URI="([^"]+)"/g, (_match, uri: string) => {
        const absolute = PlaylistRewriter.ABSOLUTE_URL.test(uri) ? uri : base + uri;
        return `URI="${absolute}"`;
      });
    });
  }

  private baseUrl(): string {
    const idx = this.config.sourceUrl.lastIndexOf("/");
    return idx >= 0
      ? this.config.sourceUrl.slice(0, idx + 1)
      : this.config.sourceUrl + "/";
  }
}
