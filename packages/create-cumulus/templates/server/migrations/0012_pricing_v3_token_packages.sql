-- Pricing v3: 6-tier token package ladder.
--
-- Replaces the original 3 flat packages (starter/growth/scale) with a
-- 6-tier ladder where each step up gives a larger per-token discount,
-- framed cosmetically as a bonus-tokens percentage. The escalating
-- discount curve anchors the top tier (Premium) as obviously the best
-- per-token rate.
--
-- The server (src/server/routes/billing.ts:loadTopupPackage) only reads
-- {id, cents, tokens, label} — every other field is purely cosmetic and
-- consumed by the React layer (app/(user)/me/billing). The `tokens`
-- field is the FINAL credited amount; the Stripe webhook
-- (handleTopupSession) credits exactly that to token_balances.balance.
-- So bonus framing is built into the JSON shape, not the server logic.
--
-- Per-token rate curve (USD):
--   starter $0.00500 → plus $0.00400 → pro $0.00357 → growth $0.00313 →
--   scale $0.00250 → premium $0.00200  (60 % cheaper at Premium)
--
-- Migration is idempotent (UPDATE … WHERE id='default') — safe to re-run.

UPDATE "pricing_config"
   SET "topup_packages" = '[
     {"id":"starter","cents":500,"label":"Starter","base_tokens":1000,"bonus_tokens":0,"tokens":1000,"bonus_pct":0,"badge":null,"tagline":"Kick the tires"},
     {"id":"plus","cents":2000,"label":"Plus","base_tokens":4000,"bonus_tokens":1000,"tokens":5000,"bonus_pct":25,"badge":null,"tagline":"+25% bonus tokens"},
     {"id":"pro","cents":5000,"label":"Pro","base_tokens":10000,"bonus_tokens":4000,"tokens":14000,"bonus_pct":40,"badge":null,"tagline":"+40% bonus tokens"},
     {"id":"growth","cents":10000,"label":"Growth","base_tokens":20000,"bonus_tokens":12000,"tokens":32000,"bonus_pct":60,"badge":"popular","tagline":"+60% bonus · most picked"},
     {"id":"scale","cents":25000,"label":"Scale","base_tokens":50000,"bonus_tokens":50000,"tokens":100000,"bonus_pct":100,"badge":null,"tagline":"+100% bonus tokens"},
     {"id":"premium","cents":50000,"label":"Premium","base_tokens":100000,"bonus_tokens":150000,"tokens":250000,"bonus_pct":150,"badge":"best_value","tagline":"+150% bonus · best per-token rate"}
   ]'::jsonb,
   "updated_at" = now()
 WHERE "id" = 'default';
