-- Seven tables. Every customer-owned row carries tenant_id.
-- Money columns are bigint: micros overflow a 32-bit integer at about $2,147.

CREATE TABLE plans (
  code             text PRIMARY KEY,
  name             text NOT NULL,
  api_call_limit   integer NOT NULL CHECK (api_call_limit >= 0),
  token_limit      integer NOT NULL CHECK (token_limit >= 0),
  spend_cap_micros bigint  NOT NULL CHECK (spend_cap_micros >= 0),
  stripe_price_id  text
);

CREATE TABLE tenants (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL,
  plan_code           text NOT NULL REFERENCES plans(code),
  subscription_status text NOT NULL DEFAULT 'active'
                        CHECK (subscription_status IN ('active', 'past_due', 'canceled')),
  stripe_customer_id  text UNIQUE,
  -- Only the SHA-256 of the key is stored. The plaintext exists once, at seed time.
  api_key_hash        text NOT NULL UNIQUE,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE subscriptions (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  stripe_subscription_id text NOT NULL UNIQUE,
  status                 text NOT NULL,
  current_period_start   timestamptz,
  current_period_end     timestamptz,
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX subscriptions_tenant_idx ON subscriptions (tenant_id);

-- The UNIQUE constraint below is not an optimisation. It IS the duplicate
-- prevention: the application inserts first and lets the database reject the
-- second concurrent retry. A read-then-check loses that race.
CREATE TABLE idempotency_keys (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  endpoint            text NOT NULL,
  key                 text NOT NULL,
  request_fingerprint text NOT NULL,
  state               text NOT NULL CHECK (state IN ('in_progress', 'completed')),
  response_status     integer,
  response_body       jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT idempotency_keys_tenant_endpoint_key_unique
    UNIQUE (tenant_id, endpoint, key)
);

-- One reservation per request, holding all three estimates together, so the
-- release path is a single row transition rather than one per usage type.
CREATE TABLE reservations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  idempotency_key_id    uuid REFERENCES idempotency_keys(id) ON DELETE SET NULL,
  estimated_calls       integer NOT NULL CHECK (estimated_calls >= 0),
  estimated_tokens      integer NOT NULL CHECK (estimated_tokens >= 0),
  estimated_cost_micros bigint  NOT NULL CHECK (estimated_cost_micros >= 0),
  state                 text NOT NULL
                          CHECK (state IN ('held', 'committed', 'released', 'expired')),
  billing_period        date NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  expires_at            timestamptz NOT NULL
);

-- Read on every single request, to total what is currently held.
CREATE INDEX reservations_held_idx ON reservations (tenant_id, billing_period, state);

CREATE TABLE usage_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  usage_type         text NOT NULL CHECK (usage_type IN ('api_call', 'tokens')),
  quantity           integer NOT NULL CHECK (quantity >= 0),
  cost_micros        bigint  NOT NULL CHECK (cost_micros >= 0),
  -- Per-category token counts and costs, kept so a charge can be explained later.
  breakdown          jsonb,
  reservation_id     uuid REFERENCES reservations(id) ON DELETE SET NULL,
  idempotency_key_id uuid REFERENCES idempotency_keys(id) ON DELETE SET NULL,
  -- Stored, not derived: makes the monthly rollup an index lookup, and stops an
  -- event's period drifting if the clock logic changes later.
  billing_period     date NOT NULL,
  occurred_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX usage_events_rollup_idx ON usage_events (tenant_id, billing_period);

-- Webhook replays are rejected by the primary key, the same trick as above.
CREATE TABLE processed_webhook_events (
  stripe_event_id text PRIMARY KEY,
  event_type      text NOT NULL,
  processed_at    timestamptz NOT NULL DEFAULT now()
);
