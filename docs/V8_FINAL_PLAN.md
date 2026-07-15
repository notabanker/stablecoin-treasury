# V8 Finalplan — Settlement + Treasury (SMB → Corporate)

**Stand:** 2026-07-12 · **Status:** Freigegeben zur Umsetzung  
**Technische Details:** `docs/V8_IMPLEMENTATION_PLAN.md` · **Tasks:** `docs/V8_TASK_LIST.md`

---

## 1. Zielbild

**Von:** MiCA-orientierte Governance-/Control-Plane auf simulierten Stablecoin-Rails.  
**Nach:** **Settlement- + Treasury-Service** — halten, bewegen, abrechnen, liquiditätssteuern, reconcilen, reporten (Stablecoin + später Fiat), mit kontrollen, die von SMB bis Corporate skalieren.

**Value Proposition:**  
*Stablecoin- und Fiat-Treasury mit durchgängiger Policy, Vier-Augen, automatischer Doppelbuchung und Audit-Kette — schneller und günstiger als klassisches Banking, mit Kontrollen, die TMS-Light-Tools nicht bieten.*

**Posture (ehrlich):**  
Demo GO · Diligence GO mit Vorbehalten · **Production Money Movement NO-GO** bis Phase 0–2 + Partner + Infra belegt sind.

---

## 2. Festgelegte Entscheidungen

| ID | Entscheidung | Festlegung |
|---|---|---|
| **Strategie** | Produktpivot V8 | ✅ Settlement + Treasury, SMB + Corporate |
| **Phase 0** | Money-path safety starten | ✅ Autorisiert |
| **G1** | `provider_submissions`, crash-safe Settlement | ✅ Freigegeben |
| **Accounting P1** | Erster SMB-Connector (DE/München) | ✅ **sevdesk** |
| **E2** | Secrets Manager | ✅ **Doppler** (Dev/Pilot); Prod: AWS SM oder Doppler |
| **E1** | Custody-Sandbox | ✅ **Circle** (primär, EURC/USDC); **Fireblocks** als Enterprise-Alternative |
| **Lizenzmodell** | Geldfluss | ✅ Software-Agent des Partners; kein eigenes CASP/EMI in V8 |
| **G4** | Integrations-Schema für sevdesk | ✅ Freigegeben (Umsetzung mit Epic 1.5) |
| **G2** | SMB-Tier + Feature-Flags | ✅ Freigegeben (Umsetzung mit Epic 1.2) |
| **G5** | SMB-Onboarding + leichtes KYC | ✅ Freigegeben (Umsetzung mit Epic 1.3) |

### Noch offen (vor Phase 2+)

| ID | Thema | Bis wann |
|---|---|---|
| **E3** | SEPA-EMI für Fiat On/Off-Ramp | Phase 2 |
| **G3, G7** | Fiat-Ledger + Rail-Adapter | Phase 2 (Flo-Gate bei Schema) |
| **G6** | API-Keys Maschinenzugriff | Phase 1 Ende / Phase 2 |
| **Corporate ERP** | DATEV (direkt/Chift) vs. SAP-Export only | Phase 2 |
| **G8–G10** | Yield, Multi-Jurisdiction, White-Label | Phase 3 |
| **Infra** | Managed Postgres, WAF, mTLS, On-Call | Phase 2–3 (human-executed) |

---

## 3. Phasenüberblick

```text
Phase 0 (Wochen 1–6)     Sicherheit Geldpfad — BLOCKIERT ALLES
        ↓
Phase 1 (Monate 2–4)     Sandbox-Settlement + SMB + sevdesk
        ↓
Phase 2 (Monate 4–8)     Fiat SEPA + DATEV/SAP + Forecasting + Infra Welle 1
        ↓
Phase 3 (Monate 8+)      Multi-Jurisdiction, Liquidity, Embedded, Production GO
```

**Goldene Regel:** Kein Marketing „live settlement“, kein SMB-Volumen, keine Partner-Credentials ohne **Phase 0 grün + Doppler + Circle-Sandbox belegt**.

---

## 4. Phase 0 — Money-path safety (JETZT)

**Ziel:** CRITICAL/HIGH Audit-Findings schließen, bevor Settlement und sevdesk darauf aufbauen.

### Epics & Reihenfolge

| Epic | Inhalt | Tasks |
|---|---|---|
| **0.1** | Demo-Reset sicher (H1+H2) | `ALLOW_DEMO_RESET`, tenant-scoped reset, adversarial tests |
| **0.2** | Outbox zuverlässig (H3) | DLQ, backoff, starvation-fix, poison-test |
| **0.3** | Provider crash-safe (G1, Finding 1) | `provider_submissions`, Idempotenz, retry ohne Doppel-Submit |
| **0.4** | Härtung | M5 prod password, creator≠approver DB, breaker-tests, HMAC freshness |
| **0.5** | Docs | `PRODUCTION_READINESS.md` konsistent |

