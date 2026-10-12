import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: ['node:sqlite'],
  outputFileTracingIncludes: {
    '/*': ['./drizzle/*.sql'],
    '/api/connections/variational-test': ['./scripts/variational-diagnostic.py'],
    '/api/connections': ['./scripts/variational-diagnostic.py'],
    '/api/sync': ['./scripts/variational-diagnostic.py'],
  },
  outputFileTracingExcludes: { '/*': ['./.data/**/*', './.sites-runtime/**/*', './.wrangler/**/*', './lib/imported-ledger.json', './tests/**/*'] },
};

export default nextConfig;
