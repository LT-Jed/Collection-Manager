-- CreateTable
CREATE TABLE "NodeMembership" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "productGid" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "NodeMembership_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "HierarchyNode" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "NodeMembership_nodeId_productGid_key" ON "NodeMembership"("nodeId", "productGid");

-- CreateIndex
CREATE INDEX "NodeMembership_shopId_productGid_idx" ON "NodeMembership"("shopId", "productGid");

-- CreateIndex
CREATE INDEX "NodeMembership_nodeId_idx" ON "NodeMembership"("nodeId");