### Exit-Kriterien Phase 0

- [ ] H1, H2, H3, Finding 1, M5, B-2 behoben + Tests
- [ ] `npm run check` + `npm run test:all` + prod-config gate + smoke + 5 Invarianten + audit-verifier
- [ ] Readiness-Doc: expliziter **Money-Movement NO-GO** bis 5.3 + Infra

**Keine weiteren Freigaben nötig** — Umsetzung kann sofort starten.

---

## 5. Phase 1 — Settlement MVP + SMB + sevdesk

**Ziel:** Ein **echter Sandbox-Settlement** End-to-End; SMB-Oberfläche; **sevdesk**-Journal-Sync.

**Voraussetzungen:** Phase 0 exit · Doppler live · Circle-Sandbox-Vertrag/Keys

### 5.1 Infrastruktur-Voraussetzungen (E2 + E1)

| Schritt | Aktion |
|---|---|
| Doppler | Projekt anlegen; Secrets: `CIRCLE_API_KEY`, `CIRCLE_WEBHOOK_SECRET`, `SEVDESK_CLIENT_ID/SECRET` |
| `packages/shared/secrets.mjs` | Boot-time load; nie loggen |
| Circle | Sandbox-Account, EURC/USDC Wallets, Webhook-URL auf Gateway |
| ADR-012 | Custody-Adapter-Mapping dokumentieren |

### 5.2 Epic 1.1 — Echter Stablecoin-Rail (Task 5.3)

1. `CircleCustodyAdapter` implementieren (`custody.mjs` registry)
2. `operations.providers`: `adapter=circle`, `environment=sandbox`
3. Webhook `process-settlement-webhook` → Saga-Bestätigung (schließt L6)
4. E2E: Create → Approve → Execute → Webhook → Settled → Journal → Recon
5. Runbook: Credential-Rotation, Fehlermodi

### 5.3 Epic 1.2 — SMB-Tier (G2)

- `identity.tenants.tier`: `smb` | `corporate`
- `feature_flags`: vier_augen, advanced_recon, repair_desk, …
- SMB-Shell: Home, Zahlen, Aktivität, Einstellungen — **ohne** Repair/Recon-Desk
- Corporate: bestehendes Treasury-Desk unverändert
- Demo-Tenant SMB (tenant-3)

### 5.4 Epic 1.3 — SMB-Onboarding (G5)

- Status: `draft` → `kyc_pending` → `active`
- Self-Serve Signup + leichtes KYC (Partner oder Review-Queue)
- `execute` blockiert bis `active`
- In-App-Erklärungen (Stablecoin, Fees, Timing)

### 5.5 Epic 1.5 — sevdesk (G4)

| Schritt | Detail |
|---|---|
| Schema | `integrations.connections`, `oauth_tokens`, `sync_log`, `gl_mappings` |
| OAuth | Connect/Disconnect in Einstellungen |
| Mapper | `accounting.journal_entries` → sevdesk Buchung/Beleg |
| Trigger | Job bei `payment.settled` (idempotent über `sync_log`) |
| Tests | Fixture-basiert, kein Live-OAuth in CI |

### 5.6 Epic 1.6–1.7 (P1, wo Kapazität)

- Settlement-Timeline in Payment-Detail
- Statements in UI (L3)
- Outbound Webhooks für Integratoren
- API-Keys (G6) — kann Phase 1 Ende

### Exit-Kriterien Phase 1

- [ ] Circle-Sandbox-Settlement E2E mit crash-safe `provider_submissions`
- [ ] SMB-Nutzer: erste Zahlung ohne Advanced-Desk
- [ ] sevdesk-Sandbox: Journal nach Settlement sichtbar
- [ ] Phase-0-Regression weiter grün
- [ ] Readiness: „Pilot Sandbox Settlement“ — **nicht** Production GO

---

## 6. Phase 2 — Fiat + Corporate-Tiefe

**Ziel:** Erster **SEPA**-Rail via EMI-Partner; unified Balance; DATEV/SAP; Forecasting; Infra Welle 1.

| Epic | Inhalt | Gate |
|---|---|---|
| **2.1** | `fiat-rail.mjs`, SEPA-Partner-Adapter | G7, E3 |
| **2.2** | `wallet.fiat_accounts`, On/Off-Ramp, unified Balance API | G3 |
| **2.3** | MT940/camt.053, virtuelle Unterkonten, DATEV oder 2. ERP | G4 |
| **2.4** | Cash-Forecast 30/60/90 (regelbasiert) | — |
| **2.5** | Entity-Hierarchie, konsolidierte Sicht | — |
| **2.6** | Staging IaC, Observability, SBOM/SCA | A6 ext |

