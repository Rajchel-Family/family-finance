/**
 * netlify/functions/plaid.js
 *
 * Environment variables (set in Netlify dashboard):
 *   PLAID_CLIENT_ID
 *   PLAID_SECRET
 *   PLAID_ENV              (sandbox | development | production)
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
 */

const { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } = require('plaid');
const { createClient } = require('@supabase/supabase-js');

const plaid = new PlaidApi(new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV || 'sandbox'],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET':    process.env.PLAID_SECRET,
    },
  },
}));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HEADERS, body: '' };
  if (event.httpMethod !== 'POST')   return { statusCode: 405, headers: HEADERS, body: 'Method Not Allowed' };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  try {
    switch (body.action) {
      case 'create_link_token': return await createLinkToken(body);
      case 'exchange_token':    return await exchangeToken(body);
      case 'sync':              return await syncData(body);
      case 'net_worth':         return await snapshotNetWorth(body);
      default: return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: 'Unknown action' }) };
    }
  } catch (err) {
    console.error(err?.response?.data || err.message);
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ error: err?.response?.data?.error_message || err.message }) };
  }
};

async function createLinkToken({ user_id }) {
  const resp = await plaid.linkTokenCreate({
    user: { client_user_id: user_id },
    client_name:   'Family Finance Dashboard',
    products:      [Products.Transactions],
    country_codes: [CountryCode.Us],
    language:      'en',
  });
  return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ link_token: resp.data.link_token }) };
}

async function exchangeToken({ public_token, user_id }) {
  const resp = await plaid.itemPublicTokenExchange({ public_token });
  const { access_token, item_id } = resp.data;
  await supabase.from('plaid_items').upsert(
    { user_id, access_token, item_id, created_at: new Date().toISOString() },
    { onConflict: 'item_id' }
  );
  return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ access_token, item_id }) };
}

async function syncData({ access_token, user_id }) {
  const start = new Date(); start.setDate(start.getDate() - 90);
  const fmt   = d => d.toISOString().split('T')[0];

  const txResp = await plaid.transactionsGet({
    access_token,
    start_date: fmt(start),
    end_date:   fmt(new Date()),
    options: { count: 500, offset: 0 },
  });

  const transactions = txResp.data.transactions.map(t => ({
    user_id,
    plaid_transaction_id: t.transaction_id,
    account_id:    t.account_id,
    name:          t.name,
    amount:        t.amount,
    date:          t.date,
    category:      t.category?.[0] || 'Other',
    category_detail: t.category?.join(' > ') || null,
    pending:       t.pending,
    logo_url:      t.logo_url || null,
  }));

  if (transactions.length) {
    const { error } = await supabase.from('transactions').upsert(transactions, { onConflict: 'plaid_transaction_id' });
    if (error) throw error;
  }

  const balResp = await plaid.accountsBalanceGet({ access_token });
  const accounts = balResp.data.accounts.map(a => ({
    user_id,
    plaid_account_id:  a.account_id,
    name:              a.name,
    official_name:     a.official_name,
    type:              a.type,
    subtype:           a.subtype,
    current_balance:   a.balances.current,
    available_balance: a.balances.available,
    iso_currency_code: a.balances.iso_currency_code,
    last_updated:      new Date().toISOString(),
  }));

  if (accounts.length) {
    const { error } = await supabase.from('accounts').upsert(accounts, { onConflict: 'plaid_account_id' });
    if (error) throw error;
  }

  // Snapshot net worth
  let assets = 0, liabilities = 0;
  balResp.data.accounts.forEach(a => {
    const bal = a.balances.current || 0;
    if (['credit','loan','mortgage'].includes(a.type)) liabilities += bal;
    else assets += bal;
  });
  await supabase.from('net_worth_snapshots').upsert({
    user_id, snapshot_date: fmt(new Date()),
    total_assets: assets, total_liabilities: liabilities, total_value: assets - liabilities,
  }, { onConflict: 'user_id,snapshot_date' });

  return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ synced_transactions: transactions.length, synced_accounts: accounts.length }) };
}

async function snapshotNetWorth({ user_id }) {
  const { data: items } = await supabase.from('plaid_items').select('access_token').eq('user_id', user_id);
  let assets = 0, liabilities = 0;
  for (const item of items || []) {
    try {
      const resp = await plaid.accountsBalanceGet({ access_token: item.access_token });
      resp.data.accounts.forEach(a => {
        const bal = a.balances.current || 0;
        if (['credit','loan','mortgage'].includes(a.type)) liabilities += bal;
        else assets += bal;
      });
    } catch(e) { console.warn('Balance fetch failed:', e.message); }
  }
  const fmt = d => d.toISOString().split('T')[0];
  await supabase.from('net_worth_snapshots').insert({
    user_id, snapshot_date: fmt(new Date()),
    total_assets: assets, total_liabilities: liabilities, total_value: assets - liabilities,
  });
  return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ total_assets: assets, total_liabilities: liabilities, total_value: assets - liabilities }) };
}
