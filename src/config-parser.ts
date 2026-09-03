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

/** One CaptionHub flow whose tracks should be pulled from the API. */
export interface FlowSettings {
  flowId: string;
  groupId?: string;
  variantPattern?: string;
}

export interface ApiSettings {
  url: string;
  token: string;
  cacheMs: number;
}

/**
 * What the env vars say on their own. sourceUrl and subtitles are only
 * optional when flows are configured; ConfigLoader fills them in from the
 * API.
 */
export interface EnvConfig {
  sourceUrl?: string;
  subtitles?: SubtitlePlaylist[];
  mode: Mode;
  flows: FlowSettings[];
  api?: ApiSettings;
}

const DEFAULT_API_URL = "https://api.captionhub.com/api";
const DEFAULT_CACHE_SECONDS = 60;

export class ConfigParser {
  static fromEnv(env: NodeJS.ProcessEnv = process.env): EnvConfig {
    return new ConfigParser(env).parse();
  }

  /** Env-only config, for callers that never use the API. */
  static staticFromEnv(env: NodeJS.ProcessEnv = process.env): RewriteConfig {
    const parsed = ConfigParser.fromEnv(env);
    if (parsed.flows.length > 0) {
      throw new ConfigError("Flow-based configuration needs ConfigLoader.load");
    }
    return {
      sourceUrl: parsed.sourceUrl as string,
      subtitles: parsed.subtitles ?? [],
      mode: parsed.mode,
    };
  }

  constructor(private readonly env: NodeJS.ProcessEnv) {}

  parse(): EnvConfig {
    const flows = this.parseFlows();
    const hasFlows = flows.length > 0;
    const config: EnvConfig = {
      sourceUrl: this.parseSourceUrl(hasFlows),
      subtitles: this.parseSubtitles(hasFlows),
      mode: this.parseMode(),
      flows,
    };
    if (hasFlows) config.api = this.parseApi();
    ConfigParser.checkGroupPatterns(config.subtitles ?? [], "SUBTITLE_PLAYLISTS");
    return config;
  }