**Exit:** Fiat-Sandbox-Transfer + MT940-Match + Staging deploybar.

---

## 7. Phase 3 — Skalierung + Embedded + Production GO

| Bereich | Inhalt |
|---|---|
| **Compliance** | Multi-Jurisdiction (G9), EDD Corporate, Echtzeit-Sanktionen |
| **Liquidity** | Sweeps, Auto-Conversion (G8, legal) |
| **Embedded** | White-Label API (G10) |
| **Production GO** | Pen-Test, DORA/MiCA-Runbooks, Flo + Legal Sign-off |

Production GO **nur** wenn: Phase 0–2 grün · lizenzierter Partner · Secrets · Postgres PITR · WAF · Pen-Test.

---

## 8. Architektur (kurz)

**Services:** Unverändert (Gateway, wallet, policy, compliance, payment, accounting, recon, operations, job-worker, relay-worker).

**Neu als Module (kein Monolith):**

```text
packages/shared/adapters/
  custody.mjs      ← Circle (+ simulated für Tests)
  fiat-rail.mjs    ← Phase 2 SEPA
packages/shared/secrets.mjs   ← Doppler
integrations/      ← sevdesk OAuth + Mapper (Phase 1)
```

**Saga (Ziel):** Policy → Compliance → **provider_submissions** → Circle submit → Webhook/Poll → Debit → Journal → Recon → sevdesk sync → Audit.

**Kein `settlement-service`** bis Phase 3 und nur bei Rail-Volumen-Bedarf.

---

## 9. Wettbewerb & Positionierung

| vs. | Vorteil |
|---|---|
| Merge (Orchestrierung) | Policy, Vier-Augen, Journals, Hash-Audit |
| Trovata/Kyriba (TMS) | SMB-Zugang + Stablecoin-native |
| Fireblocks/Circle (Custody) | Treasury-Workflow + Buchhaltung + Recon |
| DE-Markt | MiCA-Control-Plane + **sevdesk** + später DATEV |

---

## 10. Verifikation (jede Phase)

```bash
npm run check
npm run test:all
# prod-config gate (PRODUCTION_MODE dummy env)
npm run migrate && npm run dev && npm run smoke
# 5-row invariant SQL (docs/RUNBOOKS.md)
node scripts/verify-audit-chain.mjs
# UI ohne Console-Errors
```

**Task erledigt** nur wenn Loop grün + Docs behaupten genau das, was Tests belegen.

---

## 11. Zeitplan (Richtwerte)

| Phase | Dauer | Meilenstein |
|---|---|---|
| **0** | 4–6 Wochen | Audit HIGH/CRITICAL zu |
| **1** | 8–12 Wochen | Circle Sandbox + SMB + sevdesk |
| **2** | 12–16 Wochen | SEPA Sandbox + MT940 + Staging |
| **3** | 6+ Monate | Production GO Gate |

Parallel (Business/Legal): EU-CASP für Produktionsstory, E3 EMI-Vertrag, Pricing, GTM München/EEA.

---

## 12. Nächste konkrete Schritte

### Engineering (sofort)

1. Epic **0.1.1** — `ALLOW_DEMO_RESET` Gate  
2. Epic **0.1.2–0.1.4** — Tenant-scoped reset  
3. Epic **0.2** — Outbox DLQ  
4. Epic **0.3** — `provider_submissions` (G1)

### Business/Infra (parallel)

1. Doppler-Projekt + Team-Zugang  
2. Circle Sandbox-Account beantragen  
3. sevdesk Developer-App / API-Zugang  
4. Kurz-ADR-012 unterschreiben/archivieren

### Nach Phase-0-Exit

1. `CircleCustodyAdapter` + Webhook-Pfad  
2. SMB-Shell (G2)  
3. sevdesk OAuth + Mapper (G4)

---

## 13. Referenzen

| Dokument | Zweck |
|---|---|
| `docs/V8_IMPLEMENTATION_PLAN.md` | Vollständige Epic-/Task-Spezifikation |
| `docs/V8_TASK_LIST.md` | Checkbox-Tracking |
| `docs/V6_AUDIT_REPORT.md` | Phase-0-Finding-Quelle |
| `PROJECT_STATE.md` | Live-Agent-Status + Gate-Tabelle |
| `docs/PRODUCTION_READINESS.md` | Delivered vs. Required |

---

*Dieser Finalplan ist die verbindliche Zusammenfassung. Technische Task-IDs und Acceptance Criteria bleiben in `V8_IMPLEMENTATION_PLAN.md` / `V8_TASK_LIST.md` maßgeblich.*