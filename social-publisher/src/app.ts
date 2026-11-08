import { Firestore } from "@google-cloud/firestore";
import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import Fastify from "fastify";
import { z, ZodError } from "zod";
import { CanvaTemplateRenderer } from "./canva.js";
import type { AppConfig } from "./config.js";
import { DailyGenerator } from "./daily.js";
import { Dispatcher } from "./dispatcher.js";
import { createPublicationSchema } from "./domain.js";
import { VertexContentGenerator } from "./generation.js";
import { createPublishers } from "./publishers.js";
import { loadSites } from "./sites.js";
import { SiteSourceReader } from "./source.js";
import {
  AccountStore,
  CredentialStore,
  DailyRunStore,
  JobStore,
} from "./storage.js";

const dispatchRequestSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

export async function buildApp(config: AppConfig) {
  const app = Fastify({
    logger: {
      redact: {
        paths: ["req.headers.authorization", "req.headers.cookie"],
        censor: "[REDACTED]",
      },
    },
  });
  const firestore = new Firestore({
    projectId: config.GOOGLE_CLOUD_PROJECT,
    databaseId: config.FIRESTORE_DATABASE,
    ignoreUndefinedProperties: true,
  });
  const accountStore = new AccountStore(firestore);
  const credentialStore = new CredentialStore(
    new SecretManagerServiceClient(),
    config.GOOGLE_CLOUD_PROJECT,
  );
  const jobStore = new JobStore(firestore);
  const dispatcher = new Dispatcher(
    accountStore,
    credentialStore,
    jobStore,
    createPublishers(config.META_GRAPH_VERSION),
    config.JOB_MAX_ATTEMPTS,
  );
  const dailyGenerator = new DailyGenerator(
    await loadSites(),
    accountStore,
    credentialStore,
    jobStore,
    new DailyRunStore(firestore),
    new SiteSourceReader(),
    new VertexContentGenerator(
      config.GOOGLE_CLOUD_PROJECT,
      config.VERTEX_LOCATION,
      config.VERTEX_MODEL,
    ),
    new CanvaTemplateRenderer(),
    config.CANVA_SECRET_ID,
  );

  app.get("/health", async () => ({ status: "ok" }));

  app.post("/v1/publications", async (request, reply) => {
    const input = createPublicationSchema.parse(request.body);
    await accountStore.assertForSite(input.accountIds, input.siteId);
    const jobIds = await jobStore.enqueue(input);
    return reply.code(202).send({ jobIds });
  });

  app.post("/v1/dispatch", async (request) => {
    const input = dispatchRequestSchema.parse(request.body ?? {});
    return dispatcher.dispatch(input.limit ?? config.JOB_BATCH_SIZE);
  });

  app.post("/v1/generate-daily", async () => dailyGenerator.run());

  app.get<{ Params: { jobId: string } }>(
    "/v1/jobs/:jobId",
    async (request, reply) => {
      const job = await jobStore.get(request.params.jobId);
      if (!job) return reply.code(404).send({ error: "Job not found" });
      return job;
    },
  );

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: "Invalid request",
        issues: error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }
    request.log.error({ err: error }, "request failed");
    return reply.code(500).send({ error: "Internal server error" });
  });

  return app;
}
