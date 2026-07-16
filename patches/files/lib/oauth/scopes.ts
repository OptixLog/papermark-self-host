// Token scope catalog. Referenced by pages/api/teams/[teamId]/tokens but never
// published to the public papermark repo. Presets follow the
// RestrictedToken.scopes schema comment; the granular list covers the core
// resources.
export const PRESET_SCOPES: readonly string[] = ["apis.all", "apis.read"];
export const GRANULAR_SCOPES: readonly string[] = [
  "documents.read",
  "documents.write",
  "links.read",
  "links.write",
  "datarooms.read",
  "datarooms.write",
];
