import { describe, expect, it } from "vitest";
import type {
  Credential,
  Platform,
  PostContent,
  SocialAccount,
} from "./domain.js";
import type { HttpClient } from "./http.js";
import { createPublishers } from "./publishers.js";

class MockHttpClient implements HttpClient {
  readonly calls: { url: string; init: RequestInit }[] = [];

  constructor(private readonly responses: unknown[]) {}

  async request<T>(url: string, init: RequestInit): Promise<T> {
    this.calls.push({ url, init });
    const response = this.responses.shift();
    if (response === undefined) throw new Error("Missing mock response");
    return response as T;
  }
}

const credential: Credential = { accessToken: "secret-token" };
const content: PostContent = {
  text: "Explore Ephesus with a local guide.",
  title: "Ephesus private tours",
  link: "https://ephesusancientcity.com/tours",
  imageUrl: "https://ephesusancientcity.com/image.jpg",
  hashtags: ["Ephesus", "TurkeyTravel"],
};

function account(platform: Platform): SocialAccount {
  return {
    siteId: "ephesus-ancient-city",
    platform,
    destinationId: `${platform}-destination`,
    secretId: `${platform}-secret`,
    enabled: true,
    options: {},
  };
}

describe("platform publishers", () => {
  it.each([
    ["facebook", { id: "facebook-post" }, "facebook-post", 1],
    ["pinterest", { id: "pin-id" }, "pin-id", 1],
    [
      "reddit",
      { json: { data: { name: "t3_reddit" }, errors: [] } },
      "t3_reddit",
      1,
    ],
    ["blogger", { id: "blog-post" }, "blog-post", 1],
    [
      "tumblr",
      { response: { id_string: "tumblr-post" } },
      "tumblr-post",
      1,
    ],
  ] as const)(
    "publishes to %s",
    async (platform, response, expectedId, callCount) => {
      const http = new MockHttpClient([response]);
      const publisher = createPublishers("v24.0", http).get(platform);
      const result = await publisher?.publish(
        account(platform),
        credential,
        content,
      );
      expect(result?.externalId).toBe(expectedId);
      expect(http.calls).toHaveLength(callCount);
      expect(String(http.calls[0]?.init.headers)).not.toContain("secret-token");
    },
  );

  it.each(["instagram", "threads"] as const)(
    "creates and publishes a %s container",
    async (platform) => {
      const http = new MockHttpClient([
        { id: "container-id" },
        { id: "published-id" },
      ]);
      const publisher = createPublishers("v24.0", http).get(platform);
      const result = await publisher?.publish(
        account(platform),
        credential,
        content,
      );
      expect(result?.externalId).toBe("published-id");
      expect(http.calls).toHaveLength(2);
    },
  );

  it("requires an image for Instagram", async () => {
    const http = new MockHttpClient([]);
    const publisher = createPublishers("v24.0", http).get("instagram");
    await expect(
      publisher?.publish(account("instagram"), credential, {
        text: "No image",
        hashtags: [],
      }),
    ).rejects.toThrow("imageUrl");
  });
});
