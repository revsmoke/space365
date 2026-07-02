import { existsSync, readFileSync } from "node:fs";
import {
  buildClientCredentialsTokenRequest,
  decodeJwtPayload,
  loadGraphCredentialConfig,
  parseDotEnv,
} from "../ingest/src/graph_credentials";

const envText = readFileSync(".env", "utf8");
const appInfoText = existsSync("APPINFO.md") ? readFileSync("APPINFO.md", "utf8") : undefined;
const env = parseDotEnv(envText);
const config = loadGraphCredentialConfig({ envText, appInfoText });

console.log("config.clientId.present=true");
console.log("config.tenantId.present=true");
console.log(`config.redirectUri.count=${config.redirectUris.length}`);
console.log(`config.scope=${config.scope}`);

const copiedToken = env.GRAPH_API_ACCESS_TOKEN
  ? decodeJwtPayload(env.GRAPH_API_ACCESS_TOKEN)
  : null;
if (copiedToken) {
  console.log(`copiedToken.aud=${copiedToken.aud ?? "missing"}`);
  console.log(`copiedToken.appid=${copiedToken.appid ?? copiedToken.azp ?? "missing"}`);
  console.log(`copiedToken.expired=${isExpired(copiedToken.exp)}`);
}

const tokenRequest = buildClientCredentialsTokenRequest(config);
const tokenResponse = await fetch(tokenRequest.url, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: tokenRequest.body,
});
const tokenPayload = await tokenResponse.json();

console.log(`clientCredentials.status=${tokenResponse.status}`);
if (!tokenResponse.ok) {
  console.log(`clientCredentials.error=${String(tokenPayload.error ?? "unknown")}`);
  process.exit(1);
}

const appToken = decodeJwtPayload(tokenPayload.access_token);
console.log(`appToken.aud=${appToken?.aud ?? "missing"}`);
console.log(`appToken.appid=${appToken?.appid ?? appToken?.azp ?? "missing"}`);
console.log(`appToken.expired=${isExpired(appToken?.exp)}`);
console.log(`appToken.role.count=${Array.isArray(appToken?.roles) ? appToken.roles.length : 0}`);

const meResponse = await fetch("https://graph.microsoft.com/v1.0/teams?$top=1", {
  headers: {
    Authorization: `Bearer ${tokenPayload.access_token}`,
    Accept: "application/json",
  },
});
console.log(`graph.teams.status=${meResponse.status}`);

if (!meResponse.ok) {
  const body = await meResponse.json().catch(() => ({}));
  const error = isRecord(body) && isRecord(body.error) ? body.error.code : "unknown";
  console.log(`graph.teams.error=${String(error)}`);
  process.exit(1);
}

function isExpired(exp: unknown): boolean {
  return typeof exp === "number" && exp < Math.floor(Date.now() / 1000);
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
