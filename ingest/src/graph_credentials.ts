export type DotEnvValues = Record<string, string>;

export type AppInfoValues = {
  clientId?: string;
  tenantId?: string;
  redirectUris: string[];
};

export type GraphCredentialConfig = {
  clientId: string;
  tenantId: string;
  clientSecret: string;
  scope: string;
  redirectUris: string[];
};

export type TokenRequest = {
  url: string;
  body: URLSearchParams;
};

export type DecodedJwtPayload = {
  aud?: string;
  appid?: string;
  azp?: string;
  roles?: string[];
  scp?: string;
  exp?: number;
  [key: string]: unknown;
};

const DEFAULT_GRAPH_SCOPE = "https://graph.microsoft.com/.default";
const GUID_PATTERN = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

export function parseDotEnv(input: string): DotEnvValues {
  const values: DotEnvValues = {};

  for (const line of input.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    values[key] = unquote(rawValue);
  }

  return values;
}

export function parseAppInfo(input: string): AppInfoValues {
  return {
    clientId: readGuidAfterLabel(input, "Application \\(client\\) ID"),
    tenantId: readGuidAfterLabel(input, "Directory \\(tenant\\) ID"),
    redirectUris: readRedirectUris(input),
  };
}

export function loadGraphCredentialConfig(input: {
  envText: string;
  appInfoText?: string;
}): GraphCredentialConfig {
  const env = parseDotEnv(input.envText);
  const appInfo = input.appInfoText ? parseAppInfo(input.appInfoText) : { redirectUris: [] };
  const clientId = env.ENTRA_APP_CLIENT_ID ?? env.CLIENT_ID ?? appInfo.clientId;
  const tenantId = env.ENTRA_TENANT_ID ?? env.TENANT_ID ?? appInfo.tenantId;
  const clientSecret = env.CLIENT_SECRET_VALUE ?? env.ENTRA_APP_CLIENT_SECRET;
  const scope = env.GRAPH_SCOPE ?? DEFAULT_GRAPH_SCOPE;

  if (!clientId) {
    throw new Error("Missing ENTRA_APP_CLIENT_ID or APPINFO Application (client) ID");
  }
  if (!tenantId) {
    throw new Error("Missing ENTRA_TENANT_ID or APPINFO Directory (tenant) ID");
  }
  if (!clientSecret) {
    throw new Error("Missing CLIENT_SECRET_VALUE");
  }

  return {
    clientId,
    tenantId,
    clientSecret,
    scope,
    redirectUris: parseRedirectUriEnv(env.ENTRA_APP_REDIRECT_URIS) ?? appInfo.redirectUris,
  };
}

export function buildClientCredentialsTokenRequest(
  config: Pick<GraphCredentialConfig, "tenantId" | "clientId" | "clientSecret" | "scope">,
): TokenRequest {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    scope: config.scope,
    grant_type: "client_credentials",
  });

  return {
    url: `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`,
    body,
  };
}

export function decodeJwtPayload(token: string): DecodedJwtPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }

  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function readGuidAfterLabel(input: string, labelPattern: string): string | undefined {
  const regex = new RegExp(`${labelPattern}\\s*\\n\\s*(${GUID_PATTERN})`, "i");
  return input.match(regex)?.[1];
}

function readRedirectUris(input: string): string[] {
  const uris = new Set<string>();
  const uriRegex = /https?:\/\/[^\s|"'`]+/g;
  for (const match of input.matchAll(uriRegex)) {
    uris.add(match[0]);
  }
  return [...uris];
}

function parseRedirectUriEnv(input: string | undefined): string[] | undefined {
  if (!input || !input.includes("http")) {
    return undefined;
  }

  const uris = input
    .split(/[,\s]+/)
    .map((value) => value.trim())
    .filter((value) => value.startsWith("http://") || value.startsWith("https://"));

  return uris.length > 0 ? uris : undefined;
}
