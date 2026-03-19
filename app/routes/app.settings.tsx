import { useEffect, useCallback, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useLoaderData, useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { runFullSync } from "../services/collectionSync.server";
import { syncSeparateCollections } from "../services/separateCollections.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const shop = await db.shop.upsert({
    where: { shopDomain: session.shop },
    create: { shopDomain: session.shop },
    update: {},
  });

  return {
    settings: {
      brandMode: shop.brandMode,
      defaultBreadcrumbTree: shop.defaultBreadcrumbTree,
      minProductThreshold: shop.minProductThreshold,
      artistEnabled: shop.artistEnabled,
      lineEnabled: shop.lineEnabled,
      collectionEnabled: shop.collectionEnabled,
    },
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();

  const brandMode = (formData.get("brandMode") as string) || "brand_only";
  const defaultBreadcrumbTree =
    (formData.get("defaultBreadcrumbTree") as string) || "branded";
  const minProductThreshold =
    parseInt(formData.get("minProductThreshold") as string, 10) || 1;
  const artistEnabled = formData.get("artistEnabled") === "true";
  const lineEnabled = formData.get("lineEnabled") === "true";
  const collectionEnabled = formData.get("collectionEnabled") === "true";

  // Get current settings to detect changes
  const currentShop = await db.shop.findUnique({
    where: { shopDomain: session.shop },
  });

  const hierarchyChanged =
    currentShop &&
    (currentShop.brandMode !== brandMode ||
      currentShop.minProductThreshold !== minProductThreshold);

  const separateChanged =
    currentShop &&
    (currentShop.artistEnabled !== artistEnabled ||
      currentShop.lineEnabled !== lineEnabled ||
      currentShop.collectionEnabled !== collectionEnabled);

  // Update settings
  await db.shop.update({
    where: { shopDomain: session.shop },
    data: {
      brandMode,
      defaultBreadcrumbTree,
      minProductThreshold,
      artistEnabled,
      lineEnabled,
      collectionEnabled,
    },
  });

  // Trigger re-syncs if needed
  if (hierarchyChanged) {
    await runFullSync(admin, session.shop);
  }
  if (separateChanged) {
    await syncSeparateCollections(admin, session.shop);
  }

  return { success: true };
};

