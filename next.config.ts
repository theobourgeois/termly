import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Pages are built in one worker so each university's catalog is read from Supabase once, not once
    // per worker; several at a time overload the database and it cancels reads.
    cpus: 1,
  },
  // Social images read the font and the university's logo from disk.
  outputFileTracingIncludes: {
    "/**/opengraph-image": ["./src/app/fonts/og/**", "./public/universities/**"],
    // Catalogs are read from disk; see src/scripts/node/download-catalogs.js.
    "/**": ["./catalogs/**"],
  },
  async redirects() {
    return [{ source: "/api/sitemap", destination: "/sitemap.xml", permanent: true }];
  },
};

export default nextConfig;
