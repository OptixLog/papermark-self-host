// Applies the self-host patches to an upstream papermark checkout.
// Run from the papermark source root: `node patches-selfhost/apply.mjs`
// Fails loudly if any patch target drifts — re-audit before bumping the
// pinned PAPERMARK_REF.
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const patchesDir = dirname(fileURLToPath(import.meta.url));
const root = process.cwd();

function patchFile(relPath, find, replace, mustContainAfter, { all = false } = {}) {
  const path = join(root, relPath);
  const src = readFileSync(path, "utf8");
  if (!src.includes(find)) {
    throw new Error(`${relPath}: patch anchor not found: ${find}`);
  }
  const out = all ? src.split(find).join(replace) : src.replace(find, replace);
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

// 4. QStash is not configured on self-host; the createUser event's
//    publishJSON (15-min delayed welcome email) throws "invalid token",
//    NextAuth reports CREATE_USER_EVENT_ERROR, and every NEW user's FIRST
//    login attempt bounces back to /login (the retry works because the user
//    row already exists). Welcome scheduling is best-effort — never let it
//    abort sign-in.
patchFile(
  "lib/auth/auth-options.ts",
  `      await qstash.publishJSON({
        url: \`\${process.env.NEXT_PUBLIC_BASE_URL ?? getMainDomainUrl()}/api/cron/welcome-user\`,
        body: {
          userId: message.user.id,
        },
        delay: 15 * 60,
      });`,
  `      try {
        await qstash.publishJSON({
          url: \`\${process.env.NEXT_PUBLIC_BASE_URL ?? getMainDomainUrl()}/api/cron/welcome-user\`,
          body: {
            userId: message.user.id,
          },
          delay: 15 * 60,
        });
      } catch (error) {
        console.warn("createUser: welcome-user scheduling failed (QStash unconfigured?)", error);
      }`,
  "welcome-user scheduling failed",
);

// 5. MinIO (S3-compatible) addressing. The AWS SDK defaults to
//    virtual-hosted-style URLs, so with a custom endpoint every presigned
//    URL targets https://<bucket>.minio.optixlog.com — NXDOMAIN, all uploads
//    and downloads fail. Force path-style whenever a custom endpoint is
//    configured (both the shared clients and the tus MultiRegionS3Store,
//    which additionally never forwarded the endpoint at all and would have
//    talked to real AWS).
patchFile(
  "lib/files/aws-client.ts",
  `  return new S3Client({
    endpoint: config.endpoint || undefined,
    region: config.region,`,
  `  return new S3Client({
    endpoint: config.endpoint || undefined,
    forcePathStyle: !!config.endpoint,
    region: config.region,`,
  "forcePathStyle: !!config.endpoint",
  { all: true },
);
patchFile(
  "ee/features/storage/s3-store.ts",
  `    const superS3Config: any = {
      bucket: euConfig.bucket,
      region: euConfig.region,`,
  `    const superS3Config: any = {
      bucket: euConfig.bucket,
      region: euConfig.region,
      ...(euConfig.endpoint
        ? { endpoint: euConfig.endpoint, forcePathStyle: true }
        : {}),`,
  "endpoint: euConfig.endpoint, forcePathStyle: true",
);
patchFile(
  "ee/features/storage/s3-store.ts",
  `    const euS3Config: any = {
      bucket: euConfig.bucket,
      region: euConfig.region,`,
  `    const euS3Config: any = {
      bucket: euConfig.bucket,
      region: euConfig.region,
      ...(euConfig.endpoint
        ? { endpoint: euConfig.endpoint, forcePathStyle: true }
        : {}),`,
  "const euS3Config",
);
patchFile(
  "ee/features/storage/s3-store.ts",
  `      const usS3Config: any = {
        bucket: this.usConfig.bucket,
        region: this.usConfig.region,`,
  `      const usS3Config: any = {
        bucket: this.usConfig.bucket,
        region: this.usConfig.region,
        ...(this.usConfig.endpoint
          ? { endpoint: this.usConfig.endpoint, forcePathStyle: true }
          : {}),`,
  "endpoint: this.usConfig.endpoint, forcePathStyle: true",
);

// 6. Modules referenced by the code but never published to the public repo.
cpSync(join(patchesDir, "files"), root, { recursive: true });
console.log("copied reconstructed modules (lib/*, svg.d.ts)");

console.log("all self-host patches applied");