export default function Settings() {
  const { settings } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const [brandMode, setBrandMode] = useState(settings.brandMode);

  const isLoading =
    ["loading", "submitting"].includes(fetcher.state) &&
    fetcher.formMethod === "POST";

  useEffect(() => {
    if (fetcher.data) {
      if ((fetcher.data as { success: boolean }).success) {
        shopify.toast.show("Settings saved");
      }
    }
  }, [fetcher.data, shopify]);

  const handleSubmit = useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const form = e.currentTarget;
      const formData = new FormData();

      // Brand mode radio
      const brandModeRadio = form.querySelector(
        'input[name="brandMode"]:checked',
      ) as HTMLInputElement | null;
      formData.set("brandMode", brandModeRadio?.value ?? "brand_only");

      // Default breadcrumb tree
      const defaultTree = form.querySelector(
        'input[name="defaultBreadcrumbTree"]:checked',
      ) as HTMLInputElement | null;
      formData.set(
        "defaultBreadcrumbTree",
        defaultTree?.value ?? "branded",
      );

      formData.set(
        "minProductThreshold",
        (
          form.querySelector(
            '[name="minProductThreshold"]',
          ) as HTMLInputElement
        )?.value || "1",
      );
      formData.set(
        "artistEnabled",
        (form.querySelector('[name="artistEnabled"]') as HTMLInputElement)
          ?.checked
          ? "true"
          : "false",
      );
      formData.set(
        "lineEnabled",
        (form.querySelector('[name="lineEnabled"]') as HTMLInputElement)
          ?.checked
          ? "true"
          : "false",
      );
      formData.set(
        "collectionEnabled",
        (form.querySelector('[name="collectionEnabled"]') as HTMLInputElement)
          ?.checked
          ? "true"
          : "false",
      );

      fetcher.submit(formData, { method: "POST" });
    },
    [fetcher],
  );

  return (
    <s-page heading="Settings">
      <form onSubmit={handleSubmit}>
        <s-stack direction="block" gap="base">
          <s-section heading="Brand Hierarchy Mode">
            <s-stack direction="block" gap="base">
              <s-paragraph>
                Choose how the Brand (vendor) level is handled in the collection
                hierarchy.
              </s-paragraph>

              <s-stack direction="block" gap="small-200">
                <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
                  <input
                    type="radio"
                    name="brandMode"
                    value="brand_only"
                    checked={brandMode === "brand_only"}
                    onChange={() => setBrandMode("brand_only")}
                  />
                  <span>
                    <strong>Brand only</strong> — Hierarchy starts with Brand
                  </span>
                </label>

                <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
                  <input
                    type="radio"
                    name="brandMode"
                    value="no_brand"
                    checked={brandMode === "no_brand"}
                    onChange={() => setBrandMode("no_brand")}
                  />
                  <span>
                    <strong>No brand</strong> — Hierarchy starts with Product Type (skips Brand)
                  </span>
                </label>

                <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
                  <input
                    type="radio"
                    name="brandMode"
                    value="both"
                    checked={brandMode === "both"}
                    onChange={() => setBrandMode("both")}
                  />
                  <span>
                    <strong>Both</strong> — Creates two parallel hierarchies: one starting with Brand, one without
                  </span>
                </label>
              </s-stack>

              {brandMode === "both" && (
                <s-box padding="small-200" borderWidth="base" borderRadius="base">
                  <s-stack direction="block" gap="small-200">
                    <s-text type="strong">Default breadcrumb tree</s-text>
                    <s-paragraph>
                      When a visitor arrives from outside the site (or from a non-collection page),
                      which hierarchy should the breadcrumbs default to?
                    </s-paragraph>
                    <s-stack direction="block" gap="small-200">
                      <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
                        <input
                          type="radio"
                          name="defaultBreadcrumbTree"
                          value="branded"
                          defaultChecked={settings.defaultBreadcrumbTree === "branded"}
                        />
                        <span>Branded (default)</span>
                      </label>
                      <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
                        <input
                          type="radio"
                          name="defaultBreadcrumbTree"
                          value="unbranded"
                          defaultChecked={settings.defaultBreadcrumbTree === "unbranded"}
                        />
                        <span>Unbranded</span>
                      </label>
                    </s-stack>
                  </s-stack>
                </s-box>
              )}
            </s-stack>
          </s-section>

          <s-section heading="General Settings">
            <s-number-field
              label="Minimum products to create a collection"
              name="minProductThreshold"
              value={String(settings.minProductThreshold)}
              min={1}
            />
          </s-section>

          <s-section heading="Separate Collection Groups">
            <s-stack direction="block" gap="base">
              <s-paragraph>
                Enable these to generate separate flat collections based on specific metafields.
                These are independent of the main hierarchy.
              </s-paragraph>

              <s-checkbox
                label="Generate Artist collections (custom.artist)"
                name="artistEnabled"
                {...(settings.artistEnabled ? { checked: true } : {})}
              />

              <s-checkbox
                label="Generate Line collections (custom.line)"
                name="lineEnabled"
                {...(settings.lineEnabled ? { checked: true } : {})}
              />

              <s-checkbox
                label="Generate Collection collections (custom.collection)"
                name="collectionEnabled"
                {...(settings.collectionEnabled ? { checked: true } : {})}
              />
            </s-stack>
          </s-section>

          <s-box padding="base">
            <s-button
              variant="primary"
              type="submit"
              {...(isLoading ? { loading: true } : {})}
            >
              Save Settings
            </s-button>
          </s-box>
        </s-stack>
      </form>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
