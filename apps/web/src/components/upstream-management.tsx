import { useState, type FormEvent } from 'react';

import { api } from '../api/client.js';
import { useI18n } from '../i18n/i18n.js';
import {
  metadataRecord,
  metadataRows,
  UpstreamMetadataEditor,
  type UpstreamMetadataRow,
} from './upstream-metadata-editor.js';

export interface ManagedUpstream {
  id: string;
  alias: string;
  displayName?: string;
  description?: string;
  metadata?: Record<string, string>;
  url: string;
  allowPrivateNetwork: boolean;
  credentialsConfigured: boolean;
  version: number;
  pluginId?: string;
  pluginVersion?: string;
}

export interface DeletionImpact {
  policies: number;
  profileRules: number;
  grants: number;
}

export function UpstreamEditForm({
  upstream,
  csrfToken,
  plugins,
  onSaved,
  onCancel,
}: {
  upstream: ManagedUpstream;
  csrfToken: string;
  plugins: readonly Readonly<{ id: string; version: string }>[];
  onSaved(upstream: ManagedUpstream): void;
  onCancel(): void;
}) {
  const { t } = useI18n();
  const [alias, setAlias] = useState(upstream.alias);
  const [displayName, setDisplayName] = useState(upstream.displayName ?? '');
  const [description, setDescription] = useState(upstream.description ?? '');
  const [metadata, setMetadata] = useState<UpstreamMetadataRow[]>(() =>
    metadataRows(upstream.metadata),
  );
  const [url, setUrl] = useState(upstream.url);
  const [privateNetwork, setPrivateNetwork] = useState(
    upstream.allowPrivateNetwork,
  );
  const [authorization, setAuthorization] = useState('');
  const [removeCredential, setRemoveCredential] = useState(false);
  const [pluginPin, setPluginPin] = useState(
    upstream.pluginId === undefined || upstream.pluginVersion === undefined
      ? ''
      : `${upstream.pluginId}@${upstream.pluginVersion}`,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(false);
    try {
      const updated = await api<ManagedUpstream>(
        `/api/admin/upstreams/${upstream.id}`,
        {
          method: 'PUT',
          body: JSON.stringify({
            version: upstream.version,
            alias,
            displayName: displayName.trim() === '' ? null : displayName,
            description: description.trim() === '' ? null : description,
            metadata: metadataRecord(metadata),
            url,
            allowPrivateNetwork: privateNetwork,
            ...(pluginPin === ''
              ? { pluginId: null, pluginVersion: null }
              : {
                  pluginId: pluginPin.slice(0, pluginPin.lastIndexOf('@')),
                  pluginVersion: pluginPin.slice(pluginPin.lastIndexOf('@') + 1),
                }),
            ...(removeCredential
              ? { credentials: null }
              : authorization === ''
                ? {}
                : { credentials: { authorization } }),
          }),
        },
        csrfToken,
      );
      onSaved(updated);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="upstream-edit-form"
      onSubmit={(event) => void submit(event)}
    >
      <div className="form-heading">
        <div><h3>{t('upstreams.editTitle')}</h3><p>{t('upstreams.editDetail')}</p></div>
      </div>
      <div className="form-grid">
        <label className="field">
          <span>{t('upstreams.displayName')}</span>
          <input
            maxLength={120}
            placeholder={t('upstreams.displayNamePlaceholder')}
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
          <small>{t('upstreams.displayNameHint')}</small>
        </label>
        <label className="field">
          <span>{t('upstreams.alias')}</span>
          <input
            required
            pattern="[a-z0-9_-]+"
            value={alias}
            onChange={(event) => setAlias(event.target.value)}
          />
        </label>
        <label className="field field-wide">
          <span>{t('upstreams.url')}</span>
          <input
            required
            type="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
        </label>
        <label className="field field-wide">
          <span>{t('upstreams.description')}</span>
          <textarea
            maxLength={1000}
            rows={3}
            placeholder={t('upstreams.descriptionPlaceholder')}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        <UpstreamMetadataEditor rows={metadata} onChange={setMetadata} />
        <label className="field field-wide">
          <span>{t('upstreams.replaceCredential')}</span>
          <input
            type="password"
            autoComplete="off"
            disabled={removeCredential}
            value={authorization}
            onChange={(event) => setAuthorization(event.target.value)}
          />
        </label>
        <label className="field field-wide">
          <span>{t('upstreams.plugin')}</span>
          <select value={pluginPin} onChange={(event) => setPluginPin(event.target.value)}>
            <option value="">{t('upstreams.noPlugin')}</option>
            {upstream.pluginId !== undefined && upstream.pluginVersion !== undefined &&
              !plugins.some((plugin) => plugin.id === upstream.pluginId && plugin.version === upstream.pluginVersion) && (
                <option value={`${upstream.pluginId}@${upstream.pluginVersion}`}>{upstream.pluginId} · {upstream.pluginVersion} ({t('plugins.disabled')})</option>
              )}
            {plugins.map((plugin) => (
              <option key={`${plugin.id}@${plugin.version}`} value={`${plugin.id}@${plugin.version}`}>
                {plugin.id} · {plugin.version}
              </option>
            ))}
          </select>
          <small>{t('upstreams.pluginHint')}</small>
        </label>
      </div>
      <div className="form-options">
        <label className="check-row">
          <input
            type="checkbox"
            checked={privateNetwork}
            onChange={(event) => setPrivateNetwork(event.target.checked)}
          />
          <span><strong>{t('upstreams.private')}</strong><small>{t('upstreams.privateHint')}</small></span>
        </label>
        {upstream.credentialsConfigured && (
          <label className="check-row destructive-option">
            <input
              type="checkbox"
              checked={removeCredential}
              onChange={(event) => setRemoveCredential(event.target.checked)}
            />
            <span><strong>{t('upstreams.removeCredential')}</strong><small>{t('upstreams.removeCredentialHint')}</small></span>
          </label>
        )}
      </div>
      {error && <p className="catalog-error">{t('upstreams.saveFailed')}</p>}
      <div className="form-actions">
        <button className="secondary-button" type="button" onClick={onCancel}>{t('common.cancel')}</button>
        <button className="primary compact" type="submit" disabled={busy}>
          {busy ? t('common.loading') : t('common.save')}
        </button>
      </div>
    </form>
  );
}

export function UpstreamDeleteConfirmation({
  alias,
  impact,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  alias: string;
  impact: DeletionImpact;
  busy: boolean;
  error?: boolean;
  onConfirm(): void;
  onCancel(): void;
}) {
  const { t, formatNumber } = useI18n();
  return (
    <div className="delete-confirmation" role="alertdialog">
      <strong>{t('upstreams.deleteTitle')}</strong>
      <p>{t('upstreams.deleteWarning')} <code>{alias}</code></p>
      <dl>
        <div><dt>{t('upstreams.affectedPolicies')}</dt><dd>{formatNumber(impact.policies)}</dd></div>
        <div><dt>{t('upstreams.affectedProfileRules')}</dt><dd>{formatNumber(impact.profileRules)}</dd></div>
        <div><dt>{t('upstreams.affectedGrants')}</dt><dd>{formatNumber(impact.grants)}</dd></div>
      </dl>
      {error === true && (
        <p className="catalog-error">{t('upstreams.deleteFailed')}</p>
      )}
      <div className="management-actions">
        <button type="button" onClick={onCancel}>{t('common.cancel')}</button>
        <button
          className="danger-button"
          type="button"
          disabled={busy}
          onClick={onConfirm}
        >
          {busy ? t('common.loading') : t('upstreams.confirmDelete')}
        </button>
      </div>
    </div>
  );
}
