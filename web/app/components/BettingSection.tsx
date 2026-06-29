'use client';

import { useMemo, useState } from 'react';
import { validateBetAmount } from '../lib/validators';
import { useToast } from '../../providers/ToastProvider';
import { predinexContract } from '../lib/adapters/predinex-contract';
import { Loader2, Wallet, AlertCircle } from 'lucide-react';
import type { Pool } from '@/app/lib/adapters/types';
import { useWallet } from './WalletAdapterProvider';
import { useNetworkMismatch } from '@/lib/hooks/useNetworkMismatch';
import { TruncatedAddress } from '../../components/TruncatedAddress';
import { invalidateOnPlaceBet } from '../lib/cache-invalidation';
import { toastMessages, showToastPayload } from '../../lib/toast-messages';
import { TransactionFeeModal } from './TransactionFeeModal';
import { TxStage } from '../lib/soroban-transaction-service';

interface BettingSectionProps {
    pool: Pool;
    poolId: number;
    onBetSuccess?: (outcome: number, amount: number) => void;
}

export default function BettingSection({ pool, poolId, onBetSuccess }: BettingSectionProps) {
    const wallet = useWallet();
    const { isConnected, address, connect } = wallet;
    const { showToast } = useToast();
    const [betAmount, setBetAmount] = useState("");
    const [amountTouched, setAmountTouched] = useState(false);
    const [isBetting, setIsBetting] = useState(false);
    const [feePrompt, setFeePrompt] = useState<{ feeStroops: string, resolve: (v: boolean) => void } | null>(null);
    const [stage, setStage] = useState<TxStage>('idle');

    const STROOPS_PER_STX = 10_000_000;

    // Per-pool limits (raw units) — optional for legacy pools.
    const minBetStroops = pool.minBet ?? 0;
    const maxBetStroops = pool.maxBet ?? 0;
    const minBetStx = minBetStroops / STROOPS_PER_STX;
    const hasMaxBet = maxBetStroops > 0;
    const maxBetStx = hasMaxBet ? maxBetStroops / STROOPS_PER_STX : null;
    const hasMinBet = minBetStroops > 0;

    // Derived directly from connection state — no effect needed for this mock value
    const walletBalance: number | null = isConnected ? 100.0 : null;

    const { isMismatch, expectedNetworkName } = useNetworkMismatch();

    // Inline, client-side validation of the bet amount. Returns a human-readable
    // error string, or null when the amount is valid for this pool. Runs on every
    // change/blur so the form can show feedback and disable submission before the
    // user ever triggers a transaction.
    const amountError = useMemo<string | null>(() => {
        if (betAmount.trim() === "") {
            return "Amount is required";
        }
        const amountStx = parseFloat(betAmount);
        // Base checks (number, > 0, global bounds) reuse the shared validator.
        const base = validateBetAmount(amountStx);
        if (!base.valid) {
            return base.error ?? "Invalid amount";
        }
        // Pool-specific limits take precedence over the global bounds.
        if (hasMinBet && amountStx < minBetStx) {
            return `Minimum bet is ${minBetStx} XLM`;
        }
        if (hasMaxBet && maxBetStx !== null && amountStx > maxBetStx) {
            return `Maximum bet is ${maxBetStx} XLM`;
        }
        if (walletBalance !== null && amountStx > walletBalance) {
            return `Amount exceeds your balance of ${walletBalance.toFixed(2)} XLM`;
        }
        return null;
    }, [betAmount, hasMinBet, minBetStx, hasMaxBet, maxBetStx, walletBalance]);

    const isAmountInvalid = amountError !== null;
    const showAmountError = amountTouched && isAmountInvalid;

    const placeBet = async (outcome: number) => {
        if (!isConnected) {
            connect();
            return;
        }

        const amountStx = parseFloat(betAmount);
        if (!betAmount || isNaN(amountStx) || amountStx <= 0) {
            showToastPayload(showToast, toastMessages.bet.invalidAmount);
            return;
        }

        const amountStroops = Math.floor(amountStx * STROOPS_PER_STX);

        if (minBetStroops > 0 && amountStroops < minBetStroops) {
            showToastPayload(showToast, toastMessages.bet.minBet(minBetStx));
            return;
        }

        if (hasMaxBet && maxBetStroops > 0 && amountStroops > maxBetStroops) {
            showToastPayload(showToast, toastMessages.bet.maxBet(maxBetStx ?? 0));
            return;
        }

        // Check wallet balance
        if (walletBalance !== null && amountStx > walletBalance) {
            showToastPayload(showToast, toastMessages.bet.insufficientBalance(walletBalance));
            return;
        }

        setIsBetting(true);

        try {
            await predinexContract.placeBetSoroban({
                wallet,
                poolId,
                outcome,
                amountStroops,
                onStageChange: (s) => setStage(s),
                onFeeEstimated: (fee) => {
                    return new Promise((resolve) => {
                        setFeePrompt({ feeStroops: fee, resolve });
                    });
                }
            });
            
            if (address) {
                invalidateOnPlaceBet({ poolId, userAddress: address });
            }
            showToast('Bet placed successfully!', 'success');
            setIsBetting(false);
            setBetAmount("");
            setStage('idle');
            setFeePrompt(null);
            if (onBetSuccess) {
                onBetSuccess(outcome, amountStroops);
            }
        } catch (error) {
            console.error("Bet transaction failed:", error);
            showToast(`Failed to place bet: ${error instanceof Error ? error.message : 'Unknown error'}`, 'error');
            setIsBetting(false);
            setStage('idle');
            setFeePrompt(null);
        }
    };

    if (pool.settled) {
        return (
            <div className="text-center py-6 bg-muted/50 rounded-lg">
                <p className="text-lg font-bold">This pool has been settled.</p>
                <p className="text-muted-foreground">Winner: {pool.winningOutcome === 0 ? pool.outcomeA : pool.outcomeB}</p>
            </div>
        );
    }

    if (!isConnected) {
        return (
            <div className="text-center py-6 bg-muted/50 rounded-lg">
                <Wallet className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
                <p className="text-lg font-bold mb-2">Connect Wallet to Bet</p>
                <p className="text-muted-foreground mb-4">You need to connect your wallet to place bets on this market.</p>
                <button
                    onClick={connect}
                    className="flex items-center gap-2 bg-primary/10 hover:bg-primary/20 text-primary px-6 py-3 rounded-full border border-primary/20 transition font-medium mx-auto hover:scale-105"
                >
                    <Wallet className="w-5 h-5" />
                    Connect Wallet
                </button>
            </div>
        );
    }

    const totalPool = pool.totalA + pool.totalB;
    const oddsA = totalPool > 0 ? ((pool.totalA / totalPool) * 100).toFixed(1) : "50.0";
    const oddsB = totalPool > 0 ? ((pool.totalB / totalPool) * 100).toFixed(1) : "50.0";

    return (
        <div className="space-y-4">
            {/* Real-time odds display */}
            <div className="p-4 bg-muted/30 rounded-lg border border-border/50">
                <p className="text-sm text-muted-foreground mb-2">Current Odds</p>
                <div className="flex h-3 rounded-full overflow-hidden mb-2">
                    <div
                        className="bg-green-500 transition-all duration-500"
                        style={{ width: `${oddsA}%` }}
                    />
                    <div
                        className="bg-red-500 transition-all duration-500"
                        style={{ width: `${oddsB}%` }}
                    />
                </div>
                <div className="flex justify-between text-sm">
                    <div className="text-green-400">
                        <span className="font-medium">{pool.outcomeA}</span>
                        <span className="ml-1 text-muted-foreground">{oddsA}%</span>
                    </div>
                    <div className="text-red-400">
                        <span className="mr-1 text-muted-foreground">{oddsB}%</span>
                        <span className="font-medium">{pool.outcomeB}</span>
                    </div>
                </div>
                <p className="text-xs text-muted-foreground mt-1 text-center">
                    Total pool: {(totalPool / 10_000_000).toLocaleString()} XLM
                </p>
            </div>

            <TransactionFeeModal
                isOpen={!!feePrompt}
                actionName="Place Bet"
                feeStroops={feePrompt?.feeStroops || '0'}
                onConfirm={() => {
                    feePrompt?.resolve(true);
                    setFeePrompt(null);
                }}
                onCancel={() => {
                    feePrompt?.resolve(false);
                    setFeePrompt(null);
                    setIsBetting(false);
                    setStage('idle');
                }}
                isConfirming={stage === 'signing' || stage === 'submitting' || stage === 'polling'}
            />
            {/* Wallet Info */}
            {isConnected && address && (
                <div className="p-4 bg-primary/5 rounded-lg border border-primary/20">
                    <div className="flex justify-between items-center">
                        <div>
                            <p className="text-sm text-muted-foreground">Connected Wallet</p>
                            <TruncatedAddress address={address} className="font-mono text-sm" />
                        </div>
                        <div className="text-right">
                            <p className="text-sm text-muted-foreground">Balance</p>
                            <p className="font-bold">{walletBalance?.toFixed(2) || '0'} XLM</p>
                        </div>
                    </div>
                </div>
            )}

            {/* Balance Warning */}
            {walletBalance !== null && walletBalance < minBetStx && !isMismatch && (
                <div className="p-3 bg-yellow-500/10 border border-yellow-500/20 rounded-lg flex gap-2">
                    <AlertCircle className="w-5 h-5 text-yellow-500 shrink-0 mt-0.5" />
                    <p className="text-sm text-yellow-600">
                        Insufficient balance to place bets. Minimum: {minBetStx} XLM
                    </p>
                </div>
            )}

            {/* Network Mismatch Warning */}
            {isMismatch && (
                <div className="p-3 bg-yellow-500/10 border border-yellow-500/20 rounded-lg flex gap-2">
                    <AlertCircle className="w-5 h-5 text-yellow-500 shrink-0 mt-0.5" />
                    <p className="text-sm text-yellow-600">
                        Please switch to {expectedNetworkName} to place bets.
                    </p>
                </div>
            )}

            {/* Bet Amount Input */}
            <div>
                <label className="block text-sm font-medium mb-2">Bet Amount (XLM)</label>
                <input
                    type="number"
                    step="0.1"
                    min={hasMinBet ? String(minBetStx) : undefined}
                    max={hasMaxBet && maxBetStx !== null ? String(maxBetStx) : undefined}
                    className={`w-full bg-muted/50 border rounded-lg px-4 py-3 focus:outline-none focus:ring-2 ${
                        showAmountError
                            ? 'border-red-500 focus:ring-red-500/50'
                            : 'border-border focus:ring-primary/50'
                    }`}
                    placeholder="e.g., 10"
                    value={betAmount}
                    onChange={(e) => setBetAmount(e.target.value)}
                    onBlur={() => setAmountTouched(true)}
                    disabled={isBetting || (walletBalance !== null && walletBalance < minBetStx) || isMismatch}
                    aria-label="Enter bet amount in XLM"
                    aria-invalid={showAmountError}
                    aria-describedby={showAmountError ? 'bet-amount-error' : 'bet-amount-limits'}
                />
                {showAmountError ? (
                    <p
                        id="bet-amount-error"
                        role="alert"
                        className="text-xs text-red-500 mt-2 flex items-center gap-1"
                    >
                        <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                        {amountError}
                    </p>
                ) : (
                    <p id="bet-amount-limits" className="text-xs text-muted-foreground mt-2">
                        Bet limits:{' '}
                        {hasMinBet ? `Min ${minBetStx} XLM` : 'No minimum'}
                        {hasMaxBet && maxBetStx !== null ? `, Max ${maxBetStx} XLM` : ', No maximum'}
                    </p>
                )}
            </div>

            {/* Bet Buttons */}
            <div className="grid grid-cols-2 gap-4">
                <button
                    onClick={() => placeBet(0)}
                    disabled={isBetting || isAmountInvalid || (walletBalance !== null && walletBalance < minBetStx) || isMismatch}
                    className="py-4 bg-green-600 hover:bg-green-700 text-white font-bold rounded-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed flex justify-center items-center gap-2"
                >
                    {isBetting ? <Loader2 className="w-5 h-5 animate-spin" /> : isMismatch ? 'Wrong Network' : `Bet on ${pool.outcomeA}`}
                </button>
                <button
                    onClick={() => placeBet(1)}
                    disabled={isBetting || isAmountInvalid || (walletBalance !== null && walletBalance < minBetStx) || isMismatch}
                    className="py-4 bg-red-600 hover:bg-red-700 text-white font-bold rounded-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed flex justify-center items-center gap-2"
                >
                    {isBetting ? <Loader2 className="w-5 h-5 animate-spin" /> : isMismatch ? 'Wrong Network' : `Bet on ${pool.outcomeB}`}
                </button>
            </div>
        </div>
    );
}