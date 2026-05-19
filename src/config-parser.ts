import {
  Mode,
  RewriteConfig,
  SubtitlePlaylist,
} from "./playlist-rewriter";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export class ConfigParser {
  static fromEnv(env: NodeJS.ProcessEnv = process.env): RewriteConfig {
    return new ConfigParser(env).parse();
  }

  constructor(private readonly env: NodeJS.ProcessEnv) {}

  parse(): RewriteConfig {
    return {
      sourceUrl: this.parseSourceUrl(),
      subtitles: this.parseSubtitles(),
      mode: this.parseMode(),
    };
  }

  private parseSourceUrl(): string {
    const sourceUrl = this.env.PLAYLIST_URL;
    if (!sourceUrl) {
      throw new ConfigError("PLAYLIST_URL env var is required");
    }
    if (!ConfigParser.isHttpUrl(sourceUrl)) {
      throw new ConfigError("PLAYLIST_URL must be an http(s) URL");
    }
    return sourceUrl;
  }

  private parseMode(): Mode {
    const mode = this.env.MODE ?? "add";
    if (mode !== "add" && mode !== "replace") {
      throw new ConfigError(
        `MODE must be "add" or "replace", got "${mode}"`,
      );
    }
    return mode;
  }

  private parseSubtitles(): SubtitlePlaylist[] {
    const raw = this.env.SUBTITLE_PLAYLISTS ?? "[]";

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ConfigError(`SUBTITLE_PLAYLISTS must be valid JSON: ${message}`);
    }

    if (!Array.isArray(parsed)) {
      throw new ConfigError("SUBTITLE_PLAYLISTS must be a JSON array");
    }

    return parsed.map((entry, i) => ConfigParser.parseSubtitleEntry(entry, i));
  }

  private static parseSubtitleEntry(entry: unknown, index: number): SubtitlePlaylist {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new ConfigError(`SUBTITLE_PLAYLISTS[${index}] must be an object`);
    }
    const obj = entry as Record<string, unknown>;

    for (const field of ["label", "language", "url"] as const) {
      const value = obj[field];
      if (typeof value !== "string" || value.length === 0) {
        throw new ConfigError(
          `SUBTITLE_PLAYLISTS[${index}].${field} must be a non-empty string`,
        );
      }
    }

    if (!ConfigParser.isHttpUrl(obj.url as string)) {
      throw new ConfigError(
        `SUBTITLE_PLAYLISTS[${index}].url must be an http(s) URL`,
      );
    }

    if (obj.default !== undefined && typeof obj.default !== "boolean") {
      throw new ConfigError(
        `SUBTITLE_PLAYLISTS[${index}].default must be a boolean when present`,
      );
    }

    return {
      label: obj.label as string,
      language: obj.language as string,
      default: obj.default as boolean | undefined,
      url: obj.url as string,
    };
  }

  private static isHttpUrl(value: string): boolean {
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  }
}
