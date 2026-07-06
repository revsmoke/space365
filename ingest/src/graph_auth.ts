/**
 * Microsoft Graph app-only auth via certificate client assertion (P0.1).
 *
 * The client secret is dead — we authenticate with an RS256 JWT assertion
 * signed by the tenant's wildcard certificate private key:
 *   header: { alg: RS256, typ: JWT, x5t: base64url(SHA1(cert DER)) }
 *   claims: { aud: <token endpoint>, iss/sub: <client id>, jti, nbf, exp(+10m) }
 * Verified working against login.microsoftonline.com on 2026-07-06.
 */
import { createHash, createSign, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseDotEnv } from "./graph_credentials";

export type CertCredentialConfig = {
  clientId: string;
  tenantId: string;
  certificatePem: string;
  privateKeyPem: string;
  scope: string;
};

export type AssertionParts = {
  header: { alg: string; typ: string; x5t: string };
  claims: {
    aud: string;
    iss: string;
    sub: string;
    jti: string;
    nbf: number;
    exp: number;
  };
};

const DEFAULT_GRAPH_SCOPE = "https://graph.microsoft.com/.default";
const ASSERTION_LIFETIME_SECONDS = 10 * 60;
/** Refresh cached access tokens 5 minutes before they expire. */
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

export function tokenEndpoint(tenantId: string): string {
  return `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
}

/** Extract the DER bytes of the first CERTIFICATE block in a PEM file. */
export function pemCertificateToDer(pem: string): Buffer {
  const match = pem.match(
    /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/,
  );
  if (!match) {
    throw new Error("No CERTIFICATE block found in PEM input");
  }
  return Buffer.from(match[1].replace(/\s+/g, ""), "base64");
}

/** x5t: base64url-encoded SHA-1 fingerprint of the certificate DER. */
export function computeX5t(certificatePem: string): string {
  const der = pemCertificateToDer(certificatePem);
  return createHash("sha1").update(der).digest("base64url");
}

export function buildAssertionParts(
  config: Pick<CertCredentialConfig, "clientId" | "tenantId" | "certificatePem">,
  nowEpochSeconds: number = Math.floor(Date.now() / 1000),
  jti: string = randomUUID(),
): AssertionParts {
  return {
    header: {
      alg: "RS256",
      typ: "JWT",
      x5t: computeX5t(config.certificatePem),
    },
    claims: {
      aud: tokenEndpoint(config.tenantId),
      iss: config.clientId,
      sub: config.clientId,
      jti,
      nbf: nowEpochSeconds,
      exp: nowEpochSeconds + ASSERTION_LIFETIME_SECONDS,
    },
  };
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** Build and sign the client assertion JWT. */
export function buildClientAssertion(
  config: Pick<
    CertCredentialConfig,
    "clientId" | "tenantId" | "certificatePem" | "privateKeyPem"
  >,
  nowEpochSeconds?: number,
  jti?: string,
): string {
  const parts = buildAssertionParts(config, nowEpochSeconds, jti);
  const signingInput = `${base64UrlJson(parts.header)}.${base64UrlJson(parts.claims)}`;
  const signature = createSign("RSA-SHA256")
    .update(signingInput)
    .sign(config.privateKeyPem)
    .toString("base64url");
  return `${signingInput}.${signature}`;
}

export function buildTokenRequestBody(
  config: Pick<CertCredentialConfig, "clientId" | "scope">,
  assertion: string,
): URLSearchParams {
  return new URLSearchParams({
    client_id: config.clientId,
    scope: config.scope,
    grant_type: "client_credentials",
    client_assertion_type:
      "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: assertion,
  });
}

export type LoadCertConfigOptions = {
  envText?: string;
  certificatePath?: string;
  privateKeyPath?: string;
  repoRoot?: string;
};

export function loadCertCredentialConfig(
  options: LoadCertConfigOptions = {},
): CertCredentialConfig {
  const repoRoot = options.repoRoot ?? new URL("../..", import.meta.url).pathname;
  const envText =
    options.envText ?? readFileSync(`${repoRoot}/.env`, "utf8");
  const env = parseDotEnv(envText);
  const clientId = env.ENTRA_APP_CLIENT_ID;
  const tenantId = env.ENTRA_TENANT_ID;
  if (!clientId) throw new Error("Missing ENTRA_APP_CLIENT_ID in .env");
  if (!tenantId) throw new Error("Missing ENTRA_TENANT_ID in .env");

  const certPath =
    options.certificatePath ??
    env.GRAPH_CERTIFICATE_PATH ??
    `${repoRoot}/ssl_certs/wildcard_tpgarchitecture.crt`;
  const keyPath =
    options.privateKeyPath ??
    env.GRAPH_PRIVATE_KEY_PATH ??
    `${repoRoot}/ssl_certs/wildcard_tpgarchitecture.key`;

  return {
    clientId,
    tenantId,
    certificatePem: readFileSync(certPath, "utf8"),
    privateKeyPem: readFileSync(keyPath, "utf8"),
    scope: env.GRAPH_SCOPE ?? DEFAULT_GRAPH_SCOPE,
  };
}

export type TokenResult = {
  accessToken: string;
  expiresAtMs: number;
};

/** App-only token provider with caching (refresh 5 min before expiry). */
export class GraphTokenProvider {
  #config: CertCredentialConfig;
  #cached: TokenResult | null = null;
  #inflight: Promise<TokenResult> | null = null;

  constructor(config: CertCredentialConfig) {
    this.#config = config;
  }

  async getToken(): Promise<string> {
    const now = Date.now();
    if (this.#cached && this.#cached.expiresAtMs - TOKEN_REFRESH_SKEW_MS > now) {
      return this.#cached.accessToken;
    }
    if (!this.#inflight) {
      this.#inflight = this.#fetchToken().finally(() => {
        this.#inflight = null;
      });
    }
    this.#cached = await this.#inflight;
    return this.#cached.accessToken;
  }

  async #fetchToken(): Promise<TokenResult> {
    const assertion = buildClientAssertion(this.#config);
    const body = buildTokenRequestBody(this.#config, assertion);
    const response = await fetch(tokenEndpoint(this.#config.tenantId), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const payload = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };
    if (!response.ok || !payload.access_token) {
      throw new Error(
        `Token request failed (${response.status}): ${payload.error ?? "unknown"}`,
      );
    }
    return {
      accessToken: payload.access_token,
      expiresAtMs: Date.now() + (payload.expires_in ?? 3600) * 1000,
    };
  }
}
