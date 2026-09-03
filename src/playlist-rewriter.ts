export interface SubtitlePlaylist {
  label: string;
  language: string;
  default?: boolean;
  url: string;
  /** GROUP-ID for the EXT-X-MEDIA tag. Defaults to "subs". */
  groupId?: string;
  /**
   * Regular expression tested against each variant's URI. Variants that
   * match get SUBTITLES set to this track's group. Tracks in one group
   * share the first pattern defined among them.
   */
  variantPattern?: string;
}

interface SubtitleGroup {
  id: string;
  pattern?: RegExp;
}

export type Mode = "add" | "replace";

export interface RewriteConfig {
  sourceUrl: string;
  subtitles: SubtitlePlaylist[];
  mode: Mode;
}

export class PlaylistRewriter {
  private static readonly DEFAULT_GROUP_ID = "subs";
  private static readonly ABSOLUTE_URL = /^https?:\/\//i;

  private readonly groups: SubtitleGroup[];

  constructor(private readonly config: RewriteConfig) {
    this.groups = PlaylistRewriter.collectGroups(config.subtitles);
  }

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

    const rewritten = lines.map((line, index) => {
      if (!line.startsWith("#EXT-X-STREAM-INF")) return line;

      const group = this.groupFor(PlaylistRewriter.variantUri(lines, index));

      if (line.includes("SUBTITLES=")) {
        if (replace) {
          return line.replace(/SUBTITLES="[^"]+"/, `SUBTITLES="${group}"`);
        }
        return line;
      }

      const trailingNewline = line.endsWith("\n") ? "\n" : "";
      return (
        line.replace(/\n$/, "") +
        `,SUBTITLES="${group}"` +
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
      `#EXT-X-STREAM-INF:BANDWIDTH=1655093,AVERAGE-BANDWIDTH=1332156,SUBTITLES="${this.groupFor(this.config.sourceUrl)}"\n` +
      `${this.config.sourceUrl}\n` +
      `${this.subtitleMediaTags().join("\n")}\n`
    );
  }

  /**
   * Picks the GROUP-ID a variant should reference: the first group whose
   * pattern matches the variant URI, else the first group without a
   * pattern, else the default group.
   */
  private groupFor(variantUri: string): string {
    const matched = this.groups.find((g) => g.pattern?.test(variantUri));
    if (matched) return matched.id;
    const general = this.groups.find((g) => !g.pattern);
    return general?.id ?? PlaylistRewriter.DEFAULT_GROUP_ID;
  }

  private static collectGroups(subtitles: SubtitlePlaylist[]): SubtitleGroup[] {
    const groups: SubtitleGroup[] = [];
    for (const track of subtitles) {
      const id = PlaylistRewriter.groupIdOf(track);
      let group = groups.find((g) => g.id === id);
      if (!group) {
        group = { id };
        groups.push(group);
      }
      if (!group.pattern && track.variantPattern) {
        group.pattern = new RegExp(track.variantPattern);
      }
    }
    return groups;
  }

  private static groupIdOf(track: SubtitlePlaylist): string {
    return track.groupId || PlaylistRewriter.DEFAULT_GROUP_ID;
  }

  /** The URI line that follows an EXT-X-STREAM-INF tag. */
  private static variantUri(lines: string[], from: number): string {
    for (let i = from + 1; i < lines.length; i++) {
      const candidate = lines[i].trim();
      if (candidate && !candidate.startsWith("#")) return candidate;
    }
    return "";
  }

  private subtitleMediaTags(): string[] {
    return this.config.subtitles.map((p) => {
      const defaultFlag = p.default ? "YES" : "NO";
      const language = (p.language ?? "").toLowerCase();
      const name = p.label || language || "Subtitles";
      return (
        `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="${PlaylistRewriter.groupIdOf(p)}",` +
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
