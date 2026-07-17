// Applies the self-host patches to an upstream papermark checkout.
// Run from the papermark source root: `node patches-selfhost/apply.mjs`
// Fails loudly if any patch target drifts — re-audit before bumping the
// pinned PAPERMARK_REF.
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const patchesDir = dirname(fileURLToPath(import.meta.url));
const root = process.cwd();

function patchFile(relPath, find, replace, mustContainAfter) {
  const path = join(root, relPath);
  const src = readFileSync(path, "utf8");
  if (!src.includes(find)) {
    throw new Error(`${relPath}: patch anchor not found: ${find}`);
  }
  const out = src.replace(find, replace);
  if (!out.includes(mustContainAfter)) {
    throw new Error(`${relPath}: patch verification failed`);
  }
  writeFileSync(path, out);
  console.log(`patched ${relPath}`);
}

// 1. Upstream hardcodes papermark.io/papermark.com as the "app" hosts; every
//    other host is routed to DomainMiddleware (the custom document-sharing
//    domain viewer) and /login & /dashboard are unreachable. Add the
//    self-host domain to the app-host allowlist. NEXT_PUBLIC_APP_BASE_HOST is
//    inlined into the middleware bundle at build time.
patchFile(
  "middleware.ts",
  'host?.includes("localhost") ||',
  'host?.includes("localhost") ||\n        (!!process.env.NEXT_PUBLIC_APP_BASE_HOST &&\n          host?.includes(process.env.NEXT_PUBLIC_APP_BASE_HOST)) ||',
  "NEXT_PUBLIC_APP_BASE_HOST",
);

// 2. rateLimiters at the pinned ref lacks the bulkLinkImport limiter that
//    lib/api/links/bulk-import.ts references (type error at build).
patchFile(
  "ee/features/security/lib/ratelimit.ts",
  "export const rateLimiters = {",
  'export const rateLimiters = {\n  // 10 bulk link imports per minute per team\n  bulkLinkImport: new Ratelimit({\n    redis,\n    limiter: Ratelimit.slidingWindow(10, "1 m"),\n    prefix: "rl:bulk-link-import",\n    enableProtection: true,\n    analytics: true,\n  }),',
  "bulkLinkImport",
);

// 3. Session cookie on self-host HTTPS. Upstream keys the "__Secure-" cookie
//    prefix (and Secure flag) off VERCEL_URL, so on a non-Vercel HTTPS deploy
//    the cookie is written as plain "next-auth.session-token" — but
//    middleware getToken() on HTTPS looks for the "__Secure-" name and never
//    sees the session (login succeeds, /dashboard bounces to /login).
//    Key it off NEXTAUTH_URL being https instead, and never set the
//    hardcoded .papermark.com cookie domain off Vercel.
patchFile(
  "lib/auth/auth-options.ts",
  "const VERCEL_DEPLOYMENT = !!process.env.VERCEL_URL;",
  'const VERCEL_DEPLOYMENT =\n  !!process.env.VERCEL_URL || !!process.env.NEXTAUTH_URL?.startsWith("https://");',
  'NEXTAUTH_URL?.startsWith("https://")',
);
patchFile(
  "lib/auth/auth-options.ts",
  'domain: VERCEL_DEPLOYMENT ? ".papermark.com" : undefined,',
  "domain: process.env.VERCEL_URL ? \".papermark.com\" : undefined,",
  'process.env.VERCEL_URL ? ".papermark.com"',
);

// 4. Modules referenced by the code but never published to the public repo.
cpSync(join(patchesDir, "files"), root, { recursive: true });
console.log("copied reconstructed modules (lib/*, svg.d.ts)");

console.log("all self-host patches applied");
