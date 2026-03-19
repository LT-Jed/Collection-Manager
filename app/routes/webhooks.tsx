import type { ActionFunctionArgs } from "react-router";
import { authenticate, unauthenticated } from "../shopify.server";
import { syncProduct, handleCollectionDelete } from "../services/collectionSync.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, session, topic, shop } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  switch (topic) {
    case "APP_UNINSTALLED":
      if (session) {
        await db.session.deleteMany({ where: { shop } });
      }
      break;

    case "APP_SCOPES_UPDATE": {
      const current = payload.current as string[];
      if (session) {
        await db.session.update({
          where: { id: session.id },
          data: { scope: current.toString() },
        });
      }
      break;
    }

    case "PRODUCTS_CREATE": {
      const { admin } = await unauthenticated.admin(shop);
      await syncProduct(admin, shop, payload.admin_graphql_api_id as string, "create");
      break;
    }

    case "PRODUCTS_UPDATE": {
      const { admin } = await unauthenticated.admin(shop);
      await syncProduct(admin, shop, payload.admin_graphql_api_id as string, "update");
      break;
    }

    case "PRODUCTS_DELETE": {
      const { admin } = await unauthenticated.admin(shop);
      await syncProduct(
        admin,
        shop,
        payload.admin_graphql_api_id as string,
        "delete",
        (payload.handle as string) || undefined,
      );
      break;
    }

    case "COLLECTIONS_DELETE": {
      const { admin } = await unauthenticated.admin(shop);
      await handleCollectionDelete(admin, shop, payload.admin_graphql_api_id as string);
      break;
    }

    default:
      console.log(`Unhandled webhook topic: ${topic}`);
  }

  return new Response();
};
