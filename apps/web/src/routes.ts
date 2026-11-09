export type Page = 'access' | 'history' | 'inbox' | 'system' | 'upstreams' | 'plugins';

export type AppRoute =
  | { page: Page; approvalId?: string }
  | { page: 'oauth'; oauthRequestId: string }
  | { page: 'setup'; setupRequestId: string };

export const pagePaths: Record<Page, string> = {
  inbox: '/approvals',
  history: '/history',
  access: '/access',
  upstreams: '/upstreams',
  system: '/system',
  plugins: '/plugins',
};

function normalizedPathname(pathname: string): string {
  if (pathname === '/') return pathname;
  return pathname.replace(/\/+$/, '');
}

function decodedApprovalId(value: string): string | undefined {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.length > 0 ? decoded : undefined;
  } catch {
    return undefined;
  }
}

export function routeFromLocation(
  location: Pick<Location, 'pathname' | 'search'>,
): AppRoute {
  const pathname = normalizedPathname(location.pathname);
  const oauthMatch = /^\/oauth\/consent\/([^/]+)$/.exec(pathname);
  if (oauthMatch?.[1] !== undefined) {
    const oauthRequestId = decodedApprovalId(oauthMatch[1]);
    if (oauthRequestId !== undefined) return { page: 'oauth', oauthRequestId };
  }
  const setupMatch = /^\/setup\/requests\/([^/]+)$/.exec(pathname);
  if (setupMatch?.[1] !== undefined) {
    const setupRequestId = decodedApprovalId(setupMatch[1]);
    if (setupRequestId !== undefined) return { page: 'setup', setupRequestId };
  }
  const approvalMatch = /^\/approvals\/([^/]+)$/.exec(pathname);
  const approvalId = approvalMatch?.[1] === undefined
    ? undefined
    : decodedApprovalId(approvalMatch[1]);
  if (approvalId !== undefined) return { page: 'inbox', approvalId };

  const page = (Object.entries(pagePaths) as [Page, string][])
    .find(([, path]) => path === pathname)?.[0];
  if (page !== undefined) {
    const legacyApprovalId = page === 'inbox'
      ? new URLSearchParams(location.search).get('approval') ?? undefined
      : undefined;
    return legacyApprovalId === undefined
      ? { page }
      : { page, approvalId: legacyApprovalId };
  }

  const legacyApprovalId = new URLSearchParams(location.search).get('approval');
  return legacyApprovalId === null
    ? { page: 'inbox' }
    : { page: 'inbox', approvalId: legacyApprovalId };
}

export function routePath(route: AppRoute): string {
  if (route.page === 'setup') return `/setup/requests/${encodeURIComponent(route.setupRequestId)}`;
  if (route.page === 'oauth') return `/oauth/consent/${encodeURIComponent(route.oauthRequestId)}`;
  if (route.page === 'inbox' && route.approvalId !== undefined) {
    return `${pagePaths.inbox}/${encodeURIComponent(route.approvalId)}`;
  }
  return pagePaths[route.page];
}
