// Restricted-token helpers. Referenced by
// pages/api/teams/[teamId]/{tokens,remove-teammate} but never published to the
// public papermark repo; reconstructed from those call sites.
import { z } from "zod";

import prisma from "@/lib/prisma";

export const RestrictedTokenSubjectTypeSchema = z.enum(["user", "machine"]);
export type RestrictedTokenSubjectType = z.infer<
  typeof RestrictedTokenSubjectTypeSchema
>;

export function parseRestrictedTokenSubjectType(
  value: unknown,
): RestrictedTokenSubjectType {
  const parsed = RestrictedTokenSubjectTypeSchema.safeParse(
    typeof value === "string" ? value.trim().toLowerCase() : value,
  );
  return parsed.success ? parsed.data : "user";
}

// "user" keys are revoked when the owner loses team access; "machine" keys
// stay team-scoped (see the RestrictedToken schema comment).
export async function revokeUserBoundTeamTokens(
  userId: string,
  teamId: string,
): Promise<void> {
  await prisma.restrictedToken.deleteMany({
    where: { userId, teamId, subjectType: "user" },
  });
}
