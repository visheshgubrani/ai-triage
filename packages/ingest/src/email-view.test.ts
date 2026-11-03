import { describe, expect, it } from "vitest";
import { sanitizeEmailHtml } from "./email-view";

describe("sanitizeEmailHtml", () => {
  it("drops scripts, styles, forms and remote images, and opens links in a new tab", () => {
    const html = `<style>body{background:url(https://t.example/x.gif)}</style>
      <p onclick="steal()">Hello <b>there</b></p><script>alert(1)</script>
      <img src="https://tracker.example/pixel.gif"><img src="data:image/png;base64,AAAA" alt="logo">
      <form action="https://evil.example"><input name="password"></form>
      <a href="https://example.com/invoice" onmouseover="x()">invoice</a><a href="javascript:alert(1)">bad</a>
      <iframe src="https://evil.example"></iframe>`;
    const clean = sanitizeEmailHtml(html);
    expect(clean).toContain("<p>Hello <b>there</b></p>");
    expect(clean).toContain('<img src="data:image/png;base64,AAAA" alt="logo" />');
    expect(clean).toContain(
      '<a href="https://example.com/invoice" target="_blank" rel="noopener noreferrer">invoice</a>',
    );
    for (const gone of [
      "<script",
      "alert(1)",
      "<style",
      "tracker.example",
      "<form",
      "<input",
      "onclick",
      "onmouseover",
      "javascript:",
      "<iframe",
    ]) {
      expect(clean).not.toContain(gone);
    }
  });
});
