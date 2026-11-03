import { type NextRequest, NextResponse } from "next/server";

// A strict, nonce-based Content Security Policy on every page (docs/security.md). Next.js puts the
// nonce on its own scripts during dynamic rendering, so every page must render dynamically (the
// root layout forces it). Styles allow 'unsafe-inline' because React style attributes can't carry
// a nonce. The API and storage are other origins: the browser fetches the API, PUTs uploads to
// storage, and shows PDFs and images from presigned storage URLs.

const origin = (url: string) => new URL(url).origin;
const apiOrigin = origin(process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787");
const storageOrigin = origin(process.env.S3_PUBLIC_ENDPOINT ?? "http://localhost:9020");

function contentSecurityPolicy(nonce: string, options: { dev: boolean; https: boolean }): string {
  const directives = [
    "default-src 'self'",
    // React reconstructs server error stacks with eval in development only.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${options.dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${storageOrigin}`,
    "font-src 'self'",
    `connect-src 'self' ${apiOrigin} ${storageOrigin}`,
    `frame-src ${storageOrigin}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  if (options.https) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = contentSecurityPolicy(nonce, {
    dev: process.env.NODE_ENV === "development",
    https: request.nextUrl.protocol === "https:",
  });
  // Next reads the policy from the request to find the nonce while rendering.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("content-security-policy", csp);
  return response;
}

export const config = {
  matcher: [
    {
      // Pages only: static assets and prefetches don't need a policy.
      source: "/((?!_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
