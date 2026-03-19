# Collection Manager – Shopify App Plan

## Overview
A Shopify app that automatically maintains a hierarchical collection structure, keeps products organized, manages breadcrumb navigation via theme extensions, and handles redirects when collections become empty.

---

## Architecture

### Tech Stack
- **Backend:** Remix
- **Frontend:** React + Polaris (Shopify's design system)
- **Database:** SQLLite (via Prisma ORM) — stores hierarchy state, settings, sync jobs
- **Shopify APIs:** Admin REST + GraphQL API, Metafields API, URL Redirects API, Theme Extensions API

---

## 1. Data Model

### Hierarchy Levels (ordered)
```
1. Brand          → product.vendor
2. ProductType    → product.product_type
3. Occasion       → metafield: custom.occasion
4. Tone           → metafield: custom.tone
5. Recipient Gender → metafield: custom.recipient_gender
6. Recipient Group  → metafield: custom.recipient_group
7. For Children     → metafield: custom.recipient_kid (bool → "Kids" / "Adults")
```

### Database Tables
- **`shops`** — shopDomain, accessToken, settings (brandLevelEnabled, minProductThreshold)
- **`hierarchy_nodes`** — id, shopId, level, value, parentId, collectionGid, productCount, isActive
- **`collection_sync_jobs`** — jobId, shopId, triggeredBy (webhook/manual), status, createdAt
- **`redirects_log`** — fromPath, toPath, reason, createdAt

---

## 2. Core Backend Services

### A. Hierarchy Builder Service
- On first install or manual sync: scans all products and their metafields
- Builds a tree of unique values at each level
- Only creates a collection node if `productCount >= minProductThreshold`
- Assigns a Shopify Custom Collection + manual product assignments per node

### B. Collection Sync Service
Triggered by webhooks on:
- `products/create`, `products/update`, `products/delete`
- `collections/delete`

Logic per event:
1. Re-evaluate affected hierarchy paths
2. Create missing collections if threshold is now met
3. Remove (and redirect) collections if product count drops below threshold or hits zero
4. Update `collection_lists` metafield on parent collections to reflect current children

### C. Metafield Manager
Each collection gets a metafield:
- **Namespace:** `custom`
- **Key:** `collection_children`
- **Type:** `list.collection_reference`
- **Value:** GIDs of all direct child collections in the hierarchy

### D. Redirect Manager
When a collection is removed:
- If it has a parent collection → redirect `/collections/[handle]` → `/collections/[parent-handle]`
- If it's a top-level collection → redirect to `/collections/all`
- Uses Shopify's URL Redirects API, logs to `redirects_log`

---

## 3. Shopify Webhooks

| Webhook Topic | Action |
|---|---|
| `products/create` | Evaluate new hierarchy paths, create collections if threshold met |
| `products/update` | Re-evaluate changed vendor/type/metafields, move product across hierarchy |
| `products/delete` | Decrement counts, remove collections + redirect if below threshold |
| `collections/delete` | Ensure redirect is created if externally deleted |
| `app/uninstalled` | Cleanup |

---

## 4. Frontend (Shopify Embedded App – Polaris)

### Pages

**Dashboard**
- Hierarchy tree visualization (collapsible nodes per level)
- Collection count per level, product count per collection
- Last sync timestamp + "Sync Now" button

**Settings Page**
- Toggle: *Enable Brand-level collections* (on/off) — when off, hierarchy starts at ProductType
- Number input: *Minimum products to create a collection* (default: 1)
- Save + auto-trigger a re-sync on change
- Toggle to generate seperate collections based on metafield of custom.artist
- Toggle to generate seperate collections based on metafield of custom.line
- Toggle to generate seperate collections based on metafield of custom.collection

**Collections View**
- Browse the full hierarchy tree
- Per node: collection name, handle, product count, child collections, link to Shopify admin
- Manually trigger a re-sync on a specific node

**Redirects Log**
- Table of all auto-created redirects (from → to, reason, date)

---

## 5. Theme Extensions

### Extension A: Collection Page Breadcrumb
- Renders breadcrumb trail for a collection page
- Reads the collection's `custom.collection_children` metafield (and walks up via parent reference) to build the trail
- Format: `All Products > Brand > ProductType > Occasion > ...`
- Top-level links back to `/collections/all`
- Built as a **Shopify Section / Block** using Liquid + JSON schema

### Extension B: Product Page Breadcrumb
- Renders breadcrumb trail on a product page
- Derives the deepest applicable hierarchy path for that product (based on vendor, type, and metafields)
- Walks up the hierarchy to build the full breadcrumb chain
- Deepest collection links directly, each ancestor links to its collection handle
- Also built as a **Shopify Section / Block**

### Extension C: Seperate Collection Shop page
- Select one of the seperate collections (custom.artist, line or collection) and display all collections options in that group
- Make it searchable

Both extensions will:
- Be configurable in the Theme Editor (show/hide levels, separator character)
- Gracefully degrade if collections haven't been created yet
- All will be under one extension but different blocks

---

## 6. Key Workflows

### Install Flow
1. OAuth → store access token
2. Register all webhooks
3. Define metafield definitions on the shop (collection_children)
4. Queue a full product scan + hierarchy build job
5. Redirect merchant to Dashboard

### Product Update Flow
1. Webhook received → enqueue sync job
2. Fetch product's vendor, type, and all 5 metafields
3. Compute full hierarchy path (respecting brandLevelEnabled setting)
4. For each level in path: upsert collection, add product, update parent's `collection_children` metafield
5. Check old path — remove product from any collections it no longer belongs to
6. If any collection's count drops below threshold → remove collection + create redirect

### Settings Change Flow
1. Merchant changes `brandLevelEnabled` or `minProductThreshold`
2. App saves setting, queues a full re-sync
3. Re-sync rebuilds hierarchy from scratch using new rules
4. Orphaned collections are redirected, new collections are created

---

## 7. Project File Structure

```
collection-manager/
├── app/                        # Remix app (frontend + backend routes)
│   ├── routes/
│   │   ├── app._index.jsx      # Dashboard
│   │   ├── app.settings.jsx    # Settings page
│   │   ├── app.collections.jsx # Collections browser
│   │   ├── app.redirects.jsx   # Redirects log
│   │   └── webhooks/           # Webhook handlers
│   ├── services/
│   │   ├── hierarchyBuilder.js
│   │   ├── collectionSync.js
│   │   ├── metafieldManager.js
│   │   └── redirectManager.js
│   └── components/             # Polaris UI components
├── extensions/
│   ├── breadcrumb-collection/  # Theme extension – collection page
│   └── breadcrumb-product/     # Theme extension – product page
├── prisma/
│   └── schema.prisma
└── shopify.app.toml
```

---