import { useEffect, useState, type ReactNode } from 'react';
import { useI18n } from '../i18n/i18n.js';
import { LanguageSwitch } from './language-switch.js';
import { beginStorageEnrollment, finishStorageEnrollment, recoverStorage, storageApi, unlockStorage, type StorageStatus } from '../storage-client.js';
import type { MessageKey } from '../i18n/en.js';
import { Icon } from './icon.js';
import { useTheme } from '../theme/theme.js';

export function StorageBoundary({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const { theme, toggle } = useTheme();
  const [status, setStatus] = useState<StorageStatus>();
  const [error, setError] = useState(false);
  useEffect(() => { void storageApi<StorageStatus>('status').then(setStatus, () => setError(true)); }, []);
  if (error) return <main className="session-check"><p role="alert">{t('storage.unavailable')}</p><button onClick={() => location.reload()}>{t('storage.retry')}</button></main>;
  if (status === undefined) return <main className="session-check" aria-busy="true">{t('common.loading')}</main>;
  return status.locked ? <main className="storage-unlock"><div className="storage-topbar"><span className="storage-brand"><Icon name="shield-check" size={24} />Approval MCP</span><div><LanguageSwitch /><button className="theme-toggle" onClick={toggle}><Icon name={theme === 'dark' ? 'moon' : 'sun'} />{t(theme === 'dark' ? 'status.darkTheme' : 'status.lightTheme')}</button></div></div><StorageControls initialStatus={status} /></main> : children;
}

export function StorageControls({ initialStatus, csrfToken }: { initialStatus?: StorageStatus; csrfToken?: string }) {
  const { t, formatDate } = useI18n();
  const [status, setStatus] = useState(initialStatus);
  const [name, setName] = useState('');
  const [setupToken, setSetupToken] = useState('');
  const [recovery, setRecovery] = useState('');
  const [newRecovery, setNewRecovery] = useState<string>();
  const [enrollment, setEnrollment] = useState<Awaited<ReturnType<typeof beginStorageEnrollment>>>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MessageKey>();
  const [selected, setSelected] = useState(initialStatus?.slots[0]?.id ?? '');
  useEffect(() => { if (initialStatus === undefined) void storageApi<StorageStatus>('status').then(setStatus).catch(() => setError('storage.unavailable')); }, [initialStatus]);
  async function run(operation: () => Promise<void>) {
    setBusy(true); setError(undefined);
    try { await operation(); }
    catch (e) { setError(e instanceof Error && e.message === 'storage.prfUnsupported' ? 'storage.prfUnsupported' : 'storage.failed'); }
    finally { setBusy(false); }
  }
  if (status === undefined) return <p>{error ? t('storage.unavailable') : t('common.loading')}</p>;
  const wrongOrigin = location.origin !== status.primaryOrigin;
  const canEnroll = !status.initialized || csrfToken !== undefined;
  return <section className="push-card storage-card" aria-labelledby="storage-title">
    <header><div><span className="eyebrow">APPROVAL MCP</span><h2 id="storage-title">{t(status.locked ? 'storage.lockedTitle' : 'storage.title')}</h2><p>{t(status.locked ? 'storage.lockedHint' : 'storage.subtitle')}</p></div></header>
    {error && <p role="alert" className="error">{t(error)}</p>}
    {wrongOrigin ? <p>{t('storage.primaryOrigin')} <a href={`${status.primaryOrigin}/unlock`}>{status.primaryOrigin}</a></p> : <>
      {status.environmentUnlock && <p className="storage-notice">{t('storage.environmentHint')}</p>}
      <p className="push-hint">{t(status.bootstrapNotifications ? 'storage.notificationsHint' : 'storage.notificationsDisabledHint')}</p>
      {status.legacyKeyRequired ? <p role="alert">{t('storage.legacyHint')}</p> : <>
        {status.locked && status.initialized && <div className="storage-fields">
          {status.slots.length > 0 ? <><label>{t('storage.passkey')}<select value={selected || status.slots[0]?.id} onChange={(e) => setSelected(e.target.value)}>{status.slots.map((slot) => <option key={slot.id} value={slot.id}>{slot.name}</option>)}</select></label><button className="primary" disabled={busy} onClick={() => void run(async () => { await unlockStorage(status, selected || status.slots[0]!.id); location.reload(); })}>{t('storage.unlock')}</button></> : <p>{t('storage.envRequired')}</p>}
          {status.recoveryAvailable && <details><summary>{t('storage.recover')}</summary><label>{t('storage.recoveryKey')}<input type="password" autoComplete="off" value={recovery} onChange={(e) => setRecovery(e.target.value)} /></label><button className="secondary-button" disabled={busy || recovery.trim() === ''} onClick={() => void run(async () => { try { await recoverStorage(status, recovery); location.reload(); } finally { setRecovery(''); } })}>{t('storage.unlock')}</button></details>}
        </div>}
        {canEnroll && <div className="storage-fields">
          <h3>{t(status.initialized ? 'storage.addPasskey' : 'storage.setupTitle')}</h3><p>{t('storage.separatePasskey')}</p>
          {!status.initialized && <label>{t('storage.setupCode')}<input type="password" autoComplete="off" value={setupToken} onChange={(e) => setSetupToken(e.target.value)} /></label>}
          <label>{t('storage.passkeyName')}<input value={name} maxLength={64} onChange={(e) => setName(e.target.value)} /></label>
          {enrollment === undefined ? <button className="primary" disabled={busy || !name.trim() || (!status.initialized && !setupToken)} onClick={() => void run(async () => setEnrollment(await beginStorageEnrollment(status, name, setupToken, csrfToken)))}>{t('storage.register')}</button> : <><p>{t('storage.finishHint')}</p><button className="primary" disabled={busy} onClick={() => void run(async () => {
            const code = await finishStorageEnrollment(status, enrollment, setupToken, csrfToken);
            setEnrollment(undefined); setSetupToken(''); setName('');
            if (code !== undefined) setNewRecovery(code);
            setStatus(await storageApi<StorageStatus>('status'));
          })}>{t('storage.finish')}</button><button className="secondary-button" disabled={busy} onClick={() => { enrollment.key = undefined; setEnrollment(undefined); }}>{t('common.cancel')}</button></>}
        </div>}
        {newRecovery && <div className="storage-recovery"><h3>{t('storage.saveRecovery')}</h3><p>{t('storage.saveRecoveryHint')}</p><input aria-label={t('storage.recoveryKey')} readOnly autoComplete="off" value={newRecovery} /><button className="secondary-button" onClick={() => { setNewRecovery(undefined); if (csrfToken === undefined) location.reload(); }}>{t('storage.saved')}</button></div>}
        {!status.locked && !newRecovery && csrfToken === undefined && <button className="primary" onClick={() => location.reload()}>{t('storage.continue')}</button>}
        {csrfToken !== undefined && status.slots.map((slot) => <div className="storage-slot" key={slot.id}><div><strong>{slot.name}</strong><p>{formatDate(slot.createdAt)}</p></div><button className="danger-link" disabled={busy || status.slots.length <= 1} onClick={() => { if (confirm(t('storage.removeConfirm'))) void run(async () => { await storageApi(`passkeys/${slot.id}`, status, {}, csrfToken, 'DELETE'); setStatus(await storageApi('status')); }); }}>{t('storage.remove')}</button></div>)}
      </>}
    </>}
  </section>;
}
