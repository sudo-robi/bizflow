export interface User {
  id: string;
  email: string;
  full_name?: string | null;
  is_active?: boolean;
  [key: string]: unknown;
}

export interface Membership {
  business: Business;
  role: Role;
  status?: string;
  [key: string]: unknown;
}

export interface Business {
  id: string;
  name: string;
  legal_name?: string | null;
  country?: string | null;
  currency?: string;
  role?: Role;
  created_at?: string;
  [key: string]: unknown;
}

export type Role = "owner" | "admin" | "finance_manager" | "supplier";

export interface Supplier {
  id: string;
  business_name: string;
  contact_name?: string | null;
  email?: string | null;
  phone?: string | null;
  wallet_address: string;
  country?: string | null;
  notes?: string | null;
  status?: string;
  created_at?: string;
  [key: string]: unknown;
}

export interface LineItem {
  id?: string;
  description: string;
  quantity: number | string;
  unit_price: number | string;
  [key: string]: unknown;
}

export interface InvoicePayment {
  id: string;
  amount: string;
  status?: string;
  hash?: string | null;
  created_at?: string;
  [key: string]: unknown;
}

export interface Invoice {
  id: string;
  invoice_number?: string;
  supplier_id?: string;
  supplier?: Supplier | null;
  description?: string;
  amount: string;
  asset_code?: string;
  asset_issuer?: string | null;
  due_date?: string | null;
  reference?: string | null;
  status: string;
  amount_paid?: string;
  remaining_amount?: string;
  items?: LineItem[];
  payments?: InvoicePayment[];
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export interface Milestone {
  id: string;
  description: string;
  amount: string;
  due_date?: string | null;
  status?: string;
  released_at?: string | null;
  release_transaction_hash?: string | null;
  sort_order?: number;
  [key: string]: unknown;
}

/** conditions and approval_requirements are JSON objects on the backend. */
export type AgreementMetadata = Record<string, unknown> | string;

export interface Agreement {
  id: string;
  reference?: string;
  supplier_id?: string;
  supplier?: Supplier | null;
  title: string;
  description?: string | null;
  total_amount: string;
  asset_code?: string;
  asset_issuer?: string | null;
  expiry_date?: string | null;
  conditions?: AgreementMetadata | null;
  approval_requirements?: AgreementMetadata | null;
  status: string;
  milestones?: Milestone[];
  /** Decimal string (e.g. "0"); use Number(funded_amount) > 0 to test escrow state. */
  funded_amount?: string | null;
  fund_transaction_hash?: string | null;
  escrow_contract_id?: string | null;
  created_at?: string;
  [key: string]: unknown;
}

export interface Payment {
  id: string;
  invoice_id?: string | null;
  agreement_id?: string | null;
  milestone_id?: string | null;
  amount: string;
  asset_code?: string;
  asset_issuer?: string | null;
  status: string;
  hash?: string | null;
  source_account?: string | null;
  destination_account?: string | null;
  memo?: string | null;
  created_at?: string;
  [key: string]: unknown;
}

export interface BlockchainTransaction {
  id?: string;
  hash: string;
  status?: string;
  verification_status?: string;
  successful?: boolean;
  amount?: string;
  asset_code?: string;
  source_account?: string | null;
  destination_account?: string | null;
  memo?: string | null;
  created_at?: string;
  confirmed_at?: string | null;
  ledger?: number | null;
  fee?: string | null;
  [key: string]: unknown;
}

export interface Notification {
  id: string;
  title: string;
  message?: string | null;
  type?: string;
  is_read?: boolean;
  read?: boolean;
  created_at?: string;
  [key: string]: unknown;
}

export interface Member {
  user: User;
  role: Role;
  status?: string;
  [key: string]: unknown;
}

/** A point used by the chart components; built from the backend's monthly_volume map. */
export interface ActivityPoint {
  date?: string;
  label?: string;
  amount?: string;
  count?: number | string;
}

export interface DashboardReport {
  counts?: {
    invoices?: number;
    suppliers?: number;
    payments_confirmed?: number;
    payments_pending?: number;
    agreements_active?: number;
    milestones_released?: number;
    [key: string]: unknown;
  };
  invoices_by_status?: Record<string, number>;
  total_paid?: string;
  /** Optional: the backend may include this; otherwise it comes from /reports/analytics. */
  outstanding?: string;
  monthly_volume?: Record<string, string>;
  recent_transactions?: BlockchainTransaction[];
  has_data?: boolean;
  [key: string]: unknown;
}

export interface AnalyticsReport {
  outstanding_liabilities?: string;
  [key: string]: unknown;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  per_page: number;
  [key: string]: unknown;
}

export interface PreparedPayment {
  payment_id: string;
  xdr: string;
  hash: string;
  expires_at?: string;
  [key: string]: unknown;
}

export interface TransactionDetails {
  source: string;
  destination: string;
  amount: string;
  asset: string;
  assetIssuer?: string | null;
  memo: string;
  fee: string;
  network: string;
  hash: string;
  operationType: string;
}

export interface WalletBalance {
  asset: string;
  issuer?: string | null;
  balance: string;
}

export interface PublicReceipt {
  hash: string;
  status?: string;
  amount?: string;
  asset_code?: string;
  destination?: string | null;
  source?: string | null;
  memo?: string | null;
  settled_invoice?: string | null;
  confirmed_at?: string | null;
  [key: string]: unknown;
}
