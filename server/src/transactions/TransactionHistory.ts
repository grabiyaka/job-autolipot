import { ApplicationError } from '../../framework/core/errors.js';
import { checkedReading } from './TransactionAmount.js';
import type {
  TransactionRecord, TransactionState, TransactionVerification, TransactionView,
} from './TransactionTypes.js';

function compareTransactions(left: TransactionRecord, right: TransactionRecord): number {
  return Date.parse(left.effectiveAt) - Date.parse(right.effectiveAt)
    || left.sequence - right.sequence
    || left.id.localeCompare(right.id);
}

function isAuditEvent(record: TransactionRecord): boolean {
  return record.effect.kind === 'cancellation' || record.effect.kind === 'description-change';
}

function cancellationSources(records: readonly TransactionRecord[]): Map<string, TransactionRecord> {
  const originals = new Map(records.map(record => [record.id, record]));
  const cancellations = new Map<string, TransactionRecord>();

  for (const cancellation of records) {
    if (cancellation.effect.kind !== 'cancellation' || cancellation.reversesId === null) continue;
    const source = originals.get(cancellation.reversesId);
    if (!source || isAuditEvent(source) || source.subscriberId !== cancellation.subscriberId) continue;
    if (compareTransactions(source, cancellation) >= 0 || cancellations.has(source.id)) continue;
    cancellations.set(source.id, cancellation);
  }

  return cancellations;
}

function shiftedState(state: TransactionState, change: TransactionState): TransactionState {
  return {
    balanceKopeks: state.balanceKopeks - change.balanceKopeks,
    maintenanceBalanceKopeks: state.maintenanceBalanceKopeks - change.maintenanceBalanceKopeks,
    readingHundredths: state.readingHundredths - change.readingHundredths,
  };
}

/** Present the corrected chain while retaining every original execution snapshot. */
export function presentTransactions(records: readonly TransactionRecord[]): TransactionView[] {
  const ordered = [...records].sort(compareTransactions);
  const originals = new Map(ordered.map(record => [record.id, record]));
  const cancellations = cancellationSources(ordered);
  const descriptions = new Map<string, string>();

  for (const amendment of ordered) {
    if (amendment.effect.kind !== 'description-change' || amendment.amendsId === null) continue;
    const source = originals.get(amendment.amendsId);
    if (!source || isAuditEvent(source) || source.subscriberId !== amendment.subscriberId) continue;
    if (compareTransactions(source, amendment) < 0) descriptions.set(source.id, amendment.effect.description);
  }

  return ordered.map(record => {
    let before = { ...record.effect.before };
    let after = { ...record.effect.after };

    if (!isAuditEvent(record)) {
      for (const [sourceId, cancellation] of cancellations) {
        const source = originals.get(sourceId)!;
        if (source.subscriberId !== record.subscriberId) continue;
        // Rows after cancellation were already recorded against the corrected card.
        if (compareTransactions(source, record) < 0 && compareTransactions(record, cancellation) < 0) {
          before = shiftedState(before, source.effect.change);
          after = shiftedState(after, source.effect.change);
        }
      }
    }

    return {
      record,
      description: descriptions.get(record.id) ?? record.effect.description,
      cancelledBy: cancellations.get(record.id)?.id ?? null,
      projection: { before, after },
    };
  });
}

function inheritedVerification(records: readonly TransactionRecord[]): TransactionVerification | null {
  const first = records[0];
  if (!first) return null;
  const before = first.subscriberBefore;
  const verification = first.verificationBefore ?? (
    before.verifiedByTransactionId !== null && before.verifiedReadingHundredths !== null && before.verifiedAt !== null
      ? {
        transactionId: before.verifiedByTransactionId,
        readingHundredths: before.verifiedReadingHundredths,
        confirmedAt: before.verifiedAt,
      }
      : null
  );
  if (!verification) return null;
  // A source in this ledger must qualify through its own durable classification.
  if (records.some(record => record.id === verification.transactionId
    || record.effect.kind === 'cancellation' && record.reversesId === verification.transactionId)) return null;
  return verification;
}

function restorableVerification(verification: TransactionVerification | null): TransactionVerification | null {
  if (verification === null) return null;
  try {
    checkedReading(verification.readingHundredths);
  } catch (error) {
    if (!(error instanceof ApplicationError)) throw error;
    throw new ApplicationError(
      'TRANSACTION_UNSAFE_CANCELLATION',
      'Отмена делает подтверждённое показание недопустимым. Требуется отдельное исправление связанных операций.',
      409,
    );
  }
  return verification;
}

/** Determine the verified reading after a pending cancellation without mutating history. */
export function verificationAfterCancellation(
  records: readonly TransactionRecord[], target: TransactionRecord,
): TransactionVerification | null {
  const subscriberHistory = records.filter(record => record.subscriberId === target.subscriberId);
  if (!subscriberHistory.some(record => record.id === target.id)) subscriberHistory.push(target);
  const views = presentTransactions(subscriberHistory);
  const ordered = views.map(view => view.record);
  const alreadyCancelled = cancellationSources(ordered).has(target.id);

  for (const view of [...views].reverse()) {
    const candidate = view.record;
    if (candidate.id === target.id || view.cancelledBy !== null) continue;
    if (candidate.effect.kind !== 'meter-reconciliation' || !candidate.effect.confirmsReading) continue;

    const readingHundredths = view.projection.after.readingHundredths
      - (!alreadyCancelled && compareTransactions(target, candidate) < 0 ? target.effect.change.readingHundredths : 0);
    return restorableVerification({
      transactionId: candidate.id,
      readingHundredths,
      confirmedAt: candidate.verificationAfter?.confirmedAt ?? candidate.effectiveAt,
    });
  }

  const inherited = inheritedVerification(ordered);
  return restorableVerification(inherited?.transactionId === target.id ? null : inherited);
}
