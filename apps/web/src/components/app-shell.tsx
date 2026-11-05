import type { ReactNode } from 'react';

import { api, clearClientAuthentication } from '../api/client.js';
import { useI18n, type Locale } from '../i18n/i18n.js';
import { useTheme } from '../theme/theme.js';
import { Icon, type IconName } from './icon.js';
import { LanguageSwitch } from './language-switch.js';
import { pagePaths, type Page } from '../routes.js';

export type { Page } from '../routes.js';
const nav: { page: Page; key: `nav.${Page}`; icon: IconName }[] = [
  { page: 'inbox', key: 'nav.inbox', icon: 'inbox' },
  { page: 'history', key: 'nav.history', icon: 'arrow-history' },
  { page: 'access', key: 'nav.access', icon: 'shield-check' },
  { page: 'upstreams', key: 'nav.upstreams', icon: 'sync' },
  { page: 'plugins', key: 'nav.plugins', icon: 'chip' },
  { page: 'system', key: 'nav.system', icon: 'chip' },
];

export async function logoutSession(
  csrfToken: string,
  onLogout: () => void,
): Promise<void> {
  try {
    await api('/api/auth/logout', { method: 'POST' }, csrfToken);
  } catch {
    // Local logout must still complete when the session expired or the server is offline.
  } finally {
    clearClientAuthentication();
    onLogout();
  }
}

function ThemeControl({ compact = false }: { compact?: boolean }) {
  const { t } = useI18n();
  const { theme, toggle } = useTheme();
  const currentLabel = theme === 'dark'
    ? t('status.darkTheme')
    : t('status.lightTheme');
  const nextLabel = theme === 'dark'
    ? t('status.lightTheme')
    : t('status.darkTheme');
  return (
    <button
      type="button"
      className={`theme-toggle${compact ? ' compact-theme-toggle' : ''}`}
      onClick={toggle}
      aria-label={nextLabel}
      title={nextLabel}
    >
      <Icon name={theme === 'dark' ? 'moon' : 'sun'} />
      <span>{currentLabel}</span>
    </button>
  );
}

export function AppShell({ page, csrfToken, onNavigate, onLogout, children }: {
  page: Page;
  csrfToken: string;
  onNavigate(page: Page): void;
  onLogout(): void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const navigation = () => nav.map((item) => (
    <button
      type="button"
      key={item.page}
      className={page === item.page ? 'selected' : ''}
      aria-current={page === item.page ? 'page' : undefined}
      onClick={() => onNavigate(item.page)}
      data-route={pagePaths[item.page]}
    >
      <Icon name={item.icon} />
      <span>{t(item.key)}</span>
    </button>
  ));
  const logout = () => void logoutSession(csrfToken, onLogout);
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark"><Icon name="shield-check" size={20} /></span>
          <div><strong>{t('app.name')}</strong><small>{t('app.controlPlane')}</small></div>
        </div>
        <nav aria-label={t('nav.primary')}>{navigation()}</nav>
        <div className="sidebar-foot">
          <div className="preference-row">
            <LanguageSwitch />
            <ThemeControl />
          </div>
          <button className="logout-button" type="button" onClick={logout}>
            <Icon name="log-out" />
            <span>{t('common.logout')}</span>
          </button>
          <span className="secure-line"><Icon name="lock-closed" />{t('status.secure')}</span>
        </div>
      </aside>
      <header className="mobile-header">
        <div className="brand">
          <span className="brand-mark"><Icon name="shield-check" size={18} /></span>
          <div><strong>{t('app.name')}</strong><small>{t('app.controlPlane')}</small></div>
        </div>
        <div className="mobile-preferences">
          <LanguageSwitch />
          <ThemeControl compact />
          <button
            className="logout-button mobile-logout"
            type="button"
            aria-label={t('common.logout')}
            title={t('common.logout')}
            onClick={logout}
          >
            <Icon name="log-out" />
          </button>
        </div>
      </header>
      <main>{children}</main>
      <nav className="bottom-nav" aria-label={t('nav.primary')}>{navigation()}</nav>
    </div>
  );
}

export function localePath(locale: Locale, page: Page): string {
  return `${pagePaths[page]}?locale=${locale}`;
}
