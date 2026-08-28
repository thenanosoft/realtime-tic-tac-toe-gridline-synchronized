import type { NextConfig } from 'next';

const [repositoryOwner, repositoryName] = (process.env.GITHUB_REPOSITORY ?? '/').split('/');
const isUserSite = repositoryName === `${repositoryOwner}.github.io`;
const inferredPagesBase = process.env.GITHUB_ACTIONS === 'true' && repositoryName && !isUserSite
  ? `/${repositoryName}`
  : '';
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? inferredPagesBase;

const nextConfig: NextConfig = {
  output: 'export',
  trailingSlash: true,
  basePath,
  assetPrefix: basePath || undefined,
  images: { unoptimized: true },
  env: { NEXT_PUBLIC_BASE_PATH: basePath },
};

export default nextConfig;
