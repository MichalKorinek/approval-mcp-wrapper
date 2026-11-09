export type SetupAction = 'create' | 'update' | 'unchanged';
export type SetupCredentialPlan = 'none' | 'provided' | 'keep' | 'required' | 'remove';
export type SetupField =
  | 'url' | 'allowPrivateNetwork' | 'displayName' | 'description'
  | 'metadata' | 'credentials';
export type SetupValueField = Exclude<SetupField, 'credentials'>;

export interface SetupUpstreamValues {
  url: string;
  allowPrivateNetwork: boolean;
  displayName?: string;
  description?: string;
  metadata?: Record<string, string>;
}

export interface SetupPlanItem {
  alias: string;
  action: SetupAction;
  upstreamId?: string;
  baseVersion?: number;
  changes: SetupField[];
  desired: SetupUpstreamValues;
  credentials: SetupCredentialPlan;
  /** The address an URL change replaces; only the authenticated approval view carries it. */
  previousUrl?: string;
}

export interface SetupRequestView {
  id: string;
  source: string;
  /** Label of the client token the request was submitted with (verified). */
  requestedWith: string;
  createdAt: string;
  expiresAt: string;
  planDigest: string;
  items: SetupPlanItem[];
}

/** A value shown on the approval page; booleans are left for the page to translate. */
export type SetupDisplayValue = string | boolean;

export interface SetupValueRow {
  field: SetupValueField;
  value: SetupDisplayValue;
  changed: boolean;
  /** The replaced address, shown for an URL change of an existing upstream. */
  before?: string;
}

const VALUE_FIELDS: readonly SetupValueField[] = [
  'url', 'allowPrivateNetwork', 'displayName', 'description', 'metadata',
];

function displayValue(values: SetupUpstreamValues, field: SetupValueField): SetupDisplayValue | undefined {
  switch (field) {
    case 'url': return values.url;
    case 'allowPrivateNetwork': return values.allowPrivateNetwork;
    case 'displayName': return values.displayName;
    case 'description': return values.description;
    case 'metadata': {
      const entries = Object.entries(values.metadata ?? {});
      return entries.length === 0
        ? undefined
        : entries.map(([key, value]) => `${key}=${value}`).join(', ');
    }
  }
}

/** Every value the operator approves for one upstream, marking the changed ones. */
export function valueRows(item: SetupPlanItem): SetupValueRow[] {
  const rows: SetupValueRow[] = [];
  for (const field of VALUE_FIELDS) {
    const value = displayValue(item.desired, field);
    if (value === undefined) continue;
    const before = field === 'url' ? item.previousUrl : undefined;
    rows.push({ field, value, changed: item.changes.includes(field), ...(before === undefined ? {} : { before }) });
  }
  return rows;
}

export function requiredCredentialAliases(items: readonly SetupPlanItem[]): string[] {
  return items.filter((item) => item.credentials === 'required').map((item) => item.alias);
}

/** Reads an operator-entered value; aliases such as `constructor` must not hit `Object.prototype`. */
export function enteredValue(entered: Readonly<Record<string, string>>, alias: string): string {
  return Object.hasOwn(entered, alias) ? entered[alias] ?? '' : '';
}

export function approvalCredentials(
  items: readonly SetupPlanItem[],
  entered: Readonly<Record<string, string>>,
): Record<string, { authorization: string }> | undefined {
  const result: Record<string, { authorization: string }> = {};
  for (const alias of requiredCredentialAliases(items)) {
    const value = enteredValue(entered, alias).trim();
    if (value === '') return undefined;
    Object.defineProperty(result, alias, {
      value: { authorization: value },
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
}

export function warnsAboutPrivateNetwork(item: SetupPlanItem): boolean {
  return item.action !== 'unchanged' &&
    item.desired.allowPrivateNetwork &&
    item.changes.includes('allowPrivateNetwork');
}
