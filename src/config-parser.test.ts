import { ConfigError, ConfigParser } from "./config-parser";

function env(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return overrides as NodeJS.ProcessEnv;
}

const VALID_SUBTITLES = JSON.stringify([
  {
    label: "English",
    language: "en",
    default: true,
    url: "https://captions.example.com/en.m3u8",
  },
]);

describe("ConfigParser.fromEnv", () => {
  test("returns a valid config with sensible defaults", () => {
    const config = ConfigParser.fromEnv(
      env({
        PLAYLIST_URL: "https://example.com/master.m3u8",
        SUBTITLE_PLAYLISTS: VALID_SUBTITLES,
      }),
    );
    expect(config.sourceUrl).toBe("https://example.com/master.m3u8");
    expect(config.mode).toBe("add");
    expect(config.subtitles).toHaveLength(1);
    expect(config.subtitles[0].default).toBe(true);
  });

  test("defaults SUBTITLE_PLAYLISTS to an empty list", () => {
    const config = ConfigParser.fromEnv(
      env({ PLAYLIST_URL: "https://example.com/master.m3u8" }),
    );
    expect(config.subtitles).toEqual([]);
  });

  describe("PLAYLIST_URL", () => {
    test("rejects missing value", () => {
      expect(() => ConfigParser.fromEnv(env({}))).toThrow(ConfigError);
      expect(() => ConfigParser.fromEnv(env({}))).toThrow(/required/);
    });

    test("rejects non-http(s) URL", () => {
      expect(() =>
        ConfigParser.fromEnv(env({ PLAYLIST_URL: "ftp://example.com/x.m3u8" })),
      ).toThrow(/http\(s\) URL/);
    });

    test("rejects malformed URL", () => {
      expect(() =>
        ConfigParser.fromEnv(env({ PLAYLIST_URL: "not a url" })),
      ).toThrow(/http\(s\) URL/);
    });
  });

  describe("MODE", () => {
    test("rejects unknown mode", () => {
      expect(() =>
        ConfigParser.fromEnv(
          env({
            PLAYLIST_URL: "https://example.com/master.m3u8",
            MODE: "delete",
          }),
        ),
      ).toThrow(/MODE must be "add" or "replace"/);
    });

    test("accepts add and replace", () => {
      for (const mode of ["add", "replace"] as const) {
        const config = ConfigParser.fromEnv(
          env({ PLAYLIST_URL: "https://example.com/master.m3u8", MODE: mode }),
        );
        expect(config.mode).toBe(mode);
      }
    });
  });

  describe("SUBTITLE_PLAYLISTS", () => {
    function withSubs(value: string): NodeJS.ProcessEnv {
      return env({
        PLAYLIST_URL: "https://example.com/master.m3u8",
        SUBTITLE_PLAYLISTS: value,
      });
    }

    test("accepts the playlist_tracks shape returned by the CaptionHub API", () => {
      const apiTracks = JSON.stringify([
        {
          language_name: "English",
          default: true,
          language_code: "en",
          url: "https://cdn.captionhub.com/live/vtt/playlist/en/stream.m3u8",
        },
        {
          language_name: "Nederlands",
          default: false,
          language_code: "nl",
          url: "https://cdn.captionhub.com/live/vtt/playlist/nl/stream.m3u8",
        },
      ]);

      const config = ConfigParser.fromEnv(withSubs(apiTracks));

      expect(config.subtitles).toEqual([
        {
          label: "English",
          language: "en",
          default: true,
          url: "https://cdn.captionhub.com/live/vtt/playlist/en/stream.m3u8",
        },
        {
          label: "Nederlands",
          language: "nl",
          default: false,
          url: "https://cdn.captionhub.com/live/vtt/playlist/nl/stream.m3u8",
        },
      ]);
    });

    test("prefers label/language when both spellings are present", () => {
      const mixed = JSON.stringify([
        {
          label: "English (custom)",
          language_name: "English",
          language: "en-GB",
          language_code: "en",
          url: "https://x.example.com/x.m3u8",
        },
      ]);

      const config = ConfigParser.fromEnv(withSubs(mixed));

      expect(config.subtitles[0].label).toBe("English (custom)");
      expect(config.subtitles[0].language).toBe("en-GB");
    });

    test("rejects invalid JSON", () => {
      expect(() => ConfigParser.fromEnv(withSubs("{not json"))).toThrow(
        /valid JSON/,
      );
    });

    test("rejects non-array JSON", () => {
      expect(() => ConfigParser.fromEnv(withSubs('{"label":"en"}'))).toThrow(
        /must be a JSON array/,
      );
    });

    test("rejects non-object entries", () => {
      expect(() => ConfigParser.fromEnv(withSubs('["english"]'))).toThrow(
        /\[0\] must be an object/,
      );
    });

    test("rejects entries missing required fields", () => {
      expect(() =>
        ConfigParser.fromEnv(
          withSubs(
            JSON.stringify([
              { label: "English", url: "https://x.example.com/x.m3u8" },
            ]),
          ),
        ),
      ).toThrow(/\[0\]\.language \(or language_code\) must be a non-empty string/);
    });

    test("rejects empty string fields", () => {
      expect(() =>
        ConfigParser.fromEnv(
          withSubs(
            JSON.stringify([
              { label: "", language: "en", url: "https://x.example.com/x.m3u8" },
            ]),
          ),
        ),
      ).toThrow(/\[0\]\.label \(or language_name\) must be a non-empty string/);
    });

    test("rejects non-http(s) URLs in entries", () => {
      expect(() =>
        ConfigParser.fromEnv(
          withSubs(
            JSON.stringify([
              { label: "English", language: "en", url: "ftp://x.example.com/x.m3u8" },
            ]),
          ),
        ),
      ).toThrow(/\[0\]\.url must be an http\(s\) URL/);
    });

    test("rejects non-boolean default", () => {
      expect(() =>
        ConfigParser.fromEnv(
          withSubs(
            JSON.stringify([
              {
                label: "English",
                language: "en",
                url: "https://x.example.com/x.m3u8",
                default: "yes",
              },
            ]),
          ),
        ),
      ).toThrow(/\[0\]\.default must be a boolean/);
    });

    test("reports the offending index", () => {
      expect(() =>
        ConfigParser.fromEnv(
          withSubs(
            JSON.stringify([
              {
                label: "English",
                language: "en",
                url: "https://x.example.com/en.m3u8",
              },
              { label: "Dutch", language: "nl" },
            ]),
          ),
        ),
      ).toThrow(/\[1\]\.url must be a non-empty string/);
    });
  });
});
