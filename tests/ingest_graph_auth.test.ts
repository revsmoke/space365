import { describe, expect, test } from "bun:test";
import { createHash, createVerify, generateKeyPairSync } from "node:crypto";
import {
  buildAssertionParts,
  buildClientAssertion,
  buildTokenRequestBody,
  computeX5t,
  pemCertificateToDer,
  tokenEndpoint,
} from "../ingest/src/graph_auth";

const CLIENT_ID = "11111111-2222-3333-4444-555555555555";
const TENANT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

/** Synthetic PEM whose DER bytes we control exactly. */
function syntheticCertPem(derBytes: Buffer): string {
  const b64 = derBytes.toString("base64").replace(/(.{64})/g, "$1\n");
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
}

const DER = Buffer.from("space365-test-certificate-der-bytes");
const CERT_PEM = syntheticCertPem(DER);
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_KEY_PEM = privateKey.export({ type: "pkcs8", format: "pem" }) as string;

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

describe("certificate assertion builder", () => {
  test("x5t is base64url(SHA1(cert DER))", () => {
    const expected = createHash("sha1").update(DER).digest("base64url");
    expect(computeX5t(CERT_PEM)).toBe(expected);
    // base64url alphabet only, no padding
    expect(computeX5t(CERT_PEM)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("pemCertificateToDer round-trips the DER bytes", () => {
    expect(pemCertificateToDer(CERT_PEM).equals(DER)).toBe(true);
    expect(() => pemCertificateToDer("not a pem")).toThrow();
  });

  test("assertion header and claims have the required shape", () => {
    const now = 1_751_800_000;
    const parts = buildAssertionParts(
      { clientId: CLIENT_ID, tenantId: TENANT_ID, certificatePem: CERT_PEM },
      now,
      "fixed-jti",
    );
    expect(parts.header).toEqual({
      alg: "RS256",
      typ: "JWT",
      x5t: computeX5t(CERT_PEM),
    });
    expect(parts.claims.aud).toBe(
      `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`,
    );
    expect(parts.claims.iss).toBe(CLIENT_ID);
    expect(parts.claims.sub).toBe(CLIENT_ID);
    expect(parts.claims.jti).toBe("fixed-jti");
    expect(parts.claims.nbf).toBe(now);
    expect(parts.claims.exp).toBe(now + 600);
  });

  test("signed JWT verifies with the certificate key and decodes to the same parts", () => {
    const now = 1_751_800_000;
    const jwt = buildClientAssertion(
      {
        clientId: CLIENT_ID,
        tenantId: TENANT_ID,
        certificatePem: CERT_PEM,
        privateKeyPem: PRIVATE_KEY_PEM,
      },
      now,
      "fixed-jti",
    );
    const [headerB64, claimsB64, signatureB64] = jwt.split(".");
    expect(decodeSegment(headerB64)).toEqual({
      alg: "RS256",
      typ: "JWT",
      x5t: computeX5t(CERT_PEM),
    });
    const claims = decodeSegment(claimsB64);
    expect(claims.iss).toBe(CLIENT_ID);
    expect(claims.exp).toBe(now + 600);

    const verified = createVerify("RSA-SHA256")
      .update(`${headerB64}.${claimsB64}`)
      .verify(publicKey, Buffer.from(signatureB64, "base64url"));
    expect(verified).toBe(true);
  });

  test("token request body uses the jwt-bearer assertion type, no client_secret", () => {
    const body = buildTokenRequestBody(
      { clientId: CLIENT_ID, scope: "https://graph.microsoft.com/.default" },
      "assertion-jwt",
    );
    expect(body.get("grant_type")).toBe("client_credentials");
    expect(body.get("client_assertion_type")).toBe(
      "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    );
    expect(body.get("client_assertion")).toBe("assertion-jwt");
    expect(body.get("client_secret")).toBeNull();
  });

  test("tokenEndpoint targets the tenant", () => {
    expect(tokenEndpoint(TENANT_ID)).toContain(TENANT_ID);
  });
});