  private parseSourceUrl(optional: boolean): string | undefined {
    const sourceUrl = this.env.PLAYLIST_URL;
    if (!sourceUrl) {
      if (optional) return undefined;
      throw new ConfigError(
        "PLAYLIST_URL env var is required (or set CAPTIONHUB_FLOW_ID to read it from the flow)",
      );
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

  private parseSubtitles(optional: boolean): SubtitlePlaylist[] | undefined {
    const raw = this.env.SUBTITLE_PLAYLISTS;
    if (raw === undefined) return optional ? undefined : [];
    return ConfigParser.parseSubtitleList(
      ConfigParser.parseJson(raw, "SUBTITLE_PLAYLISTS"),
      "SUBTITLE_PLAYLISTS",
    );
  }

  private parseFlows(): FlowSettings[] {
    const flows: FlowSettings[] = [];
    const single = this.env.CAPTIONHUB_FLOW_ID;
    if (single) flows.push({ flowId: single });

    const raw = this.env.CAPTIONHUB_FLOWS;
    if (raw !== undefined) {
      const parsed = ConfigParser.parseJson(raw, "CAPTIONHUB_FLOWS");
      if (!Array.isArray(parsed)) {
        throw new ConfigError("CAPTIONHUB_FLOWS must be a JSON array");
      }
      parsed.forEach((entry, i) => flows.push(ConfigParser.parseFlowEntry(entry, i)));
    }
    return flows;
  }

  private parseApi(): ApiSettings {
    const token = this.env.CAPTIONHUB_API_TOKEN;
    if (!token) {
      throw new ConfigError(
        "CAPTIONHUB_API_TOKEN env var is required when flows are configured",
      );
    }
    const url = this.env.CAPTIONHUB_API_URL ?? DEFAULT_API_URL;
    if (!ConfigParser.isHttpUrl(url)) {
      throw new ConfigError("CAPTIONHUB_API_URL must be an http(s) URL");
    }
    const rawSeconds = this.env.CAPTIONHUB_FLOW_CACHE_SECONDS;
    const seconds = rawSeconds === undefined ? DEFAULT_CACHE_SECONDS : Number(rawSeconds);
    if (!Number.isFinite(seconds) || seconds < 0) {
      throw new ConfigError(
        "CAPTIONHUB_FLOW_CACHE_SECONDS must be a non-negative number",
      );
    }
    return { url: url.replace(/\/+$/, ""), token, cacheMs: seconds * 1000 };
  }

  private static parseFlowEntry(entry: unknown, index: number): FlowSettings {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new ConfigError(`CAPTIONHUB_FLOWS[${index}] must be an object`);
    }
    const obj = entry as Record<string, unknown>;
    const context = `CAPTIONHUB_FLOWS[${index}]`;
    return {
      flowId: ConfigParser.requireString(obj, context, "flow_id"),
      groupId: ConfigParser.optionalString(obj, context, "group_id"),
      variantPattern: ConfigParser.optionalPattern(obj, context, "variant_pattern"),
    };
  }

  /**
   * Validates a list of tracks. Accepts both the label/language keys and
   * the language_name/language_code keys the CaptionHub API uses, so a
   * playlist_tracks array can be used unchanged.
   */
  static parseSubtitleList(parsed: unknown, context: string): SubtitlePlaylist[] {
    if (!Array.isArray(parsed)) {
      throw new ConfigError(`${context} must be a JSON array`);
    }
    return parsed.map((entry, i) =>
      ConfigParser.parseSubtitleEntry(entry, `${context}[${i}]`),
    );
  }

  private static parseSubtitleEntry(entry: unknown, context: string): SubtitlePlaylist {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new ConfigError(`${context} must be an object`);
    }
    const obj = entry as Record<string, unknown>;

    const label = ConfigParser.requireString(obj, context, "label", "language_name");
    const language = ConfigParser.requireString(obj, context, "language", "language_code");
    const url = ConfigParser.requireString(obj, context, "url");

    if (!ConfigParser.isHttpUrl(url)) {
      throw new ConfigError(`${context}.url must be an http(s) URL`);
    }

    if (obj.default !== undefined && typeof obj.default !== "boolean") {
      throw new ConfigError(`${context}.default must be a boolean when present`);
    }

    const track: SubtitlePlaylist = {
      label,
      language,
      default: obj.default as boolean | undefined,
      url,
    };
    const groupId = ConfigParser.optionalString(obj, context, "group_id");
    if (groupId !== undefined) track.groupId = groupId;
    const variantPattern = ConfigParser.optionalPattern(obj, context, "variant_pattern");
    if (variantPattern !== undefined) track.variantPattern = variantPattern;
    return track;
  }

  /** Tracks sharing a group_id must agree on variant_pattern. */
  static checkGroupPatterns(subtitles: SubtitlePlaylist[], context: string): void {
    const seen = new Map<string, string | undefined>();
    subtitles.forEach((track, i) => {
      const id = track.groupId ?? "subs";
      if (!seen.has(id)) {
        seen.set(id, track.variantPattern);
        return;
      }
      const first = seen.get(id);
      if (track.variantPattern !== undefined && first !== undefined && first !== track.variantPattern) {
        throw new ConfigError(
          `${context}[${i}].variant_pattern conflicts with an earlier pattern for group_id "${id}"`,
        );
      }
    });
  }

  private static parseJson(raw: string, name: string): unknown {
    try {
      return JSON.parse(raw);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ConfigError(`${name} must be valid JSON: ${message}`);
    }
  }

  private static requireString(
    obj: Record<string, unknown>,
    context: string,
    field: string,
    alias?: string,
  ): string {
    const value = obj[field] ?? (alias ? obj[alias] : undefined);
    if (typeof value !== "string" || value.length === 0) {
      const name = alias ? `${field} (or ${alias})` : field;
      throw new ConfigError(`${context}.${name} must be a non-empty string`);
    }
    return value;
  }

  private static optionalString(
    obj: Record<string, unknown>,
    context: string,
    field: string,
  ): string | undefined {
    const value = obj[field];
    if (value === undefined) return undefined;
    if (typeof value !== "string" || value.length === 0) {
      throw new ConfigError(`${context}.${field} must be a non-empty string when present`);
    }
    return value;
  }

  private static optionalPattern(
    obj: Record<string, unknown>,
    context: string,
    field: string,
  ): string | undefined {
    const value = ConfigParser.optionalString(obj, context, field);
    if (value === undefined) return undefined;
    try {
      new RegExp(value);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new ConfigError(`${context}.${field} must be a valid regular expression: ${reason}`);
    }
    return value;
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
