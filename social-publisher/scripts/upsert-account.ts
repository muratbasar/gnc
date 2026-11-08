import { Firestore } from "@google-cloud/firestore";
import { accountSchema } from "../src/domain.js";

function argumentsAsRecord(values: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index]?.replace(/^--/, "");
    const value = values[index + 1];
    if (key && value) result[key] = value;
  }
  return result;
}

const args = argumentsAsRecord(process.argv.slice(2));
const projectId = process.env.GOOGLE_CLOUD_PROJECT;
if (!projectId) throw new Error("GOOGLE_CLOUD_PROJECT is required");
if (!args.id) throw new Error("--id is required");

const account = accountSchema.parse({
  siteId: args.site,
  platform: args.platform,
  destinationId: args.destination,
  secretId: args.secret,
  enabled: true,
  options: args.userAgent ? { userAgent: args.userAgent } : {},
});

const firestore = new Firestore({ projectId });
await firestore.collection("socialAccounts").doc(args.id).set(account);
console.log(`Saved socialAccounts/${args.id}`);
