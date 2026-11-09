import { useCallback, useEffect, useState } from 'react';

import {
  AUTHENTICATION_LOST_EVENT,
  clearClientAuthentication,
  validateSession,
} from './api/client.js';
import { AppShell } from './components/app-shell.js';
import { useI18n } from './i18n/i18n.js';
import { Inbox } from './pages/inbox.js';
import { Login } from './pages/login.js';
import { OAuthConsent } from './pages/oauth-consent.js';
import { SetupApproval } from './pages/setup-approval.js';
import { Upstreams } from './pages/upstreams.js';
import { Access } from './pages/access.js';
import { System } from './pages/system.js';
import { Plugins } from './pages/plugins.js';
import { History } from './pages/history.js';
import {
  routeFromLocation,
  routePath,
  type AppRoute,
  type Page,
} from './routes.js';

export function approvalIdFromServiceWorkerMessage(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const message = value as { type?: unknown; approvalId?: unknown };
  return message.type === 'approval-mcp:open-approval' &&
    typeof message.approvalId === 'string' &&
    message.approvalId.length > 0
    ? message.approvalId
    : undefined;
}

function csrfTokenFromCookie(): string | undefined {
  for (const part of globalThis.document?.cookie.split(';') ?? []) {
    const [key, ...value] = part.trim().split('=');
    if (key === 'amcp_csrf') return value.join('=');
  }
  return undefined;
}

type AuthenticationState =
  | { status: 'anonymous' }
  | { status: 'checking'; csrfToken: string }
  | { status: 'authenticated'; csrfToken: string };

function initialAuthenticationState(): AuthenticationState {
  const csrfToken = csrfTokenFromCookie();
  return csrfToken === undefined
    ? { status: 'anonymous' }
    : { status: 'checking', csrfToken };
}

export function App() {
  const { t } = useI18n();
  const [authentication, setAuthentication] = useState<AuthenticationState>(
    initialAuthenticationState,
  );
  const [route, setRoute] = useState<AppRoute>(() =>
    routeFromLocation(globalThis.location),
  );
  const navigate = useCallback((nextRoute: AppRoute, replace = false) => {
    const path = routePath(nextRoute);
    if (`${globalThis.location.pathname}${globalThis.location.search}` !== path) {
      globalThis.history[replace ? 'replaceState' : 'pushState'](null, '', path);
    }
    setRoute(nextRoute);
  }, []);

  useEffect(() => {
    navigate(routeFromLocation(globalThis.location), true);
    const restoreRoute = () => setRoute(routeFromLocation(globalThis.location));
    globalThis.addEventListener('popstate', restoreRoute);
    return () => globalThis.removeEventListener('popstate', restoreRoute);
  }, [navigate]);

  useEffect(() => {
    if (authentication.status !== 'checking') return;
    let active = true;
    void validateSession().then((status) => {
      if (!active) return;
      setAuthentication(
        status === 'authenticated'
          ? {
              status: 'authenticated',
              csrfToken: authentication.csrfToken,
            }
          : { status: 'anonymous' },
      );
    });
    return () => {
      active = false;
    };
  }, [authentication]);

  useEffect(() => {
    const authenticationLost = () => {
      clearClientAuthentication();
      setAuthentication({ status: 'anonymous' });
    };
    globalThis.addEventListener?.(
      AUTHENTICATION_LOST_EVENT,
      authenticationLost,
    );
    return () =>
      globalThis.removeEventListener?.(
        AUTHENTICATION_LOST_EVENT,
        authenticationLost,
      );
  }, []);

  useEffect(() => {
    const openApproval = (event: MessageEvent<unknown>) => {
      const approvalId = approvalIdFromServiceWorkerMessage(event.data);
      if (approvalId === undefined) return;
      navigate({ page: 'inbox', approvalId });
    };
    globalThis.navigator?.serviceWorker?.addEventListener('message', openApproval);
    return () =>
      globalThis.navigator?.serviceWorker?.removeEventListener(
        'message',
        openApproval,
      );
  }, [navigate]);

  if (authentication.status === 'checking') {
    return (
      <main className="session-check" aria-busy="true">
        <span className="brand-mark">A</span>
        <p>{t('common.loading')}</p>
      </main>
    );
  }
  if (authentication.status === 'anonymous') {
    return (
      <Login
        onAuthenticated={(csrfToken) =>
          setAuthentication({ status: 'authenticated', csrfToken })
        }
      />
    );
  }
  const { csrfToken } = authentication;
  if (route.page === 'oauth') {
    return <OAuthConsent requestId={route.oauthRequestId} csrfToken={csrfToken} />;
  }
  if (route.page === 'setup') {
    return <SetupApproval requestId={route.setupRequestId} csrfToken={csrfToken} />;
  }
  const page: Page = route.page;
  return (
    <AppShell
      page={page}
      csrfToken={csrfToken}
      onNavigate={(nextPage) => navigate({ page: nextPage })}
      onLogout={() => setAuthentication({ status: 'anonymous' })}
    >
      {page === 'inbox' ? (
        <Inbox
          csrfToken={csrfToken}
          {...(route.approvalId === undefined
            ? {}
            : { targetApprovalId: route.approvalId })}
          onOpenApproval={(approvalId) =>
            navigate({ page: 'inbox', approvalId })
          }
          onCloseApproval={() => navigate({ page: 'inbox' }, true)}
        />
      ) : page === 'upstreams' ? (
        <Upstreams csrfToken={csrfToken} />
      ) : page === 'access' ? (
        <Access csrfToken={csrfToken} />
      ) : page === 'system' ? (
        <System csrfToken={csrfToken} />
      ) : page === 'plugins' ? (
        <Plugins csrfToken={csrfToken} />
      ) : page === 'history' ? (
        <History />
      ) : (
        <section className="page">
          <header className="page-header">
            <h1>{t(`nav.${page}`)}</h1>
          </header>
          <div className="empty-state">
            <span className="brand-mark">A</span>
          </div>
        </section>
      )}
    </AppShell>
  );
}
