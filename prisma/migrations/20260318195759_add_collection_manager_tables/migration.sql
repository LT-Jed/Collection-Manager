-- CreateTable
CREATE TABLE "Shop" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopDomain" TEXT NOT NULL,
    "brandLevelEnabled" BOOLEAN NOT NULL DEFAULT true,
    "minProductThreshold" INTEGER NOT NULL DEFAULT 1,
    "artistEnabled" BOOLEAN NOT NULL DEFAULT false,
    "lineEnabled" BOOLEAN NOT NULL DEFAULT false,
    "collectionEnabled" BOOLEAN NOT NULL DEFAULT false,
    "lastSyncAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "HierarchyNode" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopId" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "levelName" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "parentId" TEXT,
    "collectionGid" TEXT,
    "collectionHandle" TEXT,
    "productCount" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "HierarchyNode_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "HierarchyNode_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "HierarchyNode" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CollectionSyncJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopId" TEXT NOT NULL,
    "triggeredBy" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "details" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CollectionSyncJob_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RedirectLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopId" TEXT NOT NULL,
    "fromPath" TEXT NOT NULL,
    "toPath" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "redirectGid" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RedirectLog_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Shop_shopDomain_key" ON "Shop"("shopDomain");

-- CreateIndex
CREATE INDEX "HierarchyNode_shopId_level_idx" ON "HierarchyNode"("shopId", "level");

-- CreateIndex
CREATE INDEX "HierarchyNode_parentId_idx" ON "HierarchyNode"("parentId");

-- CreateIndex
CREATE UNIQUE INDEX "HierarchyNode_shopId_level_value_parentId_key" ON "HierarchyNode"("shopId", "level", "value", "parentId");

-- CreateIndex
CREATE INDEX "CollectionSyncJob_shopId_status_idx" ON "CollectionSyncJob"("shopId", "status");

-- CreateIndex
CREATE INDEX "RedirectLog_shopId_idx" ON "RedirectLog"("shopId");
