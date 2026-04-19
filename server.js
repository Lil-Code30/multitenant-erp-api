/**
 * ================================================================
 *  MULTITENANT ERP API — Complete Example
 * ================================================================
 *
 *  Concepts demonstrated:
 *    1. Multitenancy: one app, isolated data per tenant
 *    2. JWT Claims: tenant_id, user_id, role, permissions
 *    3. Role-based access control (RBAC) via middleware
 *    4. Tenant isolation: every DB query is scoped by tenant_id
 *
 *  Install: pnpm install express jsonwebtoken
 *  Run:     node server.js
 * ================================================================
 */

const express = require("express");
const jwt = require("jsonwebtoken");

const app = express();
app.use(express.json());
app.use(require("cors")());

// ─── SECRET KEY ──────────────────────────────────────────────────
const JWT_SECRET = "super-secret-key-change-in-prod";

// ─── FAKE DATABASE ────────────────────────────────────────────────
// Simulates schema-per-tenant isolation.
// In a real app: each tenant has its own DB schema or a "tenant_id" column.
const db = {
  acme_corp: {
    invoices: [
      { id: "inv_1", amount: 5000, client: "Stark Industries", status: "paid" },
      {
        id: "inv_2",
        amount: 1200,
        client: "Wayne Enterprises",
        status: "pending",
      },
    ],
    users: [
      { id: "usr_1", name: "Alice", role: "admin" },
      { id: "usr_2", name: "Bob", role: "accountant" },
      { id: "usr_3", name: "Carol", role: "viewer" },
    ],
  },
  globex_inc: {
    invoices: [
      {
        id: "inv_9",
        amount: 99000,
        client: "Aperture Science",
        status: "overdue",
      },
    ],
    users: [{ id: "usr_10", name: "Hank Scorpio", role: "admin" }],
  },
};

// ─── ROLES & PERMISSIONS ─────────────────────────────────────────
//
// This is "Claims-Based Authorization":
//   - A "claim" is a piece of information asserted about a user
//     (who they are, what they can do, which tenant they belong to)
//   - Claims are embedded in the JWT token — no DB call needed to check them
//   - Roles group permissions: instead of checking 30 permissions one by one,
//     you assign a role that bundles them
//
const ROLES = {
  //                   read    write   delete  manage_users
  admin: { permissions: ["read", "write", "delete", "manage_users"] },
  accountant: { permissions: ["read", "write"] },
  viewer: { permissions: ["read"] },
};

// ─── HELPER: GENERATE A JWT TOKEN ────────────────────────────────
//
// The token payload (the "claims") contains:
//   sub        → standard JWT: the subject (user ID)
//   tenant_id  → CRITICAL: which company this user belongs to
//   role       → their role within that company (admin, accountant, viewer)
//   permissions→ pre-computed from role so middleware doesn't hit the DB
//   iat / exp  → standard JWT: issued-at, expires
//
function generateToken(userId, tenantId, role) {
  const payload = {
    sub: userId,
    tenant_id: tenantId,
    role: role,
    permissions: ROLES[role]?.permissions ?? [],
  };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "8h" });
}

// ================================================================
//  MIDDLEWARE 1 — Authentication (who are you?)
//  Decodes the JWT and attaches the claims to req.user
// ================================================================
function authenticate(req, res, next) {
  const authHeader = req.headers["authorization"];
  if (!authHeader?.startsWith("Bearer ")) {
    return res
      .status(401)
      .json({ error: "Missing or malformed Authorization header" });
  }

  const token = authHeader.slice(7);
  try {
    // jwt.verify() both decodes AND checks signature + expiry
    const claims = jwt.verify(token, JWT_SECRET);

    // Attach ALL claims to the request — available everywhere downstream
    req.user = {
      userId: claims.sub,
      tenantId: claims.tenant_id, // ← this is the multitenancy key
      role: claims.role,
      permissions: claims.permissions,
    };

    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// ================================================================
//  MIDDLEWARE 2 — Tenant isolation (which company's data?)
//  Ensures the tenant's data exists and is accessible
// ================================================================
function tenantScope(req, res, next) {
  const tenantData = db[req.user.tenantId];

  if (!tenantData) {
    return res.status(403).json({
      error: `Tenant '${req.user.tenantId}' not found or not active`,
    });
  }

  // Attach tenant-scoped data to req — controllers use req.db, never raw db
  // This is the key pattern: no route ever calls db[someId] directly.
  // Everything goes through req.db, which is already filtered to this tenant.
  req.db = tenantData;

  next();
}

// ================================================================
//  MIDDLEWARE 3 — Authorization (what can you do?)
//  Factory function: requirePermission("write") → middleware
// ================================================================
function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user.permissions.includes(permission)) {
      return res.status(403).json({
        error: `Access denied. Your role '${req.user.role}' lacks '${permission}' permission.`,
        yourPermissions: req.user.permissions,
      });
    }
    next();
  };
}

