import { describe, expect, it } from "vitest";
import { GoogleConfigError, googleConfigFromEnv } from "./config";

describe("googleConfigFromEnv", () => {
  it("is off when neither credential is set", () => {
    expect(googleConfigFromEnv({})).toBeNull();
    expect(googleConfigFromEnv({ GOOGLE_CLIENT_ID: " ", GOOGLE_CLIENT_SECRET: "" })).toBeNull();
  });

  it("refuses half a client", () => {
    expect(() => googleConfigFromEnv({ GOOGLE_CLIENT_ID: "id" })).toThrow(GoogleConfigError);
    expect(() => googleConfigFromEnv({ GOOGLE_CLIENT_SECRET: "secret" })).toThrow(GoogleConfigError);
  });

  it("uses Google's endpoints unless overridden", () => {
    const config = googleConfigFromEnv({ GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" });
    expect(config).toEqual({
      clientId: "id",
      clientSecret: "secret",
      oauthUrl: "https://accounts.google.com",
      tokenUrl: "https://oauth2.googleapis.com",
      apiUrl: "https://gmail.googleapis.com",
    });
    const fake = googleConfigFromEnv({
      GOOGLE_CLIENT_ID: "id",
      GOOGLE_CLIENT_SECRET: "secret",
      GOOGLE_OAUTH_URL: "http://localhost:9040/",
      GOOGLE_API_URL: "http://localhost:9040",
    });
    expect(fake).toMatchObject({
      oauthUrl: "http://localhost:9040",
      tokenUrl: "http://localhost:9040",
      apiUrl: "http://localhost:9040",
    });
  });
});
