import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../api/client.js';
import {
  approvalViewModel,
  type ApprovalApiRecord,
  type ApprovalViewModel,
} from '../components/approval-view-model.js';

export function useApprovalEvents() {
  const [approvals, setApprovals] = useState<ApprovalViewModel[]>([]);
  const [connected, setConnected] = useState(false);
  const lastEventId = useRef('');

  const refresh = useCallback(async () => {
    const records = await api<ApprovalApiRecord[]>('/api/admin/approvals');
    setApprovals(
      records
        .map(approvalViewModel)
        .filter((item): item is ApprovalViewModel => item !== undefined),
    );
  }, []);

  useEffect(() => {
    let closed = false;
    let source: EventSource | undefined;
    let retry = 1_000;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const refreshSoon = () => {
      if (refreshTimer !== undefined) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        void refresh().catch(() => undefined);
      }, 75);
    };
    const connect = () => {
      const query =
        lastEventId.current === ''
          ? ''
          : `?lastEventId=${encodeURIComponent(lastEventId.current)}`;
      source = new EventSource(`/api/admin/approvals/events${query}`);
      source.onopen = () => {
        retry = 1_000;
        setConnected(true);
        refreshSoon();
      };
      source.onmessage = (event) => {
        lastEventId.current = event.lastEventId;
        refreshSoon();
      };
      source.onerror = () => {
        setConnected(false);
        source?.close();
        if (!closed) {
          reconnectTimer = setTimeout(connect, retry);
          retry = Math.min(retry * 2, 15_000);
        }
      };
    };
    refreshSoon();
    connect();
    return () => {
      closed = true;
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      if (refreshTimer !== undefined) clearTimeout(refreshTimer);
      source?.close();
    };
  }, [refresh]);

  return { approvals, connected, refresh };
}
