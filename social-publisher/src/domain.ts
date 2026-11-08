import { z } from "zod";

export const platformSchema = z.enum([
  "facebook",
  "instagram",
  "threads",
  "pinterest",
  "reddit",
  "blogger",
  "tumblr",
]);

export type Platform = z.infer<typeof platformSchema>;

export const postContentSchema = z
  .object({
    text: z.string().trim().min(1).max(40_000),
    title: z.string().trim().min(1).max(300).optional(),
    link: z.url().optional(),
    imageUrl: z.url().optional(),
    hashtags: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(100)
          .regex(/^#?[\p{L}\p{N}_]+$/u)
          .transform((tag) => tag.replace(/^#/, "")),
      )
      .max(30)
      .default([]),
  })
  .strict();

export type PostContent = z.infer<typeof postContentSchema>;

export const accountSchema = z
  .object({
    siteId: z.string().trim().min(1),
    platform: platformSchema,
    destinationId: z.string().trim().min(1),
    secretId: z.string().trim().min(1),
    enabled: z.boolean().default(true),
    options: z.record(z.string(), z.string()).default({}),
  })
  .strict();

export type SocialAccount = z.infer<typeof accountSchema>;

export const credentialSchema = z
  .object({
    accessToken: z.string().min(1),
    expiresAt: z.iso.datetime({ offset: true }).optional(),
    refresh: z
      .object({
        tokenUrl: z.url(),
        clientId: z.string().min(1),
        clientSecret: z.string().min(1),
        refreshToken: z.string().min(1),
        authStyle: z.enum(["basic", "body"]).default("basic"),
        extra: z.record(z.string(), z.string()).default({}),
      })
      .optional(),
  })
  .passthrough();

export type Credential = z.infer<typeof credentialSchema>;

export const createPublicationSchema = z
  .object({
    siteId: z.string().trim().min(1),
    language: z.literal("en").default("en"),
    content: postContentSchema,
    accountIds: z.array(z.string().trim().min(1)).min(1).max(100),
    scheduledAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

export type CreatePublication = z.infer<typeof createPublicationSchema>;

export type JobStatus =
  | "pending"
  | "processing"
  | "published"
  | "failed"
  | "needs_review";

export interface PublicationJob {
  accountId: string;
  attempt: number;
  content: PostContent;
  createdAt: Date;
  externalId?: string;
  lastError?: string;
  leaseUntil?: Date;
  language: "en";
  publishedAt?: Date;
  scheduledAt: Date;
  siteId: string;
  status: JobStatus;
  updatedAt: Date;
}

export interface ClaimedJob extends PublicationJob {
  id: string;
}

export interface PublishResult {
  externalId: string;
  raw?: unknown;
}

export interface Publisher {
  readonly platform: Platform;
  publish(
    account: SocialAccount,
    credential: Credential,
    content: PostContent,
  ): Promise<PublishResult>;
}
