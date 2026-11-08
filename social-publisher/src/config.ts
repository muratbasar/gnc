import { z } from "zod";

const configSchema = z.object({
  CANVA_CLIENT_ID: z.string().min(1).optional(),
  CANVA_CLIENT_SECRET_ID: z
    .string()
    .min(1)
    .default("canva-oauth-client"),
  CANVA_SECRET_ID: z.string().min(1).default("canva-oauth"),
  FIRESTORE_DATABASE: z.string().min(1).default("(default)"),
  GOOGLE_CLOUD_PROJECT: z.string().min(1),
  JOB_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(25),
  JOB_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  META_GRAPH_VERSION: z
    .string()
    .regex(/^v\d+\.\d+$/)
    .default("v24.0"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
  OAUTH_REDIRECT_URI: z.url().optional(),
  SERVICE_MODE: z.enum(["publisher", "oauth"]).default("publisher"),
  VERTEX_LOCATION: z.string().min(1).default("global"),
  VERTEX_MODEL: z.string().min(1).default("gemini-2.5-flash"),
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AppConfig {
  return configSchema.parse(environment);
}
