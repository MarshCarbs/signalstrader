import { BigNumber, Contract, Wallet, ethers } from 'ethers';
import type { AppConfig } from './config';
import { logError, logInfo } from './logger';

const SAFE_ABI = [
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool success)',
  'function nonce() view returns (uint256)',
];

const CTF_REDEEM_ABI = [
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
];

interface PositionRecord {
  conditionId?: string;
  condition_id?: string;
  parentCollectionId?: string;
  parent_collection_id?: string;
  outcomeIndex?: number | string;
  indexSet?: string | number;
}

interface RedeemGroup {
  conditionId: string;
  parentCollectionId: string;
  indexSets: string[];
}

type ClaimMode = 'direct' | 'safe';

interface ClaimTarget {
  address: string;
  mode: ClaimMode;
}

function parseJsonSafe(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

function extractErrorMessage(error: unknown): string {
  if (!error) {
    return 'Unknown error';
  }

  if (error instanceof Error) {
    const anyErr = error as any;
    const nested =
      anyErr?.reason ||
      anyErr?.error?.reason ||
      anyErr?.error?.message ||
      anyErr?.data?.message ||
      anyErr?.response?.data?.message;

    if (typeof nested === 'string' && nested.trim()) {
      return `${error.message} | ${nested.trim()}`;
    }

    const body = anyErr?.body;
    if (typeof body === 'string' && body.trim()) {
      const parsed = parseJsonSafe(body) as any;
      const bodyMsg =
        parsed?.error?.message ||
        parsed?.message ||
        parsed?.error;
      if (typeof bodyMsg === 'string' && bodyMsg.trim()) {
        return `${error.message} | ${bodyMsg.trim()}`;
      }
      return `${error.message} | ${body.slice(0, 300)}`;
    }

    return error.message;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function isHex32(value: string): boolean {
  return /^0x[a-fA-F0-9]{64}$/.test(value);
}

function normalizeAddress(value: string): string {
  return ethers.utils.getAddress(value);
}

function extractConditionId(position: PositionRecord): string | null {
  const conditionId = (position.conditionId || position.condition_id || '').trim();
  if (!isHex32(conditionId)) {
    return null;
  }
  return conditionId;
}

function extractParentCollectionId(position: PositionRecord): string {
  const parent = (position.parentCollectionId || position.parent_collection_id || '').trim();
  return isHex32(parent) ? parent : ethers.constants.HashZero;
}

function extractIndexSet(position: PositionRecord): string | null {
  if (position.outcomeIndex !== undefined && position.outcomeIndex !== null) {
    const outcomeIndex = Number(position.outcomeIndex);
    if (Number.isFinite(outcomeIndex) && outcomeIndex >= 0) {
      return BigNumber.from(1).shl(outcomeIndex).toString();
    }
  }

  if (position.indexSet !== undefined && position.indexSet !== null) {
    try {
      return BigNumber.from(position.indexSet).toString();
    } catch {
      return null;
    }
  }

  return null;
}

async function signSafeTransaction(
  signer: Wallet,
  chainId: number,
  safeAddress: string,
  tx: {
    to: string;
    value: string;
    data: string;
    operation: number;
    safeTxGas: string;
    baseGas: string;
    gasPrice: string;
    gasToken: string;
    refundReceiver: string;
    nonce: number;
  }
): Promise<string> {
  const domain = {
    chainId,
    verifyingContract: safeAddress,
  };

  const types = {
    SafeTx: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
      { name: 'operation', type: 'uint8' },
      { name: 'safeTxGas', type: 'uint256' },
      { name: 'baseGas', type: 'uint256' },
      { name: 'gasPrice', type: 'uint256' },
      { name: 'gasToken', type: 'address' },
      { name: 'refundReceiver', type: 'address' },
      { name: 'nonce', type: 'uint256' },
    ],
  };

  return signer._signTypedData(domain, types, tx);
}

export class ClaimService {
  private readonly provider: ethers.providers.JsonRpcProvider;
  private readonly signer: Wallet;
  private running = false;
  private runCount = 0;
  private claimedGroupCount = 0;
  private failedRunCount = 0;
  private lastRunAtMs: number | null = null;
  private lastError = '';

  constructor(private readonly config: AppConfig) {
    this.provider = new ethers.providers.JsonRpcProvider(config.rpcUrl);
    this.signer = new Wallet(config.privateKey, this.provider);
  }

  private reportClaimError(context: string, error: unknown): string {
    const message = extractErrorMessage(error);
    logError(`CLAIM ERROR | ${context} | ${message}`);
    return message;
  }

  async claimOnce(): Promise<void> {
    if (!this.config.claim.enabled || this.running) {
      return;
    }

    this.running = true;
    this.runCount += 1;
    this.lastRunAtMs = Date.now();
    try {
      const targets = this.buildClaimTargets();
      logInfo(
        `Claim run #${this.runCount} targets: ${targets.map((t) => `${t.address} (${t.mode})`).join(', ')}`
      );
      let totalGroups = 0;
      let hadFailures = false;
      let firstFailureMessage = '';

      for (const target of targets) {
        let positions: PositionRecord[] = [];
        try {
          positions = await this.fetchRedeemablePositions(target.address);
        } catch (error) {
          hadFailures = true;
          const message = this.reportClaimError(
            `fetch failed for ${target.address} (${target.mode})`,
            error
          );
          if (!firstFailureMessage) firstFailureMessage = message;
          continue;
        }

        const groups = this.buildGroups(positions);
        if (groups.length === 0) {
          logInfo(`Claim: no redeemable groups for ${target.address} (${target.mode}).`);
          continue;
        }

        totalGroups += groups.length;
        logInfo(`Claim run: ${groups.length} redeem groups for ${target.address} (${target.mode}).`);
        for (const group of groups) {
          try {
            await this.redeemGroup(group, target.mode);
          } catch (error) {
            hadFailures = true;
            const message = this.reportClaimError(
              `group failed (${target.address}, ${target.mode}, ${group.conditionId})`,
              error
            );
            if (!firstFailureMessage) firstFailureMessage = message;
          }
        }
      }

      if (totalGroups === 0) {
        logInfo('Claim run finished: no redeemable groups found.');
      } else {
        logInfo('Claim run finished.');
      }

      if (hadFailures) {
        this.failedRunCount += 1;
        this.lastError = firstFailureMessage || 'One or more claim operations failed.';
      } else {
        this.lastError = '';
      }
    } catch (error) {
      this.failedRunCount += 1;
      const message = this.reportClaimError('run failed', error);
      this.lastError = message;
    } finally {
      this.running = false;
    }
  }

  private buildClaimTargets(): ClaimTarget[] {
    const targetsByAddress = new Map<string, ClaimTarget>();
    const safeAddress = this.config.claim.safeAddress?.trim();

    const addTarget = (addressRaw: string, mode: ClaimMode): void => {
      const address = normalizeAddress(addressRaw);
      const existing = targetsByAddress.get(address);
      if (!existing) {
        targetsByAddress.set(address, { address, mode });
        return;
      }
      if (existing.mode === 'direct' && mode === 'safe') {
        existing.mode = 'safe';
      }
    };

    if (safeAddress) {
      addTarget(safeAddress, 'safe');
    }

    const configuredClaimAddress = this.config.claim.walletAddress;
    const configuredMode: ClaimMode =
      safeAddress && normalizeAddress(configuredClaimAddress) === normalizeAddress(safeAddress)
        ? 'safe'
        : 'direct';
    addTarget(configuredClaimAddress, configuredMode);

    addTarget(this.signer.address, 'direct');
    return Array.from(targetsByAddress.values());
  }

  private async fetchRedeemablePositions(userAddress: string): Promise<PositionRecord[]> {
    const results: PositionRecord[] = [];
    const pageSize = 200;
    const maxPages = 20;

    for (let page = 0; page < maxPages; page++) {
      const offset = page * pageSize;
      const params = new URLSearchParams({
        user: userAddress,
        redeemable: 'true',
        sizeThreshold: '0',
        limit: String(pageSize),
        offset: String(offset),
      });

      const url = `${this.config.claim.dataApiUrl}?${params.toString()}`;
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Claim data API returned HTTP ${response.status}`);
      }

      const payload = (await response.json()) as unknown;
      const pageItems = Array.isArray(payload) ? (payload as PositionRecord[]) : [];
      if (pageItems.length === 0) {
        break;
      }

      results.push(...pageItems);
      if (pageItems.length < pageSize) {
        break;
      }
    }

    return results;
  }

  private buildGroups(positions: PositionRecord[]): RedeemGroup[] {
    const groups = new Map<string, RedeemGroup>();

    for (const position of positions) {
      const conditionId = extractConditionId(position);
      const indexSet = extractIndexSet(position);
      if (!conditionId || !indexSet) {
        continue;
      }

      const parentCollectionId = extractParentCollectionId(position);
      const key = `${conditionId}|${parentCollectionId}`;
      const existing = groups.get(key);
      if (!existing) {
        groups.set(key, {
          conditionId,
          parentCollectionId,
          indexSets: [indexSet],
        });
      } else if (!existing.indexSets.includes(indexSet)) {
        existing.indexSets.push(indexSet);
      }
    }

    return Array.from(groups.values());
  }

  private async redeemGroup(group: RedeemGroup, mode: ClaimMode): Promise<void> {
    const iface = new ethers.utils.Interface(CTF_REDEEM_ABI);
    const data = iface.encodeFunctionData('redeemPositions', [
      this.config.claim.collateralTokenAddress,
      group.parentCollectionId,
      group.conditionId,
      group.indexSets,
    ]);

    if (mode === 'safe') {
      await this.redeemViaSafe(data);
      return;
    }

    const contract = new Contract(this.config.claim.ctfAddress, CTF_REDEEM_ABI, this.signer);
    const tx = await contract.redeemPositions(
      this.config.claim.collateralTokenAddress,
      group.parentCollectionId,
      group.conditionId,
      group.indexSets,
      { gasLimit: 600000 }
    );
    const receipt = await tx.wait();
    if (receipt.status !== 1) {
      throw new Error(`Direct claim tx reverted for condition ${group.conditionId}`);
    }

    this.claimedGroupCount += 1;
    this.lastError = '';
    logInfo(`Claimed group directly: ${group.conditionId}`);
  }

  private async redeemViaSafe(data: string): Promise<void> {
    const safeAddress = this.config.claim.safeAddress;
    if (!safeAddress) {
      throw new Error('CLAIM_SAFE_ADDRESS is not set.');
    }

    const safeContract = new Contract(safeAddress, SAFE_ABI, this.signer);

    // Dry-run first to surface revert reasons directly in logs and avoid unnecessary gas spend.
    try {
      await this.provider.call({
        to: this.config.claim.ctfAddress,
        from: safeAddress,
        data,
      });
    } catch (error) {
      throw new Error(`Safe claim dry-run reverted: ${extractErrorMessage(error)}`);
    }

    const nonce: BigNumber = await safeContract.nonce();

    const safeTx = {
      to: this.config.claim.ctfAddress,
      value: '0',
      data,
      operation: 0,
      safeTxGas: '0',
      baseGas: '0',
      gasPrice: '0',
      gasToken: ethers.constants.AddressZero,
      refundReceiver: ethers.constants.AddressZero,
      nonce: nonce.toNumber(),
    };

    const signature = await signSafeTransaction(this.signer, this.config.chainId, safeAddress, safeTx);
    const feeData = await this.provider.getFeeData();
    const txOverrides: Record<string, unknown> = { gasLimit: 800000 };
    const minGasPrice = ethers.utils.parseUnits('50', 'gwei');
    const boostGwei = ethers.utils.parseUnits('15', 'gwei');

    if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
      let priority = feeData.maxPriorityFeePerGas.add(boostGwei);
      if (priority.lt(minGasPrice)) {
        priority = minGasPrice;
      }
      txOverrides.maxPriorityFeePerGas = priority;
      txOverrides.maxFeePerGas = feeData.maxFeePerGas.add(priority);
    } else {
      const gasPrice = feeData.gasPrice && feeData.gasPrice.gt(minGasPrice)
        ? feeData.gasPrice
        : minGasPrice;
      txOverrides.gasPrice = gasPrice;
    }

    const tx = await safeContract.execTransaction(
      safeTx.to,
      safeTx.value,
      safeTx.data,
      safeTx.operation,
      safeTx.safeTxGas,
      safeTx.baseGas,
      safeTx.gasPrice,
      safeTx.gasToken,
      safeTx.refundReceiver,
      signature,
      txOverrides
    );

    logInfo(`Safe claim tx sent: ${tx.hash}`);
    const receipt = await tx.wait();
    if (receipt.status !== 1) {
      throw new Error(`Safe claim tx reverted: ${tx.hash}`);
    }

    this.claimedGroupCount += 1;
    this.lastError = '';
    logInfo(`Claimed group via Safe tx: ${tx.hash}`);
  }

  getStats(): {
    running: boolean;
    runCount: number;
    claimedGroupCount: number;
    failedRunCount: number;
    lastRunAtMs: number | null;
    lastError: string;
  } {
    return {
      running: this.running,
      runCount: this.runCount,
      claimedGroupCount: this.claimedGroupCount,
      failedRunCount: this.failedRunCount,
      lastRunAtMs: this.lastRunAtMs,
      lastError: this.lastError,
    };
  }
}

export class ClaimScheduler {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly claimService: ClaimService
  ) {}

  start(): void {
    if (!this.config.claim.enabled) {
      logInfo('Claim scheduler disabled (CLAIM_INTERVAL_MINUTES <= 0).');
      return;
    }

    const runClaim = (): void => {
      this.claimService.claimOnce().catch((error: unknown) => {
        const message = extractErrorMessage(error);
        logError(`CLAIM ERROR | interval | ${message}`);
      });
    };

    const everyMs = this.config.claim.intervalMinutes * 60 * 1000;
    logInfo(`Claim scheduler active: every ${this.config.claim.intervalMinutes} minute(s).`);
    logInfo('Claim scheduler warm-up: running first claim now.');
    runClaim();
    this.timer = setInterval(runClaim, everyMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
