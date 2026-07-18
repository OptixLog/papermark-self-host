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
// Anchor WITHOUT the leading "return": the file constructs S3Client three
// times — getS3Client, getS3ClientForTeam (both `return new S3Client`) and
// getTeamS3ClientAndConfig (`const client = new S3Client`). Missing the third
// broke tus finish/delete/stream/copy while presigned uploads worked.
patchFile(
  "lib/files/aws-client.ts",
  `new S3Client({
    endpoint: config.endpoint || undefined,
    region: config.region,`,
  `new S3Client({
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

// 6. Invite links are signed with NEXT_PRIVATE_UNSUBSCRIBE_JWT_SECRET.
//    When unset, jwt.sign(payload, undefined) throws INSIDE the teammate
//    invite/resend routes - after the Invitation row is created but before
//    the email sends, so invites "succeed" in the UI yet never arrive.
//    Fall back to NEXTAUTH_SECRET (always set - NextAuth requires it) so a
//    missing env var can never silently kill invite emails again.
patchFile(
  "lib/utils/generate-jwt.ts",
  `const JWT_SECRET = process.env.NEXT_PRIVATE_UNSUBSCRIBE_JWT_SECRET as string;`,
  `const JWT_SECRET = (process.env.NEXT_PRIVATE_UNSUBSCRIBE_JWT_SECRET ||
  process.env.NEXTAUTH_SECRET) as string;`,
  "process.env.NEXTAUTH_SECRET",
);

// 7. Email via SMTP (AWS SES) instead of Resend. sendEmail() throws when
//    RESEND_API_KEY is unset, which breaks teammate invites, magic-link
//    sign-in, and view notifications on self-host. When EMAIL_SMTP_HOST is
//    configured, route through nodemailer -> SES SMTP and rewrite the
//    hardcoded papermark.com from-addresses onto EMAIL_FROM_DOMAIN.
//    (resend.batch.send / resend.contacts remain Resend-only: year-in-review
//    and newsletter-subscribe, both irrelevant on self-host.)
patchFile(
  "lib/resend.ts",
  `import prisma from "@/lib/prisma";`,
  `import { getSmtpTransport, sendViaSmtp } from "@/lib/emails/smtp-transport";
import prisma from "@/lib/prisma";`,
  "smtp-transport",
);
patchFile(
  "lib/resend.ts",
  `}) => {
  if (!resend) {
    // Throw an error if resend is not initialized
    throw new Error("Resend not initialized");
  }`,
  `}) => {
  if (!resend && !getSmtpTransport()) {
    // Throw an error if no email transport is configured
    throw new Error("Resend not initialized");
  }`,
  "!resend && !getSmtpTransport()",
);
patchFile(
  "lib/resend.ts",
  `  try {
    const { data, error } = await resend.emails.send({`,
  `  if (!resend) {
    // Self-host SMTP path (AWS SES). Mirrors the Resend call below.
    try {
      return await sendViaSmtp({
        from: fromAddress,
        to: test ? "delivered@resend.dev" : to,
        cc,
        replyTo: marketing ? "founders@optixlog.com" : replyTo,
        subject,
        html,
        text: plainText,
        headers: {
          "X-Entity-Ref-ID": nanoid(),
          ...(unsubscribeUrl
            ? {
                "List-Unsubscribe": \`<\${unsubscribeUrl}>\`,
                "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
              }
            : {}),
        },
      });
    } catch (exception) {
      log({
        message: \`Unexpected error when sending email via SMTP: \${exception}\`,
        type: "error",
        mention: true,
      });
      throw exception;
    }
  }

  try {
    const { data, error } = await resend.emails.send({`,
  "sendViaSmtp({",
);

// 8. Self-hosted Tinybird (tinybird-local container on the Dokploy host).
//    @chronark/zod-bird defaults to https://api.tinybird.co; point it at
//    TINYBIRD_BASE_URL when set. Powers page-by-page analytics, visitor
//    durations and the dashboard views chart.
for (const relPath of ["lib/tinybird/publish.ts", "lib/tinybird/pipes.ts"]) {
  patchFile(
    relPath,
    `const tb = new Tinybird({ token: process.env.TINYBIRD_TOKEN! });`,
    `const tb = new Tinybird({
  token: process.env.TINYBIRD_TOKEN!,
  ...(process.env.TINYBIRD_BASE_URL
    ? { baseUrl: process.env.TINYBIRD_BASE_URL }
    : {}),
});`,
    "TINYBIRD_BASE_URL",
  );
}

// 9. PDF conversion without Trigger.dev. convertPdfToImageRoute is a
//    Trigger.dev task; with no TRIGGER_SECRET_KEY the task never executes,
//    documentVersion.hasPages stays false, and every uploaded document shows
//    "Preparing preview... / Almost ready..." forever. The heavy lifting is
//    in the app's own /api/mupdf routes, so when Trigger.dev is unconfigured
//    drive them inline (fire-and-forget) instead. Patches the three PDF
//    upload entrypoints: process-document, new-version, and NDA agreements.
patchFile(
  "lib/api/documents/process-document.ts",
  `import { convertPdfToImageRoute } from "@/lib/trigger/pdf-to-image-route";`,
  `import {
  convertPdfToImagesInlineInBackground,
  triggerDevConfigured,
} from "@/lib/api/documents/convert-pdf-inline";
import { convertPdfToImageRoute } from "@/lib/trigger/pdf-to-image-route";`,
  "convert-pdf-inline",
);
patchFile(
  "lib/api/documents/process-document.ts",
  `  if (type === "pdf") {
    await convertPdfToImageRoute.trigger(
      {
        documentId: document.id,
        documentVersionId: document.versions[0].id,
        teamId,
      },`,
  `  if (type === "pdf" && !triggerDevConfigured()) {
    convertPdfToImagesInlineInBackground({
      documentId: document.id,
      documentVersionId: document.versions[0].id,
      teamId,
    });
  } else if (type === "pdf") {
    await convertPdfToImageRoute.trigger(
      {
        documentId: document.id,
        documentVersionId: document.versions[0].id,
        teamId,
      },`,
  "convertPdfToImagesInlineInBackground({",
);
patchFile(
  "pages/api/teams/[teamId]/documents/[id]/versions/index.ts",
  `      if (type === "pdf") {
        await convertPdfToImageRoute.trigger(
          {
            documentId: documentId,
            documentVersionId: version.id,
            teamId,`,
  `      if (type === "pdf" && !process.env.TRIGGER_SECRET_KEY) {
        const { convertPdfToImagesInlineInBackground } = await import(
          "@/lib/api/documents/convert-pdf-inline"
        );
        convertPdfToImagesInlineInBackground({
          documentId,
          documentVersionId: version.id,
          teamId,
          versionNumber: version.versionNumber,
        });
      } else if (type === "pdf") {
        await convertPdfToImageRoute.trigger(
          {
            documentId: documentId,
            documentVersionId: version.id,
            teamId,`,
  "convert-pdf-inline",
);
patchFile(
  "pages/api/teams/[teamId]/documents/agreement.ts",
  `        await convertPdfToImageRoute.trigger(`,
  `        if (!process.env.TRIGGER_SECRET_KEY) {
          const { convertPdfToImagesInlineInBackground } = await import(
            "@/lib/api/documents/convert-pdf-inline"
          );
          convertPdfToImagesInlineInBackground({
            documentId: document.id,
            documentVersionId: document.versions[0].id,
            teamId,
          });
        } else
        await convertPdfToImageRoute.trigger(`,
  "convert-pdf-inline",
);

// 10. Custom domains without Vercel. lib/domains.ts calls the Vercel Domains
//     API for add/verify/config; with PROJECT_ID_VERCEL unset every response
//     is an error object and the domains UI shows "Invalid" for everything —
//     including the app host itself. Delegate to a DNS-based checker
//     (lib/domains-selfhost.ts): a domain is valid when it CNAMEs to the app
//     host or its A records match the app host's.
patchFile(
  "lib/domains.ts",
  `export const addDomainToVercel = async (domain: string) => {
  return await fetch(`,
  `import { selfHostDomains } from "@/lib/domains-selfhost";

export const addDomainToVercel = async (domain: string) => {
  if (selfHostDomains.enabled()) return selfHostDomains.addDomain(domain);
  return await fetch(`,
  "domains-selfhost",
);
patchFile(
  "lib/domains.ts",
  `export const removeDomainFromVercelProject = async (domain: string) => {
  return await fetch(`,
  `export const removeDomainFromVercelProject = async (domain: string) => {
  if (selfHostDomains.enabled()) return selfHostDomains.removeDomain(domain);
  return await fetch(`,
  "selfHostDomains.removeDomain",
);
patchFile(
  "lib/domains.ts",
  `export const removeDomainFromVercelTeam = async (domain: string) => {
  return await fetch(`,
  `export const removeDomainFromVercelTeam = async (domain: string) => {
  if (selfHostDomains.enabled()) return selfHostDomains.removeDomain(domain);
  return await fetch(`,
  "selfHostDomains.enabled()) return selfHostDomains.removeDomain(domain);\n  return await fetch(\n    `https://api.vercel.com/v6/domains",
);
patchFile(
  "lib/domains.ts",
  `): Promise<DomainResponse & { error: { code: string; message: string } }> => {
  return await fetch(`,
  `): Promise<DomainResponse & { error: { code: string; message: string } }> => {
  if (selfHostDomains.enabled()) return selfHostDomains.getDomainResponse(domain);
  return await fetch(`,
  "selfHostDomains.getDomainResponse",
);
patchFile(
  "lib/domains.ts",
  `): Promise<DomainConfigResponse> => {
  return await fetch(`,
  `): Promise<DomainConfigResponse> => {
  if (selfHostDomains.enabled()) return selfHostDomains.getConfigResponse(domain);
  return await fetch(`,
  "selfHostDomains.getConfigResponse",
);
patchFile(
  "lib/domains.ts",
  `): Promise<DomainVerificationResponse> => {
  return await fetch(`,
  `): Promise<DomainVerificationResponse> => {
  if (selfHostDomains.enabled()) return selfHostDomains.verifyDomain(domain);
  return await fetch(`,
  "selfHostDomains.verifyDomain",
);

// 11. Realtime progress against self-hosted Trigger.dev. The react-hooks
//     default baseURL is https://api.trigger.dev; point them at our instance
//     via NEXT_PUBLIC_TRIGGER_API_URL (inlined at build — set in the
//     Dockerfile). Without this the progress bar silently never updates.
patchFile(
  "lib/utils/use-progress-status.ts",
  `    {
      enabled: !!publicAccessToken,
      accessToken: publicAccessToken,
    },
  );`,
  `    {
      enabled: !!publicAccessToken,
      accessToken: publicAccessToken,
      baseURL: process.env.NEXT_PUBLIC_TRIGGER_API_URL,
    },
  );`,
  "NEXT_PUBLIC_TRIGGER_API_URL",
);
patchFile(
  "ee/features/dataroom-freeze/lib/swr/use-freeze-progress.ts",
  `  const { runs } = useRealtimeRunsWithTag(tag, {
    enabled: isArchiveInProgress && !!accessToken,
    accessToken,
  });`,
  `  const { runs } = useRealtimeRunsWithTag(tag, {
    enabled: isArchiveInProgress && !!accessToken,
    accessToken,
    baseURL: process.env.NEXT_PUBLIC_TRIGGER_API_URL,
  });`,
  "baseURL: process.env.NEXT_PUBLIC_TRIGGER_API_URL,\n  });",
);

// 12. Copy reconstructed modules referenced by the code but not published in
// the upstream repo. Public asset overlays use stable upstream paths.
cpSync(join(patchesDir, "files"), root, { recursive: true });
console.log("copied reconstructed modules and white-label assets");

// 13. OptixLog Documents white-label pass. Keep functional Papermark sentinel
// values and cookie/host plumbing intact; these replacements target visible
// labels, metadata, links, viewer chrome, and email copy only.
function patchBrandingFile(relPath, replacements) {
  if (replacements.length === 0) return;
  const path = join(root, relPath);
  let out = readFileSync(path, "utf8");
  for (const [find, replace, { all = true } = {}] of replacements) {
    if (!out.includes(find)) {
      throw new Error(`${relPath}: branding anchor not found: ${find}`);
    }
    out = all ? out.split(find).join(replace) : out.replace(find, replace);
    if (replace && !out.includes(replace)) {
      throw new Error(`${relPath}: branding verification failed: ${replace}`);
    }
  }
  if (/OptixLog Documents[A-Za-z]/.test(out)) {
    throw new Error(`${relPath}: branding replacement corrupted an identifier`);
  }
  writeFileSync(path, out);
  console.log(`branded ${relPath}`);
}

function removeBrandingRange(relPath, start, end, replacement = "") {
  const path = join(root, relPath);
  const src = readFileSync(path, "utf8");
  const startIndex = src.indexOf(start);
  if (startIndex === -1) throw new Error(`${relPath}: branding range start not found`);
  const endIndex = src.indexOf(end, startIndex + start.length);
  if (endIndex === -1) throw new Error(`${relPath}: branding range end not found`);
  const out = src.slice(0, startIndex) + replacement + src.slice(endIndex + end.length);
  writeFileSync(path, out);
  console.log(`removed vendor branding from ${relPath}`);
}

patchBrandingFile("app/layout.tsx", [
  ["Papermark | The Open Source DocSend Alternative", "OptixLog Documents | Secure Document Sharing"],
  ["Papermark is an open-source document sharing infrastructure. Free alternative to Docsend with custom domain. Manage secure document sharing with real-time analytics.", "OptixLog Documents provides secure document sharing, data rooms, and real-time engagement analytics."],
  ["https://www.papermark.com", "https://documents.optixlog.com"],
  ['siteName: "Papermark"', 'siteName: "OptixLog Documents"'],
  ['    creator: "@papermarkio",\n', ""],
]);

patchBrandingFile("pages/_app.tsx", [
  ["Papermark | The Open Source DocSend Alternative", "OptixLog Documents | Secure Document Sharing"],
  ["Papermark is an open-source document sharing alternative to DocSend with built-in analytics.", "OptixLog Documents provides secure document sharing, data rooms, and real-time engagement analytics."],
  ["https://www.papermark.com/_static/meta-image.png", "https://documents.optixlog.com/_static/meta-image.png"],
  ["https://www.papermark.com", "https://documents.optixlog.com"],
  ['        <meta name="twitter:site" content="@papermarkio" />\n', ""],
  ['        <meta name="twitter:creator" content="@papermarkio" />\n', ""],
  ['content="Papermark" key="tw-title"', 'content="OptixLog Documents" key="tw-title"'],
  ['content="#000000"', 'content="#1a1a1a"'],
]);

patchBrandingFile("lib/utils.ts", [
  ['title = "Papermark | The Open Source DocSend Alternative"', 'title = "OptixLog Documents | Secure Document Sharing"'],
  ['description = "Papermark is an open-source document sharing alternative to DocSend with built-in engagement analytics and 100% white-labeling."', 'description = "OptixLog Documents provides secure document sharing, data rooms, and real-time engagement analytics."'],
  ['image = "https://www.papermark.com/_static/meta-image.png"', 'image = "https://documents.optixlog.com/_static/meta-image.png"'],
  ['      creator: "@papermarkio",\n', ""],
]);
patchBrandingFile("lib/constants.ts", [["Papermark - Secure Data Room Infrastructure for the modern web", "OptixLog Documents - Secure document sharing and data rooms"]]);

for (const relPath of [
  "app/(auth)/login/page.tsx",
  "app/(auth)/register/page.tsx",
  "app/(auth)/auth/email/[[...params]]/page.tsx",
  "app/(auth)/verify/invitation/page.tsx",
  "app/(auth)/auth/confirm-email-change/[token]/page.tsx",
]) {
  patchBrandingFile(relPath, [
    ["https://www.papermark.com", "https://documents.optixlog.com"],
    ["Papermark", "OptixLog Documents"],
    ['    creator: "@papermarkio",\n', ""],
  ]);
}

removeBrandingRange(
  "app/(auth)/login/page-client.tsx",
  "          <p className=\"mt-10 w-full max-w-md px-4 text-xs text-muted-foreground sm:px-12\">",
  "          </p>",
  `          <p className="mt-10 w-full max-w-md px-4 text-xs text-muted-foreground sm:px-12">
            By continuing, you acknowledge the{" "}
            <a href="https://optixlog.com/privacy-policy" target="_blank" rel="noopener noreferrer" className="underline">
              Privacy Policy
            </a>.
          </p>`,
);
patchBrandingFile("app/(auth)/login/page-client.tsx", [
  ['import { LogoCloud } from "@/components/shared/logo-cloud";\n', ""],
  ["https://www.papermark.com", "https://documents.optixlog.com"],
  ['alt="Papermark Logo"', 'alt="OptixLog Documents logo"'],
  ["Welcome to Papermark", "Welcome to OptixLog Documents"],
]);
removeBrandingRange(
  "app/(auth)/login/page-client.tsx",
  '      <div\n        className="relative hidden w-full justify-center overflow-hidden md:flex md:w-[45%] lg:w-[45%]"',
  "      </div>\n    </div>",
  `      <div
        className="relative hidden w-full justify-center overflow-hidden md:flex md:w-[45%] lg:w-[45%]"
        style={{ backgroundColor: "#1a1a1a" }}
      >
        <div className="flex h-full w-full items-center justify-center px-10 py-12">
          <div className="w-full max-w-md">
            <img
              src="/_static/papermark-logo-light.svg"
              alt="OptixLog Documents"
              className="h-8 w-auto"
            />
            <div className="mt-16">
              <h2 className="text-balance text-3xl font-semibold tracking-tight text-white">
                Share sensitive documents with clarity.
              </h2>
              <p className="mt-5 max-w-sm text-base leading-7 text-white/70">
                Secure links, data rooms, and engagement analytics in one workspace.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>`,
);

patchBrandingFile("app/(auth)/register/page-client.tsx", [
  ["PapermarkLogo", "OptixLogDocumentsLogo"],
  ["https://www.papermark.com", "https://documents.optixlog.com"],
  ['alt="Papermark Logo"', 'alt="OptixLog Documents logo"'],
]);
patchBrandingFile("app/(auth)/verify/invitation/InvitationStatusContent.tsx", [
  ["Create your own Papermark account", "Create your own OptixLog Documents account"],
]);
removeBrandingRange(
  "app/(auth)/verify/invitation/page.tsx",
  "                <p className=\"mt-10 w-full max-w-md px-4 text-xs text-muted-foreground sm:px-16\">",
  "                </p>",
  `                <p className="mt-10 w-full max-w-md px-4 text-xs text-muted-foreground sm:px-16">
                  By accepting this invitation, you acknowledge the{" "}
                  <a
                    href="https://optixlog.com/privacy-policy"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline hover:text-gray-900"
                  >
                    Privacy Policy
                  </a>
                  .
                </p>`,
);
patchBrandingFile("app/(auth)/auth/saml/page.tsx", [
  ["SSO Login | Papermark", "SSO Login | OptixLog Documents"],
]);
removeBrandingRange(
  "app/(auth)/auth/email/[[...params]]/page-client.tsx",
  "          <p className=\"mt-10 w-full max-w-md px-4 text-xs text-muted-foreground sm:px-12\">",
  "          </p>",
  `          <p className="mt-10 w-full max-w-md px-4 text-xs text-muted-foreground sm:px-12">
            By continuing, you acknowledge the{" "}
            <a href="https://optixlog.com/privacy-policy" target="_blank" rel="noopener noreferrer" className="underline">
              Privacy Policy
            </a>.
          </p>`,
);
patchBrandingFile("app/(auth)/auth/email/[[...params]]/page-client.tsx", [
  ['import { LogoCloud } from "@/components/shared/logo-cloud";\n', ""],
  ["https://www.papermark.com", "https://documents.optixlog.com"],
  ['alt="Papermark Logo"', 'alt="OptixLog Documents logo"'],
]);
removeBrandingRange(
  "app/(auth)/auth/email/[[...params]]/page-client.tsx",
  "\nfunction TestimonialSection() {",
  "\n}\n",
  `
function TestimonialSection() {
  return (
    <div
      className="relative hidden w-full justify-center overflow-hidden md:flex md:w-[45%] lg:w-[45%]"
      style={{ backgroundColor: "#1a1a1a" }}
    >
      <div className="flex h-full w-full items-center justify-center px-10 py-12">
        <div className="w-full max-w-md">
          <img
            src="/_static/papermark-logo-light.svg"
            alt="OptixLog Documents"
            className="h-8 w-auto"
          />
          <div className="mt-16">
            <h2 className="text-balance text-3xl font-semibold tracking-tight text-white">
              Share sensitive documents with clarity.
            </h2>
            <p className="mt-5 max-w-sm text-base leading-7 text-white/70">
              Secure links, data rooms, and engagement analytics in one workspace.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
`,
);

for (const relPath of ["components/sidebar/nav-user.tsx", "components/profile-menu.tsx"]) {
  patchBrandingFile(relPath, [['import { useState } from "react";\n\n', ""]]);
}
patchBrandingFile("components/sidebar/nav-user.tsx", [
  [`  FileTextIcon,
`, ""],
  [`import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Dialog, DialogContent } from "@/components/ui/dialog";
`, ""],
  [`interface Article {
  data: {
    slug: string;
    title: string;
    description?: string;
  };
}

`, ""],
  [`  const [searchOpen, setSearchOpen] = useState(false);
  const [articles, setArticles] = useState<Article[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchArticles = async (query?: string) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        locale: "en", // or get this from your app's locale
        ...(query && { q: query }),
      });

      const res = await fetch(\`/api/help?\${params}\`);
      const data = await res.json();

      if (data.error) {
        throw new Error(data.error);
      }

      setArticles(data.articles || []);
    } catch (error) {
      console.error("Error fetching articles:", error);
      setArticles([]); // Set empty array on error
    } finally {
      setLoading(false);
    }
  };

`, ""],
  [`                <DropdownMenuItem
                  onClick={() => {
                    setSearchOpen(true);
                    fetchArticles();
                  }}
                >`, `                <DropdownMenuItem
                  onClick={() => window.open("https://docs.optixlog.com", "_blank")}
                >`],
]);
removeBrandingRange(
  "components/sidebar/nav-user.tsx",
  "\n      <Dialog open={searchOpen}",
  "      </Dialog>",
  "",
);
patchBrandingFile("components/profile-menu.tsx", [
  [`import { HelpCircle, LogOut, Search } from "lucide-react";
import { FileText } from "lucide-react";
`, `import { HelpCircle, LogOut, Search } from "lucide-react";
`],
  ['import { SearchCommand } from "./search-command";\n', ""],
  [`import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Dialog, DialogContent } from "@/components/ui/dialog";
`, ""],
  [`// Define the Article interface
interface Article {
  data: {
    slug: string;
    title: string;
    description?: string;
  };
}

`, ""],
  [`  const [searchOpen, setSearchOpen] = useState(false);
  const [articles, setArticles] = useState<Article[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchArticles = async (query?: string) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        locale: "en", // or get this from your app's locale
        ...(query && { q: query }),
      });

      console.log("Fetching articles..."); // Debug log
      const res = await fetch(\`/api/help?\${params}\`);
      const data = await res.json();

      console.log("Received data:", data); // Debug log

      if (data.error) {
        throw new Error(data.error);
      }

      setArticles(data.articles || []);
    } catch (error) {
      console.error("Error fetching articles:", error);
      setArticles([]); // Set empty array on error
    } finally {
      setLoading(false);
    }
  };

`, ""],
  [`                    onClick={() => {
                      setSearchOpen(true);
                      fetchArticles();
                    }}`, `                    onClick={() => {
                      window.open("https://docs.optixlog.com", "_blank");
                    }}`],
  ["Need help?", "Documentation"],
]);
removeBrandingRange(
  "components/profile-menu.tsx",
  "\n      <Dialog open={searchOpen}",
  "      </Dialog>",
  "",
);

patchBrandingFile("components/sidebar/sidebar-panels.tsx", [
  ['<Link href="/dashboard">P</Link>', '<Link href="/dashboard"><img src="/_static/papermark-p.svg" alt="OptixLog" className="size-7 rounded-md" /></Link>'],
  ['<Link href="/dashboard">Papermark</Link>', '<Link href="/dashboard">OptixLog</Link>'],
]);
for (const relPath of [
  "components/sidebar/nav-user.tsx",
  "components/layouts/mobile-header.tsx",
  "components/profile-menu.tsx",
  "ee/features/dataroom-freeze/components/freeze-settings.tsx",
]) {
  const source = readFileSync(join(root, relPath), "utf8");
  const replacements = [
    ["support@papermark.com", "founders@optixlog.com"],
    ["support@papermark.io", "founders@optixlog.com"],
  ].filter(([find]) => source.includes(find));
  patchBrandingFile(relPath, replacements);
}
patchBrandingFile("components/layouts/mobile-header.tsx", [["Papermark", "OptixLog Documents"]]);
patchBrandingFile("components/layouts/mobile-more-menu.tsx", [["Upgrade Papermark", "Upgrade OptixLog Documents"]]);

patchBrandingFile("lib/middleware/domain.ts", [
  ["https://www.papermark.com", "https://documents.optixlog.com"],
  ["Papermark - Secure Data Room Infrastructure for the modern web", "OptixLog Documents - Secure document sharing and data rooms"],
]);
for (const relPath of [
  "lib/webhook/triggers/link-created.ts",
  "lib/api/views/send-webhook-event.ts",
]) {
  patchBrandingFile(relPath, [
    ["https://www.papermark.com/view/${link.id}", "https://documents.optixlog.com/view/${link.id}"],
    ['link.domainId && link.domainSlug ? link.domainSlug : "papermark.com"', 'link.domainId && link.domainSlug ? link.domainSlug : "documents.optixlog.com"'],
  ]);
}

patchBrandingFile("components/links/links-table.tsx", [["papermark.com/view/${link.id}", "documents.optixlog.com/view/${link.id}"]]);
patchBrandingFile("components/links/link-sheet/domain-section.tsx", [["              papermark.com", "              documents.optixlog.com"]]);
patchBrandingFile("components/links/link-sheet/pro-banner-section.tsx", [["Secured by Papermark", "Secured by OptixLog Documents"]]);

for (const relPath of [
  "pages/branding.tsx",
  "pages/settings/agreements.tsx",
  "pages/settings/domains.tsx",
  "pages/datarooms/[id]/settings/index.tsx",
  "pages/datarooms/[id]/settings/file-permissions.tsx",
  "pages/datarooms/[id]/settings/downloads.tsx",
  "pages/datarooms/[id]/settings/notifications.tsx",
  "pages/datarooms/[id]/settings/introduction.tsx",
  "pages/datarooms/[id]/branding/index.tsx",
  "pages/datarooms/[id]/groups/index.tsx",
  "pages/datarooms/[id]/permissions/index.tsx",
  "pages/datarooms/[id]/users/index.tsx",
  "pages/datarooms/[id]/documents/index.tsx",
  "pages/datarooms/[id]/analytics/index.tsx",
  "pages/datarooms/[id]/analytics/audit-log.tsx",
  "components/documents/add-document-modal.tsx",
  "components/links/link-sheet/index-file-section.tsx",
  "components/links/link-sheet/expirationIn-section.tsx",
  "components/links/link-sheet/email-protection-section.tsx",
  "components/links/link-sheet/expiration-section.tsx",
  "components/links/link-sheet/agreement-section.tsx",
  "components/links/link-sheet/allow-notification-section.tsx",
  "components/links/link-sheet/deny-list-section.tsx",
  "components/links/link-sheet/watermark-section.tsx",
  "components/links/link-sheet/password-section.tsx",
  "components/links/link-sheet/custom-fields-section.tsx",
  "components/links/link-sheet/email-authentication-section.tsx",
  "components/links/link-sheet/screenshot-protection-section.tsx",
  "components/links/link-sheet/allow-download-section.tsx",
  "components/links/link-sheet/og-section.tsx",
  "components/links/link-sheet/allow-list-section.tsx",
  "components/links/link-sheet/tags/tag-section.tsx",
]) {
  const source = readFileSync(join(root, relPath), "utf8");
  const replacements = [
    [/https:\/\/www\.papermark\.com\/help\/[^\"'`}\s),.]+/g, "https://docs.optixlog.com"],
    ["marc@papermark.com", "founders@optixlog.com"],
    ["Papermark - open-source document sharing infrastructure.", "OptixLog Documents - secure document sharing and data rooms."],
    ["Papermark is an open-source document sharing infrastructure for modern teams.", "OptixLog Documents provides secure document sharing for modern teams."],
  ];
  let out = source;
  for (const [find, replace] of replacements) {
    if (find instanceof RegExp) out = out.replace(find, replace);
    else out = out.split(find).join(replace);
  }
  writeFileSync(join(root, relPath), out);
  console.log(`branded help links in ${relPath}`);
}

patchBrandingFile("components/view/powered-by.tsx", [
  ["https://www.papermark.com?utm_campaign=poweredby&utm_medium=poweredby&utm_source=papermark-${linkId}", "https://documents.optixlog.com?utm_campaign=poweredby&utm_medium=poweredby&utm_source=optixlog-documents-${linkId}"],
  ["Share docs via", "Secured by"],
  ["Papermark", "OptixLog Documents"],
]);
for (const relPath of [
  "pages/view/[linkId]/index.tsx",
  "pages/view/[linkId]/d/[documentId].tsx",
  "pages/view/domains/[domain]/[slug]/index.tsx",
  "pages/view/domains/[domain]/[slug]/d/[documentId].tsx",
]) {
  const source = readFileSync(join(root, relPath), "utf8");
  const replacements = [
    ["Powered by Papermark", "Shared with OptixLog Documents"],
    ["https://www.papermark.com/view/${linkId}", "https://documents.optixlog.com/view/${linkId}"],
  ].filter(([find]) => source.includes(find));
  if (replacements.length === 0) {
    throw new Error(`${relPath}: expected active viewer branding anchor not found`);
  }
  patchBrandingFile(relPath, replacements);
}
patchBrandingFile("components/view/access-form/index.tsx", [
  ["https://www.papermark.com/privacy", "https://optixlog.com/privacy-policy"],
  ["https://www.papermark.com", "https://documents.optixlog.com"],
  ["Papermark", "OptixLog Documents"],
]);
for (const relPath of ["components/view/dataroom/nav-dataroom.tsx", "components/view/nav.tsx"]) {
  patchBrandingFile(relPath, [
    ["https://www.papermark.com?utm_campaign=navbar&utm_medium=navbar&utm_source=papermark-${linkId}", "https://documents.optixlog.com?utm_campaign=navbar&utm_medium=navbar&utm_source=optixlog-documents-${linkId}"],
    ["                  Papermark", "                  OptixLog Documents"],
  ]);
}
for (const relPath of ["components/upload-notification.tsx", "components/ui/progress.tsx"]) {
  patchBrandingFile(relPath, [["support@papermark.com", "founders@optixlog.com"]]);
}
patchBrandingFile("components/view/viewer/pages-horizontal-viewer.tsx", [
  ["https://www.papermark.com/_static/blank.gif", "/_static/blank.gif"],
]);
patchBrandingFile("components/view/link-preview.tsx", [["leaving Papermark", "leaving OptixLog Documents"]]);
removeBrandingRange(
  "components/view/visitor-graph.tsx",
  "          <p className=\"mt-4 w-full max-w-md px-4 text-xs text-muted-foreground sm:px-16\">",
  "          </p>",
  `          <p className="mt-4 w-full max-w-md px-4 text-xs text-muted-foreground sm:px-16">
            By clicking continue, you acknowledge the{" "}
            <Link href="https://optixlog.com/privacy-policy" target="_blank" rel="noopener noreferrer" className="underline hover:text-gray-900">
              Privacy Policy
            </Link>.
          </p>`,
);
patchBrandingFile("components/view/visitor-graph.tsx", [["Papermark", "OptixLog Documents"]]);
patchBrandingFile("lib/emails/send-welcome.ts", [["Welcome to Papermark!", "Welcome to OptixLog Documents!"]]);
patchBrandingFile("lib/emails/send-verification-request.ts", [["Login for Papermark", "Login for OptixLog Documents"]]);
patchBrandingFile("lib/emails/send-mail-verification.ts", [["Confirm your email address change for Papermark!", "Confirm your email address change for OptixLog Documents!"]]);
patchBrandingFile("lib/resend.ts", [
  ["Marc from Papermark <marc@updates.papermark.com>", "OptixLog Documents <documents@optixlog.com>"],
  ["Papermark <system@papermark.com>", "OptixLog Documents <documents@optixlog.com>"],
  ["Papermark <system@verify.papermark.com>", "OptixLog Documents <documents@optixlog.com>"],
  ["Marc Seitz <marc@papermark.com>", "OptixLog Documents <documents@optixlog.com>"],
  ["Marc from Papermark <marc@papermark.com>", "OptixLog Documents <documents@optixlog.com>"],
  ['marketing ? "marc@papermark.com" : replyTo', 'marketing ? "founders@optixlog.com" : replyTo'],
]);
patchBrandingFile("components/settings/survey-settings.tsx", [["Papermark", "OptixLog Documents"]]);
patchBrandingFile("components/domains/add-domain-modal.tsx", [["Papermark links", "OptixLog Documents links"]]);
patchBrandingFile("components/domains/domain-card.tsx", [["redirect to papermark.com", "redirect to documents.optixlog.com"]]);
patchBrandingFile("components/domains/delete-domain-modal.tsx", [
  ["be reset to <span className=\"font-medium\">papermark.com</span> links.", "be reset to <span className=\"font-medium\">documents.optixlog.com</span> links."],
  ["→ papermark.com", "→ documents.optixlog.com"],
]);
patchBrandingFile("components/domains/domain-configuration.tsx", [["use on Papermark", "use on OptixLog Documents"]]);
patchBrandingFile("components/settings/og-preview.tsx", [['const hostname = "papermark.com";', 'const hostname = "documents.optixlog.com";']]);
patchBrandingFile("ee/features/dataroom-invitations/components/invite-viewers-modal.tsx", [
  ['import { fetcher } from "@/lib/utils";', 'import { fetcher } from "@/lib/utils";\nimport { constructLinkUrl } from "@/lib/utils/link-url";'],
  ["support@papermark.com", "founders@optixlog.com"],
  ["system@papermark.com", "documents@optixlog.com"],
  ["Papermark, Inc.", "OptixLog"],
  ["Papermark", "OptixLog Documents"],
  [`{selectedLink
                      ? \`https://papermark.com/view/\${selectedLink.slug ?? selectedLink.id}\`
                      : "https://papermark.com/view/..."}`, `{selectedLink
                      ? constructLinkUrl(selectedLink)
                      : "https://documents.optixlog.com/view/..."}`],
]);
for (const relPath of [
  "ee/features/dataroom-invitations/api/group-invite.ts",
  "ee/features/dataroom-invitations/api/link-invite.ts",
]) {
  patchBrandingFile(relPath, [["support@papermark.com", "founders@optixlog.com"]]);
}
patchBrandingFile("pages/account/general.tsx", [["Papermark", "OptixLog Documents"]]);
patchBrandingFile("pages/settings/general.tsx", [["Papermark", "OptixLog Documents"]]);
patchBrandingFile("pages/settings/incoming-webhooks.tsx", [["Papermark", "OptixLog Documents"]]);
patchBrandingFile("pages/settings/webhooks/index.tsx", [["Papermark", "OptixLog Documents"]]);
patchBrandingFile("pages/datarooms/[id]/groups/[groupId]/index.tsx", [["Papermark", "OptixLog Documents"]]);

patchBrandingFile("pages/notification-preferences.tsx", [
  ["PapermarkLogo", "OptixLogDocumentsLogo"],
  ["Notification Preferences | Papermark", "Notification Preferences | OptixLog Documents"],
  ["https://www.papermark.com", "https://documents.optixlog.com"],
  ['alt="Papermark"', 'alt="OptixLog Documents"'],
  ["                Papermark", "                OptixLog Documents"],
]);

const emailFiles = [
  "components/emails/verification-link.tsx",
  "components/emails/team-invitation.tsx",
  "components/emails/viewed-document.tsx",
  "components/emails/viewed-dataroom.tsx",
  "components/emails/dataroom-notification.tsx",
  "components/emails/dataroom-digest-notification.tsx",
  "components/emails/dataroom-upload-notification.tsx",
  "components/emails/otp-verification.tsx",
  "components/emails/verification-email-change.tsx",
  "components/emails/email-updated.tsx",
  "components/emails/export-ready.tsx",
  "components/emails/download-ready.tsx",
  "ee/features/dataroom-invitations/emails/components/dataroom-viewer-invitation.tsx",
  "ee/features/dataroom-freeze/emails/components/dataroom-freeze-otp.tsx",
  "components/emails/welcome.tsx",
];
for (const relPath of emailFiles) {
  const source = readFileSync(join(root, relPath), "utf8");
  const replacements = [
    ["https://app.papermark.com", "https://documents.optixlog.com"],
    ["https://www.papermark.com", "https://documents.optixlog.com"],
    ["Papermark, Inc.", "OptixLog"],
    ["The Papermark Team", "The OptixLog Team"],
    ["Papermark", "OptixLog Documents"],
  ].filter(([find]) => source.includes(find));
  if (replacements.length === 0) {
    throw new Error(`${relPath}: expected active email branding anchor not found`);
  }
  patchBrandingFile(relPath, replacements);
}
for (const relPath of [
  "components/emails/custom-domain-setup.tsx",
  "components/emails/invalid-domain.tsx",
  "components/emails/deleted-domain.tsx",
  "components/emails/onboarding-1.tsx",
  "components/emails/onboarding-2.tsx",
  "components/emails/onboarding-3.tsx",
  "components/emails/onboarding-4.tsx",
  "lib/emails/send-custom-domain-setup.ts",
  "lib/emails/send-onboarding.ts",
]) {
  const source = readFileSync(join(root, relPath), "utf8");
  const replacements = [
    ["https://app.papermark.com", "https://documents.optixlog.com"],
    ["https://www.papermark.com", "https://documents.optixlog.com"],
    ["https://docs.papermark.com", "https://docs.optixlog.com"],
    ["support@papermark.com", "founders@optixlog.com"],
    ["Papermark, Inc.", "OptixLog"],
    ["Papermark", "OptixLog Documents"],
  ].filter(([find]) => source.includes(find));
  if (replacements.length === 0) {
    throw new Error(`${relPath}: expected active email branding anchor not found`);
  }
  patchBrandingFile(relPath, replacements);
}
patchBrandingFile("components/emails/custom-domain-setup.tsx", [
  ["papermark.com", "documents.optixlog.com"],
]);
for (const relPath of ["components/emails/verification-link.tsx", "components/emails/otp-verification.tsx"]) {
  patchBrandingFile(relPath, [[`                <br />
                1111B S Governors Ave #28117
                <br />
                Dover, DE 19904`, ""]]);
}
patchBrandingFile("components/emails/welcome.tsx", [
  ["https://documents.optixlog.com/help/article/how-to-upload-document", "https://docs.optixlog.com"],
  ["https://documents.optixlog.com/help/article/require-email-verification", "https://docs.optixlog.com"],
  ["https://documents.optixlog.com/password-protection", "https://docs.optixlog.com"],
  ["https://documents.optixlog.com/help/article/expiration-date", "https://docs.optixlog.com"],
  ["https://documents.optixlog.com/help/article/built-in-page-by-page-analytics", "https://docs.optixlog.com"],
  ["https://documents.optixlog.com/help/article/create-data-room", "https://docs.optixlog.com"],
]);
patchBrandingFile("components/emails/shared/footer.tsx", [
  ["https://app.papermark.com/account/general", "https://documents.optixlog.com/account/general"],
  [`        <Text className="text-[12px] text-neutral-500">
          Papermark, Inc.
          <br />
          1111B S Governors Ave #28117
          <br />
          Dover, DE 19904
        </Text>`, `        <Text className="text-[12px] text-neutral-500">OptixLog</Text>`],
  [`        <Text className="text-xs">
          © {new Date().getFullYear()} Papermark, Inc. All rights reserved.{" "}
          {withAddress && (
            <>
              <br />
              1111B S Governors Ave #28117, Dover, DE 19904
            </>
          )}
        </Text>`, `        <Text className="text-xs">
          © {new Date().getFullYear()} OptixLog. All rights reserved.
        </Text>`],
]);

// 14. Remaining live white-label correctness fixes found in the final audit.
// Agreement uploads should produce the same canonical Documents URL as normal
// links, while agreement downloads continue accepting historical Papermark URLs.
patchBrandingFile("components/links/link-sheet/agreement-panel/index.tsx", [
  ['import { getSupportedContentType } from "@/lib/utils/get-content-type";', 'import { getSupportedContentType } from "@/lib/utils/get-content-type";\nimport { constructLinkUrl } from "@/lib/utils/link-url";'],
  ['link: "https://www.papermark.com/view/" + linkId,', 'link: constructLinkUrl({ id: linkId }),'],
  ['placeholder="https://www.papermark.com/nda"', 'placeholder="https://documents.optixlog.com/nda"'],
]);
patchBrandingFile("pages/api/teams/[teamId]/agreements/[agreementId]/download.ts", [
  [`      // Check if the content is a Papermark URL
      const isPapermarkUrl =
        agreement.content.includes("papermark.com/view/") ||
        agreement.content.includes("www.papermark.com/view/");`, `      // Recognize canonical Documents links and historical Papermark links.
      let internalLinkId: string | null = null;
      try {
        const agreementUrl = new URL(agreement.content);
        const internalHosts = new Set([
          "documents.optixlog.com",
          "papermark.com",
          "www.papermark.com",
          "app.papermark.com",
        ]);
        const pathMatch = agreementUrl.pathname.match(/^\\/view\\/([^/?#]+)/);
        if (internalHosts.has(agreementUrl.hostname) && pathMatch?.[1]) {
          internalLinkId = pathMatch[1];
        }
      } catch {
        // Non-URL agreement content is exported as metadata below.
      }`],
  ["      if (isPapermarkUrl) {", "      if (internalLinkId) {"],
  [`        // Extract linkId from Papermark URL
        const urlParts = agreement.content.split("/view/");
        if (urlParts.length < 2) {
          return res.status(400).json("Invalid Papermark URL format");
        }

        const linkId = urlParts[1].split(/[/?#]/)[0]; // Get linkId, remove any query params or fragments

        // Fetch the link and its document
        link = await prisma.link.findUnique({
          where: { id: linkId },`, `        // Fetch the link and its document.
        link = await prisma.link.findUnique({
          where: { id: internalLinkId },`],
  ['.json("Document not found for the provided Papermark URL");', '.json("Document not found for the provided internal document URL");'],
]);

// Reachable transactional and trial emails named in the final audit.
for (const relPath of [
  "components/emails/viewed-document-paused.tsx",
  "components/emails/dataroom-trial-24h.tsx",
  "components/emails/dataroom-trial-end.tsx",
  "components/emails/dataroom-trial-welcome.tsx",
  "components/emails/installed-integration-notification.tsx",
  "ee/features/conversations/emails/components/conversation-notification.tsx",
  "ee/features/conversations/emails/components/conversation-team-notification.tsx",
]) {
  const source = readFileSync(join(root, relPath), "utf8");
  const replacements = [
    ["https://app.papermark.com", "https://documents.optixlog.com"],
    ["https://www.papermark.com", "https://documents.optixlog.com"],
    ["support@papermark.com", "founders@optixlog.com"],
    ["Papermark", "OptixLog Documents"],
  ].filter(([find]) => source.includes(find));
  if (replacements.length === 0) {
    throw new Error(`${relPath}: expected reachable email branding anchor not found`);
  }
  patchBrandingFile(relPath, replacements);
}
patchBrandingFile("components/emails/dataroom-trial-24h.tsx", [
  ["Marc from OptixLog Documents", "OptixLog Documents"],
]);
for (const relPath of [
  "ee/features/conversations/emails/components/conversation-notification.tsx",
  "ee/features/conversations/emails/components/conversation-team-notification.tsx",
]) {
  patchBrandingFile(relPath, [
    ["OptixLog Documents, Inc.", "OptixLog"],
  ]);
}
for (const relPath of [
  "lib/emails/send-dataroom-trial-24h.ts",
  "lib/emails/send-dataroom-trial-end.ts",
  "lib/emails/send-dataroom-trial.ts",
]) {
  patchBrandingFile(relPath, [
    ["Marc Seitz <marc@papermark.com>", "OptixLog Documents <founders@optixlog.com>"],
  ]);
}
patchBrandingFile("components/emails/invalid-domain.tsx", [
  ['domain = "papermark.com"', 'domain = "documents.optixlog.com"'],
]);
patchBrandingFile("components/emails/deleted-domain.tsx", [
  ['domain = "papermark.com"', 'domain = "documents.optixlog.com"'],
]);

// Active configuration screens: labels and previews only. The workflow's
// papermark.com value remains the upstream sentinel used by its API contract.
patchBrandingFile("pages/branding.tsx", [
  ["across Papermark", "across OptixLog Documents"],
  ["papermark.com/view/...", "documents.optixlog.com/view/..."],
]);
patchBrandingFile("pages/datarooms/[id]/branding/index.tsx", [
  ["papermark.com/dataroom/...", "documents.optixlog.com/dataroom/..."],
  ["papermark.com/view/...", "documents.optixlog.com/view/..."],
]);
patchBrandingFile("ee/features/workflows/pages/workflow-new.tsx", [
  ['<SelectValue placeholder="papermark.com (default)" />', '<SelectValue placeholder="documents.optixlog.com (default)" />'],
  ['<SelectItem value="papermark.com">papermark.com</SelectItem>', '<SelectItem value="papermark.com">documents.optixlog.com</SelectItem>'],
  ["Entry URL will be generated automatically (e.g., papermark.com/view/clxxx...)", "Entry URL will be generated automatically (e.g., documents.optixlog.com/view/clxxx...)"],
]);
patchBrandingFile("ee/features/workflows/components/step-form-dialog.tsx", [
  ["papermark.com/{link.slug}", "documents.optixlog.com/{link.slug}"],
]);

console.log("all self-host patches applied");
