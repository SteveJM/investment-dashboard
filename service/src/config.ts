import 'dotenv/config';

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// The set of accounts a watch-list item can be tagged against - deployment-
// specific (whose ISAs/pensions this dashboard actually tracks), so it's a
// plain comma-separated env var rather than a hard-coded list. Validated
// (non-empty) at startup since both the REST/MCP request schemas and the
// frontend's dropdowns are built from this list - see service/README.md.
const accounts = (process.env.ACCOUNTS ?? 'ISA,Taxable,Pension')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (accounts.length === 0) {
  throw new Error('ACCOUNTS must contain at least one comma-separated account name');
}

export const config = {
  databaseUrl: required('DATABASE_URL', 'postgres://investment_dashboard:devpassword@localhost:5432/investment_dashboard'),
  apiPort: Number(process.env.API_PORT ?? 4000),
  mcpPort: Number(process.env.MCP_PORT ?? 4001),
  apiKey: required('API_KEY', 'devkey'),
  priceProvider: process.env.PRICE_PROVIDER ?? 'yahoo',
  newsProvider: process.env.NEWS_PROVIDER ?? 'yahoo',
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5173').split(',').map((s) => s.trim()),
  accounts,
} as const;
