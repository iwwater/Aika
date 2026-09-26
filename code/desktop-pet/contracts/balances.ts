export type BalanceProvider = 'aliyun' | 'deepseek';
export interface BalanceRow { currency: string; amount: string; availableCredit?: string }
export interface ProviderBalance {
  provider: BalanceProvider; status: 'unconfigured' | 'idle' | 'loading' | 'ready' | 'error';
  configured: boolean; credentialRevision: number; updatedAt: string | null; checkedAt: string | null;
  stale: boolean; rows: readonly BalanceRow[]; message: string | null;
}
export interface BalanceSnapshot { providers: readonly ProviderBalance[] }
export interface BalanceManagement {
  snapshot(): BalanceSnapshot;
  refresh(provider: BalanceProvider): BalanceSnapshot;
  configureAliyun(expectedRevision: number, accessKeyId: unknown, accessKeySecret: unknown): Promise<BalanceSnapshot>;
}
