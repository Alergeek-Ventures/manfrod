CREATE TABLE IF NOT EXISTS github_installations (
    id bigint PRIMARY KEY,
    account_id bigint NOT NULL,
    account_login text NOT NULL,
    account_type text NOT NULL,
    repository_selection text NOT NULL,
    suspended_at timestamp(0) without time zone,
    installed_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    synced_at timestamp(0) without time zone,
    inserted_at timestamp(0) without time zone DEFAULT timezone('UTC', now()) NOT NULL,
    updated_at timestamp(0) without time zone DEFAULT timezone('UTC', now()) NOT NULL
);

CREATE TABLE IF NOT EXISTS github_repositories (
    id bigint PRIMARY KEY,
    installation_id bigint NOT NULL REFERENCES github_installations(id) ON DELETE CASCADE,
    full_name text NOT NULL,
    private boolean NOT NULL,
    default_branch text NOT NULL,
    archived boolean DEFAULT false NOT NULL,
    backfilled_at timestamp(0) without time zone,
    inserted_at timestamp(0) without time zone DEFAULT timezone('UTC', now()) NOT NULL,
    updated_at timestamp(0) without time zone DEFAULT timezone('UTC', now()) NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS github_repositories_full_name_index ON github_repositories (lower(full_name));
CREATE INDEX IF NOT EXISTS github_repositories_installation_id_index ON github_repositories (installation_id);

CREATE TABLE IF NOT EXISTS github_accounts (
    user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    github_user_id bigint NOT NULL,
    login text NOT NULL,
    emails text[] DEFAULT ARRAY[]::text[] NOT NULL,
    access_token bytea NOT NULL,
    refresh_token bytea,
    expires_at timestamp(0) without time zone,
    refresh_expires_at timestamp(0) without time zone,
    status text DEFAULT 'connected' NOT NULL,
    inserted_at timestamp(0) without time zone DEFAULT timezone('UTC', now()) NOT NULL,
    updated_at timestamp(0) without time zone DEFAULT timezone('UTC', now()) NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS github_accounts_github_user_id_index ON github_accounts (github_user_id);

CREATE TABLE IF NOT EXISTS github_commits (
    repository_id bigint NOT NULL REFERENCES github_repositories(id) ON DELETE CASCADE,
    sha text NOT NULL,
    branches text[] DEFAULT ARRAY[]::text[] NOT NULL,
    author_login text,
    author_email text,
    author_name text,
    authored_at timestamp(0) without time zone NOT NULL,
    message text NOT NULL,
    url text NOT NULL,
    inserted_at timestamp(0) without time zone DEFAULT timezone('UTC', now()) NOT NULL,
    PRIMARY KEY (repository_id, sha)
);

CREATE INDEX IF NOT EXISTS github_commits_author_login_index ON github_commits (lower(author_login), authored_at);
CREATE INDEX IF NOT EXISTS github_commits_author_email_index ON github_commits (lower(author_email), authored_at);
CREATE INDEX IF NOT EXISTS github_commits_authored_at_index ON github_commits (authored_at);

CREATE TABLE IF NOT EXISTS project_github_repositories (
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    repository_id bigint NOT NULL REFERENCES github_repositories(id) ON DELETE CASCADE,
    linked_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    inserted_at timestamp(0) without time zone DEFAULT timezone('UTC', now()) NOT NULL,
    PRIMARY KEY (project_id, repository_id)
);

CREATE TABLE IF NOT EXISTS project_github_boards (
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    board_node_id text NOT NULL,
    owner_login text NOT NULL,
    number integer NOT NULL,
    title text NOT NULL,
    linked_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    inserted_at timestamp(0) without time zone DEFAULT timezone('UTC', now()) NOT NULL,
    PRIMARY KEY (project_id, board_node_id)
);
