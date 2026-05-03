create extension if not exists "uuid-ossp";

create table if not exists plaid_items (
  id               uuid primary key default uuid_generate_v4(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  item_id          text not null unique,
  access_token     text not null,
  institution_name text,
  created_at       timestamptz default now()
);
alter table plaid_items enable row level security;
create policy "Users see own items" on plaid_items
  for all using (auth.uid() = user_id);

create table if not exists accounts (
  id                 uuid primary key default uuid_generate_v4(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  plaid_account_id   text not null unique,
  name               text,
  official_name      text,
  type               text,
  subtype            text,
  current_balance    numeric(14,2),
  available_balance  numeric(14,2),
  iso_currency_code  text default 'USD',
  last_updated       timestamptz default now()
);
alter table accounts enable row level security;
create policy "Users see own accounts" on accounts
  for all using (auth.uid() = user_id);

create table if not exists transactions (
  id                   uuid primary key default uuid_generate_v4(),
  user_id              uuid not null references auth.users(id) on delete cascade,
  plaid_transaction_id text not null unique,
  account_id           text,
  name                 text,
  amount               numeric(14,2),
  date                 date,
  category             text,
  category_detail      text,
  pending              boolean default false,
  logo_url             text,
  created_at           timestamptz default now()
);
create index if not exists transactions_user_date on transactions(user_id, date desc);
create index if not exists transactions_user_category on transactions(user_id, category);
alter table transactions enable row level security;
create policy "Users see own transactions" on transactions
  for all using (auth.uid() = user_id);

create table if not exists net_worth_snapshots (
  id                uuid primary key default uuid_generate_v4(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  snapshot_date     date not null,
  total_assets      numeric(14,2) default 0,
  total_liabilities numeric(14,2) default 0,
  total_value       numeric(14,2) default 0,
  created_at        timestamptz default now(),
  unique(user_id, snapshot_date)
);
create index if not exists nw_snapshots_user_date on net_worth_snapshots(user_id, snapshot_date desc);
alter table net_worth_snapshots enable row level security;
create policy "Users see own snapshots" on net_worth_snapshots
  for all using (auth.uid() = user_id);

grant all on plaid_items, accounts, transactions, net_worth_snapshots to service_role;
