import { describe, expect, it } from "vitest";
import { describeAgent } from "./user-agent";

describe("describeAgent", () => {
  it.each([
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "Chrome on Windows",
      "desktop",
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
      "Edge on Windows",
      "desktop",
    ],
    ["Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:158.0) Gecko/20100101 Firefox/158.0", "Firefox on Linux", "desktop"],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
      "Safari on macOS",
      "desktop",
    ],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
      "Safari on iPhone",
      "mobile",
    ],
    [
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
      "Chrome on Android",
      "mobile",
    ],
    [
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.0.0 Safari/537.36",
      "Headless Chrome on Linux",
      "headless",
    ],
    [
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) SomeApp/4.2 Chrome/138.0.0.0 Electron/37.0.0 Safari/537.36",
      "Desktop app on Linux",
      "desktop",
    ],
    ["curl/8.18.0", "curl", "cli"],
    ["python-requests/2.32.3", "Python", "cli"],
  ])("%s → %s", (ua, label, kind) => {
    expect(describeAgent(ua)).toEqual({ label, kind });
  });

  it("names a missing or empty agent", () => {
    expect(describeAgent(null)).toEqual({ label: "Unknown device", kind: "desktop" });
    expect(describeAgent("  ")).toEqual({ label: "Unknown device", kind: "desktop" });
  });

  it("falls back to the product token of something it doesn't know", () => {
    expect(describeAgent("ExampleBot/1.0")).toEqual({ label: "ExampleBot", kind: "cli" });
  });
});
