// Self-host patch: domain management without Vercel.
//
// Upstream's lib/domains.ts drives everything through the Vercel Domains API
// (PROJECT_ID_VERCEL / AUTH_BEARER_TOKEN). On self-host those are unset, every
// call returns an error object, and the domains UI marks every domain
// "Invalid". Here a custom domain is correctly configured when its DNS
// resolves to the same address as the app host (A/AAAA match) or CNAMEs to
// it — checked via DNS-over-HTTPS so it works in any runtime.
// Copied in by patches/apply.mjs; lib/domains.ts delegates here when
// PROJECT_ID_VERCEL is unset.
import {
  DomainConfigResponse,
  DomainResponse,
  DomainVerificationResponse,
} from "@/lib/types";

const APP_HOST = (
  process.env.NEXT_PUBLIC_APP_BASE_HOST ||
  process.env.NEXTAUTH_URL?.replace(/^https?:\/\//, "") ||
  ""
).toLowerCase();

async function resolveDoH(
  name: string,
  type: "A" | "CNAME",
): Promise<string[]> {
  try {
    const res = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`,
      { headers: { accept: "application/dns-json" } },
    );
    if (!res.ok) return [];
    const json = (await res.json()) as {
      Answer?: { type: number; data: string }[];
    };
    const want = type === "A" ? 1 : 5;
    return (json.Answer ?? [])
      .filter((a) => a.type === want)
      .map((a) => a.data.replace(/\.$/, "").toLowerCase());
  } catch {
    return [];
  }
}

async function isDomainPointedAtApp(domain: string): Promise<boolean> {
  const d = domain.toLowerCase();
  if (d === APP_HOST) return true;

  const cnames = await resolveDoH(d, "CNAME");
  if (cnames.includes(APP_HOST)) return true;

  const [domainA, appA] = await Promise.all([
    resolveDoH(d, "A"),
    resolveDoH(APP_HOST, "A"),
  ]);
  return appA.length > 0 && domainA.some((ip) => appA.includes(ip));
}

function apexOf(domain: string) {
  const parts = domain.split(".");
  return parts.length > 2 ? parts.slice(-2).join(".") : domain;
}

export const selfHostDomains = {
  enabled: () => !process.env.PROJECT_ID_VERCEL,

  async addDomain(domain: string) {
    // Nothing to register — Traefik/Dokploy handles routing. Return the
    // Vercel-API shape the callers expect.
    return { name: domain.toLowerCase(), apexName: apexOf(domain) };
  },

  async removeDomain(_domain: string) {
    return {};
  },

  async getDomainResponse(
    domain: string,
  ): Promise<DomainResponse & { error: { code: string; message: string } }> {
    // No ownership challenge on self-host — configuration IS ownership.
    return {
      name: domain.toLowerCase(),
      apexName: apexOf(domain),
      projectId: "self-hosted",
      verified: true,
      verification: [],
      error: undefined as any,
    };
  },

  async getConfigResponse(domain: string): Promise<DomainConfigResponse> {
    const pointed = await isDomainPointedAtApp(domain);
    const appA = await resolveDoH(APP_HOST, "A");
    return {
      configuredBy: pointed ? "CNAME" : null,
      acceptedChallenges: ["http-01"],
      misconfigured: !pointed,
      conflicts: [],
      // Not part of the typed interface but read by the DNS-instructions UI
      // (domain-configuration.tsx) for the suggested record values.
      ...({
        recommendedCNAME: [{ value: APP_HOST }],
        recommendedIPv4: appA.length ? [{ value: appA }] : [],
      } as object),
    };
  },

  async verifyDomain(domain: string): Promise<DomainVerificationResponse> {
    const pointed = await isDomainPointedAtApp(domain);
    return {
      name: domain.toLowerCase(),
      apexName: apexOf(domain),
      projectId: "self-hosted",
      verified: pointed,
    } as DomainVerificationResponse;
  },
};
