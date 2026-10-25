ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified boolean DEFAULT false NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS image text;

CREATE TABLE IF NOT EXISTS session (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token text NOT NULL,
    expires_at timestamp(3) without time zone NOT NULL,
    ip_address text,
    user_agent text,
    created_at timestamp(3) without time zone DEFAULT timezone('UTC', now()) NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT timezone('UTC', now()) NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS session_token_index ON session (token);
CREATE INDEX IF NOT EXISTS session_user_id_index ON session (user_id);

CREATE TABLE IF NOT EXISTS account (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id text NOT NULL,
    provider_id text NOT NULL,
    access_token text,
    refresh_token text,
    id_token text,
    access_token_expires_at timestamp(3) without time zone,
    refresh_token_expires_at timestamp(3) without time zone,
    scope text,
    password text,
    created_at timestamp(3) without time zone DEFAULT timezone('UTC', now()) NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT timezone('UTC', now()) NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS account_provider_account_index ON account (provider_id, account_id);
CREATE INDEX IF NOT EXISTS account_user_id_index ON account (user_id);

CREATE TABLE IF NOT EXISTS verification (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    identifier text NOT NULL,
    value text NOT NULL,
    expires_at timestamp(3) without time zone NOT NULL,
    created_at timestamp(3) without time zone DEFAULT timezone('UTC', now()) NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT timezone('UTC', now()) NOT NULL
);
CREATE INDEX IF NOT EXISTS verification_identifier_index ON verification (identifier);

INSERT INTO account (user_id, account_id, provider_id, access_token, refresh_token, access_token_expires_at, scope, created_at, updated_at)
SELECT
    gi.user_id,
    gi.google_sub,
    'google',
    gi.access_token,
    gi.refresh_token,
    CASE WHEN gi.token_expires_at IS NULL THEN NULL ELSE timezone('UTC', to_timestamp(gi.token_expires_at)) END,
    'openid,email,profile,https://www.googleapis.com/auth/calendar.events',
    gi.inserted_at,
    gi.updated_at
FROM google_identities gi
ON CONFLICT (provider_id, account_id) DO NOTHING;

UPDATE users SET email_verified = true WHERE id IN (SELECT user_id FROM google_identities);
