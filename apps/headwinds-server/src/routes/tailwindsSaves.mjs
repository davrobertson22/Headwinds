// /tw/saves — Tailwinds cloud saves, a supporter perk. All of the logic is in
// lib/cloudSaves.mjs (testable without a database); this file only wires the
// real auth gate and the real Prisma table into it.
import { requireAuth } from '../auth.mjs';
import { prisma } from '../db.mjs';
import { cloudSaveRoutes, prismaCloudSaveStore } from '../lib/cloudSaves.mjs';

export default cloudSaveRoutes({ store: prismaCloudSaveStore(prisma), authenticate: requireAuth });
