import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wraps admin.graphql with automatic retry on throttle (429) errors.
 * Uses exponential backoff: 1s, 2s, 4s, 8s, 16s.
 */
export async function graphqlWithRetry(
  admin: AdminApiContext,
  query: string,
  variables?: { variables: Record<string, any> },
): Promise<Response> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response: Response = variables
        ? await admin.graphql(query, variables)
        : await admin.graphql(query);
      return response;
    } catch (error: any) {
      const isThrottled =
        error?.message?.includes("Throttled") ||
        error?.response?.code === 429;

      if (isThrottled && attempt < MAX_RETRIES) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        console.log(
          `GraphQL throttled, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
        );
        await sleep(delay);
        continue;
      }

      throw error;
    }
  }

  // Should never reach here, but TypeScript needs it
  throw new Error("Max retries exceeded");
}
