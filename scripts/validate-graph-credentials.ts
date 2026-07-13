/**
 * Validate Graph app credentials using the CERTIFICATE client assertion flow
 * (the client secret is retired). Requests an app-only token and performs a
 * real read (GET /v1.0/teams?$top=1).
 */
import {
  GraphTokenProvider,
  buildAssertionParts,
  loadCertCredentialConfig,
} from "../ingest/src/graph_auth";
import { decodeJwtPayload } from "../ingest/src/graph_credentials";

const config = loadCertCredentialConfig();

console.log("config.clientId.present=true");
console.log("config.tenantId.present=true");
console.log(`config.scope=${config.scope}`);
console.log("config.auth=certificate_assertion");

const assertionParts = buildAssertionParts(config);
console.log(`assertion.header.alg=${assertionParts.header.alg}`);
console.log(`assertion.header.x5t.present=${assertionParts.header.x5t.length > 0}`);
console.log(
  `assertion.exp.minutes=${Math.round((assertionParts.claims.exp - assertionParts.claims.nbf) / 60)}`,
);

const provider = new GraphTokenProvider(config);
let accessToken: string;
try {
  accessToken = await provider.getToken();
} catch (error) {
  console.log(`clientCredentials.status=failed`);
  console.log(`clientCredentials.error=${(error as Error).message}`);
  process.exit(1);
}
console.log("clientCredentials.status=200");

const appToken = decodeJwtPayload(accessToken);
console.log(`appToken.aud=${appToken?.aud ?? "missing"}`);
console.log(`appToken.appid=${appToken?.appid ?? appToken?.azp ?? "missing"}`);
console.log(`appToken.expired=${isExpired(appToken?.exp)}`);
console.log(
  `appToken.role.count=${Array.isArray(appToken?.roles) ? appToken.roles.length : 0}`,
);

const teamsResponse = await fetch("https://graph.microsoft.com/v1.0/teams?$top=1", {
  headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
});
console.log(`graph.teams.status=${teamsResponse.status}`);

if (!teamsResponse.ok) {
  const body = (await teamsResponse.json().catch(() => ({}))) as Record<string, unknown>;
  const error =
    typeof body.error === "object" && body.error !== null
      ? (body.error as Record<string, unknown>).code
      : "unknown";
  console.log(`graph.teams.error=${String(error)}`);
  process.exit(1);
}

console.log("token OK");

function isExpired(exp: unknown): boolean {
  return typeof exp === "number" && exp < Math.floor(Date.now() / 1000);
}
