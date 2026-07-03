// There is no auth/identity system yet (that lands in the M4 backlog), so every service scopes
// its rows to this one seeded tenant instead of leaving tenant_id null. Every table already
// carries a real tenant_id column and FK -- swapping this constant for a value derived from a
// verified request context is the only change M4's tenant isolation work needs to make here.
export const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";
