import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSearchParams } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";

const PAGE_SIZE = 50;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const page = parseInt(url.searchParams.get("page") || "1", 10);

  const shop = await db.shop.findUnique({
    where: { shopDomain: session.shop },
  });

  if (!shop) {
    return { redirects: [], total: 0, page: 1, totalPages: 1 };
  }

  const [redirects, total] = await Promise.all([
    db.redirectLog.findMany({
      where: { shopId: shop.id },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    db.redirectLog.count({ where: { shopId: shop.id } }),
  ]);

  return {
    redirects: redirects.map((r) => ({
      id: r.id,
      fromPath: r.fromPath,
      toPath: r.toPath,
      reason: r.reason,
      createdAt: r.createdAt.toISOString(),
    })),
    total,
    page,
    totalPages: Math.ceil(total / PAGE_SIZE) || 1,
  };
};

function formatReason(reason: string): string {
  return reason
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function Redirects() {
  const { redirects, total, page, totalPages } =
    useLoaderData<typeof loader>();
  const [, setSearchParams] = useSearchParams();

  return (
    <s-page heading="Redirects Log">
      <s-section>
        {redirects.length > 0 ? (
          <>
            <s-box paddingBlockEnd="base">
              <s-text color="subdued">
                {total} redirect{total !== 1 ? "s" : ""} total
              </s-text>
            </s-box>

            <s-data-table>
              <s-data-table-header>
                <s-data-table-header-cell>From</s-data-table-header-cell>
                <s-data-table-header-cell>To</s-data-table-header-cell>
                <s-data-table-header-cell>Reason</s-data-table-header-cell>
                <s-data-table-header-cell>Date</s-data-table-header-cell>
              </s-data-table-header>
              <s-data-table-body>
                {redirects.map(
                  (redirect: {
                    id: string;
                    fromPath: string;
                    toPath: string;
                    reason: string;
                    createdAt: string;
                  }) => (
                    <s-data-table-row key={redirect.id}>
                      <s-data-table-cell>
                        <s-text>{redirect.fromPath}</s-text>
                      </s-data-table-cell>
                      <s-data-table-cell>
                        <s-text>{redirect.toPath}</s-text>
                      </s-data-table-cell>
                      <s-data-table-cell>
                        <s-badge>{formatReason(redirect.reason)}</s-badge>
                      </s-data-table-cell>
                      <s-data-table-cell>
                        <s-text>
                          {new Date(redirect.createdAt).toLocaleDateString()}
                        </s-text>
                      </s-data-table-cell>
                    </s-data-table-row>
                  ),
                )}
              </s-data-table-body>
            </s-data-table>

            {totalPages > 1 && (
              <s-box padding="base">
                <s-stack direction="inline" gap="base" alignItems="center">
                  <s-button
                    variant="tertiary"
                    disabled={page <= 1}
                    onClick={() =>
                      setSearchParams({ page: String(page - 1) })
                    }
                  >
                    Previous
                  </s-button>
                  <s-text>
                    Page {page} of {totalPages}
                  </s-text>
                  <s-button
                    variant="tertiary"
                    disabled={page >= totalPages}
                    onClick={() =>
                      setSearchParams({ page: String(page + 1) })
                    }
                  >
                    Next
                  </s-button>
                </s-stack>
              </s-box>
            )}
          </>
        ) : (
          <s-box padding="base">
            <s-text color="subdued">
              No redirects have been created yet. Redirects are automatically
              created when collections are removed due to products falling below
              the minimum threshold.
            </s-text>
          </s-box>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
