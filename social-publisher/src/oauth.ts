import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Firestore, Timestamp } from "@google-cloud/firestore";
import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

const oauthClientSecretSchema = z.object({
  clientSecret: z.string().min(1),
  setupKey: z.string().min(32),
});

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
  refresh_token: z.string().min(1),
});

const callbackQuerySchema = z.object({
  code: z.string().min(1),
  state: z.string().min(32),
});

const canvaScopes = [
  "asset:read",
  "asset:write",
  "brandtemplate:content:read",
  "brandtemplate:meta:read",
  "design:content:read",
  "design:content:write",
  "design:meta:read",
  "profile:read",
].join(" ");

interface CanvaOAuthConfig {
  clientId: string;
  clientSecretId: string;
  projectId: string;
  redirectUri: string;
  tokenSecretId: string;
}

function secretName(projectId: string, secretId: string): string {
  return `projects/${projectId}/secrets/${secretId}`;
}

function equalSecret(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

function bearerToken(value: string | undefined): string | undefined {
  return value?.match(/^Bearer\s+(.+)$/i)?.[1];
}

export function registerCanvaOAuth(
  app: FastifyInstance,
  firestore: Firestore,
  secrets: SecretManagerServiceClient,
  config: CanvaOAuthConfig,
): void {
  const states = firestore.collection("canvaOAuthStates");
  let cachedClientSecret:
    | { clientSecret: string; setupKey: string }
    | undefined;

  async function getClientSecret() {
    if (cachedClientSecret) return cachedClientSecret;
    const [version] = await secrets.accessSecretVersion({
      name: `${secretName(config.projectId, config.clientSecretId)}/versions/latest`,
    });
    const payload = version.payload?.data?.toString();
    if (!payload) throw new Error("Canva OAuth client secret is empty");
    cachedClientSecret = oauthClientSecretSchema.parse(JSON.parse(payload));
    return cachedClientSecret;
  }

  app.get("/oauth/canva/start", async (request, reply) => {
    const clientSecret = await getClientSecret();
    const supplied = bearerToken(request.headers.authorization);
    if (!supplied || !equalSecret(supplied, clientSecret.setupKey)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    const state = randomBytes(48).toString("base64url");
    const codeVerifier = randomBytes(64).toString("base64url");
    const codeChallenge = createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");
    await states.doc(state).create({
      codeVerifier,
      createdAt: Timestamp.now(),
      expiresAt: Timestamp.fromMillis(Date.now() + 10 * 60_000),
    });

    const query = new URLSearchParams({
      client_id: config.clientId,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      redirect_uri: config.redirectUri,
      response_type: "code",
      scope: canvaScopes,
      state,
    });
    return {
      authorizationUrl: `https://www.canva.com/api/oauth/authorize?${query}`,
      expiresInSeconds: 600,
    };
  });

  app.get("/oauth/canva/callback", async (request, reply) => {
    const query = callbackQuerySchema.parse(request.query);
    const stateRef = states.doc(query.state);
    const codeVerifier = await firestore.runTransaction(
      async (transaction) => {
        const state = await transaction.get(stateRef);
        const data = state.data();
        if (
          !state.exists ||
          !(data?.expiresAt instanceof Timestamp) ||
          data.expiresAt.toMillis() <= Date.now()
        ) {
          throw new Error("OAuth state is invalid or expired");
        }
        transaction.delete(stateRef);
        return String(data.codeVerifier);
      },
    );
    const clientSecret = await getClientSecret();
    const response = await fetch("https://api.canva.com/rest/v1/oauth/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(
          `${config.clientId}:${clientSecret.clientSecret}`,
        ).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        code: query.code,
        code_verifier: codeVerifier,
        grant_type: "authorization_code",
        redirect_uri: config.redirectUri,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const raw: unknown = await response.json();
    if (!response.ok) {
      request.log.error(
        { status: response.status },
        "Canva token exchange failed",
      );
      return reply.code(502).send("Canva authorization failed.");
    }
    const token = tokenResponseSchema.parse(raw);
    const storedCredential = {
      accessToken: token.access_token,
      expiresAt: new Date(
        Date.now() + token.expires_in * 1_000,
      ).toISOString(),
      refresh: {
        tokenUrl: "https://api.canva.com/rest/v1/oauth/token",
        clientId: config.clientId,
        clientSecret: clientSecret.clientSecret,
        refreshToken: token.refresh_token,
        authStyle: "basic",
        extra: {},
      },
    };
    await secrets.addSecretVersion({
      parent: secretName(config.projectId, config.tokenSecretId),
      payload: {
        data: Buffer.from(JSON.stringify(storedCredential), "utf8"),
      },
    });
    return reply
      .type("text/html; charset=utf-8")
      .send(
        "<!doctype html><html><body><h1>Canva connected</h1><p>You can close this window.</p></body></html>",
      );
  });
}
