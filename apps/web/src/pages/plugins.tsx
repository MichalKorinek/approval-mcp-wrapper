import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api/client.js';
import { Icon } from '../components/icon.js';
import { useI18n } from '../i18n/i18n.js';

interface ManagedPlugin {
  id: string;
  name: string;
  repository: string;
  enabled: boolean;
  busy: boolean;
  installed: { version: string; revision: string; installedAt: string; loaded: boolean }[];
  usedBy: { id: string; name: string; version: string }[];
  error: string | null;
  update: { version: string; revision: string } | null;
}
type Action = 'install' | 'check' | 'update' | 'enable' | 'disable' | 'remove';
interface PluginPreview {
  previewId: string;
  id: string;
  name: string;
  description: string;
  version: string;
  repository: string;
  revision: string;
  sha256: string;
}

export function Plugins({ csrfToken }: { csrfToken: string }) {
  const { t, formatDate } = useI18n();
  const [plugins, setPlugins] = useState<ManagedPlugin[]>();
  const [busy, setBusy] = useState<string>();
  const [feedback, setFeedback] = useState<{ error: boolean; text: string }>();
  const [confirmation, setConfirmation] = useState<{ id: string; action: 'disable' | 'remove' }>();
  const [adding, setAdding] = useState(false);
  const [repository, setRepository] = useState('');
  const [preview, setPreview] = useState<PluginPreview>();
  const [trustCode, setTrustCode] = useState(false);
  const load = useCallback(() => api<ManagedPlugin[]>('/api/admin/plugins/sources').then(setPlugins), []);

  const operationError = (error: unknown) => error instanceof ApiError && error.code === 'plugin.source_conflict'
    ? t('plugins.sourceConflict') : error instanceof ApiError && error.code === 'plugin.invalid_repository'
      ? t('plugins.invalidRepository') : error instanceof ApiError && error.code === 'plugin.preview_expired'
        ? t('plugins.previewExpired') : t('plugins.failed');

  async function previewRepository() {
    setBusy('preview');
    setFeedback(undefined);
    setPreview(undefined);
    setTrustCode(false);
    try {
      setPreview(await api<PluginPreview>('/api/admin/plugins/preview', {
        method: 'POST', body: JSON.stringify({ repository }),
      }, csrfToken));
    } catch (error) { setFeedback({ error: true, text: operationError(error) }); }
    finally { setBusy(undefined); }
  }

  async function confirmInstall() {
    if (preview === undefined || !trustCode) return;
    setBusy('add');
    setFeedback(undefined);
    try {
      setPlugins(await api<ManagedPlugin[]>('/api/admin/plugins/sources', {
        method: 'POST', body: JSON.stringify({ previewId: preview.previewId, trustCode: true }),
      }, csrfToken));
      setAdding(false);
      setRepository('');
      setPreview(undefined);
      setTrustCode(false);
      setFeedback({ error: false, text: t('plugins.saved') });
    } catch (error) { setFeedback({ error: true, text: operationError(error) }); }
    finally { setBusy(undefined); }
  }

  useEffect(() => {
    let active = true;
    const refresh = () => void api<ManagedPlugin[]>('/api/admin/plugins/sources')
      .then((value) => { if (active) setPlugins(value); })
      .catch(() => { if (active) setFeedback({ error: true, text: t('plugins.failed') }); });
    refresh();
    // Reflect changes in another admin tab without downloading plugin code.
    const timer = setInterval(refresh, 5_000);
    return () => { active = false; clearInterval(timer); };
  }, [t]);

  async function act(plugin: ManagedPlugin, action: Action) {
    setBusy(plugin.id);
    setFeedback(undefined);
    try {
      const next = await api<ManagedPlugin[]>(`/api/admin/plugins/${encodeURIComponent(plugin.id)}${action === 'remove' ? '' : `/${action}`}`, {
        method: action === 'remove' ? 'DELETE' : 'POST',
      }, csrfToken);
      setPlugins(next);
      setConfirmation(undefined);
      setFeedback({ error: false, text: `${plugin.name}: ${action === 'check'
        ? t(next.find((item) => item.id === plugin.id)?.update === null ? 'plugins.noUpdate' : 'plugins.updateAvailable')
        : t('plugins.saved')}` });
    } catch (error) {
      setFeedback({ error: true, text: error instanceof ApiError && error.code === 'plugin.in_use'
        ? t('plugins.inUse') : error instanceof ApiError && error.code === 'plugin.version_reused'
          ? t('plugins.versionReused') : t('plugins.failed') });
      await load().catch(() => undefined);
    } finally { setBusy(undefined); }
  }

  const active = plugins?.filter((plugin) => plugin.enabled && plugin.installed.some((item) => item.loaded)).length ?? 0;
  return (
    <section className="page">
      <header className="page-header"><div><h1>{t('plugins.title')}</h1><p>{t('plugins.subtitle')}</p></div>
        <div className="plugin-header-actions"><span className="plugin-count">{active} / {plugins?.length ?? 0} {t('plugins.active')}</span>
          <button className="primary compact" type="button" disabled={busy !== undefined} onClick={() => setAdding(true)}>{t('plugins.add')}</button></div>
      </header>
      <aside className="plugin-storage-note"><Icon name="shield-check" size={22} /><div><strong>{t('plugins.storageTitle')}</strong><p>{t('plugins.storageHint')}</p></div></aside>
      <p className="muted plugin-trust-note">{t('plugins.trustHint')}</p>
      {feedback !== undefined && <p role="status" className={feedback.error ? 'error' : 'success'}>{feedback.text}</p>}
      {adding && <section className="plugin-add-panel" aria-labelledby="plugin-add-title">
        <h2 id="plugin-add-title">{t('plugins.add')}</h2><p>{t('plugins.addHint')}</p>
        <form onSubmit={(event) => { event.preventDefault(); void previewRepository(); }}>
          <label>{t('plugins.repository')}<input type="url" required maxLength={250} value={repository} placeholder="https://github.com/owner/plugin-repository" disabled={busy !== undefined}
            onChange={(event) => { setRepository(event.target.value); setPreview(undefined); setTrustCode(false); }} /></label>
          <button className="secondary-button compact" type="submit" disabled={busy !== undefined || repository.trim() === ''}>{t('plugins.preview')}</button>
        </form>
        {preview !== undefined && <div className="plugin-install-preview">
          <h3>{preview.name} · v{preview.version}</h3><p>{preview.description}</p>
          <dl><div><dt>{t('plugins.repository')}</dt><dd>{preview.repository}</dd></div>
            <div><dt>{t('plugins.revision')}</dt><dd><code>{preview.revision}</code></dd></div>
            <div><dt>SHA-256</dt><dd><code>{preview.sha256}</code></dd></div></dl>
          <label className="check-row"><input type="checkbox" checked={trustCode} disabled={busy !== undefined} onChange={(event) => setTrustCode(event.target.checked)} /><span>{t('plugins.trustCode')}</span></label>
          <button className="primary compact" type="button" disabled={!trustCode || busy !== undefined} onClick={() => void confirmInstall()}>{t('plugins.confirmInstall')}</button>
        </div>}
        <button className="secondary-button compact" type="button" disabled={busy !== undefined} onClick={() => { setAdding(false); setPreview(undefined); setTrustCode(false); }}>{t('common.cancel')}</button>
      </section>}
      {plugins?.length === 0 && !adding && <div className="empty-panel record-empty"><Icon name="chip" size={28} /><h2>{t('plugins.empty')}</h2><p>{t('plugins.emptyHint')}</p></div>}
      {plugins === undefined ? <p aria-busy="true">{t('common.loading')}</p> : (
        <div className="managed-plugin-grid">
          {plugins.map((plugin) => {
            const installed = plugin.installed.length > 0;
            const failed = plugin.installed.some((item) => !item.loaded);
            const attention = failed || plugin.error !== null;
            const pending = busy !== undefined || plugin.busy;
            return (
              <article className="managed-plugin-card" key={plugin.id} aria-busy={plugin.busy || busy === plugin.id}>
                <header><span className="managed-plugin-icon"><Icon name="chip" size={23} /></span><div><h2>{plugin.name}</h2><code>{plugin.id}</code></div>
                  <span className={`managed-plugin-status ${attention ? 'failed' : plugin.enabled && installed ? 'enabled' : ''}`}>
                    {plugin.busy || busy === plugin.id ? t('common.loading') : attention ? t('plugins.needsAttention') : !installed ? t('plugins.notInstalled') : plugin.enabled ? t('plugins.enabled') : t('plugins.disabled')}
                  </span>
                </header>
                <a className="plugin-repository" href={plugin.repository} target="_blank" rel="noreferrer">{plugin.repository.replace('https://github.com/', '')} ↗</a>
                <div className="managed-plugin-details">
                  <h3>{t('plugins.versions')}</h3>
                  {installed ? <ul className="plugin-version-list">{plugin.installed.map((item) => (
                    <li key={item.version}><div><strong>v{item.version}</strong><code title={item.revision}>{item.revision.slice(0, 7)}</code></div><span>{formatDate(item.installedAt)}</span></li>
                  ))}</ul> : <p>{t('plugins.installHint')}</p>}
                  <h3>{t('plugins.usedBy')}</h3>
                  {plugin.usedBy.length === 0 ? <p>{t('plugins.unused')}</p> : <ul className="plugin-usage-list">{plugin.usedBy.map((upstream) => (
                    <li key={upstream.id}><span>{upstream.name}</span><code>v{upstream.version}</code></li>
                  ))}</ul>}
                  {plugin.update !== null && <p className="plugin-update-note">{t('plugins.updateAvailable')}: <strong>v{plugin.update.version}</strong>. {t('plugins.pinsHint')}</p>}
                  {failed && <p className="error">{t('plugins.cacheError')}</p>}
                  {!failed && plugin.error !== null && <p className="error">{t('plugins.lastError')}</p>}
                </div>
                {confirmation?.id === plugin.id ? (
                  <footer className="plugin-action-confirm"><p>{t(confirmation.action === 'remove' ? 'plugins.confirmRemove' : 'plugins.confirmDisable')}</p><div>
                    <button className="secondary-button compact" disabled={pending} onClick={() => setConfirmation(undefined)}>{t('common.cancel')}</button>
                    <button className="danger-button compact" disabled={pending} onClick={() => void act(plugin, confirmation.action)}>{t(confirmation.action === 'remove' ? 'plugins.remove' : 'plugins.disable')}</button>
                  </div></footer>
                ) : <footer className="managed-plugin-actions">
                  {!installed || failed ? <button className="primary compact" disabled={pending} onClick={() => void act(plugin, 'install')}>{t(installed ? 'plugins.repair' : 'plugins.install')}</button> : <>
                    <button className="secondary-button compact" disabled={pending} onClick={() => void act(plugin, 'check')}>{t('plugins.check')}</button>
                    {plugin.update !== null && <button className="primary compact" disabled={pending} onClick={() => void act(plugin, 'update')}>{t('plugins.update')}</button>}
                    <button className="secondary-button compact" disabled={pending} onClick={() => plugin.enabled ? setConfirmation({ id: plugin.id, action: 'disable' }) : void act(plugin, 'enable')}>{t(plugin.enabled ? 'plugins.disable' : 'plugins.enable')}</button>
                  </>}
                  {installed && <button className="danger-link compact" title={plugin.usedBy.length > 0 ? t('plugins.inUse') : undefined} disabled={pending || plugin.usedBy.length > 0} onClick={() => setConfirmation({ id: plugin.id, action: 'remove' })}>{t('plugins.remove')}</button>}
                </footer>}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
