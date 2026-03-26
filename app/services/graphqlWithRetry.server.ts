import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wraps admin.graphql with automatic retry on transient errors.
 * Retries on: throttle (429), bad gateway (502), service unavailable (503),
 * gateway timeout (504), and internal server errors (500).
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
      const statusCode = error?.response?.code;
      const isRetryable =
        error?.message?.includes("Throttled") ||
        error?.message?.includes("Bad Gateway") ||
        error?.message?.includes("Internal Server Error") ||
        error?.message?.includes("Service Unavailable") ||
        error?.message?.includes("Gateway Timeout") ||
        error?.message?.includes("ECONNRESET") ||
        error?.message?.includes("ETIMEDOUT") ||
        statusCode === 429 ||
        statusCode === 500 ||
        statusCode === 502 ||
        statusCode === 503 ||
        statusCode === 504;

      if (isRetryable && attempt < MAX_RETRIES) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        console.log(
          `GraphQL error (${statusCode || error?.message?.slice(0, 50)}), retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
        );
        await sleep(delay);
        continue;
      }

      throw error;
    }
  }

  throw new Error("Max retries exceeded");
}