// ================================================================
//  ROUTE: /auth/login  — Issues a JWT (simulates authentication)
// ================================================================
//
// In production: validate username/password against DB, then issue token.
// Here we just map a user lookup and hand back the token.
//
// Try these request bodies:
//   { "userId": "usr_1", "tenantId": "acme_corp"  }   → Alice, admin
//   { "userId": "usr_2", "tenantId": "acme_corp"  }   → Bob, accountant
//   { "userId": "usr_3", "tenantId": "acme_corp"  }   → Carol, viewer
//   { "userId": "usr_10","tenantId": "globex_inc" }   → Hank, admin
//
app.post("/auth/login", (req, res) => {
  const { userId, tenantId } = req.body;

  const tenantData = db[tenantId];
  if (!tenantData) return res.status(404).json({ error: "Tenant not found" });

  const user = tenantData.users.find((u) => u.id === userId);
  if (!user) return res.status(404).json({ error: "User not found in tenant" });

  const token = generateToken(user.id, tenantId, user.role);

  res.json({
    token,
    // Decode for clarity — in real apps, don't send this
    claimsPreview: {
      sub: user.id,
      tenant_id: tenantId,
      role: user.role,
      permissions: ROLES[user.role].permissions,
      expires: "in 8 hours",
    },
  });
});

// ================================================================
//  PROTECTED ROUTES — All require authentication + tenant scope
// ================================================================

// Apply both middlewares to everything under /api
app.use("/api", authenticate, tenantScope);

// ── GET /api/invoices ─────────────────────────────────────────────
// requirePermission("read") → only users with "read" can access
// req.db is already scoped to this tenant — no extra filter needed
//
app.get("/api/invoices", requirePermission("read"), (req, res) => {
  res.json({
    tenant: req.user.tenantId,
    invoices: req.db.invoices, // ← already isolated to acme_corp or globex_inc
  });
});

// ── POST /api/invoices ────────────────────────────────────────────
// Requires "write" — viewers cannot create invoices
//
app.post("/api/invoices", requirePermission("write"), (req, res) => {
  const { amount, client } = req.body;
  const newInvoice = {
    id: "inv_" + Date.now(),
    amount,
    client,
    status: "pending",
    createdBy: req.user.userId, // audit trail — who created it
    tenantId: req.user.tenantId, // always tag with tenant (if using shared table)
  };
  req.db.invoices.push(newInvoice);
  res.status(201).json(newInvoice);
});

// ── DELETE /api/invoices/:id ──────────────────────────────────────
// Requires "delete" — only admins
//
app.delete("/api/invoices/:id", requirePermission("delete"), (req, res) => {
  const idx = req.db.invoices.findIndex((inv) => inv.id === req.params.id);
  if (idx === -1)
    return res.status(404).json({ error: "Invoice not found in your tenant" });

  const [deleted] = req.db.invoices.splice(idx, 1);
  res.json({ deleted });
});

// ── GET /api/users ────────────────────────────────────────────────
// Requires "manage_users" — only admins
//
app.get("/api/users", requirePermission("manage_users"), (req, res) => {
  res.json({
    tenant: req.user.tenantId,
    users: req.db.users,
  });
});

// ── GET /api/me ───────────────────────────────────────────────────
// Any authenticated user can see their own claims
//
app.get("/api/me", (req, res) => {
  res.json({ user: req.user });
});

// ================================================================
//  START SERVER
// ================================================================
app.listen(3000, () => {
  console.log(`
  ┌─────────────────────────────────────────┐
  │  Multitenant ERP API running on :3000   │
  │                                         │
  │  Step 1 — Get a token:                  │
  │  POST /auth/login                       │
  │  { "userId": "usr_1",                   │
  │    "tenantId": "acme_corp" }            │
  │                                         │
  │  Step 2 — Use the token:                │
  │  GET /api/invoices                      │
  │  Authorization: Bearer <token>          │
  └─────────────────────────────────────────┘
  `);
});

/*
 ================================================================
  QUICK TEST (curl)
 ================================================================

  # 1. Login as Alice (admin of acme_corp)
  TOKEN=$(curl -s -X POST http://localhost:3000/auth/login \
    -H "Content-Type: application/json" \
    -d '{"userId":"usr_1","tenantId":"acme_corp"}' | jq -r .token)

  # 2. Read invoices (works — admin has "read")
  curl http://localhost:3000/api/invoices -H "Authorization: Bearer $TOKEN"

  # 3. Create invoice (works — admin has "write")
  curl -X POST http://localhost:3000/api/invoices \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"amount":9999,"client":"Umbrella Corp"}'

  # 4. Login as Carol (viewer of acme_corp)
  TOKEN_VIEWER=$(curl -s -X POST http://localhost:3000/auth/login \
    -H "Content-Type: application/json" \
    -d '{"userId":"usr_3","tenantId":"acme_corp"}' | jq -r .token)

  # 5. Try to create invoice as viewer (FAILS — no "write" permission)
  curl -X POST http://localhost:3000/api/invoices \
    -H "Authorization: Bearer $TOKEN_VIEWER" \
    -H "Content-Type: application/json" \
    -d '{"amount":500,"client":"Hacker"}'

  # 6. Login as Hank (admin of globex_inc) — sees DIFFERENT invoices
  TOKEN_HANK=$(curl -s -X POST http://localhost:3000/auth/login \
    -H "Content-Type: application/json" \
    -d '{"userId":"usr_10","tenantId":"globex_inc"}' | jq -r .token)

  curl http://localhost:3000/api/invoices -H "Authorization: Bearer $TOKEN_HANK"

 ================================================================
*/
