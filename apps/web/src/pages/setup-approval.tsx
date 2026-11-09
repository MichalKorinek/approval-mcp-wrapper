import { startAuthentication } from '@simplewebauthn/browser';
import { useEffect, useState } from 'react';

import { api } from '../api/client.js';
import { Icon } from '../components/icon.js';
import { LanguageSwitch } from '../components/language-switch.js';
import {
  approvalCredentials,
  enteredValue,
  valueRows,
  warnsAboutPrivateNetwork,
  type SetupDisplayValue,
  type SetupRequestView,
  type SetupValueField,
} from '../components/setup-approval-model.js';
import type { MessageKey } from '../i18n/en.js';
import { useI18n } from '../i18n/i18n.js';
import { useTheme } from '../theme/theme.js';

type Outcome = 'pending' | 'applied' | 'denied';

export function SetupApproval({ requestId, csrfToken }: { requestId: string; csrfToken: string }) {
  const { t, formatDate } = useI18n();
  const { theme, toggle } = useTheme();
  const [request, setRequest] = useState<SetupRequestView>();
  const [entered, setEntered] = useState<Record<string, string>>({});
  const [outcome, setOutcome] = useState<Outcome>('pending');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    setRequest(undefined);
    setError(false);
    void api<SetupRequestView>(`/api/setup/requests/${encodeURIComponent(requestId)}`)
      .then((result) => { if (active) setRequest(result); })
      .catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [requestId]);

  const credentials = request === undefined ? undefined : approvalCredentials(request.items, entered);

  function display(field: SetupValueField, value: SetupDisplayValue) {
    if (typeof value === 'boolean') return <span>{t(value ? 'setup.yes' : 'setup.no')}</span>;
    return field === 'displayName' || field === 'description' ? <span>{value}</span> : <code>{value}</code>;
  }

  async function approve() {
    if (request === undefined || credentials === undefined) return;
    setBusy(true);
    setError(false);
    try {
      const options = await api<Parameters<typeof startAuthentication>[0]['optionsJSON']>(
        '/api/auth/login/options', { method: 'POST' },
      );
      const passkey = await startAuthentication({ optionsJSON: options });
      await api(
        `/api/setup/requests/${encodeURIComponent(requestId)}/approve`,
        {
          method: 'POST',
          body: JSON.stringify({
            planDigest: request.planDigest,
            passkey,
            ...(Object.keys(credentials).length === 0 ? {} : { credentials }),
          }),
        },
        csrfToken,
      );
      setEntered({});
      setOutcome('applied');
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  async function deny() {
    setBusy(true);
    setError(false);
    try {
      await api(`/api/setup/requests/${encodeURIComponent(requestId)}/deny`, { method: 'POST', body: '{}' }, csrfToken);
      setEntered({});
      setOutcome('denied');
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  return <main className="oauth-page">
    <header className="login-header">
      <div className="brand"><span className="brand-mark"><Icon name="shield-check" size={20} /></span><div><strong>{t('app.name')}</strong><small>{t('app.controlPlane')}</small></div></div>
      <div className="login-preferences"><LanguageSwitch /><button className="theme-toggle" type="button" onClick={toggle}><Icon name={theme === 'dark' ? 'moon' : 'sun'} /><span>{theme === 'dark' ? t('status.darkTheme') : t('status.lightTheme')}</span></button></div>
    </header>
    <section className="oauth-card" aria-busy={busy}>
      <div className="oauth-heading"><span className="oauth-heading-icon"><Icon name="database" size={26} /></span><div><p className="eyebrow">{t('setup.eyebrow')}</p><h1>{t('setup.title')}</h1><p className="oauth-intro">{t('setup.description')}</p></div></div>
      {outcome !== 'pending'
        ? <div className="setup-outcome" role="status"><p>{t(outcome === 'applied' ? 'setup.applied' : 'setup.denied')}</p><a className="secondary-button" href="/upstreams">{t('setup.openUpstreams')}</a></div>
        : request === undefined
          ? <p>{error ? t('setup.failed') : t('common.loading')}</p>
          : <>
            <div className="oauth-client">
              <div className="oauth-client-heading"><span className="oauth-client-icon"><Icon name="chip" size={22} /></span><div><small>{t('setup.requestedBy')}</small><strong>{request.source}</strong><span>{t('setup.unverified')}</span></div></div>
              <div className="oauth-client-route"><span>{t('setup.requestedWith')}</span><code>{request.requestedWith}</code></div>
              <div className="oauth-client-route"><span>{t('setup.expiresAt')}</span><code>{formatDate(new Date(request.expiresAt))}</code></div>
            </div>
            <ul className="setup-items">
              {request.items.map((item) => <li className="setup-item" key={item.alias}>
                <div className="setup-item-heading">
                  <span className={`setup-action setup-action-${item.action}`}>{t(`setup.${item.action}` as MessageKey)}</span>
                  <strong>{item.desired.displayName ?? item.alias}</strong>
                  <code>{item.alias}</code>
                </div>
                <dl>
                  {valueRows(item).map((row) => <div key={row.field} style={{ display: 'contents' }}>
                    <dt>{t(`setup.field.${row.field}` as MessageKey)}</dt>
                    <dd>
                      {item.action === 'update' && row.changed && <span className="setup-changed">{t('setup.changed')}</span>}
                      {row.before !== undefined && <>
                        <span className="setup-before-label">{t('setup.before')}</span>
                        <span className="setup-before"><code>{row.before}</code></span>
                      </>}
                      {display(row.field, row.value)}
                    </dd>
                  </div>)}
                  <dt>{t('setup.field.credentials')}</dt><dd>{t(`setup.credentials.${item.credentials}` as MessageKey)}</dd>
                </dl>
                {warnsAboutPrivateNetwork(item) && <p className="oauth-warning"><Icon name="alert" size={18} /><span>{t('setup.privateNetwork')}</span></p>}
                {item.credentials === 'required' && <label className="oauth-field">{t('setup.credentialLabel')}
                  <input type="password" autoComplete="off" spellCheck={false} disabled={busy} value={enteredValue(entered, item.alias)} onChange={(event) => {
                    const value = event.target.value;
                    setEntered((previous) => {
                      const next = { ...previous };
                      Object.defineProperty(next, item.alias, { value, enumerable: true, writable: true, configurable: true });
                      return next;
                    });
                  }} />
                  <small>{t('setup.credentialHint')}</small>
                </label>}
              </li>)}
            </ul>
            {request.items.some((item) => item.action === 'create') && <p className="oauth-warning"><Icon name="info" size={18} /><span>{t('setup.toolsHidden')}</span></p>}
            {error && <p className="oauth-error" role="alert">{t('setup.failed')}</p>}
            <div className="oauth-actions">
              <button type="button" className="secondary-button" disabled={busy} onClick={() => void deny()}>{t('setup.deny')}</button>
              <button type="button" className="primary" disabled={busy || credentials === undefined} onClick={() => void approve()}><Icon name="fingerprint" size={18} />{t('setup.approve')}</button>
            </div>
          </>}
    </section>
  </main>;
}
