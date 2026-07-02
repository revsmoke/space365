import { expect, test } from "bun:test";
import {
  buildClientCredentialsTokenRequest,
  decodeJwtPayload,
  loadGraphCredentialConfig,
  parseAppInfo,
  parseDotEnv,
} from "../ingest/src/graph_credentials";

test("graph credentials parse dotenv without exposing values", () => {
  const parsed = parseDotEnv(`
GRAPH_API_ACCESS_TOKEN=expired-token
CLIENT_SECRET_VALUE="secret-value"
CLIENT_SECRET_ID=secret-id
`);

  expect(parsed.GRAPH_API_ACCESS_TOKEN).toBe("expired-token");
  expect(parsed.CLIENT_SECRET_VALUE).toBe("secret-value");
  expect(parsed.CLIENT_SECRET_ID).toBe("secret-id");
});

test("graph credentials fall back to APPINFO app and tenant IDs", () => {
  const config = loadGraphCredentialConfig({
    envText: "CLIENT_SECRET_VALUE=secret-value",
    appInfoText: `
Application (client) ID
c0c22d69-599d-4e47-8e42-502033f70996
Directory (tenant) ID
ddd9f933-04a5-43f0-8673-5933da46cdcb
`,
  });

  expect(config.clientId).toBe("c0c22d69-599d-4e47-8e42-502033f70996");
  expect(config.tenantId).toBe("ddd9f933-04a5-43f0-8673-5933da46cdcb");
  expect(config.clientSecret).toBe("secret-value");
  expect(config.scope).toBe("https://graph.microsoft.com/.default");
});

test("graph credentials prefer explicit env IDs over APPINFO fallback", () => {
  const config = loadGraphCredentialConfig({
    envText: `
ENTRA_APP_CLIENT_ID=11111111-1111-1111-1111-111111111111
ENTRA_TENANT_ID=22222222-2222-2222-2222-222222222222
CLIENT_SECRET_VALUE=secret-value
GRAPH_SCOPE=https://graph.microsoft.com/.default
`,
    appInfoText: `
Application (client) ID
c0c22d69-599d-4e47-8e42-502033f70996
Directory (tenant) ID
ddd9f933-04a5-43f0-8673-5933da46cdcb
`,
  });

  expect(config.clientId).toBe("11111111-1111-1111-1111-111111111111");
  expect(config.tenantId).toBe("22222222-2222-2222-2222-222222222222");
});

test("graph credentials parse APPINFO redirect URIs", () => {
  const appInfo = parseAppInfo(`
Application (client) ID
c0c22d69-599d-4e47-8e42-502033f70996
Directory (tenant) ID
ddd9f933-04a5-43f0-8673-5933da46cdcb
| Web           | https://space365.tpgarchitecture.com/auth      |
| Web           | https://space365.tpgarchitecture.com           |
`);

  expect(appInfo.redirectUris).toEqual([
    "https://space365.tpgarchitecture.com/auth",
    "https://space365.tpgarchitecture.com",
  ]);
});

test("graph credentials build client credentials token request", () => {
  const request = buildClientCredentialsTokenRequest({
    tenantId: "ddd9f933-04a5-43f0-8673-5933da46cdcb",
    clientId: "c0c22d69-599d-4e47-8e42-502033f70996",
    clientSecret: "secret-value",
    scope: "https://graph.microsoft.com/.default",
  });

  expect(request.url).toBe(
    "https://login.microsoftonline.com/ddd9f933-04a5-43f0-8673-5933da46cdcb/oauth2/v2.0/token",
  );
  expect(request.body.get("grant_type")).toBe("client_credentials");
  expect(request.body.get("client_id")).toBe("c0c22d69-599d-4e47-8e42-502033f70996");
  expect(request.body.get("client_secret")).toBe("secret-value");
});

test("graph credentials decode JWT payload metadata", () => {
  const payload = Buffer.from(
    JSON.stringify({
      aud: "https://graph.microsoft.com",
      appid: "app-id",
      roles: ["Team.ReadBasic.All"],
      exp: 1770413382,
    }),
  )
    .toString("base64url");

  const decoded = decodeJwtPayload(`header.${payload}.signature`);

  expect(decoded?.aud).toBe("https://graph.microsoft.com");
  expect(decoded?.appid).toBe("app-id");
  expect(decoded?.roles).toEqual(["Team.ReadBasic.All"]);
});
