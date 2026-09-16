import { validateProductionConfig } from "./config.mjs";
import { query, runWithTenant } from "./db.mjs";
import { createJsonService, ok, route } from "./http.mjs";
import { DEFAULT_TENANT_ID, tenantIdFromHeaders } from "./tenant.mjs";

// Shared scaffold for every domain service. It owns the pieces each index.mjs used to repeat:
// production-config gate, /health and /ready, the demo /reset route, first-boot seeding, and
// resolving the caller's tenant once per request so handlers read `ctx.tenantId`.
//
// `seed` is `{ table, reseed, list }`: on boot, seed `table` when it has no rows for the
// default tenant; on POST /reset, reseed and return `list(tenantId)`.
export async function createDomainService({ name, port, db, seed, metrics, routes }) {
  validateProductionConfig(name);

  if (seed) {
    await runWithTenant(DEFAULT_TENANT_ID, async () => {
      const { rows } = await query(db, `SELECT 1 FROM ${seed.table} WHERE tenant_id = $1 LIMIT 1`, [DEFAULT_TENANT_ID]);
      if (!rows.length) {
        await seed.reseed(DEFAULT_TENANT_ID);
      }
    });
  }

  const allRoutes = [
    route("GET", "/health", () => ok({ status: "ok", service: name }), { public: true }),
    route("GET", "/ready", async () => {
      await query(db, "SELECT 1");
      return ok({ status: "ready" });
    }, { public: true }),
    ...(seed
      ? [route("POST", "/reset", async ({ tenantId }) => {
          await seed.reseed(tenantId);
          return ok(await seed.list(tenantId));
        })]
      : []),
    ...routes
  ];

  return createJsonService({
    name,
    port,
    internalAuthRequired: true,
    extraMetrics: metrics,
    routes: allRoutes.map(withTenantId)
  });
}

// Handlers receive `tenantId` without every route re-parsing the same header. The header is
// also parsed (and must be valid) by createJsonService before the handler runs, so this only
// removes repetition -- it adds no new validation path.
function withTenantId(routeDef) {
  if (routeDef.public) return routeDef;
  return {
    ...routeDef,
    handler: (context) => routeDef.handler({ ...context, tenantId: tenantIdFromHeaders(context.headers) })
  };
}
