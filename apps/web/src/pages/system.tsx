import { useCallback, useEffect, useMemo, useState } from 'react';

import { api } from '../api/client.js';
import { useI18n } from '../i18n/i18n.js';
import { Icon } from '../components/icon.js';
import { StorageControls } from '../components/storage-vault.js';
import {
  currentPushSubscription,
  defaultPushDeviceName,
  hashPushEndpoint,
  pushCapability,
  pushPlatform,
  serializePushSubscription,
  subscribeToPush,
} from '../push-client.js';

interface PushDevice {
  id: string;
  name: string;
  locale: string;
  platform: string;
  endpointHash: string;
  createdAt: string;
  updatedAt: string;
  lastAttemptAt?: string;
  lastDeliveredAt?: string;
  lastFailureAt?: string;
  lastFailureReason?: string;
}

interface PushConfig {
  available: boolean;
  publicKey?: string;
  devices: PushDevice[];
}

type Feedback = 'denied' | 'enabled' | 'error' | 'removed' |
  'testAccepted' | 'testExpired' | 'testFailed' | undefined;

export function System({ csrfToken }: { csrfToken: string }) {
  const { t, locale, formatDate, formatNumber } = useI18n();
  const [system, setSystem] = useState<{
    status: 'ok';
    runtime: string;
    uptimeSeconds: number;
  }>();
  const [push, setPush] = useState<PushConfig>();
  const [deviceName, setDeviceName] = useState(defaultPushDeviceName);
  const [currentEndpointHash, setCurrentEndpointHash] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string>();
  const [feedback, setFeedback] = useState<Feedback>();
  const [feedbackDevice, setFeedbackDevice] = useState<string>();
  const [testingId, setTestingId] = useState<string>();
  const capability = useMemo(pushCapability, []);

  const loadPush = useCallback(async () => {
    const next = await api<PushConfig>('/api/admin/push');
    setPush(next);
    const current = await currentPushSubscription();
    setCurrentEndpointHash(
      current === null ? undefined : await hashPushEndpoint(current.endpoint),
    );
  }, []);

  useEffect(() => {
    let active = true;
    void Promise.all([
      api<NonNullable<typeof system>>('/api/admin/system'),
      api<PushConfig>('/api/admin/push'),
      currentPushSubscription(),
    ]).then(async ([systemValue, pushValue, current]) => {
      if (!active) return;
      setSystem(systemValue);
      setPush(pushValue);
      setCurrentEndpointHash(
        current === null ? undefined : await hashPushEndpoint(current.endpoint),
      );
    }).catch(() => {
      if (active) setFeedback('error');
    });
    return () => { active = false; };
  }, []);

  const currentDevice = push?.devices.find(
    (device) => device.endpointHash === currentEndpointHash,
  );

  async function enablePush(): Promise<void> {
    if (
      push?.publicKey === undefined ||
      capability !== 'available' ||
      deviceName.trim() === ''
    ) return;
    setBusy(true);
    setFeedback(undefined);
    setFeedbackDevice(undefined);
    try {
      const permission = Notification.permission === 'granted'
        ? 'granted'
        : await Notification.requestPermission();
      if (permission !== 'granted') {
        setFeedback('denied');
        return;
      }
      const subscription = await subscribeToPush(push.publicKey);
      await api<PushDevice>('/api/admin/push/devices', {
        method: 'POST',
        body: JSON.stringify({
          name: deviceName.trim(),
          locale,
          platform: pushPlatform(),
          subscription: serializePushSubscription(subscription),
        }),
      }, csrfToken);
      await loadPush();
      setFeedback('enabled');
    } catch {
      setFeedback('error');
    } finally {
      setBusy(false);
    }
  }

  async function removeDevice(device: PushDevice): Promise<void> {
    setBusy(true);
    setFeedback(undefined);
    setFeedbackDevice(undefined);
    try {
      await api<void>(`/api/admin/push/devices/${encodeURIComponent(device.id)}`, {
        method: 'DELETE',
      }, csrfToken);
      if (device.endpointHash === currentEndpointHash) {
        await (await currentPushSubscription())?.unsubscribe();
      }
      setConfirmingId(undefined);
      await loadPush();
      setFeedback('removed');
    } catch {
      setFeedback('error');
    } finally {
      setBusy(false);
    }
  }

  async function testDevice(device: PushDevice): Promise<void> {
    setBusy(true);
    setTestingId(device.id);
    setFeedback(undefined);
    setFeedbackDevice(device.name);
    try {
      const result = await api<{ status: 'accepted' | 'expired' | 'failed' }>(
        `/api/admin/push/devices/${encodeURIComponent(device.id)}/test`,
        { method: 'POST' },
        csrfToken,
      );
      setFeedback(result.status === 'accepted' ? 'testAccepted'
        : result.status === 'expired' ? 'testExpired' : 'testFailed');
    } catch {
      setFeedback('testFailed');
    } finally {
      void loadPush().catch(() => undefined);
      setTestingId(undefined);
      setBusy(false);
    }
  }

  const capabilityMessage = capability === 'install_required'
    ? t('push.installRequired')
    : capability === 'unavailable'
      ? t('push.unavailable')
      : undefined;

  return (
    <section className="page">
      <header className="page-header"><div><h1>{t('system.title')}</h1><p>{t('system.subtitle')}</p></div></header>
      <div className="health-card"><span className="health-ring"><Icon name="check-circle" size={24} /></span><div><h2>{t('system.healthy')}</h2><p>{t('system.runtime')}: <code>{system?.runtime ?? '—'}</code> · {t('system.uptime')}: {system ? formatNumber(system.uptimeSeconds) : '—'} s</p></div></div>
      <StorageControls csrfToken={csrfToken} />

      <section className="push-card" aria-labelledby="push-title">
        <header>
          <div className="push-card-icon"><Icon name="inbox" size={22} /></div>
          <div><h2 id="push-title">{t('push.title')}</h2><p>{t('push.subtitle')}</p></div>
        </header>

        <div className="push-registration">
          <label>{t('push.deviceName')}<input value={deviceName} maxLength={64} onChange={(event) => setDeviceName(event.target.value)} /></label>
          <button className="primary compact" type="button" disabled={busy || capability !== 'available' || push?.available !== true || deviceName.trim() === ''} onClick={() => void enablePush()}>
            <Icon name="inbox" />
            {busy ? t('common.loading') : currentDevice === undefined ? t('push.enable') : t('push.update')}
          </button>
        </div>
        <p className="push-hint">{capabilityMessage ?? t('push.registrationHint')}</p>
        {feedback !== undefined && <p className={`push-feedback ${feedback === 'error' || feedback === 'denied' || feedback === 'testFailed' || feedback === 'testExpired' ? 'error' : 'success'}`} role="status">{feedbackDevice === undefined ? '' : `${feedbackDevice}: `}{t(`push.feedback.${feedback}`)}</p>}

        <div className="push-device-heading"><div><h3>{t('push.devices')}</h3><p>{t('push.devicesHint')}</p></div><span>{formatNumber(push?.devices.length ?? 0)}</span></div>
        {push?.devices.length === 0 ? (
          <div className="push-empty"><Icon name="inbox" size={22} /><div><strong>{t('push.noDevices')}</strong><p>{t('push.noDevicesDetail')}</p></div></div>
        ) : (
          <div className="push-device-list">
            {push?.devices.map((device) => (
              <article key={device.id}>
                <span className="push-device-icon"><Icon name="inbox" size={18} /></span>
                <div className="push-device-copy">
                  <strong>{device.name}{device.endpointHash === currentEndpointHash && <small>{t('push.thisDevice')}</small>}</strong>
                  <span>{device.platform} · {t('push.added')} {formatDate(device.createdAt)}</span>
                  <span className={device.lastFailureAt === undefined ? '' : 'push-failure'}>
                    {device.lastFailureAt !== undefined
                      ? t('push.deliveryFailed')
                      : device.lastDeliveredAt === undefined
                        ? t('push.neverDelivered')
                        : `${t('push.lastDelivered')} ${formatDate(device.lastDeliveredAt)}`}
                  </span>
                </div>
                {confirmingId === device.id ? (
                  <div className="push-remove-confirm">
                    <span>{t('push.confirmRemove')}</span>
                    <button className="secondary-button compact" type="button" disabled={busy} onClick={() => setConfirmingId(undefined)}>{t('common.cancel')}</button>
                    <button className="danger-button compact" type="button" disabled={busy} onClick={() => void removeDevice(device)}>{t('push.remove')}</button>
                  </div>
                ) : (
                  <div className="push-device-actions">
                    <button className="secondary-button compact" type="button" disabled={busy} onClick={() => void testDevice(device)}>{testingId === device.id ? t('push.testing') : t('push.test')}</button>
                    <button className="danger-link compact" type="button" disabled={busy} onClick={() => setConfirmingId(device.id)}>{t('push.remove')}</button>
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </section>
    </section>
  );
}
